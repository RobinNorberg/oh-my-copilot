/**
 * `omg factory poll [--interval 5m] [--once] [--no-heal] [--no-intake] [--no-prs] [--json]`
 * (ADO parity design §2): a foreground polling loop, forge-neutral (GitHub
 * and Azure DevOps). It replaces webhooks where there is no public endpoint.
 * One tick, in this order:
 *
 * 1. heal: `runHealScan` (classify new red CI runs into heal state), only
 *    when `forge.capabilities.heal`; never `heal run` or `heal approve`.
 * 2. intake: the source's ids diffed against `.omg/state/factory-poll.json`
 *    `seen`; each new id is checked (check's rules) and audited
 *    (`intake-new` in `.omg/state/factory-poll-audit.jsonl`).
 * 3. PRs: every run in flight with a PR. A PR a human completed or abandoned
 *    prints the resume hint; open human review threads are counted (ADO).
 * 4. board: the board rows that changed since the previous tick
 *    (src/factory/board), or with `--json` one JSON object per tick.
 *
 * A tick never spawns a session or a lane and never writes to the tracker or
 * the forge: every forge call goes through check's read guard with no marker
 * (openReadForge), and the heal scan through the heal guard. It writes local
 * state only: the poll file and its audit; on GitHub the heal tick also
 * writes heal state under its `scan.lock` and the heal scan records in the
 * ledger directory outside the repository. The tick result says whether the
 * repository was idle (no engine owner, no run in flight, no unreadable run
 * state): the seam an intake auto-start plugs into; poll itself starts nothing.
 *
 * One poller per repository (the owner pid in the poll file, under its lock,
 * with a `beatAt` heartbeat each tick; an owner silent for 2 x the 60 min
 * ceiling is stale and taken over).
 * SIGINT / SIGTERM end the loop after the current tick. A rate-limited tick
 * (TF400733, HTTP 429) doubles the interval, up to 60 min; a clean tick
 * resets it. The interval floor is 2 min.
 *
 * Exit codes: 0 (a loop stopped by a signal, or a clean `--once` tick);
 * 1 a read failed in the `--once` tick, or another poller runs; 2 usage;
 * 5 incompatible (as `omg factory check`).
 */
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { ADO_RATE_LIMITED } from '../forge/ado/checks.js';
import { ShipSafetyError } from '../ship/exec.js';
import { collectBoard, readRuns } from './board/collect.js';
import { backlogLine, runLine } from './board/render.js';
import { CheckUsageError, checkEnvFor, openReadForge } from './check/cli.js';
import { checkItems, plainText } from './check/score.js';
import { runHealScan } from './heal/cli.js';
import { HealRunRefused } from './heal/run.js';
import { defaultOwnerDeps, factoryRepoOwnerPath, runLabel, TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity, } from './run/state.js';
/** Bumped on any change to the `--json` tick shape (src/factory/__tests__/poll.test.ts pins it). */
export const POLL_JSON_SCHEMA_VERSION = 1;
export const POLL_DEFAULT_INTERVAL_MS = 5 * 60_000;
/** The floor: ADO allows 200 TSTU per sliding 5 minutes per user (design §2.3). */
export const POLL_MIN_INTERVAL_MS = 2 * 60_000;
/** The backoff ceiling. */
export const POLL_MAX_INTERVAL_MS = 60 * 60_000;
/** An owner whose last heartbeat is older than this is stale (a crashed poller on another host, or a reused pid). */
export const POLL_OWNER_STALE_MS = 2 * POLL_MAX_INTERVAL_MS;
export class PollBusyError extends Error {
}
export const pollStatePath = (root) => join(getOmcRoot(root), 'state', 'factory-poll.json');
export const pollAuditPath = (root) => join(getOmcRoot(root), 'state', 'factory-poll-audit.jsonl');
/** `--interval`: `<n>s`, `<n>m` (also a bare number) or `<n>h`, at least 2 min. */
export function parseInterval(raw) {
    const m = /^([1-9]\d{0,5})(s|m|h)?$/.exec(raw.trim());
    if (!m)
        throw new CheckUsageError(`--interval ${JSON.stringify(raw)} is not <n>s, <n>m or <n>h`);
    const ms = Number(m[1]) * (m[2] === 's' ? 1_000 : m[2] === 'h' ? 3_600_000 : 60_000);
    if (ms < POLL_MIN_INTERVAL_MS)
        throw new CheckUsageError(`--interval ${raw} is below the 2 min floor (Azure DevOps rate limits)`);
    if (ms > POLL_MAX_INTERVAL_MS)
        throw new CheckUsageError(`--interval ${raw} is above 60 min`);
    return ms;
}
/** The wait after a tick: doubled (up to 60 min) after a rate-limited tick, the configured interval after a clean one. */
export function nextInterval(current, base, rateLimited) {
    return rateLimited ? Math.min(Math.max(current, base) * 2, POLL_MAX_INTERVAL_MS) : base;
}
function readPollFile(path) {
    if (!existsSync(path))
        return { seen: [] };
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return { seen: [] };
    }
    const f = (raw && typeof raw === 'object' ? raw : {});
    return {
        // A pid without a hostname cannot be checked: no owner.
        ...(Number.isSafeInteger(f.pid) && typeof f.hostname === 'string' ? { pid: f.pid, hostname: f.hostname } : {}),
        ...(typeof f.startedAt === 'string' ? { startedAt: f.startedAt } : {}),
        ...(typeof f.beatAt === 'string' ? { beatAt: f.beatAt } : {}),
        seen: Array.isArray(f.seen) ? f.seen.filter((n) => Number.isSafeInteger(n) && n > 0) : [],
        ...(typeof f.at === 'string' ? { at: f.at } : {}),
    };
}
const writePollFile = (path, f) => atomicWriteFileSync(path, `${JSON.stringify(f, null, 2)}\n`);
/** The poll file without its owner. */
const ownerless = (f) => ({ seen: f.seen, ...(f.at ? { at: f.at } : {}) });
/** The owner's last heartbeat (its start before the first beat) is older than POLL_OWNER_STALE_MS, or unreadable. */
const stale = (f, now) => {
    const beat = Date.parse(f.beatAt ?? f.startedAt ?? '');
    return !Number.isFinite(beat) || Date.parse(now) - beat > POLL_OWNER_STALE_MS;
};
/** A live owner, or one on another host (its pid cannot be checked), holds the file. */
const heldBy = (f, me) => f.pid !== undefined && (f.hostname !== me.hostname || (f.pid !== me.pid && me.isAlive(f.pid)));
/**
 * Claim the poller owner (the pid in the poll file, under its lock): a second
 * poller refuses; a dead one on this host is taken over.
 */
