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
 * Steps 1-4 never spawn a session or a lane and never write to the tracker or
 * the forge: every forge call goes through check's read guard with no marker
 * (openReadForge), and the heal scan through the heal guard. It writes local
 * state only: the poll file and its audit; on GitHub the heal tick also
 * writes heal state under its `scan.lock` and the heal scan records in the
 * ledger directory outside the repository. The tick result says whether the
 * repository was idle (no engine owner, no run in flight, no unreadable run
 * state).
 *
 * 5. auto-start (`factory.intake.autoStart`, trusted layers only, default
 *    off; shipyard-factory design D7): after an idle tick whose intake read
 *    succeeded and was not rate-limited (a broken run state is never idle),
 *    with budget headroom (PollBudget), and once poll's atomic claim of the
 *    engine's repo owner lock succeeds (a refusal skips the tick), poll starts one
 *    `omg factory run --next --json` and waits for it. It runs as a child
 *    `omg` process, not in-process: the run gets the engine's own guard,
 *    lock, limits, forge config and signal handling exactly as if the user
 *    had typed it, and none of it leaks into the tick's read guard (which
 *    refuses `omg`, so a tick still cannot spawn). It never starts the
 *    listener chain, `heal run` or `heal approve`, and at most one run per
 *    tick. Its budget gate fails closed (defaultPollBudget). Design note: the
 *    working-tree `intake.source` / `limit` (and `check.*`) stay
 *    allowed, so a working-tree file steers which item an unattended start
 *    picks; check's rules still decide what is runnable, and the switch and
 *    the budget come only from the trusted layers.
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
import { spawn } from 'child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { ledgerPath, ledgerTotals, parseLedger } from '../budget/ledger.js';
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
import { DEFAULT_FACTORY_RUN_LIMITS, resolveFactoryRunLimits } from './run/budget.js';
import { acquireFactoryRepoOwner, defaultOwnerDeps, factoryRepoOwnerPath, runLabel, TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity, } from './run/state.js';
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
/** The child's JSON stdout is the run outcome (state included); more than this is not parsed. */
const AUTO_START_MAX_STDOUT = 4 * 1024 * 1024;
/** The run key of poll's claim on the repo owner lock: no item is picked yet (0 is never an issue number). */
const AUTO_START_CLAIM = 0;
/** Slack on top of the run's own bounds, for its git and forge calls. */
const AUTO_START_SLACK_MS = 30 * 60_000;
/** SIGTERM to SIGKILL when the child outlives its wall-clock limit. */
const AUTO_START_GRACE_MS = 2 * 60_000;
/**
 * The child's wall-clock limit: maxRunWallTimeMs + laneTimeoutMs +
 * gatesTimeoutMs + 30 min. The engine checks maxRunWallTimeMs only at step
 * boundaries, so one invocation can overrun it by one step: a lane (its
 * laneTimeoutMs) or a gates phase (its gatesTimeoutMs). The 30 min cover the
 * git and forge calls around them. Defaults: 4 h + 30 min + 90 min + 30 min = 6.5 h.
 */
export function autoStartTimeoutMs(limits) {
    return limits.maxRunWallTimeMs + limits.laneTimeoutMs + limits.gatesTimeoutMs + AUTO_START_SLACK_MS;
}
/**
 * Read `omg factory run --next --json`'s stdout: one of factoryRunJson's
 * documents (src/cli/commands/factory.ts), which all carry `message` or
 * `error`. Anything else is not parsed.
 */
export function parseRunNextOutcome(stdout) {
    let raw;
    try {
        raw = JSON.parse(stdout);
    }
    catch {
        raw = undefined;
    }
    const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    const text = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : undefined;
    if (text === undefined)
        return { parsed: false, next: null, message: 'no outcome on stdout' };
    return { parsed: true, next: Number.isSafeInteger(o.next) && o.next > 0 ? o.next : null, message: text };
}
/**
 * The production auto-start: a child `omg factory run --next --json` (the
 * same node and CLI entry as this poller) in the repository root, stdin
 * closed, stderr shared (the run's progress shows), stdout parsed for the
 * outcome. Poll's stop signals are forwarded, so the run stops after its
 * current poll as when typed by hand. On POSIX the child runs in its own
 * process group, so a Ctrl+C reaches it once (forwarded by poll), not twice;
 * on Windows it shares the console, which delivers Ctrl+C itself, so only
 * SIGTERM is forwarded there. Past timeoutMs it gets SIGTERM, then SIGKILL
 * after graceMs; on POSIX both go to the whole process group, on Windows only
 * to the engine process (its lanes are not reached).
 */
