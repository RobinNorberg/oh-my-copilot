import type { BridgeConfig } from "./types.js";
/**
 * Capture a snapshot of tracked/modified/untracked files in the working directory.
 * Uses `git status --porcelain` + `git ls-files --others --exclude-standard`.
 * Returns a Set of relative file paths that currently exist or are modified.
 */
export declare function captureFileSnapshot(cwd: string): Set<string>;
/**
 * Sanitize user-controlled content to prevent prompt injection.
 * - Truncates to maxLength
 * - Escapes XML-like delimiter tags that could confuse the prompt structure
 * @internal
 */
export declare function sanitizePromptContent(content: string, maxLength: number): string;
export declare function recordTaskCompletionUsage(args: {
    config: BridgeConfig;
    taskId: string;
    promptFile: string;
    outputFile: string;
    provider: "codex" | "gemini";
    startedAt: number;
    startedAtIso: string;
}): void;
/** Main bridge daemon entry point */
export declare function runBridge(config: BridgeConfig): Promise<void>;
//# sourceMappingURL=mcp-team-bridge.d.ts.map