export function acquirePoller(root, now, me = defaultOwnerDeps()) {
    const path = pollStatePath(root);
    ensureDirSync(join(path, '..'));
    withFileLockSync(lockPathFor(path), () => {
        const f = readPollFile(path);
        if (heldBy(f, me) && !stale(f, now)) {
            throw new PollBusyError(`omg factory poll already runs in this repository (pid ${f.pid} on ${f.hostname} since ${f.startedAt}, last beat ${f.beatAt ?? 'none'}); one poller per repository. If no poller runs, delete ${path}`);
        }
        writePollFile(path, { pid: me.pid, hostname: me.hostname, startedAt: now, beatAt: now, ...ownerless(f) });
    }, { timeoutMs: 5_000 });
    return {
        release: () => {
            try {
                withFileLockSync(lockPathFor(path), () => {
                    const f = readPollFile(path);
                    if (f.pid === me.pid && f.hostname === me.hostname)
                        writePollFile(path, ownerless(f));
                }, { timeoutMs: 5_000 });
            }
            catch { /* the next poller takes a dead owner over */ }
        },
    };
}
function updateSeen(root, seen, at) {
    const path = pollStatePath(root);
    withFileLockSync(lockPathFor(path), () => writePollFile(path, { ...readPollFile(path), seen: [...seen].sort((a, b) => a - b), at }), { timeoutMs: 5_000 });
}
/** The owner's heartbeat; false when another poller has taken the file over. */
function beat(root, me, at) {
    const path = pollStatePath(root);
    return withFileLockSync(lockPathFor(path), () => {
        const f = readPollFile(path);
        if (f.pid !== me.pid || f.hostname !== me.hostname)
            return false;
        writePollFile(path, { ...f, beatAt: at });
        return true;
    }, { timeoutMs: 5_000 });
}
function audit(root, record, at) {
    try {
        const path = pollAuditPath(root);
        ensureDirSync(join(path, '..'));
        // Never append through a link planted at the audit path.
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
            return;
        appendFileSync(path, `${JSON.stringify({ ...record, at })}\n`, 'utf8');
    }
    catch {
        // best-effort audit trail (as the listener's)
    }
}
/** Whether an engine holds the repository (factoryRepoOwnerPath), as acquireFactoryRepoOwner would see it. */
function engineBusy(root, me) {
    const path = factoryRepoOwnerPath(root);
    if (!existsSync(path))
        return false;
    try {
        return heldBy(JSON.parse(readFileSync(path, 'utf8')), me);
    }
    catch {
        // An unreadable owner file is never taken for a free repository.
        return true;
    }
}
/**
 * The production heal tick: `omg factory heal scan` (writing heal state, never
 * a lane) through the heal guard on the raw Exec. On Azure DevOps the scan is
 * refused until heal runs there.
 */
