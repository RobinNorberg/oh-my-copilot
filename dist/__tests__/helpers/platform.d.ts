export declare const IS_WIN: boolean;
/**
 * Directory and file symlinks both work. Windows without Developer Mode or
 * elevation refuses both with EPERM.
 */
export declare function canCreateSymlinks(): boolean;
/** Directory junctions work (unprivileged on Windows; a plain dir symlink elsewhere). */
export declare function canCreateJunctions(): boolean;
/** `name` resolves on PATH (with PATHEXT on Windows), without spawning a shell. */
export declare function hasExecutable(name: string): boolean;
/** `file://` URL string for a native path (`file:///C:/...` on Windows). */
export declare function toFileUrl(path: string): string;
/** Forward-slash form of a native path, for separator-agnostic assertions. */
export declare function toPosix(path: string): string;
/** Multiplier for wall-clock ceilings tuned on Linux; process spawn and fs calls are several times slower on Windows. */
export declare const TIMING_SCALE: number;
/** Scale a Linux-tuned wall-clock ceiling for the host. Identity on Linux and macOS. */
export declare function scaleTiming(ms: number): number;
/**
 * Remove a temp tree in teardown. Windows refuses to delete a directory that a
 * still-exiting or detached child holds as its cwd or has a handle in (EPERM).
 * Node 25's `rmSync` does not retry EPERM despite `maxRetries`; `fs.promises.rm`
 * does, with linear backoff (about 5.5 s in total here).
 */
export declare function removeTempDir(path: string): Promise<void>;
/**
 * Skip on Windows. `reason` names the POSIX-only behavior so the call site
 * documents itself, e.g. `posixOnly('NTFS has no POSIX mode bits')`.
 */
export declare function posixOnly(reason: string): boolean;
/** Skip when the host cannot create symlinks. */
export declare function requiresSymlinks(): boolean;
/** Skip when `name` is not on PATH. */
export declare function requiresExecutable(name: string): boolean;
//# sourceMappingURL=platform.d.ts.map