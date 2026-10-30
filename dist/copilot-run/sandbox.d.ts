/**
 * OS sandbox plumbing for copilot_run sessions
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §3-§6).
 *
 * The Copilot runtime confines shell commands and local MCP/LSP servers in
 * Microsoft Execution Containers when a session carries a `sandboxConfig`.
 * SDK 1.0.16 has no createSession field for it, so the config goes through
 * `session.rpc.options.update` before the first turn; an SDK whose
 * createSession forwards the field gets it at create
 * (sdkCreateSessionAcceptsSandbox).
 *
 * Fail closed (§3): a review session without a confirmed sandbox runs with no
 * shell tool, a write session refuses with `sandbox-unavailable` unless
 * `writeUnsandboxed: "detect-only"` is set, and a shell call the runtime
 * reports as not sandboxed stops the session with `sandbox-escaped`.
 */
export type SandboxMode = 'enforced' | 'read-only-no-shell' | 'detect-only' | 'refused';
export type SandboxProfile = 'write' | 'review';
export interface SandboxHostRecord {
    supported: boolean;
    reason?: string;
    capabilities: Record<string, boolean>;
    /** The runtime reported support but the trial launch failed (Linux); `reason` says why. */
    launchFailed?: true;
}
/** `CopilotRunSnapshot.sandbox` (§5). */
export interface CopilotRunSandboxState {
    mode: SandboxMode;
    host: SandboxHostRecord;
    applied: 'create' | 'options.update' | 'none';
    enforcement?: {
        required: boolean;
        blocked: boolean;
        reason?: string;
    };
    /** PR 1 runs no canary: confirmation rests on host support, the applied config, enforcement and the per-call attestation. */
    canary: 'passed' | 'failed' | 'skipped';
    /** Shell calls the runtime reported as not sandboxed. */
    unsandboxedCalls: number;
    cliVersion: string;
    sdkVersion: string;
    /** Why the mode is not `enforced`. */
    reason?: string;
}
/** Shell tools whose `tool.execution_complete` must carry `sandboxed: true` in an enforced session. */
export declare const SANDBOX_SHELL_TOOLS: ReadonlySet<string>;
/** The built-in tools a review session keeps: view, search, and the turn bookkeeping tools. */
export declare const REVIEW_READ_TOOLS: readonly string[];
/** The shell tools a review session adds when its sandbox is confirmed (no write_* input to a running shell). */
export declare const REVIEW_SHELL_TOOLS: readonly string[];
export interface SandboxSettings {
    /** false = detect-only for every session (recorded, with a warning). */
    enabled: boolean;
    reviewUnsandboxed: 'no-shell' | 'refuse';
    writeUnsandboxed: 'refuse' | 'detect-only';
    writeNetwork: 'none' | 'registry';
    allowedHosts: string[];
    extraReadonlyPaths: string[];
    extraReadwritePaths: string[];
}
export declare const DEFAULT_SANDBOX_SETTINGS: Readonly<SandboxSettings>;
/** The env kill switch (§6): honoured from the MCP server's / engine's env only, never from repo config. */
export declare const SANDBOX_KILL_ENV = "OMG_SANDBOX";
export type SandboxScope = 'copilot-run' | 'factory';
/** Merge a block over the defaults; ill-typed fields are rejected, not ignored. */
export declare function resolveSandboxSettings(raw: Record<string, unknown>, source?: string): SandboxSettings;
export interface SandboxConfigLayers {
    /** The user config at its default location (userConfigLayers().trustedUser). */
    user: unknown;
    /** The working-tree project config (`.copilot/omg.jsonc`). */
    project: unknown;
}
/**
 * The settings for a session in `root`: the user config, then the project
 * config, which may only tighten (§6, the `ship.*` trust split): it can set
 * `enabled: true`, `reviewUnsandboxed: "refuse"`, `writeUnsandboxed:
 * "refuse"` and `writeNetwork: "none"`, never the looser values, hosts or
 * extra paths. A malformed block throws.
 */
