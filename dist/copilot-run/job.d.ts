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
 * - `start` refuses unless OMG_COPILOT_RUN_ALLOW=1 is set in the server env,
 *   or an in-process caller passes `allowLive` (never reachable from MCP);
 *   the session never inherits the env var;
 * - profile `review` denies the write tool and the git commands that move,
 *   rewrite or reconfigure the tree ({@link REVIEW_SHELL_DENY_PATTERNS});
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
import { type SdkPermissionRequest } from '../team/sdk-policy.js';
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const MAX_TIMEOUT_MS: number;
export declare const DEFAULT_MAX_CREDITS = 30;
export declare const MAX_RUNNING_JOBS = 2;
export declare const MAX_PROMPT_CHARS = 100000;
/** Team name of the job worktrees: `.omg/team/copilot-run/worktrees/<jobId>`, branch `omc-team/copilot-run/<jobId>`. */
export declare const WORKTREE_TEAM = "copilot-run";
/**
 * The OMC_SKIP_HOOKS list that turns off the blocking Stop hooks in a session
 * started with `disableStopContinuations`, so no Stop block silently costs a
 * request: persistent-mode (continuations), workflow-drift-guard (blocks on
 * placeholder text, which a review verdict may quote) and code-simplifier.
 * The scripts the Copilot Stop dispatcher runs each honor their own token;
 * the other hooks (git guardrails, budget guard) keep running, which
 * DISABLE_OMC would not allow.
 */
export declare const STOP_CONTINUATION_SKIP_TOKEN = "persistent-mode,workflow-drift-guard,code-simplifier";
export type CopilotRunIsolation = 'worktree' | 'none';
export type CopilotRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
/** `write` (default): the worker policy. `review`: no write tool, and no git command that moves or rewrites the tree. */
export type CopilotRunProfile = 'write' | 'review';
export declare class CopilotRunError extends Error {
}
export interface CopilotRunStartInput {
    prompt: string;
    cwd?: string;
    model?: string;
    timeoutMs?: number;
    maxCredits?: number;
    isolation?: CopilotRunIsolation;
    /** Commit-ish (sha or branch) the job worktree starts at instead of HEAD; isolation "worktree" only. */
    startRef?: string;
    profile?: CopilotRunProfile;
}
/** Options only an in-process caller can pass (the MCP tools never do). */
export interface CopilotRunStartOptions {
    /** Explicit opt-in to a live, billed session in place of OMG_COPILOT_RUN_ALLOW=1. */
    allowLive?: boolean;
    /** Skip the blocking Stop hooks ({@link STOP_CONTINUATION_SKIP_TOKEN}), so no Stop block silently costs a request. */
    disableStopContinuations?: boolean;
    /** The job's budget ledger record key (default `copilot-run:<jobId>`). */
    ledgerKey?: string;
}
/**
 * Shell commands a `review` session may not run, on top of the worker policy
 * (which already denies push, aliases and GIT_CONFIG_* env overrides):
 * - git subcommands that move or rewrite the tree, its refs or its config;
 *   `merge-base` and other hyphenated read-only subcommands stay allowed;
 * - any global `-c` or `--config-env` (an alias or `core.*` override);
 * - `git fetch` with a refspec (`main:main` writes a local ref).
 * Spelled like the push rule of SDK_SHELL_DENY_PATTERNS, on
 * normalizeShellCommand's output.
 */
export declare const REVIEW_SHELL_DENY_PATTERNS: ReadonlyArray<{
    re: RegExp;
    reason: string;
}>;
/** The review profile's extra refusal for a request the worker policy approved, or null. */
export declare function reviewProfileDenial(req: SdkPermissionRequest): string | null;
/**
 * The commit `ref` names in `repoRoot`, as a full sha. Refuses refs that
 * git could read as an option, carry whitespace or control characters, or do
 * not resolve to a commit.
 */
