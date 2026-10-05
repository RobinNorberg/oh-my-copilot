/**
 * Tier 2 of `omg smoke copilot`: scenario definitions and the pure evaluators
 * for the SDK static checks (`sdk.*`) and the scenario checks (`scn.<name>.*`).
 * No SDK, process or network access here, so the unit tests replay captured
 * event streams through the same functions the live driver uses.
 */
import { type CopilotEvent, type SmokeCheck } from './copilot-session-eval.js';
export type Scenario = 'smoke' | 'guardrail' | 'skill' | 'delegate';
export declare const ALL_SCENARIOS: readonly Scenario[];
/** About 2 premium requests (one per scenario). */
export declare const DEFAULT_SCENARIOS: readonly Scenario[];
export declare const PLUGIN_NAME = "oh-my-copilot";
export declare const DELEGATE_AGENT = "oh-my-copilot:architect";
export declare const MIN_PROTOCOL_VERSION = 3;
export declare const SDK_PACKAGE = "@github/copilot-sdk";
/** Lane B's CLI keys "pure skip" exit code 2 on this exact prefix. */
export declare const SDK_MISSING_DETAIL = "@github/copilot-sdk not installed \u2014 npm i -g @github/copilot-sdk --omit=optional --ignore-scripts";
/**
 * Never offered: our own `host_smoke` MCP tool (a smoke that can start a smoke).
 * MCP tools are named `<server>-<tool>` (server = the first `.mcp.json` key);
 * `t:host_smoke` / `t(host_smoke)` match nothing.
 */
export declare function hostSmokeToolName(mcpServer: string): string;
/** Built-in shell and file-writing tools, removed for scenarios that must not use them. */
export declare const NO_SHELL_OR_WRITE_TOOLS: readonly ["powershell", "shell", "create", "edit"];
export declare const NO_WRITE_TOOLS: readonly ["create", "edit"];
/** The subset of the SDK's PermissionRequest the policies read. */
export interface PermissionRequestLike {
    kind?: string;
    fullCommandText?: string;
    path?: unknown;
    [key: string]: unknown;
}
/** Where a scenario may act: the sandbox project and the plugin under test. */
export interface PermitContext {
    projectDir: string;
    pluginRoot: string;
    platform?: NodeJS.Platform;
}
export interface ScenarioSpec {
    name: Scenario;
    prompt: string;
    /** Built-in tools removed for this scenario; the driver adds {@link hostSmokeToolName}. */
    excludedTools: string[];
    /** Approve this permission request; everything else is rejected. */
    permit: (req: PermissionRequestLike, ctx: PermitContext) => boolean;
}
/** The one command the guardrail scenario may run (should our preToolUse hook not deny it first). */
export declare const GUARDRAIL_COMMAND: RegExp;
/** Only the exact guardrail push, and only from the sandbox project when the request names a cwd. */
export declare function permitGuardrailPush(req: PermissionRequestLike, ctx: PermitContext): boolean;
/** Reads only; when the request carries a path it must be under the plugin root or the sandbox project. */
export declare function permitScopedRead(req: PermissionRequestLike, ctx: PermitContext): boolean;
export declare const SCENARIOS: Record<Scenario, ScenarioSpec>;
/** The session's excludedTools for a scenario: its built-ins plus our host_smoke tool. */
export declare function scenarioExcludedTools(name: Scenario, mcpServer: string): string[];
/** Check ids a scenario yields, in report order (stable; Lane B's docs list them). */
export declare function scenarioCheckIds(name: Scenario): string[];
export declare const SDK_STATIC_IDS: readonly ["sdk.available", "sdk.runtime", "sdk.plugins", "sdk.skills", "sdk.agents", "sdk.mcp", "sdk.tools_excluded"];
/** Every sdk.* and scn.* id failed with one detail (SDK missing, binary missing, runtime start failure). */
export declare function failedTier2Checks(scenarios: readonly Scenario[], detail: string, from?: 'all' | 'after-available'): SmokeCheck[];
/** Copilot CLI rejects `--max-ai-credits` below this (also in `--headless` runtime mode, CLI 1.0.91). */
export declare const RUNTIME_MIN_MAX_CREDITS = 30;
/** Reported for scenarios not started once the run's credit cap was reached. */
export declare const CREDIT_CAP_SKIP_DETAIL = "skipped: credit cap reached";
/** A scenario's checks all failed with one detail (not started). */
export declare function skippedScenarioChecks(name: Scenario, detail: string): SmokeCheck[];
/** An RPC result or the error message it failed with. */
export type Rpc<T = unknown> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: string;
};
export declare function evaluateSdkRuntime(status: Rpc<{
    version?: unknown;
    protocolVersion?: unknown;
}>, binVersion: string | null, model: string): SmokeCheck;
export declare function evaluateSdkPlugins(plugins: Rpc, packageVersion: string | null): SmokeCheck;
export declare function evaluateSdkSkills(skills: Rpc, root: string, skillDirs: string[], platform?: NodeJS.Platform): SmokeCheck;
export declare function evaluateSdkAgents(agents: Rpc, agentFiles: string[]): SmokeCheck;
export declare function evaluateSdkMcp(mcp: Rpc, tools: Rpc, server: string, expected: number | string): SmokeCheck;
/**
 * `excludedTools` really removed our host_smoke tool: it is absent from the
 * session's initialized tool list (`session.rpc.tools.getCurrentMetadata`),
 * while other tools of the same server are present (else the absence proves
 * nothing, e.g. the MCP tools were never offered).
 */
