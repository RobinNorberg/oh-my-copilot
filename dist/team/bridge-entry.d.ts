/**
 * Validate that a config path is under the user's home directory
 * and contains a trusted subpath (Claude config dir or ~/.omg/).
 * Resolves the path first to defeat traversal attacks like ~/foo/.copilot/../../evil.json.
 */
export declare function validateConfigPath(configPath: string, homeDir: string, claudeConfigDir: string): boolean;
/**
 * Validate the bridge working directory is safe:
 * - Must exist and be a directory
 * - Must resolve (via realpathSync) to a path under the user's home directory
 * - Must be inside a git worktree
 */
export declare function validateBridgeWorkingDirectory(workingDirectory: string): void;
//# sourceMappingURL=bridge-entry.d.ts.map