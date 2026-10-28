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
 * - the OS sandbox (sandbox.ts): applied when the host supports it; a review
 *   session without a confirmed sandbox gets no shell tool, a write session
 *   refuses (`sandbox-unavailable`) unless `writeUnsandboxed: "detect-only"`,
 *   and a shell call the runtime reports as not sandboxed stops the session
 *   (`sandbox-escaped`); every sandbox bypass request is rejected;
 * - the runtime env is an allowlist with the profile variables relocated to
 *   the job's home (allowlistSessionEnv);
 * - profile `review` denies the write tool, runs only shell commands on the
 *   read-only allowlist (src/team/shell-allowlist.ts), and keeps the
 *   {@link REVIEW_SHELL_DENY_PATTERNS} denylist as an extra layer;
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
import { hostGitHardeningArgs } from '../team/git-worktree.js';
import { type SdkPermissionRequest } from '../team/sdk-policy.js';
import { type CopilotRunSandboxState, type SandboxScope, type SandboxSettings } from './sandbox.js';
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
    /** Which sandbox config block applies: `factory` lanes read `factory.run.sandbox` over `copilotRun.sandbox` (default `copilot-run`). */
    sandboxScope?: SandboxScope;
    /** Start the session with a credential-free env ({@link scrubLaneCredentials}). */
    scrubCredentials?: boolean;
    /**
     * The caller commits the session's changes after the job (omg factory run):
     * a write session's sandbox keeps the whole common git dir read-only, so it
     * cannot stage or commit, and no git identity is seeded for it.
     */
    hostCommits?: boolean;
}
/** Env keys a credential-free session never gets (any case on Windows). */
export declare const LANE_CREDENTIAL_ENV: readonly ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "NPM_TOKEN", "NODE_AUTH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"];
/**
 * A credential-free session env, in place. Removed: GitHub tokens
 * ({@link LANE_CREDENTIAL_ENV}), ssh-agent and askpass hooks, every other
 * secret-named var, and `GIT_CONFIG_*` overrides. `GH_CONFIG_DIR` points at an
 * empty dir, so `gh` finds no stored login; git reads no global or system
 * config (no credential helper) and never prompts.
 *
 * Copilot's own auth is kept: the stored login (OS credential store, copied
 * identity) or COPILOT_GITHUB_TOKEN, which reaches the session over RPC
 * (sandbox.ts sessionGitHubToken), not through this env. The OS credential
 * store is out of reach of any env policy; only OS confinement closes
 * that. Without a stored login the generic GitHub tokens were the only
 * credential, so a scrubbed session then needs COPILOT_GITHUB_TOKEN.
 */
export declare function scrubLaneCredentials(env: NodeJS.ProcessEnv, emptyDir: string): void;
/** Why a job stopped early: a caller's stop, the credit cap, or a shell call outside the sandbox. */
export type CopilotRunStopReason = 'timeout' | 'cancelled' | 'capped' | 'sandbox-escaped';
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
/**
 * The review profile's denylist refusal for a request the worker policy
 * approved, or null. Kept as an extra layer under the shell allowlist.
 */
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
    /** The account's real home for the sandbox's denied paths (default os.userInfo().homedir, never HOME). */
    realHome?: () => string;
    /** The sandbox settings for a job in `root` (default loadSandboxSettings: user config, project may only tighten). */
    sandboxSettings?: (root: string, scope: SandboxScope) => {
        settings: SandboxSettings;
        warnings: string[];
    };
    /** Why the host git cannot read a sandboxed lane, or null (default hostGitAttrSourceProblem: git 2.41+). */
    hostGitAttrSourceProblem?: () => string | null;
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
    stopRequested: CopilotRunStopReason | null;
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
    /** `headCommit`: the worktree's HEAD when the job ended, read through the recorded git dir (absent while running or when its links changed). */
    worktree?: WorktreeSummary & {
        baseCommit: string | null;
        removed: boolean;
        headCommit?: string;
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
    /**
     * The OS sandbox once the job decided it: `refused` ends the job with a
     * `sandbox-unavailable:` error, an unsandboxed shell call with
     * `sandbox-escaped:` (unsandboxedCalls > 0).
     */
    sandbox?: CopilotRunSandboxState;
};
export interface ChangeSummary {
    /** `git diff --stat <base>` at the repository toplevel (commits and uncommitted tracked changes); all paths are root-relative. */
    diffStat: string;
    changedFiles: string[];
    untrackedFiles: string[];
    /** Changed files that hit the ship merge-rule paths (writes there are refused, shell can still reach them). */
    protectedChanges: string[];
    /**
     * Gitlinks (mode 160000: a nested repository) in the index or HEAD that the
     * base does not have. Host git never enters them, so their content is not
     * inspected: a policy violation (the job fails as sandbox-escaped); they are
     * also listed in changedFiles and protectedChanges.
     */
    newGitlinks?: string[];
}
/**
 * `-c` pairs on every host-side git command (src/team/git-worktree.ts): no
 * hook, fsmonitor, pager, external diff or other program a job's agent
 * planted runs in the caller's process. Diffs also pass --no-ext-diff and
 * --no-textconv, and runHostGit adds the driver overrides on every command
 * that touches the work tree.
 */
export { hostGitHardeningArgs };
/**
 * One git command as an argv array (never a shell), run through runHostGit;
 * trimmed stdout, or null on failure. These run in the caller's process on a
 * job worktree the job's agent could configure (omg factory run reads the
 * change summary before its tamper check). The worktree's repository config
 * counts as agent-controlled: in a job worktree these commands pass the
 * recorded `--git-dir` (worktreeGitDirArgs) after worktreeGitLinksIntact,
 * which pins the git dir, work tree and common dir in the environment, and
 * they only read (diff, ls-files, rev-parse, config --get) or move the job's
 * own branch from the repository root.
 */
export declare function hostGit(cwd: string, args: string[]): string | null;
/** hostGitDriverOverrides for the repository at `cwd` (or the recorded git dir `gitDirArgs` names). */
export declare function filterDriverOverrides(cwd: string, gitDirArgs?: readonly string[]): string[] | null;
/**
 * What changed in the repository around `cwd` since `base`; null when git
 * cannot tell. Run at the toplevel (cwd may be a subdirectory), so every path
 * is root-relative and untracked files outside the subdirectory count too.
 *
 * The job's agent may have written the worktree's attributes and config, and
 * omg factory run reads this summary before its tamper check, so the diff
 * runs no external diff driver, no textconv, no fsmonitor and no filter
 * driver (runHostGit's driver overrides; a driver it cannot override fails
 * the diff, so the summary is null).
 */
export declare function summarizeChanges(cwd: string, base: string | null, extraProtected?: readonly string[], gitDirArgs?: readonly string[]): ChangeSummary | null;
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
    /**
     * Probe the host and set `job.sandbox` (§5). Returns the config to apply
     * when the host supports the sandbox (the mode stays the unconfirmed one
     * until confirmSandbox), else null with the final mode: `detect-only` when
     * the sandbox is switched off, otherwise the fail-closed mode.
     */
    private decideSandbox;
    /** Apply `config` (unless createSession took it) and read the enforcement status; downgrade to the fail-closed mode on any doubt. */
    private confirmSandbox;
    private snapshot;
}
//# sourceMappingURL=job.d.ts.map