export function defaultPollAutoStart(entry = process.argv[1], o = {}) {
    return ({ root }) => new Promise((resolve) => {
        if (!entry) {
            resolve({ exitCode: 1, parsed: false, next: null, message: 'cannot locate the omg CLI entry to start omg factory run --next' });
            return;
        }
        const timeoutMs = o.timeoutMs?.(root) ?? autoStartTimeoutMs(DEFAULT_FACTORY_RUN_LIMITS);
        let stdout = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;
        let timer;
        let killer;
        let unsubscribe = () => { };
        const settle = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killer);
            unsubscribe();
            resolve(r);
        };
        const notStarted = (error) => settle({ exitCode: 1, parsed: false, next: null, message: `omg factory run --next did not start: ${message(error)}` });
        let child;
        try {
            child = spawn(process.execPath, [entry, 'factory', 'run', '--next', '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, detached: process.platform !== 'win32' });
        }
        catch (error) {
            notStarted(error);
            return;
        }
        // On POSIX the child leads its own process group: signal the group so its lane children die with it.
        const killTree = (sig) => {
            if (process.platform === 'win32' || child.pid === undefined) {
                child.kill(sig);
                return;
            }
            try {
                process.kill(-child.pid, sig);
            }
            catch {
                child.kill(sig);
            }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            if (stdout.length + d.length <= AUTO_START_MAX_STDOUT)
                stdout += d;
            else
                truncated = true;
        });
        child.on('error', notStarted);
        child.on('close', (code, signal) => {
            const ended = signal ? ` (ended by ${signal})` : '';
            if (timedOut) {
                settle({ exitCode: code ?? 1, parsed: false, next: null, message: `omg factory run --next ran past its ${Math.round(timeoutMs / 60_000)} min limit and was stopped${ended}` });
                return;
            }
            const out = truncated ? { parsed: false, next: null, message: `the outcome on stdout exceeded ${AUTO_START_MAX_STDOUT} bytes` } : parseRunNextOutcome(stdout);
            settle({ exitCode: code ?? 1, ...out, message: out.parsed ? out.message : `${out.message}${ended}` });
        });
        timer = setTimeout(() => {
            timedOut = true;
            killTree('SIGTERM');
            killer = setTimeout(() => killTree('SIGKILL'), o.graceMs ?? AUTO_START_GRACE_MS);
        }, timeoutMs);
        unsubscribe = o.signals?.((signal) => {
            if (process.platform !== 'win32' || signal !== 'SIGINT')
                child.kill(signal);
        }) ?? unsubscribe;
    });
}
function softLimitOf(config, source) {
    const raw = config?.budget?.softLimit;
    if (raw === undefined)
        return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0)
        throw new Error(`${source}: budget.softLimit must be a positive number (got ${JSON.stringify(raw)})`);
    return raw;
}
/**
 * The production budget gate of an unattended start. It fails closed:
 * - the `factory.run` limits must resolve (`omg factory run` refuses without
 *   a valid per-lane AI-credit cap);
 * - the governor must be on (`OMC_BUDGET_GOVERNOR=0` means no auto-start);
 * - `budget.softLimit` comes from the user config, then the base branch (as
 *   factory.intake.autoStart); the working-tree layer can only lower it
 *   (resolveFactoryRunLimits' tighten-only rule). No trusted value, an
 *   invalid one, or an unreadable ledger blocks the start;
 * - the AI credits in the ledger must be below it (the governor only warns a
 *   human; an unattended start stops at it).
 * A human `omg factory run` never reads this gate.
 */
export function defaultPollBudget(layers, env = process.env) {
    return (root) => {
        try {
            const l = layers(root);
            resolveFactoryRunLimits(l.trustedUser, l.project);
            if (env.OMC_BUDGET_GOVERNOR === '0')
                return 'the budget governor is off (OMC_BUDGET_GOVERNOR=0); autoStart needs it on';
            const trusted = softLimitOf(l.trustedUser, 'user config') ?? softLimitOf(l.base, 'base-branch .copilot/omg.jsonc');
            if (trusted === undefined)
                return 'autoStart needs budget.softLimit (user config or base branch)';
            const project = softLimitOf(l.project, 'project config');
            const limit = project !== undefined && project < trusted ? project : trusted;
            const path = ledgerPath(root);
            const { ledger, invalid } = parseLedger(path);
            if (invalid)
                return `the budget ledger is unreadable (${path}); autoStart needs it (omg budget status)`;
            const used = ledgerTotals(ledger).credits;
            return used >= limit ? `the AI credits used (${used.toFixed(2)}) reached budget.softLimit ${limit} (omg budget status)` : null;
        }
        catch (error) {
            return message(error);
        }
    };
}
const message = (error) => plainText(error instanceof Error ? error.message : String(error));
const resumeHint = (key) => (typeof key === 'number' ? `omg factory run ${key}` : `omg factory heal approve ${key.slice('heal-'.length)}`);
/**
 * One tick. Steps 1-4 never spawn and never write to the tracker or forge; a
 * guard refusal propagates (a bug, not an unreadable item). Step 5 is the
 * auto-start, outside the read guard.
 */
