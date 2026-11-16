/**
 * OMC Tools Server - tool-name registry and stdio server config for Agent SDK hosts
 *
 * Exposes the OMC custom tools (LSP, AST, python_repl, skills, state, ...) to
 * local Node.js Agent SDK integrations as the "t" MCP server. The server is
 * the shipped standalone stdio bundle (bridge/mcp-server.cjs), so this module
 * needs no Agent SDK at runtime. This is not a VS Code extension host or CI
 * runner by itself.
 */
export { DISABLE_TOOLS_GROUP_MAP, parseDisabledGroups } from "./disable-tools.js";
/**
 * Stdio MCP server config exposing all OMC custom tools via the shipped
 * standalone server (bridge/mcp-server.cjs), for an Agent SDK `mcpServers`
 * entry named "t".
 *
 * Tools will be available as mcp__t__<tool_name>.
 * Tools in disabled groups (via OMC_DISABLE_TOOLS) are excluded at startup.
 */
export declare const omcToolsServer: {
    command: string;
    args: string[];
};
/**
 * Tool names in MCP format for allowedTools configuration.
 * Only includes tools that are enabled (not disabled via OMC_DISABLE_TOOLS).
 */
export declare const omcToolNames: string[];
interface ToolNameFilterOptions {
    includeLsp?: boolean;
    includeAst?: boolean;
    includePython?: boolean;
    includeSkills?: boolean;
    includeState?: boolean;
    includeNotepad?: boolean;
    includeMemory?: boolean;
    includeTrace?: boolean;
    includeInterop?: boolean;
    includeSharedMemory?: boolean;
    includeDeepinit?: boolean;
    includeWiki?: boolean;
}
/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export declare function getOmcToolNames(options?: ToolNameFilterOptions): string[];
/**
 * Test-only helper for deterministic category-filter verification independent of env startup state.
 */
export declare function _getAllToolNamesForTests(options?: ToolNameFilterOptions): string[];
//# sourceMappingURL=omc-tools-server.d.ts.map