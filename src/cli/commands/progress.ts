/**
 * `omg progress` — agent progress events (contract: src/lib/agent-progress.ts):
 *   emit    append one event to the agent's log (never fails the caller's chain)
 *   watch   stream new events plus synthesized `status=stalled` lines, one
 *           line per event, for Claude Code's Monitor tool; exits when every
 *           watched agent is `done`
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
import {
  PROGRESS_FILE_ENV,
  agentFromProgressFile,
  defaultProgressDir,
  emitProgress,
  formatProgressDuration,
  formatProgressEvent,
  isProgressStatus,
  parseProgressDuration,
  parseProgressLine,
  summarizeProgress,
  type AgentProgressSummary,
  type ProgressEvent,
} from '../../lib/agent-progress.js';

class UsageError extends Error {}

export interface ProgressDeps {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** One complete output line (no trailing newline). */
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: () => string;
}

const defaultDeps: ProgressDeps = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: () => process.cwd(),
};

interface SourceOptions {
  file: string[];
  dir?: string;
}

interface Sources {
  /** Fixed files (watched even before they exist), or null in directory mode. */
  files: string[] | null;
  dir: string | null;
}

function resolveSources(o: SourceOptions, cwd: string): Sources {
  if (o.file.length > 0) return { files: o.file, dir: null };
  if (o.dir) return { files: null, dir: o.dir };
  const envFile = process.env[PROGRESS_FILE_ENV];
  if (envFile) return { files: [envFile], dir: null };
  return { files: null, dir: defaultProgressDir(cwd) };
}

function listSources(sources: Sources): string[] {
  if (sources.files) return sources.files;
  try {
    return readdirSync(sources.dir!).filter((name) => name.endsWith('.log')).sort().map((name) => join(sources.dir!, name));
  } catch {
    return [];
  }
}

function parseStall(raw: string): number {
  const ms = parseProgressDuration(raw, 'm');
  if (ms === null || ms <= 0) throw new UsageError(`--stall must be a positive duration like 10m, 90s or 1h, got ${JSON.stringify(raw)}`);
  return ms;
}

function parseInterval(raw: string): number {
  const ms = parseProgressDuration(raw, 'ms');
  if (ms === null || ms < 50) throw new UsageError(`--interval must be at least 50ms, got ${JSON.stringify(raw)}`);
  return ms;
}

interface Tail {
  offset: number;
  rest: Buffer;
}

/** New complete lines since the last read; a shrunken file (rotation, truncation) is reread from the start. */
function readNewLines(path: string, tail: Tail, flush: boolean): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size < tail.offset) {
    tail.offset = 0;
    tail.rest = Buffer.alloc(0);
  }
  let chunk = Buffer.alloc(0);
  if (size > tail.offset) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      chunk = Buffer.alloc(size - tail.offset);
      const read = readSync(fd, chunk, 0, chunk.length, tail.offset);
      chunk = chunk.subarray(0, read);
      tail.offset += read;
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const data = Buffer.concat([tail.rest, chunk]);
  const lastNewline = data.lastIndexOf(0x0a);
  const complete = lastNewline === -1 ? Buffer.alloc(0) : data.subarray(0, lastNewline);
  tail.rest = lastNewline === -1 ? data : data.subarray(lastNewline + 1);
  const lines = lastNewline === -1 ? [] : complete.toString('utf8').split('\n');
  if (flush && tail.rest.length > 0) {
    lines.push(tail.rest.toString('utf8'));
    tail.rest = Buffer.alloc(0);
  }
  return lines;
}

function withAgent(event: ProgressEvent, path: string): ProgressEvent {
  return event.agent ? event : { ...event, agent: agentFromProgressFile(path) };
}

