/**
 * `omg smoke copilot` — load-check the oh-my-copilot plugin inside the real
 * GitHub Copilot CLI.
 *
 * Tier 0 makes no model call: manifest/version, generated hooks/agents drift,
 * `plugin list`/`skill list` against `--plugin-dir`, and the standalone MCP
 * server's tools/list. Tier 1 adds one cheap non-interactive session in a
 * throwaway COPILOT_HOME and asserts on its persisted events, debug log and
 * the `.omg/` state our hooks write. Tier 2 replaces that session with
 * `@github/copilot-sdk` static checks and scripted scenarios
 * (src/smoke/copilot-sdk-driver.ts).
 */
import { type BinaryResolverDeps } from './copilot-binary.js';
import { type SmokeCheck } from './copilot-session-eval.js';
import { type SpawnFn, type SpawnSyncFn } from './process-utils.js';
import { type LoadSdkFn } from './copilot-sdk-driver.js';
import { type Scenario, type ScenarioCost } from './copilot-sdk-scenarios.js';
export type { SmokeCheck } from './copilot-session-eval.js';
export type { Scenario } from './copilot-sdk-scenarios.js';
export { ALL_SCENARIOS, DEFAULT_SCENARIOS } from './copilot-sdk-scenarios.js';
export type SmokeTier = 0 | 1 | 2;
export interface SmokeOptions {
    /** Default: OMC_PLUGIN_ROOT, else the package root of the running omg. */
    pluginRoot: string;
    /**
     * 0 = load check (no model call); 1 = tier 0 + one live session;
     * 2 = tier 0 + @github/copilot-sdk static checks + {@link SmokeOptions.scenarios}.
     */
    tier: SmokeTier;
    copilotBin?: string;
    /**
     * Tier 1 model. Default {@link DEFAULT_SMOKE_MODEL}. Tier 2: the session
     * model (default: a cheap explicit model from models.list, else auto).
     */
    model?: string;
    /**
     * Tier 1 `--max-ai-credits` (CLI minimum is {@link MIN_MAX_CREDITS}).
     * Tier 2: a cap for the whole run. A scenario whose `assistant.usage`
     * credits pass what is left is aborted, later scenarios are skipped, and the
     * runtime also gets `--max-ai-credits` (raised to the CLI minimum).
     */
    maxCredits?: number;
    /**
     * Per subprocess at tier 0 (default 60 s); the tier 1 session (default 180 s);
     * each tier 2 scenario (default 120 s, then abort). Tier 0 steps of a tier 1/2
     * run keep 60 s. The mcp.list_tools check is fixed at 10 s.
     */
    timeoutMs?: number;
    /** Keep the throwaway COPILOT_HOME and project dir for debugging. */
    keepHome?: boolean;
    /** Tier 1 prompt override. */
    prompt?: string;
    /** Tier 1: use the delegation prompt and add the `subagent.selected` check. */
    delegate?: boolean;
    /** Tier 2 scenarios (default {@link DEFAULT_SCENARIOS}); [] = SDK static checks only, zero model calls. */
    scenarios?: Scenario[];
    env?: NodeJS.ProcessEnv;
    /** Test seams; defaults are the real implementations. */
    deps?: SmokeDeps;
}
export interface SmokeDeps extends BinaryResolverDeps {
    spawn?: SpawnFn;
    spawnSync?: SpawnSyncFn;
    /** Expected standalone MCP tool count (default: tool-registry `allTools.length`). */
    loadExpectedToolCount?: () => Promise<number>;
    randomUUID?: () => string;
    /** Real Copilot config dir to copy the login identity from (default getCopilotConfigDir()). */
    userConfigDir?: string;
    /** Tier 2: resolve @github/copilot-sdk (default {@link loadCopilotSdk}); null = not installed. */
    loadSdk?: LoadSdkFn;
}
export interface SmokeReport {
    ok: boolean;
    tier: SmokeTier;
    pluginRoot: string;
    pluginVersion: string | null;
    copilot: {
        bin: string | null;
        version: string | null;
    };
    checks: SmokeCheck[];
    artifacts: SmokeArtifacts;
    durationMs: number;
    skipped?: string;
    /** Tier 2: SDK package and runtime it drove; `model` is the scenario model or `auto`. */
    sdk?: {
        version: string | null;
        runtimeVersion: string | null;
        protocolVersion: number | null;
        model?: string;
    };
    /** Tier 2: summed over the scenarios (AI credits = nano-AIU / 1e9). */
    cost?: ScenarioCost;
}
/**
 * Paths kept with keepHome (else deleted and omitted). `listHome` is the tier 0
 * COPILOT_HOME used for `plugin list`/`skill list`; `copilotHome` is the tier 1
 * session's COPILOT_HOME (its parent also holds the temp project).
 */
