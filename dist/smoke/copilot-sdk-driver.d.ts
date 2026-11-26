/**
 * Tier 2 of `omg smoke copilot`: drive the installed Copilot CLI through
 * `@microsoft/copilot-sdk` v2 (optional and not declared in package.json,
 * never bundled; SDK protocol 4, Copilot CLI >= {@link MIN_COPILOT_CLI}).
 *
 * SDK resolution ({@link loadCopilotSdk}), first hit wins:
 * 1. `import('@microsoft/copilot-sdk')` from this module: a local or project
 *    install, or a global install next to a global oh-my-copilot (parent
 *    `node_modules` lookup);
 * 2. a global install: `%APPDATA%/npm/node_modules` (win32), then
 *    `npm root -g`. This covers a repo checkout (`npx tsx`, `node dist/...`)
 *    with the SDK installed by `SDK_INSTALL_COMMAND` (copilot-sdk-scenarios.ts).
 *    A global hit must be named {@link SDK_PACKAGE}, satisfy
 *    `^`{@link SDK_MIN_VERSION}, and have its entry files inside its own dir.
 * Not found: every sdk.* and scn.* check fails with {@link SDK_MISSING_DETAIL}
 * and the report is `skipped`.
 *
 * The runtime is always the installed exe the earlier tiers resolved, spawned
 * as a child process (`RuntimeConnection.forSpawnedStdio({ path })`), never
 * the SDK's bundled runtime and never the in-process (FFI) host that SDK v2
 * defaults to: the factory needs a separate process (sandbox, pid, args, env).
 */
import { type CopilotEvent, type SmokeCheck } from './copilot-session-eval.js';
import { type FiletoolsEvidence, type PermissionRequestLike, type Scenario, type ScenarioCost } from './copilot-sdk-scenarios.js';
import { type SpawnSyncFn } from './process-utils.js';
import { type CassetteMode, type CopilotRequestHandlerCtor } from './replay/handler.js';
import { type CassetteRun } from './replay/run.js';
import type { PlaceholderDirs } from './replay/redact.js';
import type { runChainScenario } from './copilot-chain-scenario.js';
import type { runCliScenario } from './copilot-cli-scenarios.js';
import type { runFactoryRunScenario } from './copilot-factory-run-scenario.js';
import type { runSandboxLaneScenario } from './copilot-sandbox-lane-scenario.js';
import type { runTeamScenario } from './copilot-team-scenario.js';
export type PermissionResult = {
    kind: 'approve-once';
} | {
    kind: 'reject';
    feedback?: string;
};
/** The permission callback (`CreateSessionOptions.permissions.onRequest`). */
export type SdkPermissionHandler = (req: PermissionRequestLike, ctx: {
    sessionId: string;
}) => PermissionResult | Promise<PermissionResult>;
/** The slice of SDK v2 `CreateSessionOptions` this codebase sets (nested groups; omitted groups keep the SDK defaults). */
export interface SdkSessionConfig {
    model?: string;
    workingDirectory: string;
    permissions: {
        onRequest: SdkPermissionHandler;
        /** The OS sandbox, applied before MCP servers or tools start (sandbox-session.ts confirms it through the enforcement status). */
        sandbox?: unknown;
    };
    events?: {
        onEvent?: (event: CopilotEvent) => void;
    };
    plugins: {
        directories: string[];
    };
    mcp: {
        disabledServers: string[];
    };
    tools: {
        excludedTools: string[];
        /** Allowlist of tool names; `excludedTools` still wins. */
        availableTools?: string[];
        /** SDK session tools (`Tool[]`); the team host's in-process plugin tools. */
        definitions?: unknown[];
    };
    /** Per-session GitHub token, sent over the session RPC (not the runtime env). */
    github?: {
        token?: string;
    };
}
export interface SdkSessionLike {
    sessionId: string;
    send(opts: {
        prompt: string;
    }): Promise<unknown>;
    abort(): Promise<void>;
    disconnect(): Promise<void>;
    rpc: {
        plugins: {
            list(): Promise<unknown>;
        };
        skills: {
            list(): Promise<unknown>;
        };
        agent: {
            list(): Promise<unknown>;
        };
        mcp: {
            list(): Promise<unknown>;
            listTools(params: {
                serverName: string;
            }): Promise<unknown>;
        };
        /** Experimental; no model call. */
        tools?: {
            initializeAndValidate?(): Promise<unknown>;
            getCurrentMetadata?(): Promise<unknown>;
        };
        /** `session.options.update` patch (SDK v2 nested groups, e.g. `{ tools: { availableTools } }`). */
        options?: {
            update?(params: Record<string, unknown>): Promise<{
                success?: boolean;
            }>;
        };
        sandbox?: {
            getEnforcementStatus?(): Promise<{
                required?: boolean;
                blocked?: boolean;
                reason?: string;
            }>;
        };
    };
}
export interface SdkClientLike {
    start(): Promise<void>;
    stop(): Promise<Error[]>;
    forceStop?(): Promise<void>;
    getStatus(): Promise<{
        version?: unknown;
        protocolVersion?: unknown;
    }>;
    listModels(): Promise<Array<{
        id?: unknown;
    }>>;
    createSession(config: SdkSessionConfig): Promise<SdkSessionLike>;
    deleteSession(sessionId: string): Promise<void>;
    /** Server RPCs; `sandbox.getHostSupport` reports whether the host can run the OS sandbox. */
    rpc?: {
        sandbox?: {
            getHostSupport?(): Promise<unknown>;
        };
    };
    /** A cassette client (withCassette) only: record or replay the next requests as `scenario`. */
    setCassetteScenario?(scenario: string, stateDir: string): void;
}
/**
 * `RuntimeConnection.forSpawnedStdio` options: the child process (`path`,
 * `args`, `env`, its cwd `workingDirectory`) and the owned runtime's home
 * (`baseDirectory`, COPILOT_HOME). SDK v1 had the last two on the client.
 */
