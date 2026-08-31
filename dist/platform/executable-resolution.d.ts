/**
 * Cross-Platform Executable Resolution
 *
 * One hardened implementation of the "find this binary and optionally ask it
 * for a version" ritual: `where.exe`/`which` with a bounded timeout, shell-free
 * spawns, and a narrow cmd.exe fallback for Windows `.cmd`/`.bat` shims that
 * cannot be started directly.
 */
export interface CliInfo {
    available: boolean;
    version?: string;
    path?: string;
}
/** The narrow diagnostic result used by doctor-facing callers. */
export interface CliProbeResult {
    found: boolean;
    path?: string;
    version?: string;
    error?: string;
}
/**
 * Resolve a bare binary name to an absolute path via `where.exe`/`which`.
 * Returns undefined for an unsafe name or any resolution failure.
 */
export declare function resolveExecutable(binary: string, platform?: NodeJS.Platform): string | undefined;
/**
 * Presence check for a command. Absolute paths are checked on disk; bare names
 * go through the PATH resolver, which is bounded by a timeout so a hook cannot
 * hang on an unreachable network-drive PATH entry.
 */
export declare function isExecutableAvailable(command: string, platform?: NodeJS.Platform): boolean;
export interface ExecutableProbeOptions {
    /** Arguments passed to the resolved executable. Defaults to ['--version']. */
    args?: string[];
    platform?: NodeJS.Platform;
    timeoutMs?: number;
}
export interface ExecutableProbeResult {
    /** True only when the child (direct or via cmd.exe) exited with status 0. */
    exitedZero: boolean;
    /** First non-blank stdout line, when the child succeeded and produced output. */
    output?: string;
    error?: string;
}
/**
 * Run a resolved executable with a bounded timeout and no shell. On Windows a
 * `.cmd`/`.bat` shim that refuses to start directly is retried through a
 * validated COMSPEC, but only when its path matches a closed literal grammar.
 */
export declare function probeExecutable(resolvedPath: string, options?: ExecutableProbeOptions): ExecutableProbeResult;
/** Resolve a provider CLI and perform a bounded, shell-free optional version probe. */
export declare function probeCli(binary: string, platform?: NodeJS.Platform): CliProbeResult;
/**
 * Legacy detector projection. `available` intentionally remains tied to a
 * status-zero version process rather than to successful path resolution.
 */
export declare function detectCli(binary: string): CliInfo;
export declare function detectAllClis(): Record<string, CliInfo>;
//# sourceMappingURL=executable-resolution.d.ts.map