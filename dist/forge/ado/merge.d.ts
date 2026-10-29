/**
 * ForgeMerge on Azure Repos (factory forges design §6, §8.4): the merge
 * decision from branch policies, for a human to read, and the merge command
 * a human runs. Nothing here merges: the guard refuses a PR body with
 * `status`, `completionOptions` or `autoCompleteSetBy`, so the printed
 * command cannot run through the factory.
 *
 * The printed command reads its body from a file the engine writes
 * (adoMergeBody, mode 0600) at an ABSOLUTE path in the engine-owned state
 * directory, outside every untrusted root: a relative path would resolve
 * against wherever the human stands, and a lane could have committed a body
 * there (completionOptions.bypassPolicy, say).
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
export interface AdoMergeOptions {
    /** Engine-owned directory for the merge body (ForgeOptions.stateDir). */
    stateDir: string;
    /** Roots a lane or job can write; the body file must be outside every one. */
    untrustedRoots: readonly string[];
}
/**
 * Why `dir` (already resolved) may not hold the merge body, or undefined: it
 * must be a directory, and on POSIX owned by this user and not writable
 * by group or others, so nobody else can swap the body between the write
 * and the human's run. Windows modes carry no ACL information; there the
 * untrusted-root check is the guard.
 */
export declare function mergeBodyDirProblem(dir: string, platform?: NodeJS.Platform): string | undefined;
/** Write the head-pinned body for `pr` and return its absolute path. */
export declare function writeAdoMergeBody(ctx: Pick<AdoContext, 'repo'>, o: AdoMergeOptions, pr: number, headSha: string): string;
export declare function adoMerge(ctx: AdoContext, o: AdoMergeOptions): ForgeMerge;
//# sourceMappingURL=merge.d.ts.map