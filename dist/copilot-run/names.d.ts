/**
 * Names shared by the `copilot_run_*` MCP tools and the SDK session fences
 * that must keep them away from Copilot sessions (src/team/sdk-policy.ts,
 * src/smoke/copilot-session-env.ts). Dependency-free: the team MCP bundle
 * reaches this module through sdk-policy.
 */
/** Opt-in for `copilot_run_start` (live, billed Copilot sessions) in the MCP server env. */
export declare const COPILOT_RUN_ALLOW_ENV = "OMG_COPILOT_RUN_ALLOW";
export declare const COPILOT_RUN_TOOL_NAMES: readonly ["copilot_run_start", "copilot_run_status", "copilot_run_wait", "copilot_run_cancel", "copilot_run_cleanup"];
//# sourceMappingURL=names.d.ts.map