export declare function resolveStartRef(repoRoot: string, ref: unknown): string;
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
    /** The runtime's start identity (pid-reuse guard; default getProcessStartIdentity), null when unknown. */
    processIdentity?: (pid: number) => Promise<string | null>;
}
export interface WorktreeSummary {
    path: string;
    branch: string;
    repoRoot: string;
}
/** A job as start, status, wait and cancel return it (the copilot_run tools' JSON). */
export type CopilotRunSnapshot = {
    jobId: string;
    status: CopilotRunStatus;
    stopRequested: 'timeout' | 'cancelled' | 'capped' | null;
    isolation: CopilotRunIsolation;
    profile: CopilotRunProfile;
    startRef?: string;
    cwd: string;
    workingDirectory: string;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    timeoutMs: number;
    maxCredits: number;
    sessionId: string | null;
    finalText: string | null;
    error: string | null;
    usage: {
        premiumRequests: number;
        credits: number;
        source: 'measured' | 'estimated';
        summary: string;
    };
    worktree?: WorktreeSummary & {
        baseCommit: string | null;
        removed: boolean;
    };
    changes?: ChangeSummary;
    deniedPermissions?: Array<{
        kind: string;
        reason: string;
    }>;
    notes?: string[];
    eventsPath: string;
    /**
     * The copilot runtime child once it started: its pid and start identity
     * (null when it could not be read). A caller that outlives a crash of this
     * process (omg factory run) uses it to make sure the child is gone.
     */
    runtime?: {
        pid: number;
        identity: string | null;
    };
};
export interface ChangeSummary {
    /** `git diff --stat <base>` at the repository toplevel (commits and uncommitted tracked changes); all paths are root-relative. */
    diffStat: string;
    changedFiles: string[];
    untrackedFiles: string[];
    /** Changed files that hit the ship merge-rule paths (writes there are refused, shell can still reach them). */
    protectedChanges: string[];
}
/**
 * `-c` pairs that switch off every filter driver a config level the job's
 * agent can write (local, worktree, global, an include, the command line)
 * defines: empty `clean`, `smudge` and `process`, `required=false`. Git runs
 * a driver only when its command is non-empty, so a diff against the working
 * tree then reads file bytes as they are. A driver set only in the system
 * config (admin rights to write; Git for Windows ships `filter.lfs` there) is
 * kept. Listing the config runs nothing. Null when the drivers cannot be
 * listed or a name cannot be passed as `-c` (it holds `=` or a line break):
 * the caller fails closed.
 */
export declare function filterDriverOverrides(cwd: string): string[] | null;
/**
 * What changed in the repository around `cwd` since `base`; null when git
 * cannot tell. Run at the toplevel (cwd may be a subdirectory), so every path
 * is root-relative and untracked files outside the subdirectory count too.
 *
 * The job's agent may have written the worktree's attributes and config, and
 * omg factory run reads this summary before its tamper check, so the diff
 * runs no external diff driver, no textconv, no fsmonitor and no filter
 * driver (filterDriverOverrides).
 */
export declare function summarizeChanges(cwd: string, base: string | null, extraProtected?: readonly string[]): ChangeSummary | null;
export declare function defaultCopilotRunDeps(env?: NodeJS.ProcessEnv): CopilotRunDeps;
export declare class CopilotRunManager {
    private readonly deps;
    private readonly jobs;
    constructor(deps: CopilotRunDeps);
    /** Validate, ask the budget governor, prepare the worktree, and start the session in the background. */
    start(input: CopilotRunStartInput, options?: CopilotRunStartOptions): CopilotRunSnapshot;
    status(jobId: string): CopilotRunSnapshot;
    /** Wait until the job ends or `timeoutMs` passes; the snapshot says which. */
    wait(jobId: string, timeoutMs: number): Promise<CopilotRunSnapshot>;
    /** Abort the session and wait (bounded) for the teardown. */
    cancel(jobId: string): Promise<CopilotRunSnapshot>;
    /**
     * Server shutdown: cancel every live job, wait up to `graceMs` for the
     * teardowns, then kill the runtimes still alive. Worktrees stay for review.
     */
    stopAll(graceMs?: number): Promise<void>;
    /** Remove a finished job's worktree and branch when nothing in them would be lost. */
    cleanup(jobId: string): CopilotRunSnapshot & {
        cleanup: string;
    };
    private find;
    /** Ledger record `job.ledgerKey` (default `copilot-run:<jobId>`); fail-open. False when the lock was busy (retry later). */
    private recordBudget;
    /** Drive the session to its end and tear it down; returns the final status. */
    private run;
    private snapshot;
}
//# sourceMappingURL=job.d.ts.map