import type { RunDirHandle } from "./run-dir.js";
/** Fail closed before acquiring any run-scoped locks on unsupported platforms. */
export declare function assertContainedFsSupported(platform?: NodeJS.Platform): void;
/**
 * Validate the untrusted final component before it reaches any path API.
 * Contained artifacts are deliberately a single portable basename: allowing
 * either platform separator would make the contract depend on the host that
 * happens to process the descriptor, and Windows also treats `:` as an ADS
 * separator. Require canonical NFC so the same artifact name has one portable
 * byte-level spelling across Linux, macOS, and Windows; reject normalization-
 * changing values rather than attempting to canonicalize untrusted input.
 */
export declare function assertSafeContainedFileName(fileName: string, platform?: NodeJS.Platform): void;
/** Open a runtime artifact without following a symlink at the final path. */
export declare function openNoFollow(filePath: string, flags: number, mode?: number): number;
/** Reject special files and hardlinks that escape the run-directory inode. */
export declare function assertPrivateRegularFile(fileDescriptor: number, filePath: string): void;
/** Read a runtime artifact without following a symlink at the final path. */
export declare function readFileNoFollow(filePath: string): string;
/**
 * Resolve a path for an already-open run directory without changing the
 * process-wide platform state. Linux exposes directory FDs as traversable
 * procfs directories. Platforms without that primitive fail closed instead of
 * falling back to a raceable pathname.
 */
export declare function containedPathForPlatform(directoryFd: number, runDirPath: string, fileName: string, platform?: NodeJS.Platform): string;
/**
 * Run a synchronous operation against a directory FD on Linux. If the
 * directory is renamed or its parent path is replaced while the operation is
 * in flight, the FD still refers to the originally validated directory.
 * Platforms without a traversable directory FD fail closed.
 */
export declare function withContainedPath<T>(runDir: RunDirHandle, fileName: string, operation: (filePath: string) => T): T;
/** Run several related operations beneath one identity-checked directory FD. */
export declare function withContainedDirectory<T>(runDir: RunDirHandle, operation: (directoryPath: string) => T, platform?: NodeJS.Platform): T;
export declare function withContainedPathForPlatform<T>(runDir: RunDirHandle, fileName: string, operation: (filePath: string) => T, platform: NodeJS.Platform): T;
/** Read a named artifact through a validated run-directory handle. */
export declare function readContainedFileNoFollow(runDir: RunDirHandle, fileName: string): string;
//# sourceMappingURL=safe-fs.d.ts.map