export interface SpawnedStdioOptions {
    path?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    workingDirectory?: string;
    baseDirectory?: string;
}
/** The slice of SDK v2 `CopilotClientOptions` this codebase sets. */
export interface SdkClientOptions {
    /** SDK v2 requires an explicit mode; `coding-agent` is v1's implicit CLI-like default (renamed from `copilot-cli`). */
    mode: 'coding-agent';
    /** Always a spawned stdio connection (`RuntimeConnection.forSpawnedStdio`, see {@link spawnedClientOptions}). */
    runtime: unknown;
    /** Set by withCassette (replay/handler.ts) only: routes every model request through the cassette handler. */
    models?: {
        requestHandler?: unknown;
    };
    github?: {
        /**
         * Client-level GitHub token: the SDK puts it in the runtime's env (COPILOT_SDK_AUTH_TOKEN) and adds
         * --no-auto-login. Only for a no-session probe; a lane's goes over the session RPC.
         */
        token?: string;
        /** Set by withCassette in replay: never use the machine's stored login. */
        useLoggedInUser?: boolean;
    };
}
export interface CopilotSdkModule {
    CopilotClient: new (opts: SdkClientOptions) => SdkClientLike;
    RuntimeConnection: {
        forSpawnedStdio(opts: SpawnedStdioOptions): unknown;
    };
    /** `CopilotRequestHandler` (experimental); record/replay needs it. */
    CopilotRequestHandler?: CopilotRequestHandlerCtor;
}
/**
 * Client options for a runtime child process on `conn.path`: every client of
 * this codebase is built here, in `coding-agent` mode (v1's implicit default).
 */
