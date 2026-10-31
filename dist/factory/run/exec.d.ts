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
 * - Tracker writes (`omg factory enqueue` only, when its TrackerWriteContext is
 *   set): `gh issue create`, `gh issue edit` (title, body, labels) and the
 *   `shipyard-key:` search `gh issue list --search`, each in one exact shape,
 *   pinned to the configured repository, with a body file from the caller's
 *   own directory (gh reads the guard's checked copy) and labels from its allowlist. Never close, delete,
 *   transfer or lock; without the context all three shapes are refused.
 * - Azure DevOps: `az devops invoke` on the routes.ts allowlist only, as the
 *   resolved az entry, for the run's forge repo (src/forge/ado/guard.ts).
 *   The work item create and the PATCH's item fields and links pass only with
 *   the TrackerWriteContext (shipyard-factory design PR 7b).
 * - The engine-owned prepare checkout: `git worktree add -B <its branch>
 *   <abs path> <sha40>` and `git merge --abort` (ship's prepare shapes run in it).
 * - Read-only git for the lane tamper check (review-guard.ts) and the review
 *   prompt's diff (no external diff driver, no textconv) and its standards
 *   files (`ls-tree` of docs/standards/ at the base commit).
 * - Every engine git command runs hardened (hardenedGitExec): no hooks and no
 *   fsmonitor, so a hook or fsmonitor a lane planted cannot run in the engine
 *   even if the tamper check missed it.
 */
import { type AdoGuardContext } from '../../forge/ado/guard.js';
import { ShipSafetyError, type Exec } from '../../ship/exec.js';
/** Every branch the factory pushes starts with this prefix (fixed, not configurable). */
export declare const FACTORY_BRANCH_PREFIX = "factory/";
export { MAX_TRACKER_BODY_CHARS } from '../../forge/body-file.js';
export declare class FactorySafetyError extends ShipSafetyError {
    constructor(message: string);
}
export declare const FOR_EACH_REF_FORMAT = "--format=%(refname) %(objectname)";
/**
 * What `omg factory enqueue` may write (shipyard-factory design §3.3, PR 7a).
 * Only a caller that sets it gets the tracker write shapes.
 */
export interface TrackerWriteContext {
    /** The configured forge repository as gh's `--repo` value (ghRepoArg, src/forge/github/gh.ts); every write names exactly it. */
    repo: string;
    /** Absolute directory the caller writes bodies into; `--body-file` must be a file directly in it. */
    bodyDir: string;
    /** Labels a write may add or remove (the intake label, `priority:p0`…`p3`); `factory:*` and `harbor:*` never pass. On Azure DevOps: the tags a new work item may carry. */
    labels: readonly string[];
    /** Azure DevOps: the work item types a create may name (factory.intake.itemTypes); none = no create. */
    itemTypes?: readonly string[];
}
/**
 * Throws FactorySafetyError unless the command is a factory shape or a
 * non-push, non-merge ship shape. `extraProtected` adds the run's base.
 * `az` and python go to the Azure DevOps guard (src/forge/ado/guard.ts),
 * which refuses them unless `ado` names the run's forge and az entry.
 * `writes` (enqueue only) adds the tracker write shapes.
 */
export declare function assertFactoryCommand(cmd: string, args: string[], extraProtected?: readonly string[], env?: Readonly<Record<string, string>>, ado?: AdoGuardContext, writes?: TrackerWriteContext): void;
/**
 * Wrap an Exec so every call passes assertFactoryCommand first; `extraProtected` is read per call.
 * An `az devops invoke` write runs with the guard's own copy of its validated --in-file body,
 * and a tracker write (gh issue create/edit) with the guard's own copy of its checked --body-file.
 * `writes` is set only by `omg factory enqueue`: the tracker write shapes pass while it returns a context.
 */
export declare function factoryGuardExec(exec: Exec, extraProtected?: () => readonly string[], ado?: () => AdoGuardContext | undefined, writes?: () => TrackerWriteContext | undefined): Exec;
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