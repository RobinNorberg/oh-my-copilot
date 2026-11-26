/**
 * OS sandbox plumbing for copilot_run sessions
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §3-§6).
 *
 * The Copilot runtime confines shell commands and local MCP/LSP servers in
 * Microsoft Execution Containers when a session carries a sandbox config.
 * SDK v2 takes it at create (`permissions.sandbox`); a live session takes it
 * through `session.rpc.options.update({ permissions: { sandbox } })`
 * ({@link applySandboxConfig}, the smoke canaries).
 *
 * Fail closed (§3): a review session without a confirmed sandbox runs with no
 * shell tool, a write session refuses with `sandbox-unavailable` unless
 * `writeUnsandboxed: "detect-only"` is set, and a shell call the runtime
 * reports as not sandboxed stops the session with `sandbox-escaped`.
 */
import { findOnPath } from '../utils/windows-search.js';
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
    /** `sandbox.getState().configSource` once the state confirmed the policy in force. */
    configSource?: string;
    /** PR 1 runs no canary: confirmation rests on host support, the applied config, enforcement and the per-call attestation. */
    canary: 'passed' | 'failed' | 'skipped';
    /** Shell calls the runtime reported as not sandboxed. */
    unsandboxedCalls: number;
    /**
     * The `sandbox-escaped:` error when a confirmed (`enforced`) sandbox was
     * switched off, opted out or weakened mid-session (the
     * `session.sandbox_state_changed` tripwire). A shell call started after it
     * and killed before its completion event is never counted, so this, not
     * `unsandboxedCalls`, is the escape record (absent in older records).
     */
    stateEscaped?: string;
    cliVersion: string;
    sdkVersion: string;
    /** The write session's writeNetwork setting as it ran (absent for a review session and in older records). */
    writeNetwork?: SandboxSettings['writeNetwork'];
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
/**
 * `factory.run.sandbox.gates`: how `omg factory run` runs the PR's own code in
 * prepare's checks and the local gate. `enforced` runs each command in the
 * write-profile OS sandbox (and falls back to `ack` where it cannot);
 * `ack` runs it unsandboxed only after `--allow-unsandboxed-gates` named the
 * head; `unsandboxed` runs it unsandboxed with a warning.
 */
export type GatesSandboxMode = 'enforced' | 'ack' | 'unsandboxed';
export declare const GATES_SANDBOX_MODES: readonly GatesSandboxMode[];
/** The trusted layers `factory.run.sandbox.gates` is read from: never the working tree or the PR head. */
export interface GatesSandboxLayers {
    /** The user config at its default location (userConfigLayers().trustedUser). */
    user: unknown;
    /** The `.copilot/omg.jsonc` committed at the run's verified base sha (undefined when not read). */
    base: unknown;
    /** The engine's own environment: {@link SANDBOX_KILL_ENV}=off maps to `ack` (a park per head, never a plain run by itself). */
    env: NodeJS.ProcessEnv;
}
/**
 * The gates mode and where it came from. The kill switch wins, then the user
 * config, then the base's committed config, then `enforced`. The base may set
 * `enforced` or `ack` but never `unsandboxed` (the PR's repository must not
 * switch the sandbox off for its own code): that throws, as does any other
 * value.
 */
export declare function resolveGatesSandboxMode(layers: GatesSandboxLayers): {
    mode: GatesSandboxMode;
    source: string;
};
/**
 * `factory.run.sandbox.requireDeniedPaths`: a sandboxed gate on a host that
 * does not report `denied_paths` (Windows today) runs and counts by default,
 * with the credential files under the user profile readable; `true` makes
 * such a host give no verdict (the gates-unsandboxed park). Read from the
 * user config and the base-committed `.copilot/omg.jsonc` only; either layer
 * can turn it on and no layer can turn it off over the other's `true`.
 */
export declare function resolveRequireDeniedPaths(layers: Pick<GatesSandboxLayers, 'user' | 'base'>): {
    require: boolean;
    source: string;
};
/** `factory.run.sandbox.isolation`: where a sandboxed gate runs (the Copilot OS sandbox, or a local container). */
export type GateIsolation = 'copilot' | 'container';
/** `factory.run.sandbox.container`: the container the gate runs in with isolation "container". */
export interface GateContainerSettings {
    runtime: 'docker' | 'podman';
    /** An image reference; default `node:<host major>-bookworm-slim`. A digest pin (`name@sha256:...`) is kept as given. */
    image: string;
    /** `--memory` (e.g. "4g"). */
    memory: string;
    /** `--cpus`. */
    cpus: number;
    /** `--pids-limit`. */
    pidsLimit: number;
    /** How long each dependency install step (`npm ci`, then its scripts) may run. */
    installTimeoutMinutes: number;
    /** The most a command's work volume may hold (e.g. "10g"); over it, a watchdog kills that command's container. */
    diskLimit: string;
}
/** The default gate image: the host Node major on Debian bookworm slim. */
export declare const defaultGateImage: (nodeVersion?: string) => string;
/**
 * `factory.run.sandbox.isolation` and `factory.run.sandbox.container` from
 * the USER config only: the PR's repository must never choose where its own
 * code runs or with what limits, so a value committed in the base's
 * `.copilot/omg.jsonc` is ignored (`ignoredBase` names it for a notice). A
 * malformed user value throws. The image may not start with `-` (it is one
 * argv word after the runtime's options) and holds only reference characters.
 */
