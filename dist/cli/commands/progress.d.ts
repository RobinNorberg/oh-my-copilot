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
export declare function watchProgress(o: WatchOptions, deps: ProgressDeps): Promise<number>;
export declare function progressCommand(overrides?: Partial<ProgressDeps>): Command;
export {};
//# sourceMappingURL=progress.d.ts.map