export async function pollTick(ctx) {
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
    const ledgerNow = step('ledger', () => existsSync(ledgerPath(root)));
    if (ledgerNow !== undefined) {
        if (ctx.previous.ledger && !ledgerNow)
            warnings.push(`budget ledger ${ledgerPath(root)} disappeared; spend restarts at 0`);
        ctx.previous.ledger = ledgerNow;
    }
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
    const locked = engineBusy(root, ctx.owner);
    // A run state that is unreadable or fails its integrity seal may hide a run in flight: never idle.
    const unsound = broken.size > 0 || [...runs.values()].some((s) => !verifyFactoryIntegrity(s));
    const idle = !locked && !unsound && !live.some(([, s]) => !s.gate);
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
    // 5. auto-start: at most one run, on an idle tick only.
    let autoStart;
    const blocked = !config.intake.autoStart ? 'factory.intake.autoStart is off'
        : locked ? 'the run lock is held: an engine runs in this repository'
            : unsound ? 'a run state is unreadable or fails its integrity check'
                : !idle ? 'a run is in flight'
                    : !intake.ran ? `no intake read this tick (${intake.reason})`
                        : rateLimited ? 'the tick was rate-limited'
                            : null;
    if (blocked)
        autoStart = { started: false, reason: blocked };
    else {
        let reason = ctx.budget(root);
        if (!reason) {
            // `idle` is advisory: claim the engine's repo owner lock atomically (as an engine would); a refusal skips this
            // tick. It is released for the child, whose own claim at start is the binding one: an engine that slips in
            // between makes that claim refuse, so two engines never run.
            try {
                acquireFactoryRepoOwner(root, AUTO_START_CLAIM, at, ctx.owner).release();
            }
            catch (error) {
                reason = `the run lock is held: ${message(error)}`;
            }
        }
        if (reason)
            autoStart = { started: false, reason: plainText(reason) };
        else {
            audit(root, { kind: 'auto-start' }, at);
            const r = await ctx.autoStart({ root });
            audit(root, { kind: 'auto-start-done', ...(r.parsed ? { next: r.next } : { outcome: 'unreadable' }), exitCode: r.exitCode }, new Date(ctx.now()).toISOString());
            autoStart = { started: true, parsed: r.parsed, next: r.parsed ? r.next : null, exitCode: r.exitCode, message: plainText(r.message) };
        }
    }
    return {
        schemaVersion: POLL_JSON_SCHEMA_VERSION, tick: ctx.tick, at, forge: config.kind, repo: config.repo.url,
        heal, intake, prs, board, idle, autoStart, rateLimited, errors: errors.map(plainText), warnings: warnings.map(plainText),
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
    if (t.autoStart.started) {
        const a = t.autoStart;
        const took = !a.parsed ? 'outcome unreadable' : a.next !== null ? `took #${a.next}` : a.exitCode === 0 ? 'found nothing runnable' : 'took no item';
        lines.push(`  auto-start: omg factory run --next ${took}, exit ${a.exitCode}: ${a.message}`);
    }
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
    // The budget gate's layers and the child's limits, read once like the rest of the config.
    const layers = { trustedUser: deps.trustedUser(), base: read.baseConfig, project: deps.projectConfig(read.root) };
    const runLimits = () => {
        try {
            return resolveFactoryRunLimits(layers.trustedUser, layers.project).limits;
        }
        catch {
            return DEFAULT_FACTORY_RUN_LIMITS; // the budget gate refuses the start first
        }
    };
    const { release } = acquirePoller(read.root, new Date(now()).toISOString(), owner);
    let stopping = 0;
    const wake = new AbortController();
    // An auto-started run in flight gets every stop signal too (defaultPollAutoStart), the second before the exit.
    const forwards = new Set();
    const off = (deps.onStop ?? defaultOnStop)((signal = 'SIGTERM') => {
        stopping += 1;
        for (const forward of forwards)
            forward(signal);
        if (stopping > 1)
            process.exit(130);
        deps.err('omg factory poll: stopping after the current tick; press again to exit at once');
        wake.abort();
    });
    const ctx = {
        forge: read.forge, config: read.config, root: read.root, base: read.base, exec: read.exec, baseSha: read.baseSha,
        heal: o.heal !== false, intake: o.intake !== false, prs: o.prs !== false,
        healScan: deps.healScan,
        autoStart: deps.autoStart ?? defaultPollAutoStart(process.argv[1], {
            timeoutMs: () => autoStartTimeoutMs(runLimits()),
            signals: (forward) => { forwards.add(forward); return () => { forwards.delete(forward); }; },
        }),
        budget: deps.budget ?? defaultPollBudget(() => layers),
        owner, now, previous: { board: new Map(), prs: new Map() }, tick: 0,
    };
    let interval = base;
    try {
        for (;;) {
            const t = await pollTick(ctx);
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