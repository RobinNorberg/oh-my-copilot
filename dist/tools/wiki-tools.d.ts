/**
 * Wiki MCP Tools
 *
 * Provides 7 tools for the LLM Wiki knowledge layer:
 * wiki_ingest, wiki_query, wiki_lint, wiki_add, wiki_list, wiki_read, wiki_delete
 */
import { z } from 'zod';
import { ToolDefinition, AnyToolDefinition } from './types.js';
export declare const wikiIngestTool: AnyToolDefinition;
export declare const wikiQueryTool: AnyToolDefinition;
export declare const wikiLintTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiAddTool: AnyToolDefinition;
export declare const wikiListTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiReadTool: ToolDefinition<{
    page: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiDeleteTool: ToolDefinition<{
    page: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiTools: (AnyToolDefinition | ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    page: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=wiki-tools.d.ts.map