export declare function loadSandboxSettings(root: string, scope: SandboxScope, layers?: SandboxConfigLayers): {
    settings: SandboxSettings;
    warnings: string[];
};
/** The SDK's SandboxConfig (rpc.d.ts), the fields this module sets. */
export interface SandboxConfig {
    enabled: boolean;
    addCurrentWorkingDirectory: boolean;
    allowBypass: false;
    allowDevToolAccess: false;
    sandboxMcpServers: true;
    sandboxLspServers: true;
    auth: {
        git: false;
        gh: false;
    };
    userPolicy: {
        filesystem: {
            readwritePaths: string[];
            readonlyPaths: string[];
            deniedPaths?: string[];
        };
        network: {
            allowOutbound: boolean;
            allowLocalNetwork: boolean;
            allowedHosts?: string[];
        };
    };
}
export interface SandboxPolicyContext {
    worktree: string;
    commonGitDir: string;
    /** The session's own git dir (`<commonGitDir>/worktrees/<name>` for a linked worktree). */
    gitDir?: string;
    pluginRoot: string;
    /** The job's COPILOT_HOME (and relocated profile). */
    jobHome: string;
    /** The job's state directory (events, home). */
    jobDir: string;
    /** The account's real home (os.userInfo, not HOME / USERPROFILE). */
    realHome: string;
    platform: NodeJS.Platform;
    settings: SandboxSettings;
    /** The host commits for a write session (omg factory run): the common git dir is read-only as a whole (§4.3). */
    hostCommits?: boolean;
    /** The node and git install dirs a lane launches from (laneToolPaths), granted read-only. */
    toolPaths?: string[];
    /** The account's uid (Linux/macOS): `/run/user/<uid>` holds its D-Bus, systemd and agent sockets. */
    uid?: number;
    /** The engine's SSH_AUTH_SOCK: the agent socket's dir is denied (Linux/macOS). */
    sshAuthSock?: string;
}
export declare const REGISTRY_HOSTS: readonly string[];
/**
 * The read-write carve-outs of the read-only common git dir for a write
 * session: `objects/` and its own `worktrees/<name>` admin dir. No ref is
 * granted: the job worktree's HEAD is detached, so a commit writes only the
 * admin dir's HEAD, index and logs/HEAD, and the host moves the job's branch
 * after the session (job.ts syncJobBranch). One job cannot rewrite another
 * job's branch. Without a linked worktree (isolation "none") the git dir is
 * the common dir and only `objects/` is granted: the session cannot commit,
 * it fails closed.
 *
 * The grants are directories, and git writes by lock and rename (`index.lock`
 * then `index`, `HEAD.lock` then `HEAD`), which needs create and rename rights
 * in the directory itself. The admin dir's `commondir`, `gitdir` and
 * `config.worktree` files and the worktree's `.git` file are read-only
 * entries nested in those grants (buildSandboxConfig): on Copilot CLI 1.0.105
 * on Windows the sandbox then refuses writing, renaming over and deleting
 * them, but it cannot protect a name that does not exist yet. The
 * host also records them at creation (config.worktree as a hash, absent counts)
 * and runs no git in the worktree once they differ (git-worktree.ts
 * worktreeGitLinksIntact, and runHostGit before every command), with every host git call
 * hardened (hostGitHardeningArgs) and pointed at the recorded git dir.
 * `objects/info/alternates` is writable for the same reason: it only adds
 * places to look objects up, runs no code, and cannot forge an object,
 * because git names every object by the hash of its content.
 */
export declare function laneGitWritePaths(ctx: Pick<SandboxPolicyContext, 'commonGitDir' | 'gitDir' | 'platform'>): string[];
/**
 * The sandboxConfig for a session. `review` is §4.2 exactly. `write` with
 * `hostCommits` (omg factory run, whose engine commits after the lane) is
 * §4.3: the common git dir is read-only as a whole, so the session cannot
 * stage, commit or write any git file. `write` without it (a copilot_run job
 * that commits in its worktree) keeps the common git dir read-only except
 * what a commit on its detached HEAD writes (laneGitWritePaths). Either way
 * config, hooks, info, packed-refs and every ref stay read-only: the session
 * cannot plant core.hooksPath, core.fsmonitor or a hook for host-side git.
 * `deniedPaths` is sent only when the host reports `denied_paths`. An extra
 * read-write path outside the worktree throws. The tool dirs (`toolPaths`)
 * are read-only in both profiles; one that holds the real home, the worktree,
 * the common git dir or the job dir (a `D:\dev\node.exe` with every repo
 * beside it), or is a filesystem root, is dropped.
 */
