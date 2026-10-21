/**
 * `omg progress` — agent progress events (contract: src/lib/agent-progress.ts):
 *   emit    append one event to the agent's log (never fails the caller's chain)
 *   watch   stream new events plus synthesized `status=stalled` lines, one
 *           line per event, for Claude Code's Monitor tool; exits when every
 *           tracked agent is `done` (or settled, with `--until settled`)
 *   status  table of each agent's latest event and state
 *
 * Sources for watch / status: every `--file`, else `--dir` (each `*.log`),
 * else `$OMG_PROGRESS_FILE`, else `<state root>/progress/`.
 *
 * Exit codes: 0 ok (emit also when the write failed: a warning goes to
 * stderr, because a broken progress log must not stop the work), 2 usage error.
 */
import { Command } from 'commander';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { PROGRESS_FILE_ENV, agentFromProgressFile, defaultProgressDir, emitProgress, formatProgressDuration, formatProgressEvent, isProgressStatus, parseProgressDuration, parseProgressLine, summarizeProgress, } from '../../lib/agent-progress.js';
class UsageError extends Error {
}
const defaultDeps = {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    cwd: () => process.cwd(),
};
function resolveSources(o, cwd) {
    if (o.file.length > 0)
        return { files: o.file, dir: null };
    if (o.dir)
        return { files: null, dir: o.dir };
    const envFile = process.env[PROGRESS_FILE_ENV];
    if (envFile)
        return { files: [envFile], dir: null };
    return { files: null, dir: defaultProgressDir(cwd) };
}
function listSources(sources) {
    if (sources.files)
        return sources.files;
    try {
        return readdirSync(sources.dir).filter((name) => name.endsWith('.log')).sort().map((name) => join(sources.dir, name));
    }
    catch {
        return [];
    }
}
function parseStall(raw) {
    const ms = parseProgressDuration(raw, 'm');
    if (ms === null || ms <= 0)
        throw new UsageError(`--stall must be a positive duration like 10m, 90s or 1h, got ${JSON.stringify(raw)}`);
    return ms;
}
function parseInterval(raw) {
    const ms = parseProgressDuration(raw, 'ms');
    if (ms === null || ms < 50)
        throw new UsageError(`--interval must be at least 50ms, got ${JSON.stringify(raw)}`);
    return ms;
}
function parseUntil(raw) {
    if (raw !== 'done' && raw !== 'settled')
        throw new UsageError(`--until must be done or settled, got ${JSON.stringify(raw)}`);
    return raw;
}
/** An ISO-8601 time, or a duration back from now (`2h`; bare number = minutes). */
function parseSince(raw, now) {
    const ms = parseProgressDuration(raw, 'm');
    if (ms !== null)
        return now.getTime() - ms;
    const at = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at))
        throw new UsageError(`--since must be an ISO-8601 time or a duration like 2h, got ${JSON.stringify(raw)}`);
    return at;
}
function parseAgents(raw) {
    const agents = raw.split(',').map((a) => a.trim()).filter(Boolean);
    if (agents.length === 0)
        throw new UsageError(`--agents must list agent names like lane-1,lane-2, got ${JSON.stringify(raw)}`);
    return agents;
}
const newTail = () => ({ offset: 0, rest: Buffer.alloc(0), ino: 0, birthtimeMs: 0 });
/** Bytes from offset to the current end; throws when unreadable. */
function readFrom(path, offset, size) {
    if (size <= offset)
        return Buffer.alloc(0);
    const fd = openSync(path, 'r');
    try {
        const chunk = Buffer.alloc(size - offset);
        return chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, offset));
    }
    finally {
        closeSync(fd);
    }
}
function tryStat(path) {
    try {
        return statSync(path);
    }
    catch {
        return null;
    }
}
/**
 * New complete lines since the last read. A rotated file (new identity, or
 * shrunk when the platform reports none) is finished from `<file>.1` at the
 * old offset, then read from the start; a file truncated in place is reread
 * from the start.
 */
