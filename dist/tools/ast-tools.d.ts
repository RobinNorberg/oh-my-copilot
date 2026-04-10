/**
 * AST Tools using ast-grep
 *
 * Provides AST-aware code search and transformation:
 * - Pattern matching with meta-variables ($VAR, $$$)
 * - Code replacement while preserving structure
 * - Support for 25+ programming languages
 */
import { z } from "zod";
/**
 * Validate that a tool path is within the project root boundary.
 * Only enforced when security.restrictToolPaths is enabled.
 */
export declare function validateToolPath(inputPath: string): string;
export interface AstToolDefinition<T extends z.ZodRawShape> {
    name: string;
    description: string;
    schema: T;
    annotations?: import('./types.js').ToolAnnotations;
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
    }>;
}
export type AnyAstToolDefinition = AstToolDefinition<any> & {
    handler: (args: any) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
    }>;
};
/**
 * Supported languages for AST analysis
 * Maps to ast-grep language identifiers
 */
export declare const SUPPORTED_LANGUAGES: [string, ...string[]];
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
/**
 * AST Grep Search Tool - Find code patterns using AST matching
 */
export declare const astGrepSearchTool: AnyAstToolDefinition;
/**
 * AST Grep Replace Tool - Replace code patterns using AST matching
 */
export declare const astGrepReplaceTool: AnyAstToolDefinition;
/**
 * Get all AST tool definitions
 */
export declare const astTools: AnyAstToolDefinition[];
//# sourceMappingURL=ast-tools.d.ts.map