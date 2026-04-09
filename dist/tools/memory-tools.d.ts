/**
 * Project Memory MCP Tools
 *
 * Provides tools for reading and writing project memory.
 */
import { z } from 'zod';
import { ToolDefinition, AnyToolDefinition } from './types.js';
export declare const projectMemoryReadTool: AnyToolDefinition;
export declare const projectMemoryWriteTool: ToolDefinition<{
    memory: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    merge: z.ZodOptional<z.ZodBoolean>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const projectMemoryAddNoteTool: ToolDefinition<{
    category: z.ZodString;
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const projectMemoryAddDirectiveTool: AnyToolDefinition;
/**
 * All memory tools for registration
 */
export declare const memoryTools: (AnyToolDefinition | ToolDefinition<{
    memory: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    merge: z.ZodOptional<z.ZodBoolean>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    category: z.ZodString;
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=memory-tools.d.ts.map