export declare function spawnedClientOptions(loaded: Pick<LoadedSdk, 'module'>, conn: SpawnedStdioOptions & {
    path: string;
}, extra?: Pick<SdkClientOptions, 'github'>): SdkClientOptions;
export interface LoadedSdk {
    module: CopilotSdkModule;
    version: string | null;
    /** Where it resolved from: `node resolution` or the package dir under a global prefix. */
    from: string;
    /** Set by withCassette: every client of this SDK records or replays. Test this, not the env. */
    cassette?: CassetteMode;
}
/** Resolves the SDK, or null when it is not installed. */
export type LoadSdkFn = () => Promise<LoadedSdk | null>;
/**
 * Candidate global `node_modules` dirs before `npm root -g`: only the npm
 * default on win32. Env-steerable prefixes (`npm_config_prefix`) and the
 * running node's dir are not probed: they could load an arbitrary package.
 */
export declare function globalModuleRoots(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
/** Lowest SDK release the driver is written against and tested with (SDK v2, protocol 4). */
export declare const SDK_MIN_VERSION = "2.0.3";
/**
 * Lowest Copilot CLI the driver is tested with: the runtime SDK {@link SDK_MIN_VERSION}
 * is built against. 1.0.113 is the first CLI on protocol 4; older ones speak protocol 3,
 * which SDK v2 refuses at the handshake.
 */
export declare const MIN_COPILOT_CLI = "1.0.116";
/** The package SDK v1 was published as; `omg factory check` names it when it is installed instead of {@link SDK_PACKAGE}. */
export declare const LEGACY_SDK_PACKAGE = "@github/copilot-sdk";
/** `^2.0.3` without a semver dependency: same major, >= {@link SDK_MIN_VERSION}, no prerelease. */
export declare function satisfiesSdkRange(version: string | undefined | null): boolean;
/**
 * Import the SDK from a package dir found under a global root. Refuses a
 * package with another name, a version outside `^`{@link SDK_MIN_VERSION},
 * or an `exports`/`main` entry that resolves outside the package dir.
 */
export declare function importFromDir(dir: string): Promise<LoadedSdk | null>;
/**
 * Resolve a Windows npm shim (`copilot.cmd` / `.ps1`) to the `.js` or `.exe`
 * it launches, so the SDK (which spawns `path` without a shell) can drive it.
 * Null when the shim cannot be read or names no existing target.
 */
export declare function resolveShimTarget(shim: string, read?: (p: string) => string, exists?: (p: string) => boolean): string | null;
/**
 * See the module comment for the resolution order. Every hit goes through
 * {@link withCassette}, so every client of the codebase records or replays
 * when the cassette env is set (and loading throws when it cannot).
 */
export declare function loadCopilotSdk(env?: NodeJS.ProcessEnv, spawnSync?: SpawnSyncFn): Promise<LoadedSdk | null>;
/**
 * The version of SDK v1 ({@link LEGACY_SDK_PACKAGE}) under the global roots
 * {@link loadCopilotSdk} searches, or null. Reads package.json only: v1 is never
 * imported. `omg factory check` names it when v2 is missing.
 */
export declare function findLegacySdkVersion(env?: NodeJS.ProcessEnv, spawnSync?: SpawnSyncFn): string | null;
export declare const DEFAULT_SCENARIO_TIMEOUT_MS = 120000;
/** The runtime child's pid: the SDK keeps it on the private `cliProcess` (SDK 1.0.16 through 2.0.3). */
export declare function runtimePid(client: SdkClientLike): number | undefined;
/** Updates the Copilot CLI (the npm install; a WinGet or Homebrew install updates with `copilot update`). */
export declare const COPILOT_UPDATE_COMMAND = "npm i -g @github/copilot@latest";
/** The SDK's `client.start()` handshake refusal, parsed (null: some other error). */
export declare function sdkProtocolMismatch(err: unknown): {
    sdkMin: number;
    sdkMax: number;
    server: number | null;
} | null;
/**
 * The `.catch` for `client.start()`: rethrows a protocol mismatch as an error
 * naming both versions and the fix, anything else unchanged.
 */
export declare function rethrowSdkStartError(err: unknown): never;
/** The probe's own start bound: a handshake answers in seconds, and `auto` must not wait a launch's minute. */
export declare const PROBE_START_TIMEOUT_MS = 15000;
/** Prefix of probeSdkProtocol's answer when the handshake did not finish in time. */
export declare const PROBE_TIMEOUT_REASON = "copilot_sdk_probe_timeout";
export interface SdkProtocolProbeOptions {
    env?: NodeJS.ProcessEnv;
    startTimeoutMs?: number;
    stopTimeoutMs?: number;
    killTree?: (pid: number) => void;
    /** Runs on the started client before it stops (no session exists: only no-session RPCs such as sandbox.getHostSupport); a throw is ignored. */
    onStarted?: (client: SdkClientLike) => Promise<void>;
}
/**
 * Starts and stops a runtime on `bin` (no session, no prompt) and returns the
 * explained protocol mismatch, `copilot_sdk_probe_timeout: ...` when start()
 * hangs, or null when the handshake passes or fails for any other reason (the
 * real launch reports those). The runtime gets the session env allowlist in a
 * throwaway home with no login identity: a handshake needs no credential.
 */
export declare function probeSdkProtocol(loaded: LoadedSdk, bin: string, opts?: SdkProtocolProbeOptions): Promise<string | null>;
/**
 * probeSdkProtocol, memoized per process by the binary's realpath, size and
 * mtime and the SDK version. A timeout is not kept (it may be transient).
 */
export declare function memoSdkProtocolProbe(loaded: LoadedSdk, bin: string, probe?: (loaded: LoadedSdk, bin: string) => Promise<string | null>): Promise<string | null>;
export declare function prepareSdkProject(spawnSync: SpawnSyncFn, projectDir: string, remoteDir: string, env: NodeJS.ProcessEnv): string | null;
/**
 * filetools: the fixture under the sandbox project (notes.txt, a README.md
 * carrying a fresh nonce) and a probe plugin under the home whose hook entries
 * ({@link probeHooksJson}) append their stdin payloads to `probe.jsonl`.
 */
export declare function prepareFiletools(projectDir: string, home: string, node?: string): {
    nonce: string;
    writeNonce: string;
    probeDir: string;
    probeLog: string;
};
/** What the filetools turn left behind: the probe records and the fixture's state. */
export declare function collectFiletools(projectDir: string, probe: {
    nonce: string;
    writeNonce: string;
    probeLog: string;
}): FiletoolsEvidence;
export interface SdkTierInput {
    root: string;
    bin: string;
    binVersion: string | null;
    packageVersion: string | null;
    /** Isolated COPILOT_HOME (config.json with login identity + trustedFolders already written). */
    home: string;
    projectDir: string;
    remoteDir: string;
    /** Client env (buildSessionEnv + scenario switches); per runtime process, not per session. */
    env: NodeJS.ProcessEnv;
    scenarios: Scenario[];
    model?: string;
    timeoutMs: number;
    /**
     * Credit cap for the whole run: a scenario is aborted once its
     * `assistant.usage` credits pass what is left, and later scenarios are
     * skipped once the run total passes it. The runtime also gets
     * `--max-ai-credits max(30, maxCredits)` (30 is the CLI minimum).
     */
    maxCredits: number;
    keepHome: boolean;
    loadSdk: LoadSdkFn;
    loadExpectedToolCount: () => Promise<number>;
    spawnSync: SpawnSyncFn;
    skillDirs: string[];
    agentFiles: string[];
    mcpServer: string;
    /** Test seams: platform (default process.platform), pid liveness and the runtime tree kill. */
    platform?: NodeJS.Platform;
    isAlive?: (pid: number) => boolean;
    killTree?: (pid: number) => void;
    /** Test seam: the Linux trial sandbox launch behind sdk.sandbox's host support (default cachedBwrapTrialLaunchError). */
    sandboxTrialLaunch?: () => string | null;
    /** Test seam: git's sh.exe the win32 spawn canary launches (default gitForWindowsShell). */
    canaryGitShell?: (env: NodeJS.ProcessEnv) => string | null;
    /** The `chain` scenario runner ({@link runChainScenario}, real `copilot -p` links), injected by the smoke entry. */
    runChain: typeof runChainScenario;
    /** The `team` scenario runner ({@link runTeamScenario}, a real 2-worker sdk team), injected by the smoke entry. */
    runTeam: typeof runTeamScenario;
    /** The CLI scenarios' runner ({@link runCliScenario}, headless copilot sessions), injected by the smoke entry. */
    runCli: typeof runCliScenario;
    /** The `factory-run` scenarios' runner ({@link runFactoryRunScenario}, the engine with real lanes), injected by the smoke entry. */
    runFactory: typeof runFactoryRunScenario;
    /** The `sandbox-lane` scenario's runner ({@link runSandboxLaneScenario}, copilot_run lanes in the OS sandbox), injected by the smoke entry. */
    runSandbox: typeof runSandboxLaneScenario;
    /**
     * `--record`/`--replay`: `env` already carries the cassette env (no
     * scenario) and `loadSdk` applied it. Each scenario then runs with its own
     * cassette state, and gets a `scn.<name>.record` or `scn.<name>.replay` check.
     */
    cassette?: CassetteRun;
}
export interface SdkTierResult {
    checks: SmokeCheck[];
    sdk?: {
        version: string | null;
        runtimeVersion: string | null;
        protocolVersion: number | null;
        model: string;
    };
    cost?: ScenarioCost;
    /** Per scenario JSONL event capture, under the home dir. */
    events: Partial<Record<Scenario, string>>;
    skipped?: string;
    /** `--replay`: per scenario, its `scn.<name>.replay` verdict and counts (the cassette's `selfVerify`). */
    replay?: Partial<Record<Scenario, {
        ok: boolean;
        misses: number;
        drift: number;
    }>>;
}
/**
 * The smoke dirs a scenario's cassette turns into placeholders. The factory
 * scenarios work in their own repository beside the sandbox project
 * (copilot-factory-run-scenario.ts); TMP is the run's temp parent, so every
 * path under it is stable across runs.
 */
export declare function scenarioPlaceholderDirs(input: Pick<SdkTierInput, 'root' | 'home' | 'projectDir' | 'remoteDir'>, name?: Scenario): PlaceholderDirs;
/** `--max-ai-credits` for the runtime: the run cap, raised to the CLI minimum. */
export declare function runtimeCreditCap(maxCredits: number): number;
export declare const RUNTIME_WEDGED_DETAIL = "skipped: runtime unresponsive after a scenario timeout";
export declare function runSdkTier(input: SdkTierInput): Promise<SdkTierResult>;
/**
 * The spawn canary's command: the external programs every lane starts, the
 * engine's node, the `node` on the lane's PATH (the plugin hooks and the `t`
 * MCP server run that one), the PATH git and, when `gitShell` is given
 * (win32), git's `usr\bin\sh.exe`, which runs git hooks. A shell builtin
 * (`echo`) would pass while the sandbox denies every child .exe, so each
 * node line is labelled and sh prints its marker itself. sh runs last and
 * its exit code is printed, so a failed sh leaves the call's own exit 0.
 */
export declare function sandboxCanaryCommand(platform: NodeJS.Platform, nodePath: string, gitShell?: string | null): string;
/**
 * Which canary programs printed their line (`engine-node v<n>.<n>`,
 * `path-node v<n>.<n>`, `git version <n>`, `git-sh-ok`), and sh's exit code
 * (`git-sh-exit <n>`) when printed.
 */
export declare function sandboxCanaryLaunched(output: string): {
    engineNode: boolean;
    pathNode: boolean;
    git: boolean;
    gitShell: boolean;
    gitShellExit: number | null;
};
//# sourceMappingURL=copilot-sdk-driver.d.ts.map