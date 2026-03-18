/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Copilot CLI statusline interface.
 * Based on copilot-hud reference implementation.
 */
import type { StatuslineStdin } from './types.js';
/**
 * Persist the last successful stdin read to disk.
 * Used by --watch mode to recover data when stdin is a TTY.
 */
export declare function writeStdinCache(stdin: StatuslineStdin): void;
/**
 * Read the last cached stdin JSON.
 * Returns null if no cache exists or it is unreadable.
 */
export declare function readStdinCache(): StatuslineStdin | null;
/**
 * Read and parse stdin JSON from Copilot CLI.
 * Returns null if stdin is not available or invalid.
 */
export declare function readStdin(): Promise<StatuslineStdin | null>;
/**
 * Get context window usage percentage.
 * Prefers native percentage from Copilot CLI v2.1.6+, falls back to manual calculation.
 */
export declare function getContextPercent(stdin: StatuslineStdin): number;
/**
 * Get model display name from stdin.
 */
export declare function getModelName(stdin: StatuslineStdin): string;
//# sourceMappingURL=stdin.d.ts.map