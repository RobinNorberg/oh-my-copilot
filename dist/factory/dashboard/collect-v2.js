/**
 * `omg factory dashboard` data, schemaVersion 2: a pure `collect -> JSON`
 * step (render.ts turns the JSON into the page; a later `--serve` reuses
 * both). LOCAL reads only: run states, owner and slot files, progress-log
 * modification times, the engine ledger, bench result files. No forge or
 * network call and no write of any kind; the tracker columns come in only
 * as an already-read board (`--forge`, the CLI does that read).
 *
 * Trust: each run state is read once and checked like `omg factory
 * attention` checks it (readRun: the seal, then the engine ledger on the
 * same bytes). A run that fails is listed with its trust marker and no free
 * text from its state (no title, no reason), and its numbers are never
 * summed into a total: `cost.excluded` counts them apart. The Attention
 * section IS the attention collector's output (collectAttention), so its
 * rows and their trust rules are the same as the CLI's.
 *
 * Every string from a state, the tracker or a bench file is untrusted: it
 * goes through plainText here and is HTML-escaped again in render.ts.
 */
import { readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { plainText } from '../check/score.js';
import { attentionJson, collectAttention, readRegularFile } from '../attention/collect.js';
import { gateSteps } from '../run/gate-next.js';
import { factoryProgressFile } from '../run/progress.js';
import { defaultOwnerDeps, FACTORY_PHASES, heldSlots, runLabel, TERMINAL_FACTORY_PHASES, } from '../run/state.js';
import { localDay, parseSince } from './collect.js';
import { withWorktreePathRenderScope } from '../../lib/worktree-paths.js';
export const DASHBOARD_SCHEMA_VERSION_2 = 2;
const GATE_NOTE = /^awaiting-human: ([^:]+):/;
/** resumed()'s note: the rerun that drops the gate. */
const RERUN_NOTE = /^rerun after awaiting-human: /;
/** A timestamp this far past now is reported as later than now (engine and reader clocks); every time is still clamped to now. */
const FUTURE_SLACK_MS = 60_000;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_BENCH_FILES = 200;
const MAX_BENCH_BYTES = 4_000_000;
const text = (v, max = 300) => plainText(String(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
const msOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n) => Math.round(n * 1000) / 1000;
const emptyUsage = () => ({ credits: 0, premiumRequests: 0, lanes: 0 });
function addUsage(into, u) {
    into.credits = round(into.credits + u.credits);
    into.premiumRequests += u.premiumRequests;
    into.lanes += u.lanes;
}
/**
 * What a history entry does to a park. The engine's writers (src/factory/run/):
 * - `park`: setGate's `awaiting-human: <gate>: <reason>` note (from === to);
 *   a park after a park changes the gate, the wait goes on.
 * - `end`: an entry that clears the gate: a phase move (moveTo, from !== to,
 *   incl. a cancel and markMergedByHuman's merged record) and the resume's
 *   `rerun after awaiting-human: <gate>` note (resumed(), which drops the gate).
 * - `note`: every other from === to note (tracker-sync failures, clean's
 *   --lane-stopped, lane, gate, sandbox and model notes). None of them clears
 *   the gate, so inside a park they are waiting time like the park itself.
 */
function parkEffect(h) {
    if (h.from === null || h.from !== h.to)
        return { kind: 'end' };
    const note = String(h.note ?? '');
    const park = GATE_NOTE.exec(note);
    if (park)
        return { kind: 'park', gate: text(park[1], 60) };
    return RERUN_NOTE.test(note) ? { kind: 'end' } : { kind: 'note' };
}
/**
 * The run's timeline from its history. Each history entry starts a segment
 * that lasts to the next entry. A park note (`awaiting-human: <gate>: ...`,
 * written by setGate) starts WAITING time, which lasts until an entry ends the
 * park (parkEffect: a phase move, a rerun, a human-merge record, a cancel):
 * notes written while parked are waiting time too. While the run is still
 * parked the wait runs to `now`, from `waitingSince` (the later of the last
 * park note and `gate.at`). Every other segment is engine time of the phase
 * the last move entered; a terminal phase ends the run (no segment after it),
 * and the last segment of a run that is neither parked nor finished runs to
 * `updatedAt`. A state whose gate is newer than its last history entry (no
 * park note) waits from `gate.at`.
 *
 * Every time is clamped to `now`, and an entry older than the one before it
 * starts where that one ended: no span is negative or later than now.
 * `clamped` says why when an entry is out of order or later than now (beyond
 * a minute of clock skew).
 *
 * What it cannot tell: an engine that died without a park (the gap to the
 * next invocation counts as engine time), and when a human really merged a
 * PR (the wait ends when a read surface or a rerun recorded it).
 */
export function runTimeline(s, now) {
    const entries = (Array.isArray(s.history) ? s.history : []).filter((h) => h && Number.isFinite(msOf(h.at)));
    const steps = [];
    let engineMs = 0;
    let waitingMs = 0;
    let mergeWaitMs = 0;
    let mergeReadyAt = null;
    let engineToMergeReadyMs = null;
    let waitingSince = null;
    const problems = new Set();
    /** A time no later than now (NaN stays NaN). */
    const clamp = (t) => {
        if (t > now + FUTURE_SLACK_MS)
            problems.add('later than now');
        return Math.min(t, now);
    };
    const stepFor = (phase) => {
        const last = steps.at(-1);
        if (last && last.phase === phase)
            return last;
        const step = { phase, engineMs: 0, waitingMs: 0, gates: [] };
        steps.push(step);
        return step;
    };
    let phase = null;
    const parked = s.gate !== undefined && !TERMINAL_FACTORY_PHASES.includes(s.phase);
    const gateAt = clamp(msOf(s.gate?.at));
    /** The gate of the park the run is in at this entry, else null. */
    let waiting = null;
    let parkStart = Number.NaN;
    let cursor = Number.NEGATIVE_INFINITY;
    let lastStart = Number.NaN;
    for (let i = 0; i < entries.length; i++) {
        const h = entries[i];
        const effect = parkEffect(h);
        if (effect.kind !== 'park' || phase === null)
            phase = text(h.to, 40);
        if (TERMINAL_FACTORY_PHASES.includes(h.to)) {
            stepFor(phase);
            break;
        }
        let start = clamp(msOf(h.at));
        if (start < cursor) {
            problems.add('out of order');
            start = cursor;
        }
        lastStart = start;
        if (effect.kind === 'park')
            waiting = effect.gate;
        else if (effect.kind === 'end')
            waiting = null;
        const lastEntry = i === entries.length - 1;
        let end;
        if (!lastEntry)
            end = clamp(msOf(entries[i + 1].at));
        else if (waiting !== null && parked)
            end = now;
        else if (parked && Number.isFinite(gateAt) && gateAt > start)
            end = gateAt;
        else
            end = clamp(msOf(s.updatedAt));
        const span = Number.isFinite(end) && end > start ? end - start : 0;
        cursor = start + span;
        const step = stepFor(phase);
        if (effect.kind === 'park') {
            step.gates.push(effect.gate);
            parkStart = start;
            if (effect.gate === 'merge' && mergeReadyAt === null) {
                mergeReadyAt = new Date(start).toISOString();
                engineToMergeReadyMs = engineMs;
            }
        }
        if (waiting !== null) {
            step.waitingMs += span;
            waitingMs += span;
            if (waiting === 'merge')
                mergeWaitMs += span;
        }
        else {
            step.engineMs += span;
            engineMs += span;
        }
    }
    if (parked && waiting !== null) {
        waitingSince = new Date(Number.isFinite(gateAt) && gateAt > parkStart ? gateAt : parkStart).toISOString();
    }
    else if (parked && Number.isFinite(gateAt) && !(gateAt <= lastStart)) {
        // A gate with no park note after the last entry (older writers): waiting from gate.at.
        const gate = text(s.gate.name, 60);
        const step = stepFor(phase ?? text(s.phase, 40));
        const span = Math.max(0, now - gateAt);
        step.gates.push(gate);
        step.waitingMs += span;
        waitingMs += span;
        waitingSince = new Date(gateAt).toISOString();
        if (gate === 'merge') {
            mergeWaitMs += span;
            if (mergeReadyAt === null) {
                mergeReadyAt = waitingSince;
                engineToMergeReadyMs = engineMs;
            }
        }
    }
    return { steps, engineMs, waitingMs, waitingSince, mergeReadyAt, engineToMergeReadyMs, mergeWaitMs, clamped: problems.size ? [...problems].join(', ') : null };
}
/**
 * Bench result files are UNSEALED and live in the repository (or a
 * --bench-dir): anyone who can write the repository can edit them. Their
 * text fields are shown only when they are plain words of BENCH_TEXT (else
 * BENCH_NOT_SHOWN), their numbers only when finite and >= 0.
 */
export const BENCH_TEXT = /^[A-Za-z0-9._ -]+$/;
export const BENCH_NOT_SHOWN = '(not shown)';
export const BENCH_UNSEALED_NOTE = 'Unsealed files in the repository (anyone who can write the repository can edit them).';
const benchText = (v, max) => (v.length <= max && BENCH_TEXT.test(v) ? v : BENCH_NOT_SHOWN);
const forgeOf = (s) => (s.remote === LOCAL_REMOTE ? 'local' : s.forgeKind ?? 'github');
const laneAt = (l) => msOf(l.endedAt ?? l.startedAt);
function laneUsage(l) {
    return { credits: num(l.usage?.credits) ?? 0, premiumRequests: num(l.usage?.premiumRequests) ?? 0, lanes: 1 };
}
function outcomeOf(s) {
    if (s.phase === 'merged' || s.phase === 'cancelled' || s.phase === 'failed')
        return s.phase;
    return s.gate ? 'parked' : 'in-progress';
}
function quantile(values, q) {
    if (values.length === 0)
        return null;
    const v = [...values].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}
function median(values) {
    if (values.length === 0)
        return null;
    const v = [...values].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}
function unverifiedRun(key, trust, s) {
    // Only enum-shaped values of an untrusted state, each one the engine knows (its phase enum, the shared gate table): no title, no reason, no numbers.
    const phase = s && FACTORY_PHASES.includes(s.phase) ? s.phase : null;
    const gateName = s?.gate && typeof s.gate.name === 'string' && SAFE_NAME.test(s.gate.name) && gateSteps(s.gate.name).known ? s.gate.name : null;
    return {
        key: runLabel(key), kind: typeof key === 'string' ? 'ci-heal' : 'issue', trust, verified: false, title: '', phase,
        gate: gateName ? { name: gateName, reason: '', at: '' } : null, outcome: 'unknown', pr: null, head: null, forge: null,
        credits: null, premiumRequests: null, lanes: null, roles: {}, startedAt: null, updatedAt: null, elapsedMs: null,
        engineMs: null, waitingMs: null, waitingSince: null, timeline: [], mergeReadyAt: null, engineToMergeReadyMs: null, mergeWaitMs: null,
    };
}
function verifiedRun(key, s, now, sinceMs) {
    const roles = Object.create(null);
    const total = emptyUsage();
    for (const lane of s.lanes) {
        if (sinceMs !== null && !(laneAt(lane) >= sinceMs))
            continue;
        const u = laneUsage(lane);
        addUsage((roles[text(lane.role ?? lane.kind, 40)] ??= emptyUsage()), u);
        addUsage(total, u);
    }
    const tl = runTimeline(s, now);
    const run = {
        key: runLabel(key),
        kind: s.kind ?? 'issue',
        trust: 'ok',
        verified: true,
        title: text(s.issueTitle ?? (s.kind === 'ci-heal' ? 'ci-heal' : ''), 160),
        phase: text(s.phase, 40),
        gate: s.gate ? { name: text(s.gate.name, 60), reason: text(s.gate.reason, 600), at: text(s.gate.at, 40) } : null,
        outcome: outcomeOf(s),
        pr: typeof s.pr === 'number' && Number.isSafeInteger(s.pr) && s.pr > 0 ? s.pr : null,
        head: typeof s.head === 'string' && HEX40.test(s.head) ? s.head : null,
        forge: forgeOf(s),
        credits: total.credits,
        premiumRequests: total.premiumRequests,
        lanes: total.lanes,
        roles: { ...roles },
        startedAt: text(s.createdAt, 40),
        updatedAt: text(s.updatedAt, 40),
        elapsedMs: num(s.elapsedMs) ?? 0,
        engineMs: tl.engineMs,
        waitingMs: tl.waitingMs,
        waitingSince: tl.waitingSince,
        timeline: tl.steps,
        mergeReadyAt: tl.mergeReadyAt,
        engineToMergeReadyMs: tl.engineToMergeReadyMs,
        mergeWaitMs: tl.mergeWaitMs,
    };
    return { run, clamped: tl.clamped };
}
/** One bench result file as a row; null when it is not one (a run-state copy, notes). Throws on a file that cannot be read. */
function benchRow(path, file, source) {
    // lstat first, regular files only, bounded: a link, directory, FIFO or device named *.json is never opened.
    const r = readRegularFile(path, MAX_BENCH_BYTES);
    if ('missing' in r)
        return null;
    if ('error' in r)
        throw new Error(r.error);
    const j = JSON.parse(r.bytes.toString('utf8'));
    if (typeof j !== 'object' || j === null || Array.isArray(j))
        return null;
    const totals = (typeof j.totals === 'object' && j.totals !== null && !Array.isArray(j.totals) ? j.totals : null);
    // A bench result names its kind, or (older writers) carries totals; anything else in the directory is not one.
    if (j.kind !== 'omg-factory-bench' && !totals)
        return null;
    const t = totals ?? {};
    const invalid = [];
    const count = (field, v) => {
        if (v === undefined || v === null)
            return null;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
            return v;
        invalid.push(field);
        return null;
    };
    const runs = Array.isArray(j.runs) ? j.runs : Array.isArray(j.issues) ? j.issues : null;
    const started = j.startedAt ?? j.createdAt ?? j.timestamp;
    // A negative wall time (finishedAt before startedAt) is no wall time: null.
    const w = count('wallMs', t.wallMs) ?? msOf(j.finishedAt) - msOf(started);
    const wall = Number.isFinite(w) && w >= 0 ? w : null;
    const model = typeof j.model === 'string' ? j.model : typeof j.model?.id === 'string' ? j.model.id : null;
    return {
        source,
        file: benchText(file, 120),
        schemaVersion: count('schemaVersion', j.schemaVersion),
        mode: typeof j.mode === 'string' ? benchText(j.mode, 30) : null,
        omgVersion: typeof j.omgVersion === 'string' ? benchText(j.omgVersion, 30) : null,
        model: model === null ? null : benchText(model, 60),
        startedAt: typeof started === 'string' && Number.isFinite(msOf(started)) ? new Date(msOf(started)).toISOString() : null,
        issues: count('issues', t.issues) ?? (runs ? runs.length : null),
        passed: count('passed', t.passed),
        premiumRequests: count('premiumRequests', t.premiumRequests),
        credits: count('credits', t.credits),
        wallMs: wall,
        ...(invalid.length ? { invalid } : {}),
    };
}
/** readRegularFile's reasons that hold no path and no file bytes. */
const FIXED_READ_REASON = /^(it is (a link|a directory|a FIFO|a device or socket), not a regular file|it is larger than \d+ bytes|the file (was replaced|grew) while it was read)$/;
/** Bench results from `<root>/bench-results/` and every --bench-dir; one row per result file, oldest first. */
export function readBenchV2(root, dirs, warnings) {
    const out = [];
    const sources = [[join(root, 'bench-results'), 'bench-results'], ...dirs.map((d) => [d, 'bench-dir'])];
    for (const [dir, source] of sources) {
        let names;
        try {
            names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().slice(-MAX_BENCH_FILES);
        }
        catch {
            if (source === 'bench-dir')
                warnings.push(`--bench-dir ${text(dir, 200)}: not a readable directory`);
            continue;
        }
        let skipped = 0;
        for (const name of names) {
            try {
                const row = benchRow(join(dir, name), name, source);
                if (row)
                    out.push(row);
                else
                    skipped++;
            }
            catch (error) {
                // Only the bounded read's own fixed reasons are shown; any other error (a parse error quotes the file's bytes,
                // an fs error its path) becomes one fixed reason.
                const why = error instanceof Error && FIXED_READ_REASON.test(error.message) ? error.message : 'not a readable bench result file';
                warnings.push(`${source}/${text(basename(name), 120)}: skipped (${why})`);
            }
        }
        if (skipped > 0 && source === 'bench-results')
            warnings.push(`bench-results: ${skipped} JSON file(s) are not bench results and were skipped`);
    }
    return out.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.file.localeCompare(b.file));
}
function boardRows(b) {
    return [...b.columns.flatMap((c) => c.items), ...b.outside];
}
/** One render scope: the state root is resolved once per collection, not once per file path. */
export function collectDashboardV2(root, o) {
    return withWorktreePathRenderScope(() => collectV2In(root, o));
}
function collectV2In(root, o) {
    const now = (o.now ?? Date.now)();
    const sinceMs = o.since === undefined ? null : parseSince(o.since);
    const owner = o.owner ?? defaultOwnerDeps();
    const warnings = [];
    // Each run state is read once, by the attention collector (the ledger-first, capped key set); its reads are reused here.
    const reads = [];
    // Unread state files are one of attention's warnings, which the result carries (once).
    const attention = collectAttention(root, { ledgerDir: o.ledgerDir, now: () => now, limits: o.limits ?? null, owner, verbose: true, onRead: (r) => reads.push(r) });
    /** Every verified state, --since or not (Live now always shows the present). */
    const allStates = new Map();
    const states = new Map();
    const runs = [];
    /** Runs whose timeline was clamped: kept out of the throughput medians. */
    const clampedRuns = new Set();
    const excluded = { runs: 0, missing: 0 };
    const missingLabels = new Set(attention.items.filter((i) => i.trust === 'missing').map((i) => i.key));
    for (const r of reads) {
        const key = r.key;
        if (r.missing) {
            // The engine ledger records a state file that is gone: attention lists it (trust missing); a row here, never in a total.
            if (!missingLabels.has(runLabel(key)))
                continue;
            runs.push(unverifiedRun(key, 'missing', undefined));
            excluded.runs++;
            excluded.missing++;
            continue;
        }
        if (r.trust !== 'ok' || !r.state) {
            // An unreadable state is already one of attention's warnings. Nothing it claims (credits, requests) is counted or shown.
            runs.push(unverifiedRun(key, r.trust, r.state));
            excluded.runs++;
            continue;
        }
        const s = r.state;
        allStates.set(runLabel(key), s);
        if (sinceMs !== null && msOf(s.updatedAt) < sinceMs)
            continue;
        try {
            const v = verifiedRun(key, s, now, sinceMs);
            runs.push(v.run);
            states.set(runLabel(key), s);
            if (v.clamped) {
                clampedRuns.add(v.run.key);
                warnings.push(`run ${v.run.key}: history timestamps ${v.clamped}; its times are clamped to now and to the entry before, and the run is left out of the throughput medians`);
            }
        }
        catch {
            warnings.push(`run ${runLabel(key)}: skipped (its state could not be laid out)`);
        }
    }
    const startedMs = (r) => msOf(r.startedAt);
    runs.sort((a, b) => (Number(b.verified) - Number(a.verified)) || (startedMs(b) || 0) - (startedMs(a) || 0) || b.key.localeCompare(a.key, 'en', { numeric: true }));
    const verified = runs.filter((r) => r.verified);
    // Live now: the engines attention counted, and the running lane of each run they hold.
    const liveRuns = attention.summary.engines.runs.map((label) => {
        const s = allStates.get(label);
        if (!s)
            return { key: label, verified: false, phase: null, lane: null, heartbeatAgeMs: null, credits: null, inFlightCredits: 0 };
        const running = s.lanes.filter((l) => l.status === 'running').at(-1);
        let heartbeatAgeMs = null;
        try {
            heartbeatAgeMs = Math.max(0, now - statSync(factoryProgressFile(root, label.startsWith('#') ? Number(label.slice(1)) : label)).mtimeMs);
        }
        catch {
            // No progress log: no heartbeat.
        }
        const inFlight = running ? num(running.maxCredits) ?? 0 : 0;
        return {
            key: label, verified: true, phase: text(s.phase, 40),
            lane: running ? { id: text(running.id, 80), kind: text(running.role ?? running.kind, 40), startedAt: text(running.startedAt, 40), maxCredits: inFlight } : null,
            heartbeatAgeMs, credits: round(s.lanes.reduce((a, l) => a + laneUsage(l).credits, 0)), inFlightCredits: inFlight,
        };
    });
    let slots = 0;
    try {
        slots = heldSlots(root, owner).length;
    }
    catch {
        // Unreadable slots dir: none counted.
    }
    // Cost, from verified runs only.
    const totals = emptyUsage();
    const roles = new Map();
    const days = new Map();
    const cap = o.limits?.maxRunCredits ?? null;
    for (const r of verified) {
        addUsage(totals, { credits: r.credits ?? 0, premiumRequests: r.premiumRequests ?? 0, lanes: r.lanes ?? 0 });
        for (const [role, u] of Object.entries(r.roles)) {
            const into = roles.get(role) ?? emptyUsage();
            addUsage(into, u);
            roles.set(role, into);
        }
    }
    for (const s of states.values()) {
        for (const lane of s.lanes) {
            const t = laneAt(lane);
            if (!Number.isFinite(t) || (sinceMs !== null && t < sinceMs))
                continue;
            const day = localDay(t);
            const into = days.get(day) ?? emptyUsage();
            addUsage(into, laneUsage(lane));
            days.set(day, into);
        }
    }
    // Throughput: runs started and runs reaching the merge park, per local day.
    const through = new Map();
    const bump = (iso, field) => {
        const t = msOf(iso);
        if (!Number.isFinite(t) || (sinceMs !== null && t < sinceMs))
            return;
        const day = localDay(t);
        const into = through.get(day) ?? { started: 0, mergeReady: 0 };
        into[field]++;
        through.set(day, into);
    };
    for (const r of verified) {
        bump(r.startedAt, 'started');
        bump(r.mergeReadyAt, 'mergeReady');
    }
    // The medians: runs that reached the merge park on or after --since (as the per-day counts), timelines not clamped.
    const samples = verified.filter((r) => r.mergeReadyAt !== null && (sinceMs === null || msOf(r.mergeReadyAt) >= sinceMs));
    const sampled = samples.filter((r) => !clampedRuns.has(r.key));
    const toMerge = sampled.flatMap((r) => (r.engineToMergeReadyMs === null ? [] : [r.engineToMergeReadyMs]));
    const mergeWaits = sampled.map((r) => r.mergeWaitMs ?? 0);
    // Tasks: one row per run, the tracker columns only from an already-read board (--forge).
    const board = o.board ? new Map(boardRows(o.board.json).map((b) => [runLabel(b.id), b])) : null;
    const tasks = runs.map((r) => {
        const b = board?.get(r.key);
        const lastAt = r.waitingSince ? now : Math.min(now, msOf(r.updatedAt));
        return {
            key: r.key, verified: r.verified, title: r.title, phase: r.phase, gate: r.gate?.name ?? null, outcome: r.outcome, pr: r.pr, credits: r.credits,
            wallMs: r.verified && Number.isFinite(lastAt - startedMs(r)) ? Math.max(0, lastAt - startedMs(r)) : null,
            tracker: board ? { bucket: b?.check ? text(b.check.bucket, 30) : null, stage: b?.stage.live ? text(b.stage.live, 30) : null, liveText: b?.liveText ? text(b.liveText, 80) : null } : null,
        };
    });
    if (o.board) {
        for (const b of o.board.json.columns.find((c) => c.stage === 'backlog')?.items ?? []) {
            if (board && runs.some((r) => r.key === runLabel(b.id)))
                continue;
            tasks.push({
                key: runLabel(b.id), verified: false, title: text(b.title, 160), phase: null, gate: null, outcome: 'no run', pr: null, credits: null, wallMs: null,
                tracker: { bucket: b.check ? text(b.check.bucket, 30) : null, stage: b.stage.live ? text(b.stage.live, 30) : null, liveText: b.liveText ? text(b.liveText, 80) : null },
            });
        }
        warnings.push(...o.board.json.warnings.map((w) => text(w, 500)));
    }
    return {
        schemaVersion: DASHBOARD_SCHEMA_VERSION_2,
        generatedAt: new Date(now).toISOString(),
        since: o.since === undefined ? null : text(o.since, 40),
        forge: { read: Boolean(o.board), at: o.board ? text(o.board.at, 40) : null },
        attention: attentionJson(attention),
        live: { engines: attention.summary.engines.live, slots, runs: liveRuns, inFlightCredits: round(liveRuns.reduce((a, r) => a + r.inFlightCredits, 0)) },
        runs,
        tasks,
        cost: {
            caps: o.limits
                ? { laneMaxCredits: o.limits.laneMaxCredits, maxRunCredits: cap, source: 'config', note: 'defaults < trusted user config < project config, as the engine resolves them; at run time the base branch\'s committed config (the trusted-base layer) and --max-requests may lower them' }
                : { laneMaxCredits: null, maxRunCredits: null, source: 'unresolved', note: 'the run limits could not be resolved; no cap is shown' },
            totals,
            byRole: [...roles].map(([role, u]) => ({ role, ...u })).sort((a, b) => b.credits - a.credits || a.role.localeCompare(b.role)),
            byDay: [...days].map(([day, u]) => ({ day, ...u })).sort((a, b) => a.day.localeCompare(b.day)),
            byRun: verified.map((r) => ({ key: r.key, credits: r.credits ?? 0, premiumRequests: r.premiumRequests ?? 0, cap: r.kind === 'issue' ? cap : null })),
            excluded,
        },
        throughput: {
            byDay: [...through].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
            engineToMergeReady: { runs: toMerge.length, medianMs: median(toMerge), p90Ms: quantile(toMerge, 0.9) },
            waitingAtMerge: { runs: mergeWaits.length, medianMs: median(mergeWaits) },
            since: o.since === undefined ? null : text(o.since, 40),
            excludedRuns: samples.length - sampled.length,
        },
        bench: readBenchV2(root, o.benchDirs ?? [], warnings).filter((b) => sinceMs === null || b.startedAt === null || msOf(b.startedAt) >= sinceMs),
        warnings: [...attention.warnings, ...warnings].map((w) => text(w, 500)),
    };
}
//# sourceMappingURL=collect-v2.js.map