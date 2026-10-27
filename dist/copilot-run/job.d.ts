/**
 * `copilot_run_*` jobs: one headless Copilot SDK session per job, started from
 * an MCP tool so Claude Code (or any MCP client) can hand a task to Copilot
 * and review the result.
 *
 * A job runs inside the MCP server process (jobs are in memory and end with
 * it). Its session reuses the SDK team worker setup: the SDK loader and
 * runtime binary of the smoke driver, a per-job COPILOT_HOME with the copied
 * login identity (copilot-session-env.ts), and the worker permission policy
 * (sdk-policy.ts) with writes confined to the job's working directory.
 *
 * Safety:
 * - `start` refuses unless OMG_COPILOT_RUN_ALLOW=1 is set in the server env;
 * - the budget governor (src/budget) is asked first, like an `omg team`
 *   launch of one copilot worker, and the spend is recorded in the ledger
 *   (live estimate, then the `session.shutdown` totals);
 * - isolation `worktree` (default) runs Copilot in a new git worktree and
 *   branch (src/team/git-worktree.ts, team name {@link WORKTREE_TEAM}); the
 *   caller's tree is used only with isolation `none`;
 * - writes to the ship merge-rule files (PROTECTED_PATHS plus a configured
 *   ship.knownFlakyFile) are refused;
 * - a credit cap, a job timeout and cancel all abort the session; so does the
 *   server's shutdown (stopAll);
 * - at most {@link MAX_RUNNING_JOBS} jobs run at once;
 * - `cleanup` removes a job's worktree only when it is clean and holds no
 *   commit the repository HEAD lacks (removeWorkerWorktree refuses otherwise);
 *   ignored files in it (build output, .env) go with it, links (a junctioned
 *   node_modules) are unlinked first so their targets survive.
 */
import { type LoadedSdk } from '../smoke/copilot-sdk-driver.js';
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const MAX_TIMEOUT_MS: number;
export declare const DEFAULT_MAX_CREDITS = 30;
export declare const MAX_RUNNING_JOBS = 2;
export declare const MAX_PROMPT_CHARS = 100000;
/** Team name of the job worktrees: `.omg/team/copilot-run/worktrees/<jobId>`, branch `omc-team/copilot-run/<jobId>`. */
export declare const WORKTREE_TEAM = "copilot-run";
export type CopilotRunIsolation = 'worktree' | 'none';
export type CopilotRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
export declare class CopilotRunError extends Error {
}
export interface CopilotRunStartInput {
    prompt: string;
    cwd?: string;
    model?: string;
    timeoutMs?: number;
    maxCredits?: number;
    isolation?: CopilotRunIsolation;
}
export interface CopilotRunDeps {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    loadSdk: () => Promise<LoadedSdk | null>;
    /** The copilot runtime binary (shims are resolved by the job), or null. */
    resolveBin: () => string | null;
    pluginRoot: () => string;
    userConfigDir: () => string;
    isAlive: (pid: number) => boolean;
    killTree: (pid: number) => void;
}
export interface WorktreeSummary {
    path: string;
    branch: string;
    repoRoot: string;
}
export interface ChangeSummary {
    /** `git diff --stat <base>` at the repository toplevel (commits and uncommitted tracked changes); all paths are root-relative. */
    diffStat: string;
    changedFiles: string[];
    untrackedFiles: string[];
    /** Changed files that hit the ship merge-rule paths (writes there are refused, shell can still reach them). */
    protectedChanges: string[];
}
/**
 * What changed in the repository around `cwd` since `base`; null when git
 * cannot tell. Run at the toplevel (cwd may be a subdirectory), so every path
 * is root-relative and untracked files outside the subdirectory count too.
 */
export declare function summarizeChanges(cwd: string, base: string | null, extraProtected?: readonly string[]): ChangeSummary | null;
export declare function defaultCopilotRunDeps(env?: NodeJS.ProcessEnv): CopilotRunDeps;
export declare class CopilotRunManager {
    private readonly deps;
    private readonly jobs;
    constructor(deps: CopilotRunDeps);
    /** Validate, ask the budget governor, prepare the worktree, and start the session in the background. */
    start(input: CopilotRunStartInput): Record<string, unknown>;
    status(jobId: string): Record<string, unknown>;
    /** Wait until the job ends or `timeoutMs` passes; the snapshot says which. */
    wait(jobId: string, timeoutMs: number): Promise<Record<string, unknown>>;
    /** Abort the session and wait (bounded) for the teardown. */
    cancel(jobId: string): Promise<Record<string, unknown>>;
    /**
     * Server shutdown: cancel every live job, wait up to `graceMs` for the
     * teardowns, then kill the runtimes still alive. Worktrees stay for review.
     */
    stopAll(graceMs?: number): Promise<void>;
    /** Remove a finished job's worktree and branch when nothing in them would be lost. */
    cleanup(jobId: string): Record<string, unknown>;
    private find;
    /** Ledger record `copilot-run:<jobId>`; fail-open. False when the lock was busy (retry later). */
    private recordBudget;
    /** Drive the session to its end and tear it down; returns the final status. */
    private run;
    private snapshot;
}
//# sourceMappingURL=job.d.ts.map