/**
 * Validate that a config path is under the user's home directory
 * and contains a trusted subpath (Copilot config dir or ~/.omg/).
 * Resolves the path first to defeat traversal attacks like ~/foo/.copilot/../../evil.json.
 */
export declare function validateConfigPath(configPath: string, homeDir: string, claudeConfigDir: string): boolean;
//# sourceMappingURL=bridge-entry.d.ts.map