export interface SmokeArtifacts {
    listHome?: string;
    copilotHome?: string;
    eventsLog?: string;
    debugLog?: string;
    stdout?: string;
    /** Tier 2: per-scenario SDK event stream (JSONL) under copilotHome. */
    events?: Partial<Record<Scenario, string>>;
}
/**
 * No default model id: on Copilot CLI 1.0.91 every explicit `--model` tried
 * (gpt-5-mini, gpt-6-luna, claude-sonnet-5) failed with `Model "<id>" from
 * --model flag is not available` before any model call, while omitting the
 * flag lets the CLI auto-pick (it chose mai-code-1.1-flash, a low-price flash
 * model). Cost stays bounded by --max-ai-credits. Pass --model to pin one.
 */
export declare const DEFAULT_SMOKE_MODEL: string | undefined;
export declare const DEFAULT_MAX_CREDITS = 30;
/** Copilot CLI rejects `--max-ai-credits` below this. */
export declare const MIN_MAX_CREDITS = 30;
export declare const DEFAULT_TIER0_TIMEOUT_MS = 60000;
export declare const DEFAULT_TIER1_TIMEOUT_MS = 180000;
export declare const MCP_LIST_TIMEOUT_MS = 10000;
export declare const PLUGIN_NAME = "oh-my-copilot";
export declare const DELEGATE_AGENT = "oh-my-copilot:architect";
export declare const DEFAULT_SMOKE_PROMPT = "Reply with exactly: SMOKE_OK. Do not use tools.";
export declare const DELEGATE_SMOKE_PROMPT: string;
/**
 * Tier 1 session sandboxing (spellings verified against `copilot --help` and
 * `copilot help permissions`, CLI 1.0.91; deny rules beat --allow-all-tools):
 * - never let the model call our own `host_smoke` tool (server `t`) recursively;
 * - no built-in MCP servers (github-mcp-server, githubiq) in the smoke;
 * - the default prompt forbids tools, so also deny shell and file writes.
 *   `--delegate` keeps them, because the subagent hand-off is a tool call.
 */
export declare function sessionSandboxFlags(delegate: boolean): string[];
/**
 * Env policy for every copilot child the smoke spawns (the caller's env minus
 * what could redirect, disable, or re-host our hooks; precedent:
 * scripts/verify-graph-contained-fs.mjs).
 *
 * Stripped:
 * - every `OMC_*` var and `DISABLE_OMC` (state dir, plugin root, skip/disable
 *   switches, debug toggles), then only {@link SMOKE_SET_ENV} is re-added;
 * - Claude Code host markers: `CLAUDECODE`, `CLAUDE_SESSION_ID`,
 *   `CLAUDE_PLUGIN_ROOT`, and every `CLAUDE_CODE_*` (incl. CLAUDE_CODE_ENTRYPOINT);
 * - `NODE_OPTIONS` (preloads would run inside our node hooks);
 * - `COPILOT_HOME`, `COPILOT_OFFLINE`, `COPILOT_MODEL` (only `--model` picks the
 *   model), every `COPILOT_PROVIDER_*` (BYO provider routing);
 * - tier 1 with a copied login identity: `GH_TOKEN`, `GITHUB_TOKEN` (see
 *   {@link buildSessionEnv}).
 * Kept: everything else, notably PATH/PATHEXT/SystemRoot/HOME/USERPROFILE/
 * APPDATA/LOCALAPPDATA/TEMP (hooks spawn node and resolve home dirs),
 * `COPILOT_GITHUB_TOKEN`, and the remaining `COPILOT_*` (e.g. COPILOT_CLI_PATH).
 */
