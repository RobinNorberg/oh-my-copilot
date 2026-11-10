/**
 * The one GraphQL read of the GitHub forge (factory night 3, goal 2): the
 * human review input on one pull request. The factory guards refuse every
 * `gh api` except this exact argv (reviewFeedbackArgs): the query text is the
 * constant below, the repository is the configured one, the PR a number.
 *
 * Trust (decision D3): a reviewer counts when their login is in
 * `factory.review.trustedReviewers`, or when the same query reports write
 * access or more for them (the repository's first 100 collaborators, and the
 * viewer's own permission). Only a User author can be trusted that way; a Bot
 * counts only when the list names it as `<slug>[bot]`. Anyone else's review,
 * comment or thread reply is dropped and their login listed in `ignored`.
 * Bodies are returned as untrusted data: nothing here reads meaning into them.
 *
 * Fail closed: every list carries pageInfo, and a list with more entries than
 * one read returns throws ReviewFeedbackTruncatedError; a head other than the
 * PR's throws ReviewHeadMovedError; a partial answer is accepted only when
 * every error is about the collaborator list (then `trustIncomplete`).
 */
import type { ForgeRepo, ForgeReviewFeedback } from '../types.js';
/**
 * The query, one line (no argv newline on any platform). `owner` and `name`
 * go in as raw strings (`-f`, never gh's `@file` form), `number` as an integer (`-F`).
 */
export declare const REVIEW_FEEDBACK_QUERY: string;
/** One thread or review body handed on, at most (the fix prompt fences it). */
export declare const MAX_FEEDBACK_BODY_CHARS = 8000;
/** `gh` argv of the read for `pr` on `repo`. Throws on names the guard would refuse. */
export declare function reviewFeedbackArgs(repo: Pick<ForgeRepo, 'host' | 'owner' | 'name'>, pr: number): string[];
/**
 * The guard clause shared by the run and read guards: `args` is exactly
 * reviewFeedbackArgs for the repository `repoArg` (ghRepoArg:
 * `HOST/OWNER/NAME`) and some PR number. Names compare case-insensitively,
 * as GitHub resolves them. Without a repository context it is refused.
 */
export declare function isReviewFeedbackArgs(args: readonly string[], repoArg: string | undefined): boolean;
/** Who counts as a human reviewer for one read. */
export interface ReviewTrust {
    /** `factory.review.trustedReviewers` (trusted config layers only), any case. */
    trustedReviewers: readonly string[];
}
/** A gh / GraphQL rate-limit answer (poll backs off on it, as on ADO_RATE_LIMITED). */
export declare const GITHUB_RATE_LIMITED: RegExp;
/** A body the factory posted (its hidden marker as the last line): never human input. */
export declare function isFactoryComment(body: string): boolean;
/**
 * The feedback in one GraphQL response (stdout of reviewFeedbackArgs, the gh
 * exit status beside it) for `pr` at `head`. Throws when the response carries
 * no pull request (an unknown PR, a failed query), a list is missing or
 * truncated, an error is not about the collaborator list, or `head` is not the
 * PR's head. A review body counts as a thread only when the review was
 * submitted on `head` (an older head's summary was answered by a later push);
 * inline threads count while unresolved (an outdated one flagged `outdated`).
 * A CHANGES_REQUESTED stands until the same author approves or it is
 * dismissed: a later COMMENTED review does not clear it.
 */
export declare function parseReviewFeedback(stdout: string, pr: number, head: string, trust: ReviewTrust, exitStatus?: number): ForgeReviewFeedback;
//# sourceMappingURL=graphql.d.ts.map