export declare function buildSandboxConfig(profile: SandboxProfile, ctx: SandboxPolicyContext, host: SandboxHostRecord): SandboxConfig;
/** The host lookups behind laneToolPaths (a test seam). */
export interface ToolPathProbe {
    /** The engine's own node binary (process.execPath). */
    execPath: string;
    /** `name` resolved on the lane's PATH, or null. */
    which: (name: string) => string | null;
    /** `<git> --exec-path`, or null. */
    gitExecPath: (git: string) => string | null;
    realpath: (p: string) => string;
}
/**
 * `name` on `env`'s PATH (PATHEXT on win32), or null. Empty and relative
 * entries are skipped, and so is any entry under a `node_modules` dir (npx
 * and npm scripts put `node_modules/.bin` first, so a package's shim would
 * stand in for the host git that `git --exec-path` runs).
 */
export declare function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists?: (p: string) => boolean): string | null;
/**
 * The install dirs of the programs every lane starts: node (the plugin
 * hooks and the `t` MCP server run `node`) and git. With
 * `allowDevToolAccess` off the runtime grants no PATH entry, and on Windows
 * MXC then denies launching `C:\Program Files\nodejs\node.exe`; on Linux
 * and macOS the system dirs stay granted, so this matters there for a
 * toolchain outside them (nvm, the runner's tool cache, Homebrew's Cellar).
 * They are granted read-only, never read-write, and by name rather than all
 * of PATH (allowDevToolAccess): PATH entries can be per-user dirs that hold
 * config or credentials, and a lane needs only these two programs.
 *
 * node: the dir of the engine's own binary and of the `node` the lane's
 * PATH resolves to (both, realpath and link). git: Git for Windows's install
 * root (`<root>\cmd\git.exe` launches `<root>\mingw64\bin\git.exe`, which
 * runs `<root>\usr\bin\sh.exe` for hooks), found from `git --exec-path`
 * (`<root>\mingw64\libexec\git-core`) and kept only when the PATH git lies
 * under it; elsewhere the git binary's dir and its exec path.
 */
export declare function laneToolPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, probe?: ToolPathProbe): string[];
/** `<root>\usr\bin\sh.exe`, the shell Git for Windows runs hooks with, for the git on `env`'s PATH; or null. */
export declare function gitForWindowsShell(env: NodeJS.ProcessEnv, probe?: ToolPathProbe): string | null;
/** Runs `cmd args` to completion, shaped like spawnSync's result. */
export type SandboxTrialSpawner = (cmd: string, args: readonly string[], timeoutMs: number) => {
    error?: Error;
    status: number | null;
    stderr: string;
};
/**
 * The trial launch: bwrap with the namespaces the runtime's Linux sandbox
 * creates, network included (`--unshare-all`; policies without outbound
 * access get an empty net namespace), around `true`.
 */
export declare const BWRAP_TRIAL_ARGS: readonly string[];
/**
 * Whether bwrap can launch a process here: null when it can, else why not.
 * `sandbox.getHostSupport` reports a host with bwrap installed as supported
 * even where unprivileged user namespaces lack capabilities (Ubuntu 24.04's
 * AppArmor default), and there every sandboxed launch fails.
 */
export declare function bwrapTrialLaunchError(spawn?: SandboxTrialSpawner, timeoutMs?: number): string | null;
/** bwrapTrialLaunchError with the real bwrap, run once per process. */
export declare function cachedBwrapTrialLaunchError(): string | null;
export interface HostLaunchCheck {
    /** Default process.platform; the trial launch runs on linux only. */
    platform?: NodeJS.Platform;
    /** Test seam: the trial launch (default cachedBwrapTrialLaunchError). */
    trialLaunch?: () => string | null;
}
/**
 * `client.rpc.sandbox.getHostSupport()`; supported only with the `shell`
 * capability and, on Linux, a trial bwrap launch that succeeds.
 */
