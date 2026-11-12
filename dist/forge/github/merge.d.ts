/**
 * The GitHub merge command (factory forges design §2, PR 2), moved from
 * src/ship/merge.ts mergeCommand. A human runs it; `omg ship merge` alone may
 * run it, the factory guard refuses `gh pr merge` outright.
 *
 * The factory's opt-in auto-merge (src/factory/run/auto-merge.ts) is the one
 * engine merge: the REST merge pinned to the head sha (GitHub answers 409 when
 * the head moved), admitted by the factory guard only inside the engine's
 * auto-merge step for exactly that repository, PR and sha.
 */
import type { ForgeMerge } from '../types.js';
/** `gh pr merge <pr> --admin --merge --match-head-commit <sha>`: merges exactly the head the gates checked. */
export declare function ghMergeCommand(pr: number, headSha: string): string[];
/** GitHub has no branch-policy inputs beyond the gates and ship's merge rule. */
export declare function githubMerge(): ForgeMerge;
/** The step the engine is merging in: the run's repository (ghRepoArg `HOST/OWNER/NAME`), PR and head. */
export interface GithubAutoMergeStep {
    repo: string;
    pr: number;
    head: string;
}
/**
 * The gh argv of the engine's auto-merge: `PUT repos/O/N/pulls/<pr>/merge`
 * with `sha` = the head (no admin bypass: branch protection still applies)
 * and a merge commit. Undefined for anything not exactly well-formed.
 */
export declare function githubAutoMergeArgs(step: GithubAutoMergeStep): string[] | undefined;
/** The factory guard's test: exactly githubAutoMergeArgs of the engine's current step; no step = refused. */
export declare function isGithubAutoMergeArgs(args: readonly string[], step: GithubAutoMergeStep | undefined): boolean;
//# sourceMappingURL=merge.d.ts.map