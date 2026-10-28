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
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { formatAmount } from '../budget/governor.js';
import { SAFE_KEY, ledgerPath, NANO_AIU_PER_CREDIT, recordUsage } from '../budget/ledger.js';
import { openAppendExclusive } from '../lib/append-no-follow.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { getProcessStartIdentity } from '../platform/process-utils.js';
import { configuredProtectedPaths } from '../ship/config.js';
import { protectedChanges } from '../ship/merge.js';
import { resolveCopilotBinary } from '../smoke/copilot-binary.js';
import { loadCopilotSdk, resolveShimTarget, runtimePid, sdkCreateSessionAcceptsSandbox, } from '../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS, usageCredits } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity, resolveDefaultPluginRoot } from '../smoke/copilot-session-env.js';
import { killProcessTree } from '../smoke/process-utils.js';
import { ensureWorkerWorktree, getBranchName, getWorktreePath, hostGitDriverOverrides, hostGitEnv, hostGitAttrSourceProblem, hostGitHardeningArgs, readWorktreeGitLinks, recordWorktreeGitLinks, removeWorkerWorktree, runHostGit, worktreeGitDirArgs, worktreeGitLinksIntact, } from '../team/git-worktree.js';
import { buildSdkExcludedTools, decideSdkPermission, gitSubcommandDeny, isUnderRoot, normalizeShellCommand, } from '../team/sdk-policy.js';
import { reviewShellAllowlist } from '../team/shell-allowlist.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';
import { COPILOT_RUN_ALLOW_ENV } from './names.js';
import { REVIEW_READ_TOOLS, REVIEW_SHELL_TOOLS, SANDBOX_KILL_ENV, SANDBOX_SHELL_TOOLS, allowlistSessionEnv, applySandboxConfig, buildSandboxConfig, laneToolPaths, loadSandboxSettings, missingSandboxEnv, probeHostSupport, readEnforcement, scrubTokens, secretValues, sessionGitHubToken, unconfirmedMode, } from './sandbox.js';
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const MAX_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_MAX_CREDITS = RUNTIME_MIN_MAX_CREDITS;
export const MAX_RUNNING_JOBS = 2;
export const MAX_PROMPT_CHARS = 100_000;
/** Team name of the job worktrees: `.omg/team/copilot-run/worktrees/<jobId>`, branch `omc-team/copilot-run/<jobId>`. */
export const WORKTREE_TEAM = 'copilot-run';
const MCP_SERVER = 't';
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STOP_TIMEOUT_MS = 15_000;
/** stopAll's wait for the teardowns before it kills the runtimes (the server force-exits at 5 s). */
const SERVER_EXIT_GRACE_MS = 3_000;
const GIT_TIMEOUT_MS = 30_000;
const DENIED_LOG_MAX = 50;
const JOB_ID = /^cr-[0-9a-f]{12}$/;
const MAX_START_REF_CHARS = 256;
/**
 * The OMC_SKIP_HOOKS list that turns off the blocking Stop hooks in a session
 * started with `disableStopContinuations`, so no Stop block silently costs a
 * request: persistent-mode (continuations), workflow-drift-guard (blocks on
 * placeholder text, which a review verdict may quote) and code-simplifier.
 * The scripts the Copilot Stop dispatcher runs each honor their own token;
 * the other hooks (git guardrails, budget guard) keep running, which
 * DISABLE_OMC would not allow.
 */
export const STOP_CONTINUATION_SKIP_TOKEN = 'persistent-mode,workflow-drift-guard,code-simplifier';
export class CopilotRunError extends Error {
}
/** Env keys a credential-free session never gets (any case on Windows). */
export const LANE_CREDENTIAL_ENV = [
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND',
    'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL',
    // Azure DevOps: the azure-devops extension's PATs and a pipeline's job token.
    'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY', 'AZURE_DEVOPS_EXT_GITHUB_PAT', 'SYSTEM_ACCESSTOKEN',
    // azure-identity / az: service principal, certificate, workload identity and managed identity.
    'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_PASSWORD',
    'AZURE_FEDERATED_TOKEN_FILE', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET',
    // az storage account keys and SAS.
    'AZURE_STORAGE_KEY', 'AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_SAS_TOKEN',
    // Terraform azurerm (ARM_*).
    'ARM_CLIENT_SECRET', 'ARM_CLIENT_CERTIFICATE_PATH', 'ARM_CLIENT_CERTIFICATE_PASSWORD', 'ARM_OIDC_TOKEN',
    'ARM_OIDC_TOKEN_FILE_PATH', 'ARM_OIDC_REQUEST_TOKEN', 'ARM_ACCESS_KEY', 'ARM_SAS_TOKEN',
];
/** Names that look like a secret; COPILOT_GITHUB_TOKEN is the session's own credential and stays. */
const SECRET_NAME = /TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_KEY|ACCESS_KEY|_PAT\b|PRINCIPAL_KEY/i;
/**
 * A credential-free session env, in place. Removed: GitHub tokens
 * ({@link LANE_CREDENTIAL_ENV}), ssh-agent and askpass hooks, every other
 * secret-named var, and `GIT_CONFIG_*` overrides. `GH_CONFIG_DIR` and
 * `AZURE_CONFIG_DIR` point at an empty dir, so `gh` and `az` (the azure-devops
 * extension included) find no stored login; git reads no global or system
 * config (no credential helper) and never prompts.
 *
 * Copilot's own auth is kept: the stored login (OS credential store, copied
 * identity) or COPILOT_GITHUB_TOKEN, which reaches the session over RPC
 * (sandbox.ts sessionGitHubToken), not through this env. The OS credential
 * store is out of reach of any env policy; only OS confinement closes
 * that. Without a stored login the generic GitHub tokens were the only
 * credential, so a scrubbed session then needs COPILOT_GITHUB_TOKEN.
 */