export declare function resolveGateIsolation(layers: Pick<GatesSandboxLayers, 'user' | 'base'>, nodeVersion?: string): {
    isolation: GateIsolation;
    container?: GateContainerSettings;
    ignoredBase: string[];
};
/** The Windows git-transport fallback's image when the user names none: the full bookworm image, which has git. */
export declare const defaultGitGateImage: (nodeVersion?: string) => string;
/** factory.run.sandbox.windowsGitTransport: "fallback" (default) or "strict" (keep the gate-sandbox-incompatible park). */
export type WindowsGitTransportMode = 'fallback' | 'strict';
/**
 * `factory.run.sandbox.windowsGitTransport` from the USER config only (a
 * base-committed value is ignored: `ignoredBase`), and the container the
 * fallback tries first: the user's `factory.run.sandbox.container` settings,
 * with an image that has git (defaultGitGateImage) unless the user names
 * one. A malformed user value throws.
 */
export declare function resolveWindowsGitTransport(layers: Pick<GatesSandboxLayers, 'user' | 'base'>, nodeVersion?: string): {
    mode: WindowsGitTransportMode;
    container: GateContainerSettings;
    ignoredBase: boolean;
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
    /** The lane plugin dir the session loads in place of pluginRoot (lane-plugin.ts): read-only, like pluginRoot. */
    lanePluginRoot?: string;
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
    /** The CA bundle files and cert dirs the caller's env names (proxyCaEnv), granted read-only like the tool dirs. */
    extraReadonly?: string[];
    /**
     * Engine-made dirs outside the worktree a write session may write (the
     * factory's dotnet restore step: the run's own NuGet packages dir,
     * nuget-restore.ts). Never from config; a path that holds the real home,
     * the worktree, the common git dir or the job dir, or a filesystem root,
     * throws.
     */
    extraReadwrite?: string[];
    /**
     * The only hosts a write session may reach, instead of
     * settings.writeNetwork (the factory's dotnet restore step: NUGET_HOSTS).
     * Never from config.
     */
    onlyHosts?: readonly string[];
    /** The OMC global state root to deny (default getGlobalOmcStateRoot()); a test seam. */
    omcStateRoot?: string;
    /**
     * More paths a write session is denied where the host can deny paths (the
     * factory private layout: the store's seed and the other runs' and lanes'
     * dirs); a path that holds a grant is left out, like the state root.
     */
    extraDenied?: string[];
    /**
     * The user's main checkout, whose OMC root holds the budget ledger the
     * write profile denies. Default: the dir of the common git dir when that is
     * a `.git` (the factory private layout's common git dir is the private
     * repository's, so the engine names the user's checkout; review-483 L1).
     */
    mainRoot?: string;
    /**
     * The only target a `<worktree>/node_modules` link may resolve to (the
     * dir the engine linked; review-483 M4): a link elsewhere throws instead
     * of being granted read-only. Unset: nothing under node_modules is
     * granted. A link in the worktree is lane-writable, so its own target is
     * never taken as a grant: a session could plant one for the next session
     * to have mounted (the factory's gates and lanes always pass the target).
     */
    nodeModulesTarget?: string;
    /**
     * The workspace packages' node_modules of yours the engine validated for
     * this worktree's nested gate trees (factory/run/prepare.ts
     * trustedNestedRels: its own record, or the base's workspace globs ∩ the
     * marker). A nested tree is granted only on an exact realpath match with
     * one of these; the PR-writable marker alone grants nothing. Unset: none.
     */
    nestedNodeModulesTargets?: readonly string[];
}
export declare const REGISTRY_HOSTS: readonly string[];
/** The hosts the factory's sandboxed dotnet restore step reaches (nuget.org's feed serves the index and the packages). */
export declare const NUGET_HOSTS: readonly string[];
/**
 * Why `<worktree>/node_modules` must not be granted, or null. `target` is the
 * engine-recorded node_modules (review-483 M4). A single link must resolve
 * to it (older releases). A real directory is the engine's per-run tree
 * (factory/run/prepare.ts linkNodeModules): each top-level link in it must
 * point at `<target>/<its own name>` exactly, so a link the PR's code
 * re-pointed or added (to your home, your checkout, a git dir) is refused,
 * never granted. Plain dirs and files in it are the checkout's own
 * (read-write anyway). `linked`: the tree uses `target` at all.
 *
 * Workspaces (factory/run/workspace-tree.ts): a link may also point into
 * the worktree itself, lexically and by realpath (a workspace self-link to
 * the gate checkout's package; it grants nothing the worktree does not
 * have), and the links in a real `@scope` dir are checked the same way. The
 * tree's marker lists nested trees (`<rel>/node_modules`); each line of the
 * exact relative shape, through plain dirs only, is checked with
 * `<dirname(target)>/<rel>/node_modules` as its target, and that dir (a
 * real dir, never a link) is returned in `nested` as a candidate: the
 * grant needs an exact match with the engine's own list too
 * (nestedNodeModulesTargets). A line of another shape is ignored.
 */
