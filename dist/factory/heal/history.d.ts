/**
 * Read-only GitHub and git access for `omg factory heal` through an injected
 * Exec. healGuardExec allows only the fixed read shapes below; PR 1 issues no
 * GitHub write (a rerun is recorded as an intent, never run), so `gh run
 * rerun`, `gh api` and every other command are refused before they spawn.
 */
import type { Exec } from '../../ship/exec.js';
import { ShipSafetyError } from '../../ship/exec.js';
import { RUN_LIST_FIELDS } from '../../forge/github/ci.js';
export { RUN_LIST_FIELDS };
export declare class HealSafetyError extends ShipSafetyError {
    constructor(message: string);
}
export declare function assertHealCommand(cmd: string, args: string[]): void;
/** The exec every heal command runs through: allowlisted read shapes, git with replace refs off. */
export declare function healGuardExec(exec: Exec): Exec;
export interface HealRun {
    id: string;
    conclusion: string;
    status: string;
    headSha: string;
    headBranch: string;
    event: string;
    createdAt: string;
}
export interface HealJob {
    jobId: string;
    name: string;
    conclusion: string;
    failedSteps: string[];
}
export { jobLog, listRuns, parseRunJobs, parseRunList, viewRunJobs } from '../../forge/github/ci.js';
export interface ShaRange {
    /** Commits in the red sha that the green sha lacks. */
    commits: number;
    /** Changed files under src/, tests/, scripts/ or package*.json (a range touching none cannot explain a test failure). */
    codeFiles: number;
    /** The first MAX_RANGE_FILES files the red sha changed since the merge base with the green sha. */
    files: string[];
}
export declare const MAX_RANGE_FILES = 50;
/** The range lastGreen..firstRed from local git; undefined when either commit is not fetched. */
export declare function shaRange(exec: Exec, root: string, green: string, red: string): ShaRange | undefined;
//# sourceMappingURL=history.d.ts.map