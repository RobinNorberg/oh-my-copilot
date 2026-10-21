/**
 * Agent progress events: agents push one line per phase boundary so a lead
 * (or `omg progress watch` under Claude Code's Monitor tool) learns about
 * progress, failures and stalls without polling the agents.
 *
 * Contract (one event per line, append-only, UTF-8, `\n`-terminated):
 *
 *   <ISO-8601 UTC> phase=<id> status=<status> [note=<v>] [agent=<v>] [k=v ...]
 *
 * - status: start | ok | fail | blocked | heartbeat | done (writers);
 *   `stalled` is synthesized by readers only, never written to a log.
 * - Keys match KEY_RE. A value matching BARE_VALUE_RE is written bare;
 *   anything else (spaces, quotes, `=`, empty, non-ASCII) is double-quoted
 *   with `\\`, `\"`, `\n`, `\r`, `\t` escaped. Readers also accept bare
 *   values with other non-space characters (hand-written `echo` lines).
 * - Location: `$OMG_PROGRESS_FILE` when set, else
 *   `<getOmcRoot()>/progress/<agent>.log`. The agent name defaults to the
 *   file's basename when a line has no `agent=`.
 *
 * Evidence by contract (like the run ledger): emitting never throws into the
 * caller; a broken progress log must never break the work it reports on.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getOmcRoot } from './worktree-paths.js';

export const PROGRESS_STATUSES = ['start', 'ok', 'fail', 'blocked', 'heartbeat', 'done'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
/** What a reader may see: the written statuses plus the synthesized `stalled`. */
export type ProgressEventStatus = ProgressStatus | 'stalled';

export const PROGRESS_FILE_ENV = 'OMG_PROGRESS_FILE';
export const PROGRESS_AGENT_ENV = 'OMG_PROGRESS_AGENT';
/** A log above this size is renamed to `<file>.1` (replacing the previous one) before the next append (best effort under concurrent writers). */
export const PROGRESS_MAX_BYTES = 1024 * 1024;
/** Notes are truncated to this many code points so one event stays one small write. */
export const PROGRESS_MAX_NOTE = 500;
/** Phases and extra field values are truncated to this many code points. */
export const PROGRESS_MAX_VALUE = 200;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const BARE_VALUE_RE = /^[A-Za-z0-9._:/@+,%#~-]+$/;
const RESERVED_KEYS = new Set(['phase', 'status', 'note', 'agent']);

export interface ProgressEvent {
  /** ISO-8601 UTC timestamp as written. */
  ts: string;
  phase: string;
  status: ProgressEventStatus;
  note?: string;
  agent?: string;
  /** Extra `k=v` pairs, in line order. */
  fields: Record<string, string>;
}

export interface EmitProgressInput {
  phase: string;
  status: ProgressStatus;
  note?: string;
  agent?: string;
  /** Explicit log path; wins over OMG_PROGRESS_FILE and the default location. */
  file?: string;
  fields?: Record<string, string | number | boolean>;
  /** Event time (default: now). */
  at?: Date;
  /** Directory whose state root holds the default log (default: process.cwd()). */
  cwd?: string;
}

export function isProgressStatus(value: string): value is ProgressStatus {
  return (PROGRESS_STATUSES as readonly string[]).includes(value);
}

function quoteValue(value: string): string {
  if (BARE_VALUE_RE.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Serialize one event in the canonical form (no trailing newline). */
export function formatProgressEvent(event: Omit<ProgressEvent, 'fields'> & { fields?: Record<string, string> }): string {
  const parts = [event.ts, `phase=${quoteValue(event.phase)}`, `status=${event.status}`];
  if (event.note !== undefined) parts.push(`note=${quoteValue(event.note)}`);
  if (event.agent !== undefined) parts.push(`agent=${quoteValue(event.agent)}`);
  for (const [key, value] of Object.entries(event.fields ?? {})) {
    if (KEY_RE.test(key) && !RESERVED_KEYS.has(key)) parts.push(`${key}=${quoteValue(value)}`);
  }
  return parts.join(' ');
}

/** Parse one line; null for blank, malformed, or unknown-status lines. */
export function parseProgressLine(line: string): ProgressEvent | null {
  const text = line.replace(/\r$/, '');
  const tsMatch = /^(\d{4}-\d{2}-\d{2}T\S*)/.exec(text);
  if (!tsMatch || !Number.isFinite(Date.parse(tsMatch[1]))) return null;
  const pairs: Array<[string, string]> = [];
  let i = tsMatch[1].length;
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i >= text.length) break;
    const keyMatch = /^([A-Za-z][A-Za-z0-9_.-]*)=/.exec(text.slice(i));
    if (!keyMatch) return null;
    i += keyMatch[0].length;
    let value = '';
    if (text[i] === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
          const next = text[i + 1];
          value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
          i += 2;
        } else if (ch === '"') {
          i++;
          closed = true;
          break;
        } else {
          value += ch;
          i++;
        }
      }
      if (!closed || (i < text.length && text[i] !== ' ' && text[i] !== '\t')) return null;
    } else {
      const end = text.slice(i).search(/[ \t]/);
      value = end === -1 ? text.slice(i) : text.slice(i, i + end);
      i += value.length;
    }
    pairs.push([keyMatch[1], value]);
  }
  const get = (key: string): string | undefined => pairs.find(([k]) => k === key)?.[1];
  const phase = get('phase');
  const status = get('status');
  if (!phase || !status || !(isProgressStatus(status) || status === 'stalled')) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of pairs) if (!RESERVED_KEYS.has(k)) fields[k] = v;
  const event: ProgressEvent = { ts: tsMatch[1], phase, status, fields };
  const note = get('note');
  const agent = get('agent');
  if (note !== undefined) event.note = note;
  if (agent !== undefined) event.agent = agent;
  return event;
}

