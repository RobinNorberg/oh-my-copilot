/**
 * Factcheck Guard Configuration
 *
 * Loads guard config from the OMC config system with token expansion
 * and deep merge over sensible defaults.
 */
import type { GuardsConfig } from './types.js';
export declare const DEFAULT_GUARDS_CONFIG: GuardsConfig;
/**
 * Expand ${HOME} and ${WORKSPACE} tokens in a string.
 */
export declare function expandTokens(value: string, workspace?: string): string;
/**
 * Load guards config from the OMC config system.
 *
 * Reads the `guards` key from the merged OMC config, deep-merges over
 * defaults, and expands ${HOME}/${WORKSPACE} tokens.
 */
export declare function loadGuardsConfig(workspace?: string): GuardsConfig;
/**
 * Check if a project name matches any strict project patterns.
 * Uses simple glob-style matching (supports * wildcard).
 */
export declare function shouldUseStrictMode(projectName: string, patterns: string[]): boolean;
//# sourceMappingURL=config.d.ts.map