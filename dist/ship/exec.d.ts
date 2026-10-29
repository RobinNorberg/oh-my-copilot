/**
 * Command runner for `omg ship` plus the safety guard every engine command
 * passes through. The engine never runs a shell: each command is an argv
 * array, and `guardExec` refuses anything outside an allowlist of the exact
 * command shapes the engine builds before anything spawns.
 */
import { type AdoGuardContext } from '../forge/ado/guard.js';
export interface ExecResult {
    status: number;
    stdout: string;
    stderr: string;
}
export interface ExecOptions {
    cwd?: string;
    /**
     * Variables added on top of the scrubbed environment (scrubShipEnv). The
     * guard permits only TRUSTED_READ_ENV, and only for git.
     */
    env?: Readonly<Record<string, string>>;
}
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => ExecResult;
export declare class ShipSafetyError extends Error {
    constructor(message: string);
}
/**
 * Environment of every trusted read (base-branch config, known-flaky list,
 * changed-file list): `git replace` refs are ignored, so a lane's
 * `git replace <blob> <evil>` in the shared object store cannot swap content.
 */
export declare const TRUSTED_READ_ENV: Readonly<Record<string, string>>;
/**
 * The environment every engine child runs with: the parent's, minus the
 * variables above, plus GIT_NO_REPLACE_OBJECTS=1 (no command the engine runs,
 * a merge included, may see replaced objects). `omg release`
 * (src/release/engine.ts) runs every child under it too, node scripts
 * included; only its vitest suite keeps the caller's environment. Keys compare case-insensitively
 * (Windows environment names are). This narrows what a mis-set environment can
 * do; it is not a boundary against a process that controls the environment
 * outright (PATH can name another `git`), see the trust note in ship.ts.
 */
export declare function scrubShipEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare const defaultExec: Exec;
/** Branches the guard never pushes to, whatever the caller asks (the run's base is added per call). */
export declare const PROTECTED_BRANCHES: readonly string[];
/**
 * Throws ShipSafetyError unless the command is one of the shapes the engine
 * builds (allowlist, not denylist): plain `git` / `gh` / `node` binaries
 * (`.exe` allowed, `.cmd` / `.bat` shims and npm refused), the subcommand
 * first (no global options), every operand non-option-shaped. Consequently
 * rebase, pull, forced or deleting pushes, pushes to PROTECTED_BRANCHES or
 * `extraProtected` (the run's base), worktree add/remove, reset, amend,
 * squash/rebase/auto merges, `gh api`, `gh -R` and any npm command never spawn.
 * `env` (ExecOptions.env) may only be TRUSTED_READ_ENV on a git command.
 */
export declare function assertSafeCommand(cmd: string, args: string[], extraProtected?: readonly string[], env?: Readonly<Record<string, string>>): void;
/**
 * Wrap an Exec so every call is checked by assertSafeCommand first.
 * `extraProtected` is read per call (the CLI sets it to the run's base once known).
 * `az` and python go to the Azure DevOps guard (src/forge/ado/guard.ts) with
 * the ship policy: reads and the build-evaluation requeue, for `ado`'s forge
 * only; without `ado` they are refused.
 */
export declare function guardExec(exec: Exec, extraProtected?: () => readonly string[], ado?: () => AdoGuardContext | undefined): Exec;
//# sourceMappingURL=exec.d.ts.map