/** Parse a whole log; malformed lines are skipped. */
export function parseProgressLog(text: string): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const line of text.split('\n')) {
    const event = parseProgressLine(line);
    if (event) events.push(event);
  }
  return events;
}

/** A name safe as a file basename on every platform. */
export function progressAgentFileName(agent: string): string {
  return `${agent.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'agent'}.log`;
}

/** The agent a log file belongs to when its lines carry no `agent=`. */
export function agentFromProgressFile(file: string): string {
  return basename(file).replace(/\.log$/, '');
}

/** `<state root>/progress` for the project containing cwd. */
export function defaultProgressDir(cwd: string = process.cwd()): string {
  return join(getOmcRoot(cwd), 'progress');
}

/** Where emitProgress writes: explicit file, then OMG_PROGRESS_FILE, then the default per-agent log. */
export function resolveProgressFile(agent: string, file?: string, cwd?: string): string {
  return file || process.env[PROGRESS_FILE_ENV] || join(defaultProgressDir(cwd), progressAgentFileName(agent));
}

/** At most `max` code points, so a cut never splits a surrogate pair. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : Array.from(value).slice(0, max).join('');
}

/**
 * Best effort against concurrent writers: the full log is first claimed under
 * a unique name, so a writer that lost the race (and claimed the winner's
 * fresh small log instead) puts it back rather than clobbering `<file>.1`.
 * A lost race can still reorder lines; it never drops them.
 */
function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < PROGRESS_MAX_BYTES) return;
    const claimed = `${path}.${process.pid}.${Date.now()}.rotating`;
    renameSync(path, claimed);
    if (statSync(claimed).size >= PROGRESS_MAX_BYTES) {
      renameSync(claimed, `${path}.1`);
    } else if (!existsSync(path)) {
      renameSync(claimed, path);
    } else {
      appendFileSync(path, readFileSync(claimed));
      unlinkSync(claimed);
    }
  } catch {
    // missing file or a racing rotation: the append below still works
  }
}

/**
 * Append one event. Returns true when the line was written; never throws.
 * One `appendFileSync` of one short line keeps concurrent writers from
 * interleaving within a line on local filesystems.
 */
export function emitProgress(input: EmitProgressInput): boolean {
  try {
    if (!input || typeof input.phase !== 'string' || input.phase.length === 0 || !isProgressStatus(input.status)) return false;
    const agent = input.agent || process.env[PROGRESS_AGENT_ENV] || undefined;
    const path = resolveProgressFile(agent ?? 'agent', input.file, input.cwd);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields ?? {})) fields[k] = truncate(String(v), PROGRESS_MAX_VALUE);
    const line = formatProgressEvent({
      ts: (input.at ?? new Date()).toISOString(),
      phase: truncate(input.phase, PROGRESS_MAX_VALUE),
      status: input.status,
      note: input.note === undefined ? undefined : truncate(input.note, PROGRESS_MAX_NOTE),
      agent,
      fields,
    });
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export type AgentProgressState = 'running' | 'stalled' | 'failed' | 'blocked' | 'done';

export interface AgentProgressSummary {
  agent: string;
  last: ProgressEvent;
  state: AgentProgressState;
  /** Milliseconds since the last event (never negative). */
  idleMs: number;
}

export interface StallOptions {
  /** Silence after `start` / `heartbeat` / `ok` longer than this is a stall. */
  stallMs: number;
}

/**
 * Classify an agent by its latest event: `done` ends it, `fail` / `blocked`
 * surface at once, and `start` / `heartbeat` / `ok` older than stallMs is a
 * stall (`ok` closes a phase, so the next `start` or `done` is due).
 */
export function classifyProgress(last: ProgressEvent, now: Date, opts: StallOptions): { state: AgentProgressState; idleMs: number } {
  const idleMs = Math.max(0, now.getTime() - Date.parse(last.ts));
  switch (last.status) {
    case 'done':
      return { state: 'done', idleMs };
    case 'fail':
      return { state: 'failed', idleMs };
    case 'blocked':
      return { state: 'blocked', idleMs };
    default:
      return { state: idleMs > opts.stallMs ? 'stalled' : 'running', idleMs };
  }
}

/**
 * Latest event per agent (by timestamp; a later line wins a tie), classified.
 * `stalled` events from a reader's own output are ignored.
 */
export function summarizeProgress(
  events: Array<ProgressEvent & { source?: string }>,
  now: Date,
  opts: StallOptions,
): AgentProgressSummary[] {
  const latest = new Map<string, ProgressEvent>();
  for (const event of events) {
    if (event.status === 'stalled') continue;
    const agent = event.agent ?? (event.source ? agentFromProgressFile(event.source) : 'agent');
    const prev = latest.get(agent);
    if (!prev || Date.parse(event.ts) >= Date.parse(prev.ts)) latest.set(agent, event);
  }
  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, last]) => ({ agent, last, ...classifyProgress(last, now, opts) }));
}

/** `10m`, `90s`, `1h`, `500ms`; a bare number is in `defaultUnit`. Returns ms, or null when invalid. */
export function parseProgressDuration(raw: string, defaultUnit: 'ms' | 's' | 'm' | 'h' = 'm'): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) return null;
  const unit = match[2] ?? defaultUnit;
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Number(match[1]) * factor;
}

/** `45s`, `12m`, `3h5m` — compact idle time for notes and tables. */
export function formatProgressDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}
