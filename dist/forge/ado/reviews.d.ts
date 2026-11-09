/**
 * ForgeReviews on Azure Repos (factory forges design §6): pull requests
 * through `git/pullRequests`, comments as new threads. The factory only
 * opens drafts and only flips isDraft to false; the guard refuses any other
 * PR body (a merge in particular).
 */
import type { ForgeReviewFeedback, ForgeReviews, ForgeThread } from '../types.js';
import { type AdoContext } from './invoke.js';
/** REST `description` limit on a pull request. */
export declare const ADO_PR_DESCRIPTION_MAX = 4000;
/** The pull request fields the adapter reads, from `git/pullRequests/{id}`. */
export interface AdoPrView {
    id: number;
    status: string;
    isDraft: boolean;
    sourceRefName: string;
    targetRefName: string;
    /** PR head the forge last saw (lags a push by seconds). */
    lastMergeSourceCommit?: string;
    lastMergeTargetCommit?: string;
    /** The merge commit PR builds run on (refs/pull/{id}/merge). */
    lastMergeCommit?: string;
    mergeStatus?: string;
    /** Project GUID, for the policy artifact id. */
    projectId?: string;
}
/**
 * The hidden last line of every PR comment the factory posts on Azure Repos
 * (an HTML comment, not rendered): `omg factory poll` leaves those threads out
 * of its human thread count. A person who pastes it only hides their own thread.
 */
export declare const ADO_FACTORY_COMMENT_MARKER = "<!-- omg-factory: comment -->";
export declare function readAdoPr(ctx: AdoContext, pr: number): AdoPrView;
/** The PR's threads (Pull Request Threads - List), deleted ones left out; a thread without a numeric id fails the read. */
export declare function parseAdoThreads(json: unknown, pr: number): ForgeThread[];
/**
 * The human review input on one PR (ForgeReviews.reviewFeedback) from its
 * reviewers (Pull Requests - Get By Id) and threads (Pull Request Threads -
 * List). Trust is the given list (the caller passes `factory.review.trustedReviewers`
 * and the user-config trustedAuthors; uniqueNames, any case): Azure DevOps has no permission read the guard allows.
 * - decisions: each trusted reviewer's non-zero vote (10/5 approved, -5
 *   waiting for author and -10 rejected are changes-requested). A vote carries
 *   no time or commit; whether it survives a push is the branch policy's
 *   "reset votes" setting, so `at` is '' and `head` absent.
 * - threads: active or pending text threads with the trusted authors' text
 *   comments; the factory's own comments (marker) and deleted ones are
 *   dropped, so a trusted reply inside a factory-started thread still counts
 *   (its first trusted comment names the thread).
 * - head: `head` must be the PR's lastMergeSourceCommit, else
 *   ReviewHeadMovedError (the feedback would describe another commit).
 * - pendingReviewers: required reviewers who have not voted or declined.
 */
export declare function parseAdoReviewFeedback(prJson: unknown, threadsJson: unknown, pr: number, head: string, trustedReviewers: readonly string[]): ForgeReviewFeedback;
/** `review.trustedReviewers`: whose votes and comments reviewFeedback hands on (src/forge/config.ts, trusted layers only). */
export declare function adoReviews(ctx: AdoContext, review?: {
    trustedReviewers: readonly string[];
}): ForgeReviews;
//# sourceMappingURL=reviews.d.ts.map