export function defaultPollHealScan(exec, config, ledgerDir) {
    return (o) => {
        if (o.kind === 'azure-devops')
            throw new HealRunRefused('omg factory heal scan does not run on Azure DevOps yet; the heal tick is skipped');
        const heal = config(o.root);
        for (const w of heal.warnings)
            o.warn(w);
        return runHealScan({ exec, root: o.root, base: o.base, config: heal.config, now: o.now, dryRun: false, warn: o.warn, ledgerDir });
    };
}
const message = (error) => plainText(error instanceof Error ? error.message : String(error));
const resumeHint = (key) => (typeof key === 'number' ? `omg factory run ${key}` : `omg factory heal approve ${key.slice('heal-'.length)}`);
/** One tick. Never spawns, never writes to the tracker or forge; a guard refusal propagates (a bug, not an unreadable item). */
export function pollTick(ctx) {
    const { forge, config, root } = ctx;
    const at = new Date(ctx.now()).toISOString();
    const errors = [];
    const warnings = [];
    const step = (name, fn) => {
        try {
            return fn();
        }
        catch (error) {
            if (error instanceof ShipSafetyError)
                throw error;
            errors.push(`${name}: ${message(error)}`);
            return undefined;
        }
    };
    ctx.tick += 1;
    if (step('heartbeat', () => beat(root, ctx.owner, at)) === false)
        warnings.push(`another poller owns ${pollStatePath(root)}; stop this one`);
    // 1. heal
    let heal;
    if (!ctx.heal)
        heal = { ran: false, reason: '--no-heal' };
    else if (!forge.capabilities.heal)
        heal = { ran: false, reason: 'the forge has no heal capability (Azure DevOps: set factory.heal.pipeline)' };
    else {
        try {
            const r = ctx.healScan({ root, base: ctx.base, kind: forge.kind, now: new Date(ctx.now()), warn: (m) => warnings.push(plainText(m)) });
            heal = { ran: true, entries: r.entries.length, recorded: r.entries.filter((e) => e.recorded).length, queued: r.queued };
        }
        catch (error) {
            if (error instanceof ShipSafetyError)
                throw error;
            heal = { ran: false, reason: message(error) };
            if (!(error instanceof HealRunRefused))
                errors.push(`heal: ${message(error)}`);
        }
    }
    // 2. intake
    const source = config.intake.source;
    let ids = [];
    let intake;
    if (!ctx.intake)
        intake = { ran: false, reason: '--no-intake' };
    else if (!source)
        intake = { ran: false, reason: 'no intake source (factory.intake.source)' };
    else {
        const listed = step('intake', () => forge.tracker.queryItems(source, config.intake.limit));
        if (!listed)
            intake = { ran: false, reason: 'the intake query failed' };
        else {
            ids = listed;
            const seen = new Set(readPollFile(pollStatePath(root)).seen);
            const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
            const results = fresh.length ? step('intake check', () => checkItems(forge, fresh, checkEnvFor(ctx.exec, root, config, ctx.base, ctx.baseSha))) : [];
            // A failed check marks nothing seen: the next tick checks every new id again.
            if (!results)
                intake = { ran: false, reason: 'the intake check failed' };
            else {
                for (const r of results) {
                    audit(root, { kind: 'intake-new', id: r.id, bucket: r.bucket, reasons: r.reasons }, at);
                    if (r.reasons[0] === 'read-failed')
                        errors.push(`intake: ${r.detail}`);
                }
                // A read-failed item stays new, so the next tick checks it again.
                const failed = new Set(results.filter((r) => r.reasons[0] === 'read-failed').map((r) => r.id));
                step('intake seen', () => updateSeen(root, ids.filter((id) => !failed.has(id)), at));
                intake = { ran: true, items: ids.length, new: results.map((r) => ({ id: r.id, bucket: r.bucket, reasons: r.reasons })) };
            }
        }
    }
    // 3. PRs (and the idle seam): the runs in flight.
    const { runs, broken } = readRuns(root, warnings);
    const live = [...runs].filter(([, s]) => !TERMINAL_FACTORY_PHASES.includes(s.phase));
    const prs = [];
    if (ctx.prs) {
        for (const [key, s] of live) {
            if (s.pr === undefined)
                continue;
            const pr = s.pr;
            const row = { id: key, pr };
            const view = step(`PR ${pr}`, () => forge.reviews.viewPr(pr));
            if (!view)
                row.error = errors[errors.length - 1];
            else {
                row.state = view.state;
                if (view.state !== 'OPEN')
                    row.hint = resumeHint(key);
                else if (forge.reviews.listThreads) {
                    const threads = step(`PR ${pr} threads`, () => forge.reviews.listThreads(pr));
                    if (threads)
                        row.threads = threads.filter((t) => (t.status === 'active' || t.status === 'pending') && t.kind === 'text' && !t.byFactory).length;
                    else
                        row.error = errors[errors.length - 1];
                }
            }
            const facts = JSON.stringify([row.state, row.threads]);
            if (row.state !== undefined && ctx.previous.prs.get(runLabel(key)) !== facts) {
                if (row.state !== 'OPEN')
                    audit(root, { kind: 'pr-done', id: key, pr, state: row.state, hint: row.hint }, at);
                else if (row.threads !== undefined)
                    audit(root, { kind: 'pr-threads', id: key, pr, active: row.threads }, at);
                ctx.previous.prs.set(runLabel(key), facts);
            }
            prs.push(row);
        }
    }
    // A run state that is unreadable or fails its integrity seal (readFactoryState never checks it) may hide a run in flight: never idle.
    const unsound = broken.size > 0 || [...runs.values()].some((s) => !verifyFactoryIntegrity(s));
    const idle = !unsound && !engineBusy(root, ctx.owner) && !live.some(([, s]) => !s.gate);
    // 4. board: the rows that changed.
    const board = [];
    const shown = step('board', () => collectBoard({ forge, config, root, ids, check: null, now: ctx.now(), warnings }));
    if (shown) {
        const rows = [...shown.columns.flatMap((c) => c.items.map((row) => ({ stage: c.stage, row }))), ...shown.outside.map((row) => ({ stage: 'outside', row }))];
        const next = new Map();
        for (const r of rows) {
            const sig = JSON.stringify(r);
            next.set(runLabel(r.row.id), sig);
            if (ctx.previous.board.get(runLabel(r.row.id)) !== sig)
                board.push(r);
        }
        ctx.previous.board = next;
    }
    const rateLimited = [...errors, ...warnings].some((m) => ADO_RATE_LIMITED.test(m));
    return {
        schemaVersion: POLL_JSON_SCHEMA_VERSION, tick: ctx.tick, at, forge: config.kind, repo: config.repo.url,
        heal, intake, prs, board, idle, rateLimited, errors: errors.map(plainText), warnings: warnings.map(plainText),
    };
}
export function renderTick(t) {
    const prefix = t.forge === 'azure-devops' ? '!' : '#';
    const lines = [`factory poll  tick ${t.tick}  ${t.at}  ${t.forge} ${t.repo}${t.idle ? '  idle' : ''}${t.nextIntervalMs ? `  next in ${Math.round(t.nextIntervalMs / 60_000)} min` : ''}${t.rateLimited ? '  rate-limited: backing off' : ''}`];
    if (t.heal.ran && t.heal.entries > 0)
        lines.push(`  heal: ${t.heal.entries} run(s) scanned, ${t.heal.recorded} recorded${t.heal.queued ? `, ${t.heal.queued} queued` : ''} (omg factory heal status)`);
    if (t.intake.ran)
        for (const n of t.intake.new)
            lines.push(`  intake: new #${n.id} ${n.bucket}${n.reasons[0] ? ` ${n.reasons[0]}` : ''}`);
    for (const p of t.prs) {
        if (p.hint)
            lines.push(`  PR ${prefix}${p.pr} of ${runLabel(p.id)} is ${p.state === 'MERGED' ? 'merged' : 'closed'} by a human: run \`${p.hint}\` to record it`);
        else if (p.threads)
            lines.push(`  PR ${prefix}${p.pr} of ${runLabel(p.id)}: ${p.threads} open human thread(s)`);
    }
    for (const b of t.board)
        lines.push(`  ${b.stage.toUpperCase()}${b.stage === 'backlog' ? backlogLine(b.row) : runLine(b.row, prefix)}`);
    return lines.join('\n');
}
const defaultSleep = (ms, wake) => new Promise((resolve) => {
    if (wake.aborted) {
        resolve();
        return;
    }
    const timer = setTimeout(resolve, ms);
    wake.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});
