/**
 * The `omg factory run` command guard: ship's allowlist (src/ship/exec.ts)
 * extended with the exact shapes the factory engine builds (design §4).
 *
 * - Pushes: only `git push origin <sha40>:refs/heads/factory/<name>`, plain
 *   (no `+`, no flags), never a protected branch. Ship's `HEAD:refs/heads/<b>`
 *   push shape is refused here: the factory pushes nothing else.
 * - GitHub: `gh issue view|comment`, `gh pr create --draft|comment|list|ready`
 *   and `gh repo view --json url` (ci-heal runs) in fixed shapes, plus ship's
 *   `gh pr view|checks` and `gh run list|view|rerun`.
 *   Never `gh api`, `gh -R`, or a merge (merge is always human).
 * - The engine-owned prepare checkout: `git worktree add -B <its branch>
 *   <abs path> <sha40>` and `git merge --abort` (ship's prepare shapes run in it).
 * - Read-only git for the lane tamper check (review-guard.ts) and the review
 *   prompt's diff (no external diff driver, no textconv).
 * - Every engine git command runs hardened (hardenedGitExec): no hooks and no
 *   fsmonitor, so a hook or fsmonitor a lane planted cannot run in the engine
 *   even if the tamper check missed it.
 */
import { ShipSafetyError, type Exec } from '../../ship/exec.js';
/** Every branch the factory pushes starts with this prefix (fixed, not configurable). */
export declare const FACTORY_BRANCH_PREFIX = "factory/";
export declare class FactorySafetyError extends ShipSafetyError {
    constructor(message: string);
}
export declare const FOR_EACH_REF_FORMAT = "--format=%(refname) %(objectname)";
/**
 * Throws FactorySafetyError unless the command is a factory shape or a
 * non-push, non-merge ship shape. `extraProtected` adds the run's base.
 */
export declare function assertFactoryCommand(cmd: string, args: string[], extraProtected?: readonly string[], env?: Readonly<Record<string, string>>): void;
/** Wrap an Exec so every call passes assertFactoryCommand first; `extraProtected` is read per call. */
export declare function factoryGuardExec(exec: Exec, extraProtected?: () => readonly string[]): Exec;
/** Prepended to every hardened git command, after the guard checked the plain shape. */
export declare function gitHardeningArgs(hooksDir: string): string[];
/**
 * Run git with `core.hooksPath` set to an engine-owned empty directory and
 * `core.fsmonitor=false`, so no hook (pre-push, post-checkout,
 * reference-transaction) and no fsmonitor command runs in the engine.
 * Refuses when the hooks directory is missing or not empty. Other commands
 * pass through unchanged. Wrap it INSIDE factoryGuardExec, so the guard sees
 * the plain shape.
 *
 * The system and global config stay. GIT_CONFIG_NOSYSTEM is not set: Git for
 * Windows keeps `credential.helper` and `core.autocrlf` in the system config,
 * so pushes would lose their credentials and every CRLF checkout would read
 * as modified, and `credential.helper` cannot be blanked either (pushes need
 * the credential manager). The system config needs admin rights to write;
 * the global one and every file a config includes are hashed into the lane
 * snapshot instead (review-guard.ts), so a lane that plants a helper,
 * sshCommand, pushInsteadOf or clean filter there parks the run.
 */
export declare function hardenedGitExec(exec: Exec, hooksDir: string): Exec;
//# sourceMappingURL=exec.d.ts.map