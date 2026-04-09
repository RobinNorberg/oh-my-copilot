/**
 * MCP Bridge for Cross-Tool Interoperability
 *
 * Provides MCP tool definitions for communication between OMC and OMX.
 * Tools allow sending tasks and messages between the two systems.
 */
import { z } from 'zod';
import { ToolDefinition, AnyToolDefinition } from '../tools/types.js';
export type InteropMode = 'off' | 'observe' | 'active';
export declare function getInteropMode(env?: NodeJS.ProcessEnv): InteropMode;
export declare function canUseOmxDirectWriteBridge(env?: NodeJS.ProcessEnv): boolean;
export declare const interopSendTaskTool: AnyToolDefinition;
export declare const interopReadResultsTool: AnyToolDefinition;
export declare const interopSendMessageTool: AnyToolDefinition;
export declare const interopReadMessagesTool: AnyToolDefinition;
export declare const interopListOmxTeamsTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const interopSendOmxMessageTool: ToolDefinition<{
    teamName: z.ZodString;
    fromWorker: z.ZodString;
    toWorker: z.ZodString;
    body: z.ZodString;
    broadcast: z.ZodOptional<z.ZodBoolean>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const interopReadOmxMessagesTool: ToolDefinition<{
    teamName: z.ZodString;
    workerName: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const interopReadOmxTasksTool: AnyToolDefinition;
/**
 * Get all interop MCP tools for registration
 */
export declare function getInteropTools(): ToolDefinition<any>[];
//# sourceMappingURL=mcp-bridge.d.ts.map