const defaultOnStop = (handler) => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
};
/** Run the poller until a stop signal (or one tick with --once); returns the exit code. */
export async function runFactoryPoll(o, deps) {
    const base = o.interval === undefined ? POLL_DEFAULT_INTERVAL_MS : parseInterval(o.interval);
    const now = deps.now ?? Date.now;
    const warnings = [];
    const checkDeps = { ...deps, isTTY: () => false, confirm: async () => false };
    const read = openReadForge({}, checkDeps, warnings, 'omg factory poll');
    for (const w of warnings)
        deps.err(plainText(w));
    const owner = deps.owner ?? defaultOwnerDeps();
    const { release } = acquirePoller(read.root, new Date(now()).toISOString(), owner);
    let stopping = 0;
    const wake = new AbortController();
    const off = (deps.onStop ?? defaultOnStop)(() => {
        stopping += 1;
        if (stopping > 1)
            process.exit(130);
        deps.err('omg factory poll: stopping after the current tick; press again to exit at once');
        wake.abort();
    });
    const ctx = {
        forge: read.forge, config: read.config, root: read.root, base: read.base, exec: read.exec, baseSha: read.baseSha,
        heal: o.heal !== false, intake: o.intake !== false, prs: o.prs !== false,
        healScan: deps.healScan, owner, now, previous: { board: new Map(), prs: new Map() }, tick: 0,
    };
    let interval = base;
    try {
        for (;;) {
            const t = pollTick(ctx);
            if (!o.once) {
                interval = nextInterval(interval, base, t.rateLimited);
                t.nextIntervalMs = interval;
            }
            if (o.json)
                deps.out(JSON.stringify(t));
            else {
                for (const w of t.warnings)
                    deps.err(w);
                for (const e of t.errors)
                    deps.err(`omg factory poll: ${e}`);
                deps.out(renderTick(t));
            }
            if (o.once)
                return t.errors.length ? 1 : 0;
            if (stopping)
                return 0;
            await (deps.sleep ?? defaultSleep)(interval, wake.signal);
            if (stopping)
                return 0;
        }
    }
    finally {
        off();
        release();
    }
}
//# sourceMappingURL=poll.js.map