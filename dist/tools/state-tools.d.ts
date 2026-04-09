/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */
import { z } from 'zod';
import { ToolDefinition, AnyToolDefinition } from './types.js';
export declare const stateReadTool: AnyToolDefinition;
export declare const stateWriteTool: AnyToolDefinition;
export declare const stateClearTool: AnyToolDefinition;
export declare const stateListActiveTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>;
export declare const stateGetStatusTool: AnyToolDefinition;
/**
 * All state tools for registration
 */
export declare const stateTools: (AnyToolDefinition | ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=state-tools.d.ts.map