export declare function evaluateSdkToolsExcluded(meta: Rpc, server: string): SmokeCheck;
/**
 * Split runtime log text into windows by each line's leading ISO timestamp:
 * window i holds lines stamped in [starts[i], starts[i+1]); the last window is
 * open-ended. Lines before starts[0] are dropped; unstamped (continuation)
 * lines follow the previous stamped line. Attributing by time, not byte
 * offset, keeps a late SessionEnd line of scenario N out of scenario N+1.
 */
export declare function sliceLogByTime(text: string, starts: number[]): string[];
export interface ScenarioRun {
    name: Scenario;
    events: CopilotEvent[];
    /** A `session.idle` arrived for the prompt. */
    idle: boolean;
    timedOut: boolean;
    timeoutMs: number;
    /** createSession/send threw. */
    error?: string;
    /** Debug-log lines written while this scenario ran (null: no log found). */
    logText: string | null;
    /** guardrail: `git for-each-ref` output of the bare remote (null: could not inspect). */
    remoteRefs?: string | null;
    model: string;
    /** The run's credit cap (`--max-credits`). */
    maxCredits: number;
    /** What was left of {@link maxCredits} when this scenario started (default: all of it). */
    budget?: number;
    /** The driver aborted the turn because `assistant.usage` credits passed {@link budget}. */
    capped?: boolean;
}
export interface ScenarioCost {
    premiumRequests: number;
    credits: number;
}
/** AI credits billed by one `assistant.usage` event (0 for any other event). */
export declare function usageCredits(event: CopilotEvent): number;
/**
 * Prefer `session.shutdown` totals (emitted at disconnect); else sum
 * `assistant.usage`: credits from `copilotUsage.totalNanoAiu`, premium
 * requests counted per user-initiated call (agent-initiated follow-ups of the
 * same turn are not billed again).
 */
export declare function scenarioCost(events: CopilotEvent[]): ScenarioCost & {
    source: string;
};
/**
 * Hook stderr lines from our adapter (`[omg-hook]`) or hook runner
 * (`[run.cjs]`, e.g. a timeout). A hook that exits 0 has its stderr logged as
 * `[hook stderr]` lines; one that exits non-zero (fail-closed, e.g. 124) as a
 * multi-line `[ERROR] ... execution failed` entry whose stderr starts with
 * `Stderr: ` (Copilot CLI 1.0.91). Both forms count.
 */
export declare function adapterErrorLines(logText: string): string[];
/** Hook script names mentioned in adapter error lines (e.g. wiki-session-end.mjs). */
export declare function hookScriptNames(lines: string[]): string[];
export declare function evaluateScenario(run: ScenarioRun): {
    checks: SmokeCheck[];
    cost: ScenarioCost;
};
/**
 * An explicit request wins. Otherwise the first listed non-`auto` model whose
 * id looks cheap; when the runtime lists only `auto` (Copilot CLI 1.0.91 for
 * individual accounts) the session config omits `model` and the runtime routes.
 */
export declare function chooseModel(listed: string[], requested?: string): {
    model?: string;
    label: string;
    note: string;
};
//# sourceMappingURL=copilot-sdk-scenarios.d.ts.map