function stalledLine(summary: AgentProgressSummary, now: Date): string {
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

export interface WatchOptions extends SourceOptions {
  stallMs: number;
  intervalMs: number;
  once: boolean;
  replay: boolean;
}

/**
 * The watch loop. Existing lines feed the state silently (except with
 * `replay`); agents already failed / blocked / stalled at startup are
 * reported once. Later lines, and files that appear later, are streamed.
 */
export async function watchProgress(o: WatchOptions, deps: ProgressDeps): Promise<number> {
  const sources = resolveSources(o, deps.cwd());
  const tails = new Map<string, Tail>();
  const latest = new Map<string, ProgressEvent>();
  const reportedStalls = new Set<string>();
  let first = true;
  let sawNewEvent = false;
  for (;;) {
    const paths = listSources(sources);
    for (const path of paths) {
      let tail = tails.get(path);
      if (!tail) {
        if (!existsSync(path)) continue;
        tail = { offset: 0, rest: Buffer.alloc(0) };
        tails.set(path, tail);
      }
      for (const line of readNewLines(path, tail, o.once)) {
        const parsed = parseProgressLine(line);
        if (!parsed || parsed.status === 'stalled') continue;
        const event = withAgent(parsed, path);
        const prev = latest.get(event.agent!);
        if (!prev || Date.parse(event.ts) >= Date.parse(prev.ts)) latest.set(event.agent!, event);
        if (!first || o.replay) {
          deps.out(formatProgressEvent(event));
          sawNewEvent = true;
        }
      }
    }
    const now = deps.now();
    const summaries = summarizeProgress([...latest.values()], now, { stallMs: o.stallMs });
    for (const s of summaries) {
      const key = `${s.agent}\0${s.last.ts}\0${s.last.phase}\0${s.last.status}`;
      if (s.state === 'stalled' && !reportedStalls.has(key)) {
        reportedStalls.add(key);
        deps.out(stalledLine(s, now));
      } else if (first && !o.replay && (s.state === 'failed' || s.state === 'blocked')) {
        deps.out(formatProgressEvent(s.last));
      }
    }
    first = false;
    if (o.once) return 0;
    // A fixed file list waits for every file; a directory needs fresh activity, so old finished logs do not end a new watch.
    const everyFileSeen = sources.files ? sources.files.every((f) => tails.has(f)) : sawNewEvent;
    if (summaries.length > 0 && everyFileSeen && summaries.every((s) => s.state === 'done')) return 0;
    await deps.sleep(o.intervalMs);
  }
}

function readAllEvents(sources: Sources): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const path of listSources(sources)) {
    const tail: Tail = { offset: 0, rest: Buffer.alloc(0) };
    for (const line of readNewLines(path, tail, true)) {
      const parsed = parseProgressLine(line);
      if (parsed) events.push(withAgent(parsed, path));
    }
  }
  return events;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function guarded(deps: ProgressDeps, fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (error) {
    deps.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

export function progressCommand(overrides: Partial<ProgressDeps> = {}): Command {
  const deps: ProgressDeps = { ...defaultDeps, ...overrides };
  const cmd = new Command('progress');
  cmd.description('Agent progress events: emit phase events, watch them (stall detection) for the Monitor tool, show status');

  cmd
    .command('emit <phase> <status>')
    .description('Append one event (status: start|ok|fail|blocked|heartbeat|done) to $OMG_PROGRESS_FILE or <state root>/progress/<agent>.log')
    .option('--note <text>', 'Short note (quoted and escaped as needed; truncated at 500 chars)')
    .option('--agent <name>', 'Agent name (default $OMG_PROGRESS_AGENT, else "agent")')
    .option('--file <path>', 'Log file (wins over $OMG_PROGRESS_FILE)')
    .option('--field <key=value>', 'Extra key=value pair (repeatable)', collect, [])
    .action((phase: string, status: string, o: { note?: string; agent?: string; file?: string; field: string[] }) =>
      guarded(deps, () => {
        if (!isProgressStatus(status)) throw new UsageError(`status must be one of start|ok|fail|blocked|heartbeat|done, got ${JSON.stringify(status)}`);
        if (phase.trim().length === 0) throw new UsageError('phase must not be empty');
        const fields: Record<string, string> = {};
        for (const raw of o.field) {
          const eq = raw.indexOf('=');
          const key = eq === -1 ? '' : raw.slice(0, eq);
          if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || ['phase', 'status', 'note', 'agent'].includes(key)) {
            throw new UsageError(`--field must be key=value with a key like build_id (not phase/status/note/agent), got ${JSON.stringify(raw)}`);
          }
          fields[key] = raw.slice(eq + 1);
        }
        const ok = emitProgress({ phase, status, note: o.note, agent: o.agent, file: o.file, fields, at: deps.now(), cwd: deps.cwd() });
        if (!ok) deps.err('omg progress: could not write the progress event (continuing)');
        return 0;
      }));

  cmd
    .command('watch')
    .description('Stream new events and synthesized status=stalled lines (one per line); exits when every watched agent is done')
    .option('--file <path>', 'Watch this log (repeatable; may not exist yet)', collect, [])
    .option('--dir <path>', 'Watch every *.log in this directory, including files created later')
    .option('--stall <duration>', 'Silence after start/heartbeat/ok that counts as a stall (bare number = minutes)', '10m')
    .option('--interval <duration>', 'Poll interval (bare number = ms)', '1000')
    .option('--replay', 'Also print the events already in the logs')
    .option('--once', 'Read what exists, report it, and exit')
    .action((o: { file: string[]; dir?: string; stall: string; interval: string; replay?: boolean; once?: boolean }) =>
      guarded(deps, () => watchProgress({
        file: o.file,
        dir: o.dir,
        stallMs: parseStall(o.stall),
        intervalMs: parseInterval(o.interval),
        once: Boolean(o.once),
        replay: Boolean(o.replay),
      }, deps)));

  cmd
    .command('status')
    .description('Show each agent\'s latest event and state (running|stalled|failed|blocked|done)')
    .option('--file <path>', 'Read this log (repeatable)', collect, [])
    .option('--dir <path>', 'Read every *.log in this directory')
    .option('--stall <duration>', 'Stall threshold (bare number = minutes)', '10m')
    .option('--json', 'JSON output')
    .action((o: { file: string[]; dir?: string; stall: string; json?: boolean }) =>
      guarded(deps, () => {
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
        for (const r of rows) deps.out(r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd());
        return 0;
      }));

  return cmd;
}
