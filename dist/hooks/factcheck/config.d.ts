/**
 * Factcheck Guard Configuration
 *
 * Loads guard config from the OMC config system with token expansion
 * and deep merge over sensible defaults.
 */
import type { GuardsConfig } from './types.js';
export declare const DEFAULT_GUARDS_CONFIG: GuardsConfig;
/**
 * Expand ${HOME}, ${WORKSPACE}, and ${COPILOT_HOME} tokens in a string.
 * ${COPILOT_CONFIG_DIR} is accepted as a legacy alias of ${COPILOT_HOME}.
 */
export declare function expandTokens(value: string, workspace?: string): string;
/**
 * Load guards config from the OMC config system.
 *
 * Reads the `guards` key from the merged OMC config, deep-merges over
 * defaults, and expands ${HOME}/${WORKSPACE}/${COPILOT_HOME} tokens.
 */
export declare function loadGuardsConfig(workspace?: string): GuardsConfig;
/**
 * Check if a project name matches any strict project patterns.
 * Uses simple glob-style matching (supports * wildcard).
 */
export declare function shouldUseStrictMode(projectName: string, patterns: string[]): boolean;
//# sourceMappingURL=config.d.ts.map