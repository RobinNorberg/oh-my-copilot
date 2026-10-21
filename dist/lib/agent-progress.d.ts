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
export declare const PROGRESS_STATUSES: readonly ["start", "ok", "fail", "blocked", "heartbeat", "done"];
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
/** What a reader may see: the written statuses plus the synthesized `stalled`. */
export type ProgressEventStatus = ProgressStatus | 'stalled';
export declare const PROGRESS_FILE_ENV = "OMG_PROGRESS_FILE";
export declare const PROGRESS_AGENT_ENV = "OMG_PROGRESS_AGENT";
/** A log above this size is renamed to `<file>.1` (replacing the previous one) before the next append. */
export declare const PROGRESS_MAX_BYTES: number;
/** Notes are truncated to this many characters so one event stays one small write. */
export declare const PROGRESS_MAX_NOTE = 500;
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
export declare function isProgressStatus(value: string): value is ProgressStatus;
/** Serialize one event in the canonical form (no trailing newline). */
export declare function formatProgressEvent(event: Omit<ProgressEvent, 'fields'> & {
    fields?: Record<string, string>;
}): string;
/** Parse one line; null for blank, malformed, or unknown-status lines. */
export declare function parseProgressLine(line: string): ProgressEvent | null;
/** Parse a whole log; malformed lines are skipped. */
export declare function parseProgressLog(text: string): ProgressEvent[];
/** A name safe as a file basename on every platform. */
export declare function progressAgentFileName(agent: string): string;
/** The agent a log file belongs to when its lines carry no `agent=`. */
export declare function agentFromProgressFile(file: string): string;
/** `<state root>/progress` for the project containing cwd. */
export declare function defaultProgressDir(cwd?: string): string;
/** Where emitProgress writes: explicit file, then OMG_PROGRESS_FILE, then the default per-agent log. */
export declare function resolveProgressFile(agent: string, file?: string, cwd?: string): string;
/**
 * Append one event. Returns true when the line was written; never throws.
 * One `appendFileSync` of one short line keeps concurrent writers from
 * interleaving within a line on local filesystems.
 */
export declare function emitProgress(input: EmitProgressInput): boolean;
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
export declare function classifyProgress(last: ProgressEvent, now: Date, opts: StallOptions): {
    state: AgentProgressState;
    idleMs: number;
};
/**
 * Latest event per agent (by timestamp; a later line wins a tie), classified.
 * `stalled` events from a reader's own output are ignored.
 */
export declare function summarizeProgress(events: Array<ProgressEvent & {
    source?: string;
}>, now: Date, opts: StallOptions): AgentProgressSummary[];
/** `10m`, `90s`, `1h`, `500ms`; a bare number is in `defaultUnit`. Returns ms, or null when invalid. */
export declare function parseProgressDuration(raw: string, defaultUnit?: 'ms' | 's' | 'm' | 'h'): number | null;
/** `45s`, `12m`, `3h5m` — compact idle time for notes and tables. */
export declare function formatProgressDuration(ms: number): string;
//# sourceMappingURL=agent-progress.d.ts.map