export declare const STRIPPED_ENV_EXACT: readonly ["DISABLE_OMC", "CLAUDECODE", "CLAUDE_SESSION_ID", "CLAUDE_PLUGIN_ROOT", "NODE_OPTIONS", "COPILOT_HOME", "COPILOT_OFFLINE", "COPILOT_MODEL"];
export declare const STRIPPED_ENV_PREFIXES: readonly ["OMC_", "CLAUDE_CODE_", "COPILOT_PROVIDER_"];
/** Generic GitHub tokens dropped from the tier 1 session when a stored login was copied. */
export declare const LOGIN_SHADOWING_TOKENS: readonly ["GH_TOKEN", "GITHUB_TOKEN"];
/** Set on every copilot child (on top of COPILOT_HOME). */
export declare const SMOKE_SET_ENV: {
    readonly COPILOT_ALLOW_ALL: "false";
    readonly COPILOT_AUTO_UPDATE: "false";
    readonly NO_COLOR: "1";
};
/** Set on the tier 1 session only: a failing hook must surface as hook.end success:false. */
export declare const SESSION_SET_ENV: {
    readonly OMC_HOOK_FAIL_CLOSED: "1";
};
export declare function isStrippedEnvKey(key: string): boolean;
/** Walk up from this module to the directory holding the oh-my-copilot plugin.json. */
export declare function resolveDefaultPluginRoot(env?: NodeJS.ProcessEnv): string;
/**
 * The oh-my-copilot package root that contains the running module (no env,
 * no cwd fallback), or null when this code is not running from a plugin tree.
 */
export declare function resolvePackageRoot(): string | null;
/** Extract the first JSON array from CLI output that may carry warnings around it. */
export declare function extractJsonArray(text: string): unknown[] | null;
export interface SessionEnvOptions {
    /** Tier 1 session (adds {@link SESSION_SET_ENV}); false for the tier 0 list commands. */
    session?: boolean;
    /** A stored login was copied into the home: drop {@link LOGIN_SHADOWING_TOKENS}. */
    hasLogin?: boolean;
}
/** Apply the env policy documented at {@link STRIPPED_ENV_EXACT}. */
export declare function buildSessionEnv(base: NodeJS.ProcessEnv, home: string, opts?: SessionEnvOptions): NodeJS.ProcessEnv;
/**
 * Copy only the login identity (`loggedInUsers`, `lastLoggedInUser`) from the
 * user's real config. The token stays in the OS credential store; without
 * these keys an empty COPILOT_HOME falls back to `gh auth token`, whose OAuth
 * app is not entitled to Copilot models ("Model ... is not available").
 *
 * Token precedence (`copilot help environment`, 1.0.91): COPILOT_GITHUB_TOKEN,
 * GH_TOKEN, GITHUB_TOKEN each take precedence over stored credentials. So when
 * a login was copied, the session drops GH_TOKEN/GITHUB_TOKEN (typically gh or
 * Actions tokens, which would shadow the entitled login) and keeps
 * COPILOT_GITHUB_TOKEN (an explicit Copilot opt-in). Without a stored login
 * (CI) all three pass through, since a token is then the only credential.
 */
export declare function loginIdentity(userConfigDir: string): Record<string, unknown>;
export interface Tier1Inputs {
    exitCode: number | null;
    timedOut: boolean;
    error?: string;
    stdout: string;
    stderr: string;
    timeoutMs: number;
    eventsPath: string;
    eventsText: string | null;
    logText: string | null;
    projectDir: string;
    mcpServerNames: string[];
    delegate: boolean;
}
/** Evaluate captured Tier 1 artifacts (exported for fixture-driven tests). */
export declare function evaluateTier1(input: Tier1Inputs): SmokeCheck[];
export declare const LIVE_RUN_REFUSED_DETAIL = "live run refused under vitest \u2014 set OMC_LIVE_SMOKE=1 (tier 1) / =2 (tier 2 scenarios)";
/**
 * Hard no-billing guard: under a test runner (`VITEST` or `NODE_ENV=test` in
 * the real process env) a run that would call a model (tier 1; tier 2 with
 * any scenario, the default included) is refused before any subprocess or SDK
 * client, unless `OMC_LIVE_SMOKE` names that tier or the test injected the
 * seam that would otherwise bill (`deps.spawn` at tier 1, `deps.loadSdk` at
 * tier 2). Returns the refusal detail, or null to proceed.
 */
export declare function liveRunRefusal(tier: SmokeTier, scenarios: Scenario[] | undefined, deps: SmokeDeps, env?: NodeJS.ProcessEnv): string | null;
export declare function runCopilotSmoke(input?: Partial<SmokeOptions>): Promise<SmokeReport>;
//# sourceMappingURL=copilot-smoke.d.ts.map