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

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Spawn children in their own process group on POSIX so a timeout can kill
 * the whole tree (copilot's node hook and MCP children included). On win32
 * `detached` would open a new console, and taskkill /T walks the tree anyway.
 */
export function useProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/**
 * Kill a process and its children. On win32 `child.kill()` only ends the
 * direct child, leaving copilot's node hook/MCP children behind, so use
 * `taskkill /T /F`. On POSIX the child was spawned as a process-group leader
 * ({@link useProcessGroup}), so signal the group (`-pid`), falling back to
 * the pid alone.
 */
export function killProcessTree(
  pid: number | undefined,
  spawnSyncFn: SpawnSyncFn,
  platform: NodeJS.Platform = process.platform,
  killFn: (pid: number, signal: NodeJS.Signals) => void = (p, sig) => { process.kill(p, sig); },
): void {
  if (!pid) return;
  if (platform === 'win32') {
    try {
      spawnSyncFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    } catch { /* best effort */ }
    return;
  }
  try { killFn(-pid, 'SIGKILL'); return; } catch { /* not a group leader or already gone */ }
  try { killFn(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** True once the child has exited; a tree kill would then target a recycled pid. */
export function hasExited(child: { exitCode?: number | null; signalCode?: NodeJS.Signals | null }): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

/** Run a command to completion with stdin input and a hard timeout (tree kill). */
export function runAsync(
  spawnFn: SpawnFn,
  spawnSyncFn: SpawnSyncFn,
  command: string,
  args: readonly string[],
  opts: RunAsyncOptions,
): Promise<RunResult> {
  const started = Date.now();
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
        detached: useProcessGroup(),
      });
    } catch (err) {
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: (err as Error).message, durationMs: Date.now() - started });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (!hasExited(child)) killProcessTree(child.pid, spawnSyncFn);
      // Some platforms never emit 'close' once the tree is force-killed; settle anyway.
      setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2_000).unref?.();
    }, opts.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < maxOutput) stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < maxOutput) stderr += chunk; });
    child.on('error', (err) => finish({ code: null, signal: null, error: err.message }));
    child.on('close', (code, signal) => finish({ code, signal }));

    child.stdin?.on('error', () => { /* child may exit before reading stdin */ });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}
