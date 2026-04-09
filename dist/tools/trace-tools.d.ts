/**
 * Trace Tools - MCP tools for viewing agent flow traces
 *
 * Provides trace_timeline and trace_summary tools for the /trace feature.
 * Reads session replay JSONL files and formats them for display.
 */
import { z } from 'zod';
import { ToolDefinition, AnyToolDefinition } from './types.js';
export declare const traceTimelineTool: AnyToolDefinition;
export declare const traceSummaryTool: ToolDefinition<{
    sessionId: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
/**
 * All trace tools for registration
 */
export declare const traceTools: (AnyToolDefinition | ToolDefinition<{
    sessionId: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=trace-tools.d.ts.map