export function scrubLaneCredentials(env, emptyDir) {
    const exact = new Set(LANE_CREDENTIAL_ENV);
    for (const key of Object.keys(env)) {
        const upper = key.toUpperCase();
        if (upper === 'COPILOT_GITHUB_TOKEN')
            continue;
        if (exact.has(upper) || SECRET_NAME.test(upper) || upper.startsWith('GIT_CONFIG') || upper.startsWith('GCM_'))
            delete env[key];
    }
    const emptyConfig = join(emptyDir, 'gitconfig');
    writeFileSync(emptyConfig, '');
    Object.assign(env, {
        GH_CONFIG_DIR: emptyDir,
        AZURE_CONFIG_DIR: emptyDir,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
    });
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
export const REVIEW_SHELL_DENY_PATTERNS = [
    ...gitSubcommandDeny(String.raw `(?:commit|reset|checkout|merge|rebase|stash|switch|restore|cherry-pick|revert|apply|am|branch|tag|update-ref|symbolic-ref|worktree|notes|replace|push|config|pull|bisect|remote|clean|sparse-checkout|submodule|read-tree|update-index|checkout-index|filter-branch|gc\s+[^;&|\n]*--prune|reflog\s+expire)(?![\w-])`, 'review profile: git commands that change the tree, its refs or its config'),
    ...gitSubcommandDeny(String.raw `(?:-c(?:\s|$)|--config-env\b)`, 'review profile: git config overrides (-c, --config-env)'),
    // A refspec argument (`src:dst`, `+refs/*:refs/*`); a URL's `://` and scp-style `user@host:` are not one.
    ...gitSubcommandDeny(String.raw `fetch\b[^;&|\n]*?\s\+?[\w./*-]*:(?!//)`, 'review profile: git fetch with a refspec'),
];
/**
 * The review profile's denylist refusal for a request the worker policy
 * approved, or null. Kept as an extra layer under the shell allowlist.
 */
export function reviewProfileDenial(req) {
    if (req.kind === 'write')
        return 'review profile: the write tool is disabled';
    if (req.kind !== 'shell')
        return null;
    const normalized = normalizeShellCommand(String(req.fullCommandText ?? ''));
    return REVIEW_SHELL_DENY_PATTERNS.find(({ re }) => re.test(normalized))?.reason ?? null;
}
/**
 * The commit `ref` names in `repoRoot`, as a full sha. Refuses refs that
 * git could read as an option, carry whitespace or control characters, or do
 * not resolve to a commit.
 */
export function resolveStartRef(repoRoot, ref) {
    if (typeof ref !== 'string' || !ref.trim())
        throw new CopilotRunError('copilot_run_start: startRef must be a non-empty string.');
    if (ref.length > MAX_START_REF_CHARS || ref.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(ref)) {
        throw new CopilotRunError(`copilot_run_start: startRef ${JSON.stringify(ref)} is not a valid ref.`);
    }
    const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    if (!sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
        throw new CopilotRunError(`copilot_run_start: startRef ${JSON.stringify(ref)} does not resolve to a commit in ${repoRoot}.`);
    }
    return sha;
}
/** How long the runtime's start identity may take to read (PowerShell on Windows). */
const IDENTITY_TIMEOUT_MS = 10_000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const errText = (err) => (err instanceof Error ? err.message : String(err));
const isTerminal = (s) => s !== 'starting' && s !== 'running';
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
/** Wait for `promise` (which never rejects) or `ms`, whichever comes first; the timer is cleared either way. */
function settleWithin(promise, ms) {
    let timer;
    return Promise.race([
        promise.then(() => { }),
        new Promise((r) => { timer = setTimeout(r, ms); }),
    ]).finally(() => clearTimeout(timer));
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
export function hostGit(cwd, args) {
    try {
        return runHostGit(cwd, args, GIT_TIMEOUT_MS).trim();
    }
    catch {
        return null;
    }
}
const git = hostGit;
const lines = (text) => (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
/** hostGitDriverOverrides for the repository at `cwd` (or the recorded git dir `gitDirArgs` names). */
export function filterDriverOverrides(cwd, gitDirArgs = []) {
    return hostGitDriverOverrides(cwd, hostGitEnv(gitDirArgs), GIT_TIMEOUT_MS);
}
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
export function summarizeChanges(cwd, base, extraProtected = [], gitDirArgs = []) {
    if (!base)
        return null;
    const top = git(cwd, [...gitDirArgs, 'rev-parse', '--show-toplevel']);
    if (!top)
        return null;
    const stat = git(top, [...gitDirArgs, 'diff', '--no-ext-diff', '--no-textconv', '--stat', base, '--']);
    const names = git(top, [...gitDirArgs, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', base, '--']);
    // In a lane worktree the diff ignores submodules, so gitlinks come from the index and trees (no git runs in them).
    const gitlinks = (out) => (out === null ? null : out.split('\0').filter((e) => e.startsWith('160000 ')).map((e) => e.slice(e.indexOf('\t') + 1)));
    const indexLinks = gitlinks(git(top, [...gitDirArgs, 'ls-files', '-z', '--stage']));
    const headLinks = gitlinks(git(top, [...gitDirArgs, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD']));
    const baseLinks = gitlinks(git(top, [...gitDirArgs, 'ls-tree', '-r', '-z', '--full-tree', base]));
    if (stat === null || names === null || indexLinks === null || headLinks === null || baseLinks === null)
        return null;
    const newGitlinks = [...new Set([...indexLinks, ...headLinks])].filter((p) => !baseLinks.includes(p));
    const changedFiles = [...new Set([...lines(names), ...newGitlinks])];
    const untrackedFiles = lines(git(top, [...gitDirArgs, 'ls-files', '--others', '--exclude-standard']));
    return {
        diffStat: stat,
        changedFiles,
        untrackedFiles,
        protectedChanges: [...new Set([...protectedChanges([...changedFiles, ...untrackedFiles], extraProtected), ...newGitlinks])],
        newGitlinks,
    };
}
/**
 * Write the caller's git identity (user.name, user.email as git resolves
 * them in `repo`) into the relocated global config, so a write session can
 * still commit. Nothing else (aliases, hooks, credential helpers) is copied.
 */
function seedGitIdentity(repo, globalConfig) {
    for (const key of ['user.name', 'user.email']) {
        const value = git(repo, ['config', '--get', key]);
        if (value)
            git(repo, ['config', '--file', globalConfig, key, value]);
    }
}
/**
 * The `--git-dir`/`--work-tree` args for host git in the job's worktree:
 * empty without one (isolation "none"), null when its git links no longer
 * match what git wrote at creation (then no host git may run in it).
 */
function jobGitDirArgs(job) {
    if (!job.worktree)
        return [];
    const { worktreeLinks: links, commonGitDir } = job;
    if (!links || !commonGitDir || !worktreeGitLinksIntact(job.worktree.path, links, commonGitDir))
        return null;
    try {
        return worktreeGitDirArgs(job.worktree.path);
    }
    catch {
        return null;
    }
}
/**
 * Move the job's branch to the commit its worktree's HEAD reached. The
 * session commits on a detached HEAD because the sandbox keeps every ref
 * read-only, so one job cannot rewrite another job's branch. Run from the
 * repository root, with the old value, after jobGitDirArgs confirmed the links.
 */
function syncJobBranch(job, gitDirArgs) {
    const wt = job.worktree;
    const head = git(wt.path, [...gitDirArgs, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const ref = `refs/heads/${wt.branch}`;
    const current = git(wt.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!head || !current || head === current)
        return;
    if (git(wt.repoRoot, ['update-ref', '-m', 'copilot_run: the session\'s commits', ref, head, current]) === null) {
        job.notes.push(`could not move branch ${wt.branch} to the worktree's HEAD ${head.slice(0, 12)}; the commits are on the worktree's detached HEAD.`);
    }
}
/** The repository-relative path when `path` lies in `root`, else null. */
function relativeInside(path, root) {
    const rel = relative(resolve(root), resolve(path));
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : null;
}
export function defaultCopilotRunDeps(env = process.env) {
    return {
        env,
        platform: process.platform,
        loadSdk: () => loadCopilotSdk(env, spawnSync),
        resolveBin: () => resolveCopilotBinary(undefined, env).bin,
        pluginRoot: () => resolveDefaultPluginRoot(env),
        userConfigDir: () => getCopilotConfigDir(),
        isAlive: (pid) => { try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            return err.code === 'EPERM';
        } },
        killTree: (pid) => killProcessTree(pid, spawnSync),
    };
}
export class CopilotRunManager {
    deps;
    jobs = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /** Validate, ask the budget governor, prepare the worktree, and start the session in the background. */
    start(input, options = {}) {
        if (options.allowLive !== true && this.deps.env[COPILOT_RUN_ALLOW_ENV] !== '1') {
            throw new CopilotRunError(`copilot_run_start runs a live, billed Copilot session and is disabled. Set ${COPILOT_RUN_ALLOW_ENV}=1 in the MCP server env `
                + `(claude mcp add omg-dev -e ${COPILOT_RUN_ALLOW_ENV}=1 -- node <oh-my-copilot>/dist/mcp/standalone-server.js).`);
        }
        const prompt = input.prompt;
        if (typeof prompt !== 'string' || !prompt.trim())
            throw new CopilotRunError('copilot_run_start: prompt is empty.');
        if (prompt.length > MAX_PROMPT_CHARS)
            throw new CopilotRunError(`copilot_run_start: prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
            throw new CopilotRunError(`copilot_run_start: timeoutMs must be positive and at most ${MAX_TIMEOUT_MS}.`);
        }
        const maxCredits = input.maxCredits ?? DEFAULT_MAX_CREDITS;
        if (!Number.isFinite(maxCredits) || maxCredits <= 0)
            throw new CopilotRunError('copilot_run_start: maxCredits must be a positive number.');
        const isolation = input.isolation ?? 'worktree';
        const profile = input.profile ?? 'write';
        if (profile !== 'write' && profile !== 'review')
            throw new CopilotRunError(`copilot_run_start: profile must be "write" or "review", not ${JSON.stringify(profile)}.`);
        const startRef = input.startRef ?? null;
        if (startRef !== null && isolation !== 'worktree')
            throw new CopilotRunError('copilot_run_start: startRef needs isolation "worktree".');
        if (options.ledgerKey !== undefined && !SAFE_KEY.test(options.ledgerKey))
            throw new CopilotRunError(`copilot_run_start: ledgerKey ${JSON.stringify(options.ledgerKey)} must match ${SAFE_KEY}.`);
        const cwd = resolve(input.cwd ?? process.cwd());
        let isDir = false;
        try {
            isDir = statSync(cwd).isDirectory();
        }
        catch { /* missing */ }
        if (!isDir)
            throw new CopilotRunError(`copilot_run_start: cwd ${JSON.stringify(cwd)} is not an existing directory.`);
        const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
        if (isolation === 'worktree' && !repoRoot) {
            throw new CopilotRunError(`copilot_run_start: cwd ${JSON.stringify(cwd)} is not inside a git repository; isolation "worktree" needs one (or pass isolation: "none").`);
        }
        // Validated before the budget check and the worktree, so a bad ref creates nothing.
        const startSha = startRef !== null && repoRoot ? resolveStartRef(resolve(repoRoot), startRef) : null;
        // A malformed sandbox block refuses too, before anything is created.
        let sandboxSettings;
        let sandboxWarnings;
        try {
            ({ settings: sandboxSettings, warnings: sandboxWarnings } = (this.deps.sandboxSettings ?? loadSandboxSettings)(repoRoot ? resolve(repoRoot) : cwd, options.sandboxScope ?? 'copilot-run'));
        }
        catch (err) {
            throw new CopilotRunError(`copilot_run_start: sandbox config: ${errText(err)}`);
        }
        // Host git reads a sandboxed lane with GIT_ATTR_SOURCE (no lane attributes, so no driver): an older git fails closed.
        if (sandboxSettings.enabled && this.deps.env[SANDBOX_KILL_ENV] !== 'off') {
            const problem = (this.deps.hostGitAttrSourceProblem ?? hostGitAttrSourceProblem)();
            if (problem)
                throw new CopilotRunError(`copilot_run_start: ${problem}. Upgrade git, or switch the sandbox off (sandbox.enabled false).`);
            // The session env passes these through (SESSION_ENV_ALLOWLIST); without one, MXC rejects every hook and shell launch.
            const missing = missingSandboxEnv(this.deps.env, this.deps.platform);
            if (missing.length) {
                throw new CopilotRunError(`copilot_run_start: the Windows sandbox needs ${missing.join(' and ')} in the environment to launch any process, and it is unset here. Set it, or switch the sandbox off (sandbox.enabled false).`);
            }
            // isolation "none": the sandbox grants the repository top read-write, and the OMC state root (the job dir with
            // the job home and events.jsonl, the budget ledger) usually lies inside it. Fail closed rather than hand the
            // lane what the unsandboxed engine and runtime read back. detect-only promises no sandbox: it is checked again
            // (structurally) when the policy is built, and falls back to its unsandboxed run there.
            const top = repoRoot ? resolve(repoRoot) : cwd;
            if (isolation === 'none' && profile === 'write' && sandboxSettings.writeUnsandboxed !== 'detect-only') {
                const omcRoot = getOmcRoot(top);
                let inside = true;
                try {
                    inside = isUnderRoot(omcRoot, top, this.deps.platform);
                }
                catch { /* unresolvable: refuse */ }
                if (inside) {
                    throw new CopilotRunError(`copilot_run_start: a sandboxed write job with isolation "none" would let the lane write the job's state in ${omcRoot}, which lies inside ${top}. Use isolation "worktree" (the default), or the review profile.`);
                }
            }
        }
        const running = [...this.jobs.values()].filter((j) => !isTerminal(j.status)).length;
        if (running >= MAX_RUNNING_JOBS) {
            throw new CopilotRunError(`copilot_run_start: ${running} job(s) already running (limit ${MAX_RUNNING_JOBS}); wait for or cancel one first.`);
        }
        const ledgerCwd = repoRoot ? resolve(repoRoot) : cwd;
        const notes = [...sandboxWarnings];
        const id = `cr-${randomBytes(6).toString('hex')}`;
        let workCwd = cwd;
        let worktree = null;
        let worktreeLinks = null;
        let commonGitDir = null;
        let baseCommit = repoRoot ? git(cwd, ['rev-parse', 'HEAD']) : null;
        if (isolation === 'worktree') {
            let info;
            try {
                info = ensureWorkerWorktree(WORKTREE_TEAM, id, ledgerCwd, { mode: 'named', requireCleanLeader: false, ...(startSha ? { baseRef: startSha } : {}) });
            }
            catch (err) {
                // A failure after `git worktree add` leaves a worktree no job id can clean: remove it now (same safety checks), or name it.
                const path = getWorktreePath(ledgerCwd, WORKTREE_TEAM, id);
                const branch = getBranchName(WORKTREE_TEAM, id);
                let left = '';
                if (existsSync(path)) {
                    try {
                        removeWorkerWorktree(WORKTREE_TEAM, id, ledgerCwd);
                    }
                    catch { /* reported below */ }
                    if (existsSync(path))
                        left = ` The partly created worktree ${path} (branch ${branch}) is left; check it and remove it by hand (unlink any junction in it first).`;
                }
                throw new CopilotRunError(`copilot_run_start: could not create the job worktree: ${errText(err)}.${left}`);
            }
            if (!info)
                throw new CopilotRunError('copilot_run_start: worktree creation unexpectedly disabled.');
            // Record the git links git just wrote, then detach HEAD: the session
            // commits on it (the sandbox keeps every ref read-only) and the host
            // moves the job's branch after the session (syncJobBranch).
            const commonRaw = git(ledgerCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            commonGitDir = commonRaw ? resolve(commonRaw) : null;
            // With extensions.worktreeConfig git reads the admin dir's config.worktree, and the sandbox keeps only an
            // existing file read-only (buildSandboxConfig): create an empty one before the links are recorded.
            if (git(ledgerCwd, ['config', '--bool', 'extensions.worktreeConfig']) === 'true') {
                const admin = readWorktreeGitLinks(info.path)?.adminDir;
                if (admin) {
                    try {
                        writeFileSync(join(admin, 'config.worktree'), '', { flag: 'wx' });
                    }
                    catch { /* already there */ }
                }
            }
            worktreeLinks = readWorktreeGitLinks(info.path);
            const head = info.baseCommit ?? null;
            const recorded = (links) => {
                try {
                    recordWorktreeGitLinks(info.path, links);
                    return true;
                }
                catch {
                    return false;
                }
            };
            const detached = worktreeLinks !== null && commonGitDir !== null && head !== null
                && worktreeGitLinksIntact(info.path, worktreeLinks, commonGitDir) && recorded(worktreeLinks)
                && git(info.path, [...worktreeGitDirArgs(info.path), 'update-ref', '--no-deref', '-m', 'copilot_run: detach for the session', 'HEAD', head]) !== null;
            if (!detached) {
                try {
                    removeWorkerWorktree(WORKTREE_TEAM, id, ledgerCwd);
                }
                catch { /* reported below */ }
                const left = existsSync(info.path) ? ` The worktree ${info.path} (branch ${info.branch}) is left; check it and remove it by hand.` : '';
                throw new CopilotRunError(`copilot_run_start: could not record and detach the job worktree's git links.${left}`);
            }
            // The caller's subdirectory, mirrored in the worktree.
            const sub = relativeInside(cwd, ledgerCwd);
            workCwd = sub && existsSync(join(info.path, sub)) ? join(info.path, sub) : info.path;
            worktree = { path: info.path, branch: info.branch, repoRoot: ledgerCwd };
            baseCommit = info.baseCommit ?? startSha ?? baseCommit;
            if (!startSha && lines(git(ledgerCwd, ['status', '--porcelain', '--untracked-files=no'])).length > 0) {
                notes.push(`${ledgerCwd} has uncommitted changes; the worktree starts from HEAD ${baseCommit?.slice(0, 12) ?? '?'} without them.`);
            }
        }
        else if (repoRoot) {
            notes.push('isolation "none": Copilot works in your working tree; the change summary includes edits that were already there.');
        }
        let extraProtected = [];
        try {
            extraProtected = configuredProtectedPaths(ledgerCwd);
        }
        catch { /* the defaults still apply */ }
        const jobDir = join(getOmcRoot(ledgerCwd), 'state', 'copilot-run', id);
        let requestStop = () => { };
        const stopped = new Promise((r) => { requestStop = (reason) => { if (!job.stopReason)
            job.stopReason = reason; r(); }; });
        const job = {
            id,
            status: 'starting',
            prompt,
            cwd,
            workCwd,
            isolation,
            profile,
            startRef,
            disableStopContinuations: options.disableStopContinuations === true,
            scrubCredentials: options.scrubCredentials === true,
            hostCommits: options.hostCommits === true,
            ledgerKey: options.ledgerKey ?? `copilot-run:${id}`,
            model: input.model ?? null,
            timeoutMs,
            maxCredits,
            ledgerCwd,
            jobDir,
            home: join(jobDir, 'home'),
            eventsPath: join(jobDir, 'events.jsonl'),
            baseCommit,
            headCommit: null,
            worktree,
            worktreeLinks,
            commonGitDir,
            extraProtected,
            pid: undefined,
            pidIdentity: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
            sessionId: null,
            finalText: null,
            error: null,
            notes,
            usage: { premiumRequests: 0, credits: 0, measured: false },
            denied: [],
            changes: null,
            cleanedUp: false,
            sandboxSettings,
            sandbox: null,
            secrets: secretValues(this.deps.env),
            stopReason: null,
            requestStop: (reason) => requestStop(reason),
            stopped,
            done: Promise.resolve(),
        };
        this.jobs.set(id, job);
        const timer = setTimeout(() => job.requestStop('timeout'), timeoutMs);
        timer.unref?.();
        // The status turns terminal only after the teardown and the change summary.
        job.done = this.run(job)
            .catch((err) => { job.error ??= errText(err); return 'failed'; })
            .then((outcome) => {
            clearTimeout(timer);
            const gitDirArgs = jobGitDirArgs(job);
            if (gitDirArgs === null) {
                // A redirected .git, gitdir or commondir points host git at a git dir the session controls; a changed config.worktree plants config in it.
                const why = 'sandbox-escaped: the job worktree\'s git links (.git, gitdir, commondir or config.worktree) changed during the session; no host git ran in it';
                job.error = job.error ? `${why}; ${job.error}` : why;
                job.stopReason ??= 'sandbox-escaped';
                outcome = 'failed';
            }
            else {
                if (job.worktree) {
                    syncJobBranch(job, gitDirArgs);
                    job.headCommit = git(job.worktree.path, [...gitDirArgs, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
                }
                job.changes = summarizeChanges(job.workCwd, job.baseCommit, job.extraProtected, gitDirArgs);
                const nested = job.changes?.newGitlinks ?? [];
                if (job.worktree && nested.length > 0) {
                    const why = `sandbox-escaped: the session added nested repositories as gitlinks (${nested.slice(0, 5).join(', ')}); host git does not enter them, so their content was not inspected`;
                    job.error = job.error ? `${why}; ${job.error}` : why;
                    job.stopReason ??= 'sandbox-escaped';
                    outcome = 'failed';
                }
            }
            job.endedAt = new Date().toISOString();
            job.status = outcome;
        });
        return this.snapshot(job);
    }
    status(jobId) {
        return this.snapshot(this.find(jobId));
    }
    /** Wait until the job ends or `timeoutMs` passes; the snapshot says which. */
    async wait(jobId, timeoutMs) {
        const job = this.find(jobId);
        await settleWithin(job.done, Math.max(0, timeoutMs));
        return this.snapshot(job);
    }
    /** Abort the session and wait (bounded) for the teardown. */
    async cancel(jobId) {
        const job = this.find(jobId);
        if (!isTerminal(job.status)) {
            job.requestStop('cancelled');
            await settleWithin(job.done, ABORT_GRACE_MS + STOP_TIMEOUT_MS + RPC_TIMEOUT_MS);
        }
        return this.snapshot(job);
    }
    /**
     * Server shutdown: cancel every live job, wait up to `graceMs` for the
     * teardowns, then kill the runtimes still alive. Worktrees stay for review.
     */
    async stopAll(graceMs = SERVER_EXIT_GRACE_MS) {
        const live = [...this.jobs.values()].filter((j) => !isTerminal(j.status));
        for (const job of live)
            job.requestStop('cancelled');
        await settleWithin(Promise.all(live.map((j) => j.done)), graceMs);
        for (const job of live) {
            try {
                if (job.pid && this.deps.isAlive(job.pid))
                    this.deps.killTree(job.pid);
            }
            catch { /* best effort */ }
        }
    }
    /** Remove a finished job's worktree and branch when nothing in them would be lost. */
    cleanup(jobId) {
        const job = this.find(jobId);
        if (!isTerminal(job.status))
            throw new CopilotRunError(`copilot_run_cleanup: job ${jobId} is still ${job.status}; cancel it first.`);
        if (!job.worktree)
            throw new CopilotRunError(`copilot_run_cleanup: job ${jobId} ran with isolation "none"; there is no worktree to remove.`);
        let tampered = null;
        if (!job.cleanedUp) {
            try {
                // With the recorded links, a worktree whose links changed is removed by path and no git runs in it.
                ({ tampered } = removeWorkerWorktree(WORKTREE_TEAM, job.id, job.worktree.repoRoot, job.worktreeLinks ? { gitLinks: job.worktreeLinks } : {}));
            }
            catch (err) {
                throw new CopilotRunError(`copilot_run_cleanup: kept ${job.worktree.path} (branch ${job.worktree.branch}): ${errText(err)}. `
                    + 'Merge or discard the changes yourself (commit them and merge the branch, or delete them), then call cleanup again.');
            }
            job.cleanedUp = true;
            try {
                rmSync(job.jobDir, { recursive: true, force: true });
            }
            catch { /* evidence only */ }
        }
        if (tampered)
            return { ...this.snapshot(job), cleanup: `sandbox-escaped: ${tampered}` };
        return { ...this.snapshot(job), cleanup: `removed worktree ${job.worktree.path} and branch ${job.worktree.branch}` };
    }
    find(jobId) {
        if (typeof jobId !== 'string' || !JOB_ID.test(jobId))
            throw new CopilotRunError(`Invalid jobId ${JSON.stringify(jobId)}.`);
        const job = this.jobs.get(jobId);
        if (!job)
            throw new CopilotRunError(`No copilot_run job ${jobId} in this MCP server (jobs live in the server process and end with it).`);
        return job;
    }
    /** Ledger record `job.ledgerKey` (default `copilot-run:<jobId>`); fail-open. False when the lock was busy (retry later). */
    recordBudget(job, lockTimeoutMs) {
        if (this.deps.env.OMC_BUDGET_GOVERNOR === '0')
            return true;
        const usage = {
            premiumRequests: job.usage.premiumRequests,
            credits: job.usage.credits,
            source: job.usage.measured ? 'measured' : 'estimated',
            detail: job.usage.measured
                ? 'session.shutdown'
                : 'copilot_run sdk assistant.usage: AI credits as billed, user-initiated calls x1 each (multiplier unknown)',
            ...(job.model ? { model: job.model } : {}),
            updatedAt: new Date().toISOString(),
        };
        try {
            recordUsage(ledgerPath(job.ledgerCwd), job.ledgerKey, usage, undefined, { timeoutMs: lockTimeoutMs });
            return true;
        }
        catch (err) {
            return !errText(err).startsWith('Failed to acquire file lock');
        }
    }
    /** Drive the session to its end and tear it down; returns the final status. */
    async run(job) {
        const { deps } = this;
        mkdirSync(job.home, { recursive: true });
        const loaded = await deps.loadSdk().catch(() => null);
        if (!loaded) {
            job.error = '@github/copilot-sdk is not installed (npm i -g @github/copilot-sdk --omit=optional --ignore-scripts)';
            return 'failed';
        }
        const found = deps.resolveBin();
        const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
        if (!bin) {
            job.error = found ? `copilot shim ${found} names no .js/.exe target` : 'copilot CLI not found (PATH, COPILOT_CLI_PATH, WinGet)';
            return 'failed';
        }
        const pluginRoot = deps.pluginRoot();
        const ident = loginIdentity(deps.userConfigDir());
        writeFileSync(join(job.home, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [job.workCwd] }, null, 2)}\n`);
        // An env allowlist with the profile relocated into the job's home (sandbox.ts).
        const env = allowlistSessionEnv(buildSessionEnv(deps.env, job.home, { session: false, hasLogin: ident.loggedInUsers !== undefined }), job.home);
        const gitHubToken = sessionGitHubToken(deps.env);
        mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
        mkdirSync(dirname(env.GIT_CONFIG_GLOBAL), { recursive: true });
        mkdirSync(env.TEMP, { recursive: true });
        // A session the host commits for never commits, so it gets no identity.
        if (!job.hostCommits)
            seedGitIdentity(job.ledgerCwd, env.GIT_CONFIG_GLOBAL);
        // OMC_BUDGET_HOST_LEDGER: this job records the session's usage; its hooks must not count it again.
        Object.assign(env, { OMC_GIT_GUARDRAILS: '1', COPILOT_ALLOW_ALL: 'false', OMC_BUDGET_HOST_LEDGER: '1' });
        delete env[COPILOT_RUN_ALLOW_ENV];
        // OMC_* from the caller is stripped above, so this is the session's only skip list.
        if (job.disableStopContinuations)
            env.OMC_SKIP_HOOKS = STOP_CONTINUATION_SKIP_TOKEN;
        let scrubDir = null;
        if (job.scrubCredentials) {
            // COPILOT_GITHUB_TOKEN reaches the session over RPC (gitHubToken), never through the allowlisted env.
            if (ident.loggedInUsers === undefined && !gitHubToken) {
                job.error = 'a credential-free session needs a stored Copilot login (copilot login) or COPILOT_GITHUB_TOKEN; GH_TOKEN and GITHUB_TOKEN are removed from it';
                return 'failed';
            }
            scrubDir = mkdtempSync(join(tmpdir(), 'omg-lane-nocreds-'));
            // The relocated global config holds only the seeded identity (no credential helper): keep it so the lane still commits.
            const identityConfig = env.GIT_CONFIG_GLOBAL;
            scrubLaneCredentials(env, scrubDir);
            env.GIT_CONFIG_GLOBAL = identityConfig;
        }
        const policy = {
            cwd: job.workCwd,
            // The job's temp dir only: the runtime's file tools run unsandboxed and must not reach events.jsonl, nor what
            // the runtime reads back from the job home (config.json, session state, policies, logs, the package cache).
            stateRoot: env.TEMP,
            pluginRoot,
            readRoots: [job.home],
            mcpServer: MCP_SERVER,
            platform: deps.platform,
        };
        const protectedRoot = job.worktree?.path ?? job.ledgerCwd;
        const onPermissionRequest = (req) => {
            let decision = req.requestSandboxBypass === true || req.requestSandboxPermissive === true
                ? { approve: false, reason: 'sandbox bypass requests are never approved' }
                : decideSdkPermission(req, policy);
            if (decision.approve && req.kind === 'write') {
                const raw = [req.resolvedPath, req.path, req.fileName].find((v) => typeof v === 'string' && v.trim() !== '');
                const rel = raw ? relativeInside(isAbsolute(raw) ? raw : resolve(job.workCwd, raw), protectedRoot) : null;
                if (rel && protectedChanges([rel], job.extraProtected).length > 0)
                    decision = { approve: false, reason: `protected merge-rule path ${rel}` };
                // Defence in depth for a job dir inside cwd (isolation "none"): of the job dir only the temp dir is writable.
                if (decision.approve && raw) {
                    const abs = isAbsolute(raw) ? raw : resolve(job.workCwd, raw);
                    let jobState = true;
                    try {
                        jobState = isUnderRoot(abs, job.jobDir, deps.platform) && !isUnderRoot(abs, env.TEMP, deps.platform);
                    }
                    catch { /* unresolvable: refuse */ }
                    if (jobState)
                        decision = { approve: false, reason: `write into the job's state dir ${job.jobDir}` };
                }
            }
            if (decision.approve && job.profile === 'review') {
                const denial = reviewProfileDenial(req);
                const mode = job.sandbox?.mode;
                if (denial)
                    decision = { approve: false, reason: denial };
                else if (req.kind === 'shell') {
                    // A review session gets a shell only in an enforced sandbox; detect-only is for write sessions.
                    decision = mode === 'enforced'
                        ? reviewShellAllowlist(req, { cwd: job.workCwd, platform: deps.platform })
                        : { approve: false, reason: 'review profile: no shell without a confirmed sandbox' };
                }
            }
            if (decision.approve)
                return { kind: 'approve-once' };
            job.denied.push({ kind: String(req.kind), reason: decision.reason });
            if (job.denied.length > DENIED_LOG_MAX)
                job.denied.splice(0, job.denied.length - DENIED_LOG_MAX);
            return { kind: 'reject', feedback: `copilot_run policy: ${decision.reason}` };
        };
        let onIdle = () => { };
        let onShutdown = () => { };
        let sent = false;
        let idle = new Promise((r) => { onIdle = r; });
        const shutdown = new Promise((r) => { onShutdown = r; });
        const toolNames = new Map();
        let eventsFd = null;
        const onEvent = (event) => {
            if (eventsFd !== null) {
                try {
                    writeSync(eventsFd, `${scrubTokens(JSON.stringify({ at: new Date().toISOString(), ...event }), job.secrets)}\n`);
                }
                catch { /* evidence only */ }
            }
            const data = (event.data ?? {});
            switch (event.type) {
                case 'tool.execution_start':
                    if (typeof data.toolCallId === 'string' && typeof data.toolName === 'string')
                        toolNames.set(data.toolCallId, data.toolName);
                    break;
                case 'tool.execution_complete': {
                    // Attestation (§5): a shell call must report sandboxed: true. A call of an unknown tool must not
                    // report false, and in an enforced session it must report true (a missing field is an escape).
                    const id = String(data.toolCallId ?? '');
                    const name = toolNames.get(id) ?? (typeof data.toolName === 'string' ? data.toolName : null);
                    toolNames.delete(id);
                    const sbx = job.sandbox;
                    const escaped = name === null
                        ? (sbx?.mode === 'enforced' ? data.sandboxed !== true : data.sandboxed === false)
                        : SANDBOX_SHELL_TOOLS.has(name) && data.sandboxed !== true;
                    if (sbx && escaped) {
                        sbx.unsandboxedCalls += 1;
                        if (sbx.mode !== 'detect-only' && !job.stopReason) {
                            job.error = `sandbox-escaped: ${name ?? 'a tool'} call ${id || '?'} ran outside the sandbox (sandboxed: ${String(data.sandboxed)}); the session was stopped`;
                            job.requestStop('sandbox-escaped');
                        }
                    }
                    break;
                }
                case 'session.idle':
                    if (sent)
                        onIdle();
                    break;
                case 'assistant.message':
                    if (typeof data.content === 'string' && data.content.trim())
                        job.finalText = scrubTokens(data.content, job.secrets);
                    break;
                case 'assistant.usage':
                    job.usage.credits += usageCredits(event);
                    if (data.initiator === 'user')
                        job.usage.premiumRequests += 1;
                    if (typeof data.model === 'string' && !job.model)
                        job.model = data.model;
                    if (job.usage.credits >= job.maxCredits)
                        job.requestStop('capped');
                    this.recordBudget(job, 0);
                    break;
                case 'session.shutdown':
                    if (typeof data.totalPremiumRequests === 'number') {
                        job.usage.premiumRequests = data.totalPremiumRequests;
                        job.usage.measured = true;
                    }
                    if (typeof data.totalNanoAiu === 'number')
                        job.usage.credits = data.totalNanoAiu / NANO_AIU_PER_CREDIT;
                    if (typeof data.currentModel === 'string')
                        job.model = data.currentModel;
                    onShutdown();
                    break;
                case 'session.error':
                case 'model.turn_failed':
                    job.error = String(data.message ?? data.error ?? data.reason ?? event.type).slice(0, 500);
                    break;
                default:
                    break;
            }
        };
        const { CopilotClient, RuntimeConnection } = loaded.module;
        const cap = Math.max(RUNTIME_MIN_MAX_CREDITS, Math.ceil(job.maxCredits));
        const client = new CopilotClient({
            connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(cap)], env }),
            baseDirectory: job.home,
            workingDirectory: job.workCwd,
        });
        // events.jsonl is opened once, before the runtime starts (client.start()),
        // and written only through this fd: O_EXCL refuses a name that already
        // exists (a planted link included), and a later rename or replace of the
        // name cannot redirect the writes. Job ids are fresh, so an existing file fails the job.
        try {
            eventsFd = openAppendExclusive(job.eventsPath);
        }
        catch (err) {
            if (scrubDir)
                rmSync(scrubDir, { recursive: true, force: true });
            job.error = `events log ${job.eventsPath}: ${errText(err)}`;
            return 'failed';
        }
        let session = null;
        let pid;
        let outcome = 'failed';
        try {
            // A stop (cancel, server exit) during a slow start goes straight to the teardown.
            await withTimeout(Promise.race([client.start(), job.stopped]), START_TIMEOUT_MS, 'client.start()');
            pid = runtimePid(client);
            job.pid = pid;
            if (pid) {
                const identify = deps.processIdentity ?? ((p) => getProcessStartIdentity(p, Date.now() + IDENTITY_TIMEOUT_MS));
                // A stop during the read goes straight to the teardown; a late identity is still recorded.
                const reading = identify(pid).catch(() => null).then((id) => { job.pidIdentity = id; });
                await Promise.race([reading, job.stopped]);
            }
            // The sandbox is decided before the session exists: a refused job creates none.
            const sandboxConfig = job.stopReason ? null : await this.decideSandbox(job, client, loaded, pluginRoot);
            const refused = () => job.sandbox?.mode === 'refused' && sandboxConfig === null;
            if (!job.stopReason && !refused()) {
                const atCreate = sandboxConfig !== null && sdkCreateSessionAcceptsSandbox(loaded);
                // Review: the shell tools only while an enforced sandbox is still possible (confirmSandbox hides them on a downgrade).
                const shell = sandboxConfig !== null;
                session = await withTimeout(client.createSession({
                    onPermissionRequest,
                    onEvent,
                    pluginDirectories: [pluginRoot],
                    workingDirectory: job.workCwd,
                    disabledMcpServers: ['github-mcp-server'],
                    // The explicit Copilot credential over the session RPC, never in the env shell children inherit.
                    ...(gitHubToken ? { gitHubToken } : {}),
                    excludedTools: buildSdkExcludedTools(MCP_SERVER),
                    ...(job.profile === 'review' ? { availableTools: [...REVIEW_READ_TOOLS, ...(shell ? REVIEW_SHELL_TOOLS : [])] } : {}),
                    ...(atCreate ? { sandboxConfig } : {}),
                    ...(job.model ? { model: job.model } : {}),
                }), RPC_TIMEOUT_MS, 'createSession()');
                job.sessionId = session.sessionId;
                if (sandboxConfig)
                    await this.confirmSandbox(job, session, sandboxConfig, atCreate);
            }
            if (job.sandbox?.mode === 'refused') {
                job.error = `sandbox-unavailable: ${job.sandbox.reason ?? 'the sandbox is not confirmed'}`;
            }
            else if (session && !job.stopReason) {
                job.status = 'running';
                sent = true;
                await withTimeout(session.send({ prompt: job.prompt }), RPC_TIMEOUT_MS, 'send()');
                const winner = await Promise.race([idle.then(() => 'idle'), job.stopped.then(() => 'stop')]);
                if (winner === 'stop') {
                    const s = session;
                    idle = new Promise((r) => { onIdle = r; });
                    try {
                        await withTimeout(s.abort(), RPC_TIMEOUT_MS, 'abort()');
                    }
                    catch { /* best effort */ }
                    await settleWithin(idle, ABORT_GRACE_MS);
                }
            }
            outcome = job.stopReason === 'timeout'
                ? 'timeout'
                : job.stopReason === 'cancelled'
                    ? 'cancelled'
                    : job.stopReason === 'capped' || job.stopReason === 'sandbox-escaped' || job.sandbox?.mode === 'refused'
                        ? 'failed'
                        : 'completed';
            if (job.stopReason === 'capped')
                job.error = `credit cap ${job.maxCredits} reached (${job.usage.credits.toFixed(2)} AI credits); the turn was aborted`;
            if (job.stopReason === 'timeout')
                job.error = `timed out after ${job.timeoutMs} ms; the turn was aborted`;
        }
        catch (err) {
            outcome = job.stopReason === 'cancelled' ? 'cancelled' : 'failed';
            job.error = errText(err);
        }
        finally {
            if (session) {
                try {
                    await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()');
                }
                catch { /* runtime gone */ }
                // session.shutdown (the billing totals) is emitted while the session closes.
                await settleWithin(shutdown, SHUTDOWN_GRACE_MS);
                try {
                    await withTimeout(client.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()');
                }
                catch { /* best effort */ }
            }
            pid ??= runtimePid(client);
            job.pid = pid;
            // A session's shell may have left children (a detached one survives a
            // clean client.stop()): kill the runtime's whole tree while it is still
            // their parent, clean end or not, before any host git reads the worktree.
            // Without a session no tool ran, so the plain stop below is enough.
            if (session && pid && deps.isAlive(pid)) {
                try {
                    deps.killTree(pid);
                }
                catch { /* best effort; host git pins its git dir anyway */ }
            }
            let stopped = false;
            try {
                await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()');
                stopped = true;
            }
            catch { /* escalate */ }
            if (!stopped) {
                if (pid && deps.isAlive(pid))
                    deps.killTree(pid);
                try {
                    await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()');
                }
                catch { /* gone */ }
            }
            if (pid && deps.isAlive(pid))
                deps.killTree(pid);
            // The runtime is gone: no event follows, and a late one must not reach a reused fd number.
            const fd = eventsFd;
            eventsFd = null;
            if (fd !== null)
                closeSync(fd);
            if (scrubDir)
                rmSync(scrubDir, { recursive: true, force: true });
            // The final totals: a few retries if a hook holds the ledger lock.
            for (let i = 0; i < 10 && !this.recordBudget(job, 200); i++)
                await sleep(50);
            // The per-job COPILOT_HOME holds the session state and logs; kept when the job did not complete.
            if (outcome === 'completed') {
                try {
                    rmSync(job.home, { recursive: true, force: true });
                }
                catch { /* best effort */ }
            }
        }
        return outcome;
    }
    /**
     * Probe the host and set `job.sandbox` (§5). Returns the config to apply
     * when the host supports the sandbox (the mode stays the unconfirmed one
     * until confirmSandbox), else null with the final mode: `detect-only` when
     * the sandbox is switched off, otherwise the fail-closed mode.
     */
    async decideSandbox(job, client, loaded, pluginRoot) {
        const { deps } = this;
        let cliVersion = 'unknown';
        try {
            const status = await withTimeout(client.getStatus(), RPC_TIMEOUT_MS, 'getStatus()');
            if (typeof status.version === 'string')
                cliVersion = status.version;
        }
        catch { /* recorded as unknown */ }
        const host = await probeHostSupport(client, RPC_TIMEOUT_MS, { platform: deps.platform, ...(deps.sandboxTrialLaunch ? { trialLaunch: deps.sandboxTrialLaunch } : {}) });
        const base = { host, applied: 'none', canary: 'skipped', unsandboxedCalls: 0, cliVersion, sdkVersion: loaded.version ?? 'unknown' };
        const settings = job.sandboxSettings;
        const off = !settings.enabled ? 'sandbox.enabled is false' : deps.env[SANDBOX_KILL_ENV] === 'off' ? `${SANDBOX_KILL_ENV}=off` : null;
        if (off) {
            // detect-only applies to write sessions only: a review without an enforced sandbox has no shell.
            if (job.profile === 'review') {
                job.sandbox = { ...base, mode: 'read-only-no-shell', reason: off };
                job.notes.push(`sandbox: switched off (${off}); the review runs read-only without a shell.`);
            }
            else {
                job.sandbox = { ...base, mode: 'detect-only', reason: off };
                job.notes.push(`sandbox: switched off (${off}); this session is not OS-sandboxed (detect-only).`);
            }
            return null;
        }
        const fallback = (reason) => {
            job.sandbox = { ...base, mode: unconfirmedMode(job.profile, settings), reason };
            if (job.sandbox.mode === 'detect-only')
                job.notes.push(`sandbox: not available (${reason}); writeUnsandboxed "detect-only" runs this session unsandboxed.`);
            if (job.sandbox.mode === 'read-only-no-shell')
                job.notes.push(`sandbox: not available (${reason}); the review runs read-only without a shell.`);
        };
        if (!host.supported) {
            fallback(host.reason ?? 'the host does not support the sandbox');
            return null;
        }
        const top = job.worktree?.path ?? git(job.workCwd, ['rev-parse', '--show-toplevel']) ?? job.workCwd;
        // A job worktree's git dirs come from the links recorded at creation, never from discovery.
        const commonRaw = job.worktree ? job.commonGitDir : git(job.workCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const gitDirRaw = job.worktree ? job.worktreeLinks?.adminDir ?? null : git(job.workCwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
        try {
            const commonGitDir = commonRaw ? resolve(commonRaw) : resolve(top, '.git');
            const config = buildSandboxConfig(job.profile, {
                worktree: resolve(top),
                commonGitDir,
                ...(gitDirRaw ? { gitDir: resolve(gitDirRaw) } : {}),
                pluginRoot,
                jobHome: job.home,
                jobDir: job.jobDir,
                realHome: (deps.realHome ?? (() => userInfo().homedir))(),
                platform: deps.platform,
                settings,
                hostCommits: job.hostCommits,
                toolPaths: (deps.toolPaths ?? laneToolPaths)(deps.env, deps.platform),
            }, host);
            job.sandbox = { ...base, mode: unconfirmedMode(job.profile, settings), reason: 'not confirmed yet' };
            return config;
        }
        catch (err) {
            fallback(errText(err));
            return null;
        }
    }
    /** Apply `config` (unless createSession took it) and read the enforcement status; downgrade to the fail-closed mode on any doubt. */
    async confirmSandbox(job, session, config, atCreate) {
        const sbx = job.sandbox;
        let why = atCreate ? null : await applySandboxConfig(session, config, RPC_TIMEOUT_MS);
        if (!why) {
            sbx.applied = atCreate ? 'create' : 'options.update';
            const enf = await readEnforcement(session, RPC_TIMEOUT_MS);
            if (typeof enf === 'string')
                why = enf;
            else {
                sbx.enforcement = enf;
                if (enf.blocked)
                    why = `sandbox enforcement is blocked${enf.reason ? `: ${enf.reason}` : ''}`;
            }
        }
        if (!why) {
            sbx.mode = 'enforced';
            delete sbx.reason;
            return;
        }
        sbx.mode = unconfirmedMode(job.profile, job.sandboxSettings);
        sbx.reason = why;
        if (sbx.mode === 'detect-only')
            job.notes.push(`sandbox: not confirmed (${why}); writeUnsandboxed "detect-only" runs this session unsandboxed.`);
        if (sbx.mode === 'read-only-no-shell') {
            job.notes.push(`sandbox: not confirmed (${why}); the review runs read-only without a shell.`);
            // The permission handler already refuses every shell call; this also hides the tools.
            try {
                await withTimeout(session.rpc.options?.update?.({ availableTools: [...REVIEW_READ_TOOLS] }) ?? Promise.resolve(), RPC_TIMEOUT_MS, 'options.update()');
            }
            catch { /* the handler still refuses */ }
        }
    }
    snapshot(job) {
        const usage = {
            premiumRequests: job.usage.premiumRequests,
            credits: Number(job.usage.credits.toFixed(3)),
            source: job.usage.measured ? 'measured' : 'estimated',
            summary: `${formatAmount(job.usage.premiumRequests, 'premiumRequests')}, ${formatAmount(Number(job.usage.credits.toFixed(3)), 'credits')}`,
        };
        const scrub = (text) => scrubTokens(text, job.secrets);
        return {
            jobId: job.id,
            status: job.status,
            // Set as soon as a stop is asked for: a cancel that returns while the teardown runs still shows it.
            stopRequested: job.stopReason,
            isolation: job.isolation,
            profile: job.profile,
            ...(job.startRef !== null ? { startRef: job.startRef } : {}),
            cwd: job.cwd,
            workingDirectory: job.workCwd,
            model: job.model,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            timeoutMs: job.timeoutMs,
            maxCredits: job.maxCredits,
            sessionId: job.sessionId,
            // Lane output reaches state, PR comments and the ledger from here: no token passes.
            finalText: job.finalText === null ? null : scrub(job.finalText),
            error: job.error === null ? null : scrub(job.error),
            usage,
            ...(job.worktree ? { worktree: { ...job.worktree, baseCommit: job.baseCommit, removed: job.cleanedUp, ...(job.headCommit ? { headCommit: job.headCommit } : {}) } } : {}),
            ...(job.changes ? { changes: job.changes } : {}),
            ...(job.denied.length ? { deniedPermissions: job.denied.map((d) => ({ kind: d.kind, reason: scrub(d.reason) })) } : {}),
            ...(job.notes.length ? { notes: job.notes.map(scrub) } : {}),
            eventsPath: job.eventsPath,
            ...(job.pid ? { runtime: { pid: job.pid, identity: job.pidIdentity } } : {}),
            ...(job.sandbox ? { sandbox: { ...job.sandbox, host: { ...job.sandbox.host, capabilities: { ...job.sandbox.host.capabilities } } } } : {}),
        };
    }
}
//# sourceMappingURL=job.js.map