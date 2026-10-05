/**
 * Locate the GitHub Copilot CLI binary for `omg smoke copilot`.
 *
 * Order: explicit override, PATH (+PATHEXT on win32), COPILOT_CLI_PATH, then
 * on win32 the WinGet package directory (WinGet installs do not always land on
 * PATH for every shell).
 */
export interface BinaryResolution {
    bin: string | null;
    source: 'override' | 'path' | 'COPILOT_CLI_PATH' | 'winget' | null;
}
export interface BinaryResolverDeps {
    resolveExecutable?: (name: string) => string | undefined;
    existsSync?: (p: string) => boolean;
    readdirSync?: (p: string) => string[];
    platform?: NodeJS.Platform;
}
export declare function resolveCopilotBinary(override: string | undefined, env: NodeJS.ProcessEnv, deps?: BinaryResolverDeps): BinaryResolution;
/** Extract `x.y.z` from `copilot --version` output ("GitHub Copilot CLI 1.0.91."). */
export declare function parseCopilotVersion(output: string): string | null;
//# sourceMappingURL=copilot-binary.d.ts.map