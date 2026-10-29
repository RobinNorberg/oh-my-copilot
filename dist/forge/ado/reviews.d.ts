/**
 * ForgeReviews on Azure Repos (factory forges design §6): pull requests
 * through `git/pullRequests`, comments as new threads. The factory only
 * opens drafts and only flips isDraft to false; the guard refuses any other
 * PR body (a merge in particular).
 */
import type { ForgeReviews } from '../types.js';
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
export declare function readAdoPr(ctx: AdoContext, pr: number): AdoPrView;
export declare function adoReviews(ctx: AdoContext): ForgeReviews;
//# sourceMappingURL=reviews.d.ts.map