function readNewLines(path, tail, flush) {
    const st = tryStat(path);
    if (!st)
        return [];
    const lines = [];
    const known = tail.ino !== 0 || tail.birthtimeMs !== 0;
    const replaced = known && (tail.ino !== 0 && st.ino !== 0 ? st.ino !== tail.ino : st.birthtimeMs !== tail.birthtimeMs);
    if (replaced || st.size < tail.offset) {
        const old = tryStat(`${path}.1`);
        const isOldFile = old !== null && (known
            ? replaced && (tail.ino !== 0 ? old.ino === tail.ino : old.birthtimeMs === tail.birthtimeMs)
            : old.size >= tail.offset);
        if (isOldFile) {
            try {
                lines.push(...Buffer.concat([tail.rest, readFrom(`${path}.1`, tail.offset, old.size)]).toString('utf8').split('\n'));
            }
            catch {
                // the backup vanished (rotated again): its unread tail is lost
            }
        }
        tail.offset = 0;
        tail.rest = Buffer.alloc(0);
    }
    tail.ino = st.ino;
    tail.birthtimeMs = st.birthtimeMs;
    let chunk;
    try {
        chunk = readFrom(path, tail.offset, st.size);
    }
    catch {
        return lines;
    }
    tail.offset += chunk.length;
    const data = Buffer.concat([tail.rest, chunk]);
    const lastNewline = data.lastIndexOf(0x0a);
    const complete = lastNewline === -1 ? Buffer.alloc(0) : data.subarray(0, lastNewline);
    tail.rest = lastNewline === -1 ? data : data.subarray(lastNewline + 1);
    if (lastNewline !== -1)
        lines.push(...complete.toString('utf8').split('\n'));
    if (flush && tail.rest.length > 0) {
        lines.push(tail.rest.toString('utf8'));
        tail.rest = Buffer.alloc(0);
    }
    return lines;
}
function withAgent(event, path) {
    return event.agent ? event : { ...event, agent: agentFromProgressFile(path) };
}
function stalledLine(summary, now) {
    const idle = formatProgressDuration(summary.idleMs);
    return formatProgressEvent({
        ts: now.toISOString(),
        phase: summary.last.phase,
        status: 'stalled',
        note: `no event for ${idle} after status=${summary.last.status}`,
        agent: summary.agent,
        fields: { idle, last_ts: summary.last.ts },
    });
}
function pendingLine(agent, idleMs, now) {
    const idle = formatProgressDuration(idleMs);
    return formatProgressEvent({
        ts: now.toISOString(),
        phase: 'pending',
        status: 'stalled',
        note: `no event for ${idle} since the watch started`,
        agent,
        fields: { idle },
    });
}
/**
 * The watch loop. Existing lines feed the state silently (except with
 * `replay`); agents already failed / blocked / stalled at startup are
 * reported once. Later lines, and files that appear later, are streamed.
 *
 * Only new events count towards exiting (written after the watch started,
 * or at or after `sinceMs`, or every event with `replay`): the tracked
 * agents are those with a new event plus `agents`, and every `--file` needs
 * one new event, so a reused or stale log neither ends the watch early nor
 * keeps it open forever.
 */
