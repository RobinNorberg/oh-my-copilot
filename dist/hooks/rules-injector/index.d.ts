/**
 * Rules Injector Hook
 *
 * Automatically injects relevant rule files when Copilot accesses files.
 * Supports project-level (.copilot/rules, .github/instructions) and
 * user-level rules under [$COPILOT_CONFIG_DIR|~/.copilot].
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import type { RuleToInject } from './types.js';
export * from './types.js';
export * from './constants.js';
export * from './finder.js';
export * from './parser.js';
export * from './matcher.js';
export * from './storage.js';
/**
 * Create a rules injector hook for Copilot CLI.
 *
 * @param workingDirectory - The working directory for resolving paths
 * @returns Hook handlers for tool execution
 */
export declare function createRulesInjectorHook(workingDirectory: string): {
    /**
     * Process a tool execution and inject rules if relevant.
     */
    processToolExecution: (toolName: string, filePath: string, sessionId: string) => string;
    /**
     * Get rules for a specific file without marking as injected.
     */
    getRulesForFile: (filePath: string) => RuleToInject[];
    /**
     * Clear session cache when session ends.
     */
    clearSession: (sessionId: string) => void;
    /**
     * Check if a tool triggers rule injection.
     */
    isTrackedTool: (toolName: string) => boolean;
};
/**
 * Get rules for a file path (simple utility function).
 */
export declare function getRulesForPath(filePath: string, workingDirectory?: string): RuleToInject[];
//# sourceMappingURL=index.d.ts.map