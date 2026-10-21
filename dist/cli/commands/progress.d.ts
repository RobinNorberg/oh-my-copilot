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
export interface ProgressDeps {
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    /** One complete output line (no trailing newline). */
    out: (line: string) => void;
    err: (line: string) => void;
    cwd: () => string;
}
interface SourceOptions {
    file: string[];
    dir?: string;
}
export type WatchUntil = 'done' | 'settled';
export interface WatchOptions extends SourceOptions {
    stallMs: number;
    intervalMs: number;
    once: boolean;
    replay: boolean;
    /** `done`: every tracked agent's latest event is `done`; `settled`: `done`, `fail` or `blocked`. */
    until: WatchUntil;
    /** Existing events at or after this time (epoch ms) count as new for exiting. */
    sinceMs?: number;
    /** Agents the watch waits for, even before their logs exist. */
    agents: string[];
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
export declare function watchProgress(o: WatchOptions, deps: ProgressDeps): Promise<number>;
export declare function progressCommand(overrides?: Partial<ProgressDeps>): Command;
export {};
//# sourceMappingURL=progress.d.ts.map