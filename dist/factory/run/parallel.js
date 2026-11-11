/**
 * Parallel private-layout runs in one checkout (item 2 lane B2; design i23
 * 5/8): the factory.run.maxConcurrent / maxInFlightCredits settings, the
 * per-repository credit reservation of in-flight lanes, and the
 * `omg factory run --next --parallel N` supervisor. The slots and the
 * repository import lock are owner records in state.ts (its LOCK ORDER
 * comment is the one rule every holder follows).
 *
 * Parallelism exists only for private-layout runs: each run is its own
 * engine process with its own private repository; lanes, prepare and gates
 * run in parallel, while every git transport into or out of the user's
 * repository (base fetches, the seed fetch, import + push, the local forge's
 * mirror sync) is serialised by the import lock. With maxConcurrent 1 (the
 * default) or the shared layout nothing here is used.
 */
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { BASE_CONFIG_PATH, readBaseFile, resolveTrustedBases } from '../../ship/config.js';
import { TRUSTED_READ_ENV } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { describeOwner, EXIT_BUSY, FactoryStateError, isOwnerRecord, ownerHolds, ownerRecord, ownerText } from './state.js';
/** The park of a parallel engine whose layout resolved to shared at the sealed base (before any lane). */
export const PARALLEL_LAYOUT_GATE = 'parallel-needs-private';
/** The highest factory.run.maxConcurrent accepted (each run is a process with its own private clone). */
export const MAX_CONCURRENT_LIMIT = 16;
const runKeys = (config) => {
    const r = config?.factory?.run;
    return typeof r === 'object' && r !== null ? r : undefined;
};
function checkKey(key, v, source) {
    if (key === 'maxConcurrent') {
        if (!Number.isInteger(v) || v < 1 || v > MAX_CONCURRENT_LIMIT)
            throw new FactoryStateError(`${source}: factory.run.maxConcurrent must be an integer from 1 to ${MAX_CONCURRENT_LIMIT} (got ${JSON.stringify(v)})`);
    }
    else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new FactoryStateError(`${source}: factory.run.maxInFlightCredits must be a positive number (got ${JSON.stringify(v)})`);
    }
    return v;
}
/**
 * factory.run.maxConcurrent and maxInFlightCredits from the trusted layers
 * only: the user config, then the `.copilot/omg.jsonc` committed on a
 * trusted base (the caller passes undefined for an untrusted base). An
 * invalid user value throws; an invalid base value is warned about and
 * counts as unset (review-483 MEDIUM-1's rule for the base layer).
 */
export function resolveParallelSettings(user, base, warn = () => { }) {
    const out = { maxConcurrent: 1, source: 'default' };
    let concurrent = false;
    let credits = false;
    for (const [config, source] of [[user, 'user config'], [base, 'the base .copilot/omg.jsonc']]) {
        const r = runKeys(config);
        if (!r)
            continue;
        for (const key of ['maxConcurrent', 'maxInFlightCredits']) {
            if (r[key] === undefined || (key === 'maxConcurrent' ? concurrent : credits))
                continue;
            let v;
            try {
                v = checkKey(key, r[key], source);
            }
            catch (error) {
                if (config === user)
                    throw error;
                warn(`omg factory run: ${error.message}; the key counts as unset`);
                continue;
            }
            if (key === 'maxConcurrent') {
                out.maxConcurrent = v;
                out.source = source;
                concurrent = true;
            }
            else {
                out.maxInFlightCredits = v;
                credits = true;
            }
        }
    }
    return out;
}
/** Why more than one concurrent run is refused for this layout, or null. */
export function parallelLayoutRefusal(settings, layout) {
    if (settings.maxConcurrent <= 1 || layout === 'private')
        return null;
    return `factory.run.maxConcurrent ${settings.maxConcurrent} (from ${settings.source === 'the base .copilot/omg.jsonc' ? settings.source : `the ${settings.source}`}) runs several runs at once only with factory.run.layout: "private" (each run in its own private git repository); the shared layout runs one engine per checkout. Set factory.run.layout "private" in your user config, or set factory.run.maxConcurrent 1`;
}
/**
 * The `.copilot/omg.jsonc` committed at the base's local tracking ref (no
 * fetch: the lock is not held yet), read only when the base is in
 * ship.trustedBases of the user config; undefined when untrusted, absent or
 * unreadable (warned). The engine reads the layout again at the sealed base.
 */
