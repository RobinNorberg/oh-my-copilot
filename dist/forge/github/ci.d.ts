/**
 * GitHub Actions history for `omg factory heal` (factory forges design §2,
 * PR 2): the `gh run list` / `gh run view` reads moved verbatim from
 * src/factory/heal/history.ts, which re-exports these names. healGuardExec
 * still allows only these shapes.
 */
import type { Exec } from '../../ship/exec.js';
import type { HealJob, HealRun } from '../../factory/heal/history.js';
import type { ForgeCi } from '../types.js';
export declare const RUN_LIST_FIELDS = "databaseId,conclusion,status,headSha,headBranch,event,createdAt";
export declare function parseRunList(stdout: string): HealRun[];
export declare function listRuns(exec: Exec, opts: {
    workflow: string;
    event: 'push' | 'pull_request';
    branch?: string;
    limit: number;
    cwd?: string;
}): HealRun[];
export declare function parseRunJobs(stdout: string): HealJob[];
export declare function viewRunJobs(exec: Exec, runId: string, cwd?: string): HealJob[];
/** A job's log, capped (capLog) before anything parses it. */
export declare function jobLog(exec: Exec, jobId: string, cwd?: string): string;
/** The rerun heal records for a human; healGuardExec refuses it and omg never issues it. */
export declare const githubRerunIntent: (runId: string) => string;
export declare function githubCi(exec: Exec, cwd?: string): ForgeCi;
//# sourceMappingURL=ci.d.ts.map