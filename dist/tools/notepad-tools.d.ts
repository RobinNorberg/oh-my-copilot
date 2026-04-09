/**
 * Notepad MCP Tools
 *
 * Provides tools for reading and writing notepad sections
 * (Priority Context, Working Memory, MANUAL).
 */
import { z } from 'zod';
import { ToolDefinition, AnyToolDefinition } from './types.js';
export declare const notepadReadTool: AnyToolDefinition;
export declare const notepadWritePriorityTool: ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadWriteWorkingTool: ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadWriteManualTool: ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadPruneTool: ToolDefinition<{
    daysOld: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadStatsTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
/**
 * All notepad tools for registration
 */
export declare const notepadTools: (AnyToolDefinition | ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    daysOld: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=notepad-tools.d.ts.map