export declare function nodeModulesTreeProblem(worktree: string, target: string, platform?: NodeJS.Platform, targetReal?: string): {
    problem: string | null;
    linked: boolean;
    nested?: string[];
};
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
export { findOnPath };
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
    stdout?: string;
};
/**
 * The trial launch: bwrap with the namespaces the runtime's Linux sandbox
 * creates, network included (`--unshare-all`; policies without outbound
 * access get an empty net namespace), around `true`.
 */
export declare const BWRAP_TRIAL_ARGS: readonly string[];
/** The oldest bubblewrap the sandbox runs on: it launches with `--clearenv`, added in 0.5.0. */
export declare const BWRAP_MIN_VERSION: readonly [0, 5];
/** The version in `bwrap --version` ("bubblewrap 0.4.0", "bubblewrap 0.10.0"): major, minor and the version text, or null. */
export declare function parseBwrapVersion(text: string): {
    major: number;
    minor: number;
    text: string;
} | null;
/** True when `v` is older than {@link BWRAP_MIN_VERSION}. */
export declare function bwrapTooOld(v: {
    major: number;
    minor: number;
}): boolean;
/**
 * Whether bwrap can launch a process here: null when it can, else why not.
 * `sandbox.getHostSupport` reports a host with bwrap installed as supported
 * even where unprivileged user namespaces lack capabilities (Ubuntu 24.04's
 * AppArmor default), and there every sandboxed launch fails.
 */
export declare function bwrapTrialLaunchError(spawn?: SandboxTrialSpawner, timeoutMs?: number): string | null;
/** bwrapTrialLaunchError with the real bwrap, run once per process. */
export declare function cachedBwrapTrialLaunchError(): string | null;
/** Null off Linux, else cachedBwrapTrialLaunchError: the up-front gate so an unusable sandbox refuses a run instead of parking every lane. */
export declare function linuxSandboxProblem(platform?: NodeJS.Platform, trial?: () => string | null): string | null;
/**
 * The up-front gate of `omg factory run` and `omg factory bench run --live`:
 * `problem()` (linuxSandboxProblem) only when the lanes would refuse an
 * unconfirmed sandbox (`sandbox-unavailable`), i.e. the sandbox is enabled,
 * {@link SANDBOX_KILL_ENV} is not "off" and writeUnsandboxed is "refuse";
 * else null.
 */
export declare function factorySandboxProblem(settings: SandboxSettings, problem: () => string | null, env?: NodeJS.ProcessEnv): string | null;
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
/** `session.rpc.options.update({ permissions: { sandbox } })` (SDK v2 patch shape); null when applied, else why not. */
export declare function applySandboxConfig(session: unknown, config: SandboxConfig, timeoutMs: number): Promise<string | null>;
/** `session.rpc.sandbox.getEnforcementStatus()`, or why it could not be read. */
export declare function readEnforcement(session: unknown, timeoutMs: number): Promise<NonNullable<CopilotRunSandboxState['enforcement']> | string>;
/**
 * Why a sandbox state (`session.rpc.sandbox.getState()` or a
 * `session.sandbox_state_changed` event's data, both carry the same fields)
 * does not show the policy `sent` in force, else null: the effective config
 * must be enabled, must not offer bypasses (our policy sets `allowBypass:
 * false`; a managed floor can only tighten it) and must be no weaker than
 * `sent` ({@link configWeakerThanSent}), and the session must hold no opt-out
 * (`disabledForSession`) nor auto-approve bypass requests (`autoApproveBypass`).
 * A field of the wrong type counts as not in force.
 */
