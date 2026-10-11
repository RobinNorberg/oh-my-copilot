/**
 * In-process plugin tools for an SDK team worker (`team.sdk.inProcessTools`).
 *
 * By default an SDK worker session loads the plugin's stdio MCP server `t`
 * from `.mcp.json` (one `node bridge/mcp-server.cjs` child per session). With
 * this layer the host registers the same tools as SDK session tools
 * (`SessionConfig.tools`, `@github/copilot-sdk` 1.0.16) and disables the `t`
 * server for that session. The tools run in the sdk-host process.
 *
 * Parity with the MCP server:
 * - names: `<server>-<tool>`, the name Copilot gives the MCP tool, so
 *   `excludedTools` (`t-host_smoke`, `workerDenyTools` entries) and prompts
 *   that name tools are unchanged;
 * - schemas: {@link zodToJsonSchema}, the ListTools `inputSchema`;
 * - results: {@link callTool}, the CallTool handler, converted with the SDK's
 *   own `convertMcpCallToolResult`;
 * - set: {@link getEnabledTools} with the session env's `OMC_DISABLE_TOOLS`,
 *   minus the excluded names.
 * The `mcp` permission rule approves every `t` tool, so these skip the prompt.
 *
 * Fallback: {@link buildSdkInProcessTools} returns null when the loaded SDK
 * lacks `convertMcpCallToolResult`, and the session keeps the MCP server.
 *
 * A bare server name in `excludedTools` (`workerDenyTools: ['t']`, deny every
 * tool of the server) yields an empty tool set with the server still disabled.
 *
 * `cleanup` is the MCP server's shutdown cleanup (standalone-server.ts): the
 * owned Python REPL bridges and the LSP clients. The host runs it on teardown.
 */

import { callTool, getEnabledTools, zodToJsonSchema, type ToolDef } from '../mcp/tool-registry.js';
import { cleanupOwnedBridgeSessions } from '../tools/python-repl/bridge-manager.js';
import { disconnectAll as disconnectAllLsp } from '../tools/lsp/index.js';

/** The SDK `Tool` fields this layer sets (SDK 1.0.16 `dist/types.d.ts`). */
export interface SdkInProcessTool {
  name: string;
  description: string;
  parameters: ReturnType<typeof zodToJsonSchema>;
  skipPermission: true;
  handler: (args: unknown) => Promise<unknown>;
}

type ConvertMcpResult = (result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) => unknown;

export interface SdkInProcessToolSet {
  tools: SdkInProcessTool[];
  /** The MCP server the session must disable, so no tool is offered twice. */
  disabledMcpServer: string;
  /** Best-effort shutdown cleanup of tool-owned processes; never throws. */
  cleanup: () => Promise<void>;
}

/**
 * Bridge escalation that reaches SIGKILL inside the host's 5 s cleanup
 * deadline (sdk-host TOOL_CLEANUP_TIMEOUT_MS), all bridges in parallel. The
 * defaults (5 s + 2.5 s + 1 s, one bridge at a time) would be cut off before
 * SIGTERM.
 * - POSIX: SIGINT 1.5 s, SIGTERM 1.5 s, SIGKILL then 0.5 s = 3.5 s.
 * - win32: no grace. The SIGINT/SIGTERM stages are `taskkill /T` without
 *   `/F`, which does not stop a windowless bridge (~340 ms each), and every
 *   exit poll costs ~500 ms (process start time via PowerShell CIM), so the
 *   POSIX budget sends `/F` only after ~4.8 s. With 0 grace `/F` goes out
 *   after the identity check and the two no-op taskkills (~1.2 s).
 */
export function bridgeCleanupBudget(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32'
    ? { gracePeriodMs: 0, sigtermGraceMs: 0, finalWaitMs: 1_500, parallel: true }
    : { gracePeriodMs: 1_500, sigtermGraceMs: 1_500, finalWaitMs: 500, parallel: true };
}

async function cleanupInProcessTools(): Promise<void> {
  // In parallel: the LSP clients do not wait behind the bridge escalation.
  await Promise.all([
    cleanupOwnedBridgeSessions(bridgeCleanupBudget()).catch(() => undefined), // best effort, as the MCP server
    Promise.resolve().then(disconnectAllLsp).catch(() => undefined),
  ]);
}

/**
 * The plugin tools as SDK session tools, or null when the SDK module lacks the
 * capability (the caller keeps the MCP server).
 */
export function buildSdkInProcessTools(
  sdkModule: unknown,
  serverName: string,
  excludedTools: readonly string[],
  disableToolsEnv?: string,
  registry: ToolDef[] = getEnabledTools(disableToolsEnv ?? ''),
): SdkInProcessToolSet | null {
  const convert = (sdkModule as { convertMcpCallToolResult?: unknown } | null)?.convertMcpCallToolResult;
  if (typeof convert !== 'function') return null;
  const excluded = new Set(excludedTools);
  if (excluded.has(serverName)) return { tools: [], disabledMcpServer: serverName, cleanup: cleanupInProcessTools };
  const tools = registry
    .filter((tool) => !excluded.has(`${serverName}-${tool.name}`))
    .map((tool): SdkInProcessTool => ({
      name: `${serverName}-${tool.name}`,
      description: tool.description,
      parameters: zodToJsonSchema(tool.schema),
      skipPermission: true,
      handler: async (args: unknown) => (convert as ConvertMcpResult)(await callTool(tool.name, args, registry)),
    }));
  return { tools, disabledMcpServer: serverName, cleanup: cleanupInProcessTools };
}
