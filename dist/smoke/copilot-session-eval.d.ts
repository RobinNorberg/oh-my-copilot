/**
 * Pure evaluators for the artifacts of a Tier 1 `omg smoke copilot` session:
 * stdout JSONL, `<COPILOT_HOME>/session-state/<id>/events.jsonl`, the debug
 * process log, and the project's `.omg/` state. Kept free of process spawning
 * so the unit tests can run them against captured fixtures.
 */
export interface SmokeCheck {
    id: string;
    ok: boolean;
    detail: string;
    evidence?: string;
}
export interface CopilotEvent {
    type?: string;
    data?: Record<string, unknown>;
    id?: string;
    parentId?: string | null;
    [key: string]: unknown;
}
export declare const EVIDENCE_MAX = 400;
export declare function excerpt(text: string | undefined | null, max?: number): string;
/** Parse JSON Lines defensively: non-JSON lines are counted, never thrown. */
export declare function parseJsonl(text: string): {
    events: CopilotEvent[];
    bad: number;
    badSample?: string;
};
/** Concatenated assistant output (final messages and deltas). */
export declare function assistantText(events: CopilotEvent[]): string;
export declare const SMOKE_TOKEN = "SMOKE_OK";
export declare function evaluateSessionExit(input: {
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    error?: string;
    timeoutMs: number;
}): SmokeCheck;
export declare function evaluateEventsLog(eventsPath: string, text: string | null): {
    check: SmokeCheck;
    events: CopilotEvent[];
};
/** Hook types the default (tool-free) prompt must fire. */
export declare const REQUIRED_HOOK_TYPES: readonly ["sessionStart", "userPromptSubmitted", "agentStop", "sessionEnd"];
/** Hook types that only fire when the model used a tool. */
export declare const TOOL_HOOK_TYPES: readonly ["preToolUse", "postToolUse"];
interface HookRun {
    hookType: string;
    ended: boolean;
    success: boolean | null;
    error?: string;
}
/**
 * Pair `hook.start` with `hook.end`. The end event's `hookType` is used when
 * present; otherwise it is matched through a shared invocation id or the
 * start event's id (parentId).
 */
export declare function collectHookRuns(events: CopilotEvent[]): HookRun[];
export declare function evaluateHooks(events: CopilotEvent[]): SmokeCheck[];
/**
 * The adapter fails open by default (non-zero exit -> 0 plus an `[omg-hook]`
 * stderr line), which Copilot records as `hook.end success:true`. The smoke
 * runs with OMC_HOOK_FAIL_CLOSED=1, and this check catches what still slips
 * through by scanning every captured stream for adapter error lines.
 */
export declare function evaluateAdapterErrors(sources: Array<{
    name: string;
    text: string | null | undefined;
}>): SmokeCheck;
/** Plugin names from a `Plugins loaded: ["a","b"]` debug line (exact names, not substrings). */
export declare function parsePluginsLoaded(line: string): string[];
export declare function evaluatePluginsLoaded(logText: string | null): SmokeCheck;
export declare const MCP_STDERR_TAG = "OMC Tools MCP Server running on stdio";
export declare function evaluateMcpLoaded(events: CopilotEvent[], logText: string | null, serverNames: string[]): SmokeCheck;
export declare const SESSION_STARTED_MARKER = "session-started.json";
/**
 * Our SessionStart hook (scripts/session-start.mjs) writes
 * `.omg/state/sessions/<id>/session-started.json`; other hooks add more files
 * under `.omg/`. Pass when the marker exists, else when anything was written.
 */
export declare function evaluateStateWritten(projectDir: string): SmokeCheck;
export declare function evaluateSubagent(events: CopilotEvent[], agentName: string): SmokeCheck;
export {};
//# sourceMappingURL=copilot-session-eval.d.ts.map