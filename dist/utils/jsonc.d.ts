/**
 * Simple JSONC (JSON with Comments) parser
 *
 * Strips single-line (//) and multi-line (slash-star) comments from JSONC
 * before parsing with standard JSON.parse.
 */
/**
 * Parse JSONC content by stripping comments and parsing as JSON
 */
export declare function parseJsonc(content: string): unknown;
/**
 * Strip comments from JSONC content
 * Handles single-line (//) and multi-line comments
 */
export declare function stripJsoncComments(content: string): string;
//# sourceMappingURL=jsonc.d.ts.map