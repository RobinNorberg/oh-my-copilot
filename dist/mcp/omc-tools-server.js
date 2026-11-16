/**
 * OMC Tools Server - tool-name registry and stdio server config for Agent SDK hosts
 *
 * Exposes the OMC custom tools (LSP, AST, python_repl, skills, state, ...) to
 * local Node.js Agent SDK integrations as the "t" MCP server. The server is
 * the shipped standalone stdio bundle (bridge/mcp-server.cjs), so this module
 * needs no Agent SDK at runtime. This is not a VS Code extension host or CI
 * runner by itself.
 */
import { join } from "path";
import { resolvePackageRoot } from "../smoke/copilot-session-env.js";
import { lspTools } from "../tools/lsp-tools.js";
import { astTools } from "../tools/ast-tools.js";
import { pythonReplTool } from "../tools/python-repl/index.js";
import { skillsTools } from "../tools/skills-tools.js";
import { stateTools } from "../tools/state-tools.js";
import { notepadTools } from "../tools/notepad-tools.js";
import { memoryTools } from "../tools/memory-tools.js";
import { traceTools } from "../tools/trace-tools.js";
import { sharedMemoryTools } from "../tools/shared-memory-tools.js";
import { getInteropTools } from "../interop/mcp-bridge.js";
import { deepinitManifestTool } from "../tools/deepinit-manifest.js";
import { wikiTools } from "../tools/wiki-tools.js";
import { TOOL_CATEGORIES } from "../constants/index.js";
import { filterDisabledTools, tagCategory } from "./disable-tools.js";
export { DISABLE_TOOLS_GROUP_MAP, parseDisabledGroups } from "./disable-tools.js";
// Aggregate all custom tools with category metadata (full list, unfiltered)
const interopToolsEnabled = process.env.OMC_INTEROP_TOOLS_ENABLED === '1';
const interopTools = interopToolsEnabled
    ? tagCategory(getInteropTools(), TOOL_CATEGORIES.INTEROP)
    : [];
const allTools = [
    ...tagCategory(lspTools, TOOL_CATEGORIES.LSP),
    ...tagCategory(astTools, TOOL_CATEGORIES.AST),
    { ...pythonReplTool, category: TOOL_CATEGORIES.PYTHON },
    ...tagCategory(skillsTools, TOOL_CATEGORIES.SKILLS),
    ...tagCategory(stateTools, TOOL_CATEGORIES.STATE),
    ...tagCategory(notepadTools, TOOL_CATEGORIES.NOTEPAD),
    ...tagCategory(memoryTools, TOOL_CATEGORIES.MEMORY),
    ...tagCategory(traceTools, TOOL_CATEGORIES.TRACE),
    ...tagCategory(sharedMemoryTools, TOOL_CATEGORIES.SHARED_MEMORY),
    { ...deepinitManifestTool, category: TOOL_CATEGORIES.DEEPINIT },
    ...tagCategory(wikiTools, TOOL_CATEGORIES.WIKI),
    ...interopTools,
];
// Read OMC_DISABLE_TOOLS once at startup and filter tools accordingly
const enabledTools = filterDisabledTools(allTools);
/**
 * Stdio MCP server config exposing all OMC custom tools via the shipped
 * standalone server (bridge/mcp-server.cjs), for an Agent SDK `mcpServers`
 * entry named "t".
 *
 * Tools will be available as mcp__t__<tool_name>.
 * Tools in disabled groups (via OMC_DISABLE_TOOLS) are excluded at startup.
 */
export const omcToolsServer = {
    command: process.execPath,
    args: [join(resolvePackageRoot() ?? process.cwd(), "bridge", "mcp-server.cjs")],
};
/**
 * Tool names in MCP format for allowedTools configuration.
 * Only includes tools that are enabled (not disabled via OMC_DISABLE_TOOLS).
 */
export const omcToolNames = enabledTools.map(t => `mcp__t__${t.name}`);
// Build a map from MCP tool name to category for efficient lookup
// Built from allTools so getOmcToolNames() category filtering works correctly
const toolCategoryMap = new Map(allTools.map(t => [`mcp__t__${t.name}`, t.category]));
function getExcludedCategories(options) {
    const { includeLsp = true, includeAst = true, includePython = true, includeSkills = true, includeState = true, includeNotepad = true, includeMemory = true, includeTrace = true, includeInterop = true, includeSharedMemory = true, includeDeepinit = true, includeWiki = true, } = options || {};
    const excludedCategories = new Set();
    if (!includeLsp)
        excludedCategories.add(TOOL_CATEGORIES.LSP);
    if (!includeAst)
        excludedCategories.add(TOOL_CATEGORIES.AST);
    if (!includePython)
        excludedCategories.add(TOOL_CATEGORIES.PYTHON);
    if (!includeSkills)
        excludedCategories.add(TOOL_CATEGORIES.SKILLS);
    if (!includeState)
        excludedCategories.add(TOOL_CATEGORIES.STATE);
    if (!includeNotepad)
        excludedCategories.add(TOOL_CATEGORIES.NOTEPAD);
    if (!includeMemory)
        excludedCategories.add(TOOL_CATEGORIES.MEMORY);
    if (!includeTrace)
        excludedCategories.add(TOOL_CATEGORIES.TRACE);
    if (!includeInterop)
        excludedCategories.add(TOOL_CATEGORIES.INTEROP);
    if (!includeSharedMemory)
        excludedCategories.add(TOOL_CATEGORIES.SHARED_MEMORY);
    if (!includeDeepinit)
        excludedCategories.add(TOOL_CATEGORIES.DEEPINIT);
    if (!includeWiki)
        excludedCategories.add(TOOL_CATEGORIES.WIKI);
    return excludedCategories;
}
function filterToolNames(names, categoriesByName, options) {
    const excludedCategories = getExcludedCategories(options);
    if (excludedCategories.size === 0)
        return [...names];
    return names.filter(name => {
        const category = categoriesByName.get(name);
        return !category || !excludedCategories.has(category);
    });
}
/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export function getOmcToolNames(options) {
    return filterToolNames(omcToolNames, toolCategoryMap, options);
}
/**
 * Test-only helper for deterministic category-filter verification independent of env startup state.
 */
export function _getAllToolNamesForTests(options) {
    const allToolNames = allTools.map(t => `mcp__t__${t.name}`);
    return filterToolNames(allToolNames, toolCategoryMap, options);
}
//# sourceMappingURL=omc-tools-server.js.map