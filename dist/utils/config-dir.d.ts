/**
 * Host CLI Configuration Directory Resolution
 *
 * Resolves the active host CLI configuration directory, honouring
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
 * Resolve the host CLI configuration directory.
 *
 * Honours COPILOT_CONFIG_DIR (absolute path, or ~-prefixed) with fallback
 * to ~/.copilot.  Trailing separators are stripped; filesystem roots are
 * preserved.
 */
export declare function getCopilotConfigDir(): string;
/**
 * Resolve the OMC global configuration/cache directory under the active Claude
 * config dir. This keeps hook/updater/HUD caches aligned with COPILOT_CONFIG_DIR
 * instead of mixing in ~/.omc.
 */
export declare function getOmcConfigDir(): string;
/** Resolve the canonical update-check cache file path. */
export declare function getUpdateCheckCachePath(): string;
//# sourceMappingURL=config-dir.d.ts.map