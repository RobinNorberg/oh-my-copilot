/**
 * Recording seams for the gh argv-parity baseline (factory forges design §A.6):
 * every external command a code path issues is kept as one line,
 * `<cmd> <argv as JSON>` plus the options that reach the child (cwd, the env
 * keys added on top of the scrubbed environment, stdin). Temporary directories
 * are replaced by placeholders so the lines are stable across machines.
 */
import type { Exec } from '../../ship/exec.js';
/** Placeholder name -> the directory it stands for, e.g. `{ '<root>': h.root }`. */
export type Placeholders = Readonly<Record<string, string>>;
/** A value naming a placeholder directory gets the placeholder and `/` separators; any other value is kept as is. */
export declare function normalize(value: string, places: Placeholders): string;
export interface CallOpts {
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
    input?: string;
}
/** One recorded call as a single line. */
export declare function callLine(cmd: string, args: readonly string[], opts: CallOpts | undefined, places?: Placeholders): string;
/**
 * Wrap `inner` so every call is recorded before it runs. `only` limits the
 * record to those commands (the forge move touches gh; git and node stay put).
 */
export declare function recordingExec(inner: Exec, places?: Placeholders, only?: readonly string[]): {
    exec: Exec;
    calls: string[];
};
//# sourceMappingURL=recording-exec.d.ts.map