export declare function sandboxStateProblem(state: unknown, sent: SandboxConfig, platform?: NodeJS.Platform): string | null;
/** `session.rpc.sandbox.getState()`: the effective config source when the policy `sent` is in force ({@link sandboxStateProblem}), else why not. */
export declare function readSandboxState(session: unknown, timeoutMs: number, sent: SandboxConfig): Promise<{
    configSource: string;
} | string>;
/**
 * Whether a createSession error with the sandbox policy is the runtime refusing
 * the policy (a managed-policy conflict or an invalid config), the only create
 * failure the fail-closed sandbox path handles; any other (network, auth,
 * model) is an ordinary create failure. Copilot CLI 1.0.116's runtime refuses
 * a conflicting policy with "Sandbox configuration update violates managed
 * policy. Contact your administrator for more information." (code
 * `managed_sandbox_policy_conflict`) and an invalid one with "invalid parameter
 * 'sandboxConfig': ..."; a policy it cannot resolve with "session sandbox
 * policy could not be resolved: ...". Real create errors carry JSON-RPC code
 * -32603 without `data` and embed paths and model names in the message (a
 * missing `...\sandbox\repo` dir, a model called `sandbox-x`), so only these
 * known phrases count, in the message, a string code or the data as text.
 */
export declare function isSandboxPolicyError(err: unknown): boolean;
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
 * The CA paths to grant sandboxed node and git read-only, and notes: the bundle file itself of NODE_EXTRA_CA_CERTS
 * and SSL_CERT_FILE (never its dir, which may be ~/Downloads), and each SSL_CERT_DIR entry unless it is a filesystem
 * root or holds the real home. An entry that does not resolve (missing, a dangling link) is dropped with a note
 * rather than failing the whole sandbox config. A proxy URL with userinfo is noted too: the shells inherit the
 * runtime env, so they see it, and it is not stripped because the runtime needs it.
 */
export declare function proxyCaEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, realHome: string): {
    caPaths: string[];
    notes: string[];
};
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
/** Where a stored login's plaintext token can be read (storedLoginToken): the user's Copilot config dir, on this OS. */
export interface StoredLoginSource {
    userConfigDir: string;
    platform: NodeJS.Platform;
}
/**
 * The sandbox denies for the user's Copilot config dir on a keyring-less host, where its config.json holds the login
 * token in plain text (never on Windows: the token stays in Credential Manager). The default ~/.copilot is denied whole
 * anyway; a relocated COPILOT_HOME is denied whole too, unless a grant lies under it (buildSandboxConfig drops it then),
 * and its config.json always, also the file a symlinked config.json points to.
 */
export declare function copilotConfigDenies(userConfigDir: string, platform: NodeJS.Platform): string[];
/**
 * The explicit Copilot credential for the session's `gitHubToken` option
 * (SDK 1.0.16 SessionConfig: sent over the session RPC, never put in the
 * runtime's env, unlike the client-level option): COPILOT_GITHUB_TOKEN,
 * else, with `source`, the stored login's plaintext token from a keyring-less
 * host's config.json (storedLoginToken; never on Windows). The job home only
 * ever gets the login identity, so without this a keyring-less host's
 * relocated runtime has no credential.
 */
export declare function sessionGitHubToken(env: NodeJS.ProcessEnv, source?: StoredLoginSource): string | undefined;
/**
 * The credentials a runtime started from `env` and `source` can use, by name
 * only (never a value), in the order the runtime prefers them; for a
 * "Not authenticated" message.
 */
export declare function triedCredentialNames(env: NodeJS.ProcessEnv, source: StoredLoginSource, hasLogin: boolean): string[];
/**
 * `text` with, when it reports "Not authenticated", the credentials tried
 * (names only) and how to add one.
 */
export declare function withCredentialHint(text: string, env: NodeJS.ProcessEnv, source: StoredLoginSource, hasLogin: boolean): string;
/**
 * The token values lane output must never carry: those in the caller's env
 * and, with `source`, the stored login's plaintext token.
 */
export declare function secretValues(env: NodeJS.ProcessEnv, source?: StoredLoginSource): string[];
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
/**
 * A PATH for a sandboxed session or command: the host's entries less the
 * empty and relative ones (a shell resolves those from its working dir, the
 * checkout the PR's code writes, so `rm` or `git` could run a file the PR
 * put there; review round 5) and the `node_modules/.bin` dirs (any case on
 * Windows, `\` or `/`, a trailing separator too) that `npx` or `npm run`
 * put in front of the engine's own PATH: package binaries of the engine's
 * install, never the repository's tools. npm and npx find a project's
 * binaries themselves, not through the inherited PATH.
 */
export declare function sandboxPath(value: string, platform?: NodeJS.Platform): string;
//# sourceMappingURL=sandbox.d.ts.map