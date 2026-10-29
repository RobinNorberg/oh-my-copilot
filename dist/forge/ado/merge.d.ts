/**
 * ForgeMerge on Azure Repos (factory forges design §6, §8.4): the merge
 * decision from branch policies, for a human to read, and the merge command
 * a human runs. Nothing here merges: the guard refuses a PR body with
 * `status`, `completionOptions` or `autoCompleteSetBy`, so the printed
 * command cannot run through the factory.
 */
import type { ForgeMerge } from '../types.js';
import { type AdoContext } from './invoke.js';
/** The completion body a human sends: ADO rejects a stale lastMergeSourceCommit, the analogue of --match-head-commit. */
export declare function adoMergeBody(headSha: string): {
    status: 'completed';
    lastMergeSourceCommit: {
        commitId: string;
    };
    completionOptions: {
        mergeStrategy: 'noFastForward';
    };
};
/** The file name the printed merge command reads its body from. */
export declare const adoMergeBodyFile: (pr: number) => string;
export declare function adoMerge(ctx: AdoContext): ForgeMerge;
//# sourceMappingURL=merge.d.ts.map