export function readTrustedBaseLayerAtRef(exec, root, base, ref, user, warn = () => { }) {
    let trusted = false;
    try {
        trusted = resolveTrustedBases(user).includes(base);
    }
    catch { /* a bad ship.trustedBases: no base is trusted */ }
    if (!trusted)
        return undefined;
    try {
        // A sha the caller read itself (review-487 L-1: the remote's, by ls-remote) is used as is.
        const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : exec('git', ['rev-parse', '--verify', ref], { cwd: root, env: TRUSTED_READ_ENV }).stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(sha))
            return undefined;
        const text = readBaseFile(exec, root, sha, BASE_CONFIG_PATH);
        return text && text.trim() ? parseJsonc(text) : undefined;
    }
    catch (error) {
        warn(`omg factory run: the ${BASE_CONFIG_PATH} committed on ${base} could not be read for factory.run (${error instanceof Error ? error.message : String(error)}); its factory.run keys count as unset`);
        return undefined;
    }
}
/** `<ledgerDir>/credits/<repo8>.json`: one file per repository (claimRepoKey), shared by every checkout and clone of it. */
export function creditReservationPath(ledgerDir, repo8) {
    if (!/^[0-9a-f]{8}$/.test(repo8))
        throw new FactoryStateError(`the credit reservation key must be 8 hex characters (got ${ownerText(repo8)})`);
    return join(ledgerDir, 'credits', `${repo8}.json`);
}
const isReservation = (v) => isOwnerRecord(v) && typeof v.id === 'string' && typeof v.cap === 'number' && Number.isFinite(v.cap) && v.cap >= 0;
/** The file's reservations; null when absent; throws when it cannot be read or parsed (fail closed: unreadable is not "empty"). */
function readCreditFile(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw new FactoryStateError(`the credit reservation file ${path} cannot be read (${error.code ?? String(error)})`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        parsed = undefined;
    }
    const f = parsed;
    if (!f || f.version !== 1 || !Array.isArray(f.reservations) || !f.reservations.every(isReservation)) {
        throw new FactoryStateError(`the credit reservation file ${path} is unreadable, so the credits in flight are unknown; check that no factory run of this repository is in a lane, then omg factory run release removes it`);
    }
    return f.reservations;
}
function withCreditFile(path, fn) {
    ensureDirSync(join(path, '..'));
    return withFileLockSync(lockPathFor(path), fn, { timeoutMs: 10_000 });
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
/**
 * Reserve `cap` credits for lane `id` under the file's own short lock: the
 * live reservations (holder identity checked; dead holders dropped and the
 * file rewritten without them) plus `cap` must stay within `limit`. Refused:
 * `wait` says whether a live reservation ending can make room (else the cap
 * alone is over the limit). `settle` drops the reservation after the lane:
 * a lane that ended is no longer in flight (its measured credits are the
 * lane's own record). A crashed engine's reservations go with its process.
 */
export function reserveLaneCredits(o) {
    const path = creditReservationPath(o.ledgerDir, o.repo8);
    if (o.cap > o.limit) {
        return { ok: false, inFlight: 0, wait: false, reason: `this lane's cap of ${fmt(o.cap)} AI credits is over factory.run.maxInFlightCredits ${fmt(o.limit)} on its own; raise factory.run.maxInFlightCredits in your user config, or lower factory.run.laneMaxCredits, then rerun` };
    }
    return withCreditFile(path, () => {
        const all = readCreditFile(path) ?? [];
        const live = all.filter((r) => ownerHolds(r, o.deps) || (r.pid === o.deps.pid && r.hostname === o.deps.hostname));
        const inFlight = live.reduce((sum, r) => sum + r.cap, 0);
        if (inFlight + o.cap > o.limit) {
            if (live.length !== all.length)
                atomicWriteFileSync(path, `${JSON.stringify({ version: 1, reservations: live })}\n`);
            return { ok: false, inFlight, wait: true, reason: `${fmt(inFlight)} AI credits are reserved by lanes in flight (${live.map((r) => `${ownerText(r.id)} ${fmt(r.cap)}`).join(', ')}); this lane's cap of ${fmt(o.cap)} would pass factory.run.maxInFlightCredits ${fmt(o.limit)}` };
        }
        const mine = { ...ownerRecord(o.now, o.deps, { run: o.run }), id: o.id, cap: o.cap };
        atomicWriteFileSync(path, `${JSON.stringify({ version: 1, reservations: [...live.filter((r) => r.id !== o.id), mine] })}\n`);
        let settled = false;
        return {
            ok: true,
            settle: () => {
                if (settled)
                    return;
                settled = true;
                try {
                    withCreditFile(path, () => {
                        const now = readCreditFile(path) ?? [];
                        const rest = now.filter((r) => !(r.id === o.id && r.pid === o.deps.pid && r.hostname === o.deps.hostname));
                        if (rest.length === 0)
                            unlinkSync(path);
                        else
                            atomicWriteFileSync(path, `${JSON.stringify({ version: 1, reservations: rest })}\n`);
                    });
                }
                catch (error) {
                    // It stays until this engine exits; then its holder is dead and the next reservation drops it.
                    o.warn?.(`omg factory run: the credit reservation of lane ${o.id} was not released (${error instanceof Error ? error.message : String(error)}); it is dropped once this engine exits`);
                }
            },
        };
    });
}
/** The live reservations (read-only; for status). Throws on an unreadable file. */
export function liveCreditReservations(ledgerDir, repo8, deps) {
    return (readCreditFile(creditReservationPath(ledgerDir, repo8)) ?? []).filter((r) => ownerHolds(r, deps));
}
/**
 * `omg factory run release`: drop the reservations whose holder is dead; an
 * unreadable file is removed (its holders cannot be told). Live ones stay.
 * Returns what was freed, as text.
 */
export function releaseDeadCreditReservations(ledgerDir, repo8, deps) {
    const path = creditReservationPath(ledgerDir, repo8);
    return withCreditFile(path, () => {
        let all;
        try {
            all = readCreditFile(path);
        }
        catch {
            unlinkSync(path);
            return { freed: [`${path} (unreadable)`], kept: [] };
        }
        if (!all)
            return { freed: [], kept: [] };
        const live = all.filter((r) => ownerHolds(r, deps));
        const dead = all.filter((r) => !live.includes(r));
        if (dead.length === 0)
            return { freed: [], kept: live.map((r) => `${ownerText(r.id)} (${describeOwner(r)})`) };
        if (live.length === 0)
            unlinkSync(path);
        else
            atomicWriteFileSync(path, `${JSON.stringify({ version: 1, reservations: live })}\n`);
        return { freed: dead.map((r) => `credit reservation of lane ${ownerText(r.id)} (${describeOwner(r)})`), kept: live.map((r) => `${ownerText(r.id)} (${describeOwner(r)})`) };
    });
}
/**
 * Run up to `n` children at once: a child that exits with a code other than
 * busy (EXIT_BUSY: no free slot, the item or checkout held) gets its slot
 * refilled; a child that found nothing runnable (exit 0, no item) stops the
 * refills; a stop signal stops the refills and waits for the running
 * children (spawn forwards the signal to them). Exit code: 130 when
 * stopped, else 1 when a child failed (exit 1), else the highest other
 * child code, else 0.
 */
export async function runParallelSupervisor(o) {
    const children = [];
    let stopping = false;
    let exhausted = false;
    let started = 0;
    let active = 0;
    let capacity = o.n;
    let wake = () => { };
    const unsubscribe = o.onStop(() => { stopping = true; wake(); });
    try {
        for (;;) {
            while (!stopping && !exhausted && active < capacity) {
                const index = started++;
                active += 1;
                void o.spawn().then((r) => r, (error) => ({ exitCode: 1, parsed: false, next: null, message: `the child did not run: ${error instanceof Error ? error.message : String(error)}` })).then((r) => {
                    active -= 1;
                    children.push({ index, ...r });
                    o.report?.(index, r);
                    // Nothing runnable: no more refills. Busy (no free slot, the checkout held): that slot is not refilled.
                    if (r.exitCode === 0 && r.parsed && r.next === null)
                        exhausted = true;
                    // A child that failed before it took an item (a config error, an unreadable outcome) would fail again: no more refills.
                    if (r.exitCode !== 0 && r.exitCode !== EXIT_BUSY && (!r.parsed || r.next === null))
                        exhausted = true;
                    if (r.exitCode === EXIT_BUSY)
                        capacity = Math.max(0, capacity - 1);
                    wake();
                });
            }
            if (active === 0)
                break;
            await new Promise((resolve) => { wake = resolve; });
        }
    }
    finally {
        unsubscribe();
    }
    const codes = children.map((c) => c.exitCode);
    const others = codes.filter((c) => c !== EXIT_BUSY);
    const exitCode = stopping ? 130 : codes.includes(1) ? 1 : others.length === 0 && codes.length > 0 ? EXIT_BUSY : Math.max(0, ...others);
    return { exitCode, interrupted: stopping, children: children.sort((a, b) => a.index - b.index) };
}
//# sourceMappingURL=parallel.js.map