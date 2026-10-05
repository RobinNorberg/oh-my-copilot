/**
 * Subprocess helpers for `omg smoke`. Every call takes the spawn function as a
 * parameter so unit tests never start a real process.
 */
import { spawn, spawnSync } from 'child_process';
export type SpawnFn = typeof spawn;
export type SpawnSyncFn = typeof spawnSync;
export interface RunResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error?: string;
    durationMs: number;
}
export interface RunAsyncOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
    windowsVerbatimArguments?: boolean;
    /** Cap on captured stdout/stderr each (bytes of UTF-16 text). */
    maxOutput?: number;
}
/**
 * Spawn children in their own process group on POSIX so a timeout can kill
 * the whole tree (copilot's node hook and MCP children included). On win32
 * `detached` would open a new console, and taskkill /T walks the tree anyway.
 */
export declare function useProcessGroup(platform?: NodeJS.Platform): boolean;
/**
 * Kill a process and its children. On win32 `child.kill()` only ends the
 * direct child, leaving copilot's node hook/MCP children behind, so use
 * `taskkill /T /F`. On POSIX the child was spawned as a process-group leader
 * ({@link useProcessGroup}), so signal the group (`-pid`), falling back to
 * the pid alone.
 */
export declare function killProcessTree(pid: number | undefined, spawnSyncFn: SpawnSyncFn, platform?: NodeJS.Platform, killFn?: (pid: number, signal: NodeJS.Signals) => void): void;
/** True once the child has exited; a tree kill would then target a recycled pid. */
export declare function hasExited(child: {
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
}): boolean;
/** Run a command to completion with stdin input and a hard timeout (tree kill). */
export declare function runAsync(spawnFn: SpawnFn, spawnSyncFn: SpawnSyncFn, command: string, args: readonly string[], opts: RunAsyncOptions): Promise<RunResult>;
//# sourceMappingURL=process-utils.d.ts.map