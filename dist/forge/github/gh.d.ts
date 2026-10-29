/**
 * The engine-grade gh calls of the GitHub adapter (factory forges design §2,
 * PR 2): a failed command or unparsable JSON throws GhCommandError with the
 * message the factory engine's own `run(..., 'gh')` / `ghJson` produced, so
 * the engine rethrows it as its step error unchanged.
 */
import type { Exec } from '../../ship/exec.js';
/** A gh command of an engine step failed, or printed no JSON. */
export declare class GhCommandError extends Error {
    constructor(message: string);
}
/** `gh <args>` in `cwd`; stdout, or GhCommandError naming the command and its first stderr line. */
export declare function ghRun(exec: Exec, args: string[], cwd: string): string;
/** ghRun, parsed as JSON (unvalidated: the caller checks the fields). */
export declare function ghJson<T>(exec: Exec, args: string[], cwd: string): T;
//# sourceMappingURL=gh.d.ts.map