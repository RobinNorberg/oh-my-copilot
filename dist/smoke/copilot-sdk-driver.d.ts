/**
 * Tier 2 of `omg smoke copilot`: drive the installed Copilot CLI through
 * `@github/copilot-sdk` (an optional peer dependency, never bundled).
 *
 * SDK resolution ({@link loadCopilotSdk}), first hit wins:
 * 1. `import('@github/copilot-sdk')` from this module: a local or project
 *    install, or a global install next to a global oh-my-copilot (parent
 *    `node_modules` lookup);
 * 2. a global install: `%APPDATA%/npm/node_modules` (win32), then
 *    `npm root -g`. This covers a repo checkout (`npx tsx`, `node dist/...`)
 *    with the SDK installed by
 *    `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`.
 *    A global hit must be named {@link SDK_PACKAGE}, satisfy
 *    `^`{@link SDK_MIN_VERSION}, and have its entry files inside its own dir.
 * Not found: every sdk.* and scn.* check fails with {@link SDK_MISSING_DETAIL}
 * and the report is `skipped`.
 *
 * The runtime is always the installed exe the earlier tiers resolved
 * (`RuntimeConnection.forStdio({ path })`), never the SDK's bundled runtime.
 */
import { type CopilotEvent, type SmokeCheck } from './copilot-session-eval.js';
import { type PermissionRequestLike, type Scenario, type ScenarioCost } from './copilot-sdk-scenarios.js';
import { type SpawnSyncFn } from './process-utils.js';
import type { runChainScenario } from './copilot-chain-scenario.js';
export type PermissionResult = {
    kind: 'approve-once';
} | {
    kind: 'reject';
    feedback?: string;
};
export interface SdkSessionConfig {
    onPermissionRequest: (req: PermissionRequestLike, ctx: {
        sessionId: string;
    }) => PermissionResult | Promise<PermissionResult>;
    onEvent?: (event: CopilotEvent) => void;
    pluginDirectories: string[];
    workingDirectory: string;
    disabledMcpServers: string[];
    excludedTools: string[];
    model?: string;
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
        /** Experimental in SDK 1.0.16; no model call. */
        tools?: {
            initializeAndValidate?(): Promise<unknown>;
            getCurrentMetadata?(): Promise<unknown>;
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
}
export interface SdkClientOptions {
    connection: unknown;
    baseDirectory: string;
    workingDirectory: string;
}
export interface CopilotSdkModule {
    CopilotClient: new (opts: SdkClientOptions) => SdkClientLike;
    RuntimeConnection: {
        forStdio(opts: {
            path?: string;
            args?: string[];
            env?: NodeJS.ProcessEnv;
        }): unknown;
    };
}
export interface LoadedSdk {
    module: CopilotSdkModule;
    version: string | null;
    /** Where it resolved from: `node resolution` or the package dir under a global prefix. */
    from: string;
}
/** Resolves the SDK, or null when it is not installed. */
export type LoadSdkFn = () => Promise<LoadedSdk | null>;
/**
 * Candidate global `node_modules` dirs before `npm root -g`: only the npm
 * default on win32. Env-steerable prefixes (`npm_config_prefix`) and the
 * running node's dir are not probed: they could load an arbitrary package.
 */
export declare function globalModuleRoots(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
/** Lowest SDK release the driver is written against (protocol 3). */
export declare const SDK_MIN_VERSION = "1.0.16";
/** `^1.0.16` without a semver dependency: same major 1, >= 1.0.16, no prerelease. */
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
/** See the module comment for the resolution order. */
export declare function loadCopilotSdk(env?: NodeJS.ProcessEnv, spawnSync?: SpawnSyncFn): Promise<LoadedSdk | null>;
export declare const DEFAULT_SCENARIO_TIMEOUT_MS = 120000;
/** The runtime child's pid: the SDK keeps it on the private `cliProcess` (SDK 1.0.16). */
export declare function runtimePid(client: SdkClientLike): number | undefined;
export declare function prepareSdkProject(spawnSync: SpawnSyncFn, projectDir: string, remoteDir: string, env: NodeJS.ProcessEnv): string | null;
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
    /** The `chain` scenario runner ({@link runChainScenario}, real `copilot -p` links), injected by the smoke entry. */
    runChain: typeof runChainScenario;
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
}
/** `--max-ai-credits` for the runtime: the run cap, raised to the CLI minimum. */
export declare function runtimeCreditCap(maxCredits: number): number;
export declare const RUNTIME_WEDGED_DETAIL = "skipped: runtime unresponsive after a scenario timeout";
export declare function runSdkTier(input: SdkTierInput): Promise<SdkTierResult>;
//# sourceMappingURL=copilot-sdk-driver.d.ts.map