/**
 * Copilot CLI Configuration Directory Resolution
 *
 * Resolves the active Copilot CLI configuration directory, honouring
 * COPILOT_CONFIG_DIR (absolute path, or ~-prefixed) with fallback to
 * ~/.copilot.  Trailing separators are stripped; filesystem roots are
 * preserved.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/config-dir.mjs   — ESM hook/HUD runtime
 *   scripts/lib/config-dir.cjs   — CJS bridge runtime
 *   scripts/lib/config-dir.sh    — POSIX shell runtime
 */
/**
 * Resolve the Copilot CLI configuration directory.
 *
 * Honours COPILOT_CONFIG_DIR (absolute path, or ~-prefixed) with fallback
 * to ~/.copilot.  Trailing separators are stripped; filesystem roots are
 * preserved.
 */
export declare function getConfigDir(): string;
/** Alias — used throughout the fork codebase */
export { getConfigDir as getCopilotConfigDir };
/** Alias — used by modules ported directly from upstream */
export { getConfigDir as getClaudeConfigDir };
//# sourceMappingURL=config-dir.d.ts.map