export async function watchProgress(o, deps) {
    const sources = resolveSources(o, deps.cwd());
    const tails = new Map();
    const latest = new Map();
    const fresh = new Set();
    const freshFiles = new Set();
    const reportedStalls = new Set();
    const reportedPending = new Set();
    const pendingSince = o.sinceMs ?? deps.now().getTime();
    const reached = (s) => s !== undefined && (s.state === 'done' || (o.until === 'settled' && (s.state === 'failed' || s.state === 'blocked')));
    let first = true;
    for (;;) {
        const paths = listSources(sources);
        for (const path of paths) {
            let tail = tails.get(path);
            if (!tail) {
                if (!existsSync(path))
                    continue;
                tail = newTail();
                tails.set(path, tail);
            }
            for (const line of readNewLines(path, tail, o.once)) {
                const parsed = parseProgressLine(line);
                if (!parsed || parsed.status === 'stalled')
                    continue;
                const event = withAgent(parsed, path);
                const prev = latest.get(event.agent);
                if (!prev || Date.parse(event.ts) >= Date.parse(prev.ts))
                    latest.set(event.agent, event);
                if (!first || o.replay || (o.sinceMs !== undefined && Date.parse(event.ts) >= o.sinceMs)) {
                    fresh.add(event.agent);
                    freshFiles.add(path);
                }
                if (!first || o.replay)
                    deps.out(formatProgressEvent(event));
            }
        }
        const now = deps.now();
        const summaries = new Map(summarizeProgress([...latest.values()], now, { stallMs: o.stallMs }).map((s) => [s.agent, s]));
        for (const s of summaries.values()) {
            const key = `${s.agent}\0${s.last.ts}\0${s.last.phase}\0${s.last.status}`;
            // After startup only tracked agents are reported, so a stale log from an earlier run is reported once at most.
            const tracked = first || fresh.has(s.agent) || o.agents.includes(s.agent);
            if (s.state === 'stalled' && tracked && !reportedStalls.has(key)) {
                reportedStalls.add(key);
                deps.out(stalledLine(s, now));
            }
            else if (first && !o.replay && (s.state === 'failed' || s.state === 'blocked')) {
                deps.out(formatProgressEvent(s.last));
            }
        }
        for (const agent of o.agents) {
            if (fresh.has(agent) || reportedPending.has(agent) || summaries.get(agent)?.state === 'stalled')
                continue;
            const idleMs = Math.max(0, now.getTime() - pendingSince);
            if (idleMs > o.stallMs) {
                reportedPending.add(agent);
                deps.out(pendingLine(agent, idleMs, now));
            }
        }
        first = false;
        if (o.once)
            return 0;
        const tracked = new Set([...fresh, ...o.agents]);
        const filesReady = !sources.files || sources.files.every((f) => freshFiles.has(f));
        if (tracked.size > 0 && filesReady && [...tracked].every((a) => fresh.has(a) && reached(summaries.get(a))))
            return 0;
        await deps.sleep(o.intervalMs);
    }
}
function readAllEvents(sources) {
    const events = [];
    for (const path of listSources(sources)) {
        for (const line of readNewLines(path, newTail(), true)) {
            const parsed = parseProgressLine(line);
            if (parsed)
                events.push(withAgent(parsed, path));
        }
    }
    return events;
}
function collect(value, previous) {
    return [...previous, value];
}
async function guarded(deps, fn) {
    try {
        process.exitCode = await fn();
    }
    catch (error) {
        deps.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = error instanceof UsageError ? 2 : 1;
    }
}
export function progressCommand(overrides = {}) {
    const deps = { ...defaultDeps, ...overrides };
    const cmd = new Command('progress');
    cmd.description('Agent progress events: emit phase events, watch them (stall detection) for the Monitor tool, show status');
    cmd
        .command('emit <phase> <status>')
        .description('Append one event (status: start|ok|fail|blocked|heartbeat|done) to $OMG_PROGRESS_FILE or <state root>/progress/<agent>.log')
        .option('--note <text>', 'Short note (quoted and escaped as needed; truncated at 500 code points)')
        .option('--agent <name>', 'Agent name (default $OMG_PROGRESS_AGENT, else "agent")')
        .option('--file <path>', 'Log file (wins over $OMG_PROGRESS_FILE)')
        .option('--field <key=value>', 'Extra key=value pair (repeatable)', collect, [])
        .action((phase, status, o) => guarded(deps, () => {
        if (!isProgressStatus(status))
            throw new UsageError(`status must be one of start|ok|fail|blocked|heartbeat|done, got ${JSON.stringify(status)}`);
        if (phase.trim().length === 0)
            throw new UsageError('phase must not be empty');
        const fields = {};
        for (const raw of o.field) {
            const eq = raw.indexOf('=');
            const key = eq === -1 ? '' : raw.slice(0, eq);
            if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || ['phase', 'status', 'note', 'agent'].includes(key)) {
                throw new UsageError(`--field must be key=value with a key like build_id (not phase/status/note/agent), got ${JSON.stringify(raw)}`);
            }
            fields[key] = raw.slice(eq + 1);
        }
        const ok = emitProgress({ phase, status, note: o.note, agent: o.agent, file: o.file, fields, at: deps.now(), cwd: deps.cwd() });
        if (!ok)
            deps.err('omg progress: could not write the progress event (continuing)');
        return 0;
    }));
    cmd
        .command('watch')
        .description('Stream new events and synthesized status=stalled lines (one per line); exits when every agent with a new event (and every --agents name) is done')
        .option('--file <path>', 'Watch this log (repeatable; may not exist yet; each needs one new event before the watch can exit)', collect, [])
        .option('--dir <path>', 'Watch every *.log in this directory, including files created later')
        .option('--agents <names>', 'Comma-separated agents to wait for, even before their logs exist (stalled after --stall without an event)')
        .option('--until <state>', 'Exit when every tracked agent is done, or settled (done, failed or blocked)', 'done')
        .option('--since <time>', 'Existing events at or after this ISO time or duration ago (e.g. 2h) count as new for exiting')
        .option('--stall <duration>', 'Silence after start/heartbeat/ok that counts as a stall (bare number = minutes)', '10m')
        .option('--interval <duration>', 'Poll interval (bare number = ms)', '1000')
        .option('--replay', 'Also print the events already in the logs (and count them as new)')
        .option('--once', 'Read what exists, report it, and exit')
        .action((o) => guarded(deps, () => watchProgress({
        file: o.file,
        dir: o.dir,
        stallMs: parseStall(o.stall),
        intervalMs: parseInterval(o.interval),
        once: Boolean(o.once),
        replay: Boolean(o.replay),
        until: parseUntil(o.until),
        sinceMs: o.since === undefined ? undefined : parseSince(o.since, deps.now()),
        agents: o.agents === undefined ? [] : parseAgents(o.agents),
    }, deps)));
    cmd
        .command('status')
        .description('Show each agent\'s latest event and state (running|stalled|failed|blocked|done)')
        .option('--file <path>', 'Read this log (repeatable)', collect, [])
        .option('--dir <path>', 'Read every *.log in this directory')
        .option('--stall <duration>', 'Stall threshold (bare number = minutes)', '10m')
        .option('--json', 'JSON output')
        .action((o) => guarded(deps, () => {
        const stallMs = parseStall(o.stall);
        const summaries = summarizeProgress(readAllEvents(resolveSources(o, deps.cwd())), deps.now(), { stallMs });
        if (o.json) {
            deps.out(JSON.stringify(summaries, null, 2));
            return 0;
        }
        if (summaries.length === 0) {
            deps.out('no progress events');
            return 0;
        }
        const rows = [['AGENT', 'STATE', 'PHASE', 'STATUS', 'IDLE', 'NOTE'], ...summaries.map((s) => [
                s.agent, s.state, s.last.phase, s.last.status, formatProgressDuration(s.idleMs), s.last.note ?? '',
            ])];
        const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
        for (const r of rows)
            deps.out(r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd());
        return 0;
    }));
    return cmd;
}
//# sourceMappingURL=progress.js.map