export declare function probeHostSupport(client: unknown, timeoutMs: number, launch?: HostLaunchCheck): Promise<SandboxHostRecord>;
/** `session.rpc.options.update({ sandboxConfig })`; null when applied, else why not. */
export declare function applySandboxConfig(session: unknown, config: SandboxConfig, timeoutMs: number): Promise<string | null>;
/** `session.rpc.sandbox.getEnforcementStatus()`, or why it could not be read. */
export declare function readEnforcement(session: unknown, timeoutMs: number): Promise<NonNullable<CopilotRunSandboxState['enforcement']> | string>;
/**
 * What a session runs as when its sandbox is not confirmed (§3):
 * review -> `read-only-no-shell` (or `refused` with reviewUnsandboxed
 * "refuse"), write -> `refused` (or `detect-only` with writeUnsandboxed
 * "detect-only").
 */
export declare function unconfirmedMode(profile: SandboxProfile, settings: SandboxSettings): SandboxMode;
/**
 * Caller variables the runtime keeps (case-insensitive); everything else,
 * secrets included, is dropped. No credential passes: the runtime's env is
 * what its shell children inherit, so COPILOT_GITHUB_TOKEN goes to the
 * session over RPC instead (sessionGitHubToken).
 */
export declare const SESSION_ENV_ALLOWLIST: readonly string[];
/**
 * The variables the Windows sandbox (MXC) needs to launch any process,
 * hook or shell, with the runtime's env taken verbatim
 * (`inheritDefaultEnv` false): presence only, the value is not checked.
 * Copilot CLI 1.0.105 rejects a launch without them ("policy_validation:
 * ... missing the required variable(s)"). In runtime.node 1.0.105 only
 * SYSTEMROOT sits next to that message; LOCALAPPDATA comes from separate MXC
 * strings ("LOCALAPPDATA and USERPROFILE both unset", "no user-profile
 * grants: %LOCALAPPDATA% is unset ... Programs") and from the live error.
 * SystemRoot locates the system DLLs, LOCALAPPDATA the container's profile.
 */
export declare const MXC_REQUIRED_ENV: readonly string[];
/** The {@link MXC_REQUIRED_ENV} names `env` lacks (or holds blank) on win32; none elsewhere. */
export declare function missingSandboxEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[];
/**
 * The explicit Copilot credential for the session's `gitHubToken` option
 * (SDK 1.0.16 SessionConfig: sent over the session RPC, never put in the
 * runtime's env, unlike the client-level option).
 */
export declare function sessionGitHubToken(env: NodeJS.ProcessEnv): string | undefined;
/** The token values in the caller's env that lane output must never carry. */
export declare function secretValues(env: NodeJS.ProcessEnv): string[];
/**
 * `text` with every GitHub token shape and every exact `secrets` value
 * replaced by `[redacted]`. It matches literal text only: a token that is
 * base64-encoded, URL-encoded, split across lines or events, or otherwise
 * transformed passes through unredacted.
 */
export declare function scrubTokens(text: string, secrets: readonly string[]): string;
/**
 * The relocated profile variables, all under `<jobHome>/profile`, and the
 * temp variables, `<jobHome>/tmp` (the caller creates it). The runtime
 * grants the sandbox read-write on the dir its own TEMP names ("temporary
 * storage" in the SDK's allowDevToolAccess doc; the host value was the
 * user's whole %TEMP%, other jobs' homes and repositories included), and
 * no temp dir at all when that dir is missing. The temp and profile dirs
 * are lane-writable (buildSandboxConfig), so nothing the unsandboxed
 * runtime loads code or config from sits in them: the global git config
 * (the runtime runs git itself, and core.fsmonitor or a filter driver would
 * run unsandboxed) is read-only in `<jobHome>/git`, the package cache sits
 * in `<jobHome>/.cache`, and node's compile cache, which defaults to the
 * temp dir, is off.
 */
export declare function relocatedProfileEnv(jobHome: string): Record<string, string>;
/**
 * The runtime env from buildSessionEnv's output: allowlisted caller
 * variables, `LC_*`, the variables the job sets (COPILOT_HOME, the
 * SMOKE_SET_ENV flags, OMC_* — buildSessionEnv already stripped the
 * caller's), and the relocated profile. NODE_OPTIONS, GH_TOKEN, GITHUB_TOKEN,
 * cloud and npm tokens never pass.
 */
export declare function allowlistSessionEnv(env: NodeJS.ProcessEnv, jobHome: string): NodeJS.ProcessEnv;
//# sourceMappingURL=sandbox.d.ts.map