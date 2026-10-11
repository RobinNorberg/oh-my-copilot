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
 */

import { callTool, getEnabledTools, zodToJsonSchema, type ToolDef } from '../mcp/tool-registry.js';

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
  const tools = registry
    .filter((tool) => !excluded.has(`${serverName}-${tool.name}`))
    .map((tool): SdkInProcessTool => ({
      name: `${serverName}-${tool.name}`,
      description: tool.description,
      parameters: zodToJsonSchema(tool.schema),
      skipPermission: true,
      handler: async (args: unknown) => (convert as ConvertMcpResult)(await callTool(tool.name, args, registry)),
    }));
  return { tools, disabledMcpServer: serverName };
}
