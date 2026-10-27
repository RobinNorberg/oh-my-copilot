/**
 * Drive mode for `omg release <v> --drive` and `omg ship gates <pr> --drive`:
 * one long-lived loop that runs until a terminal state (done, a real
 * failure, or a decision only a human can make), so a lead arms one Monitor
 * on `omg progress watch --file <log> --until settled` instead of polling.
 *
 *   driveRelease   re-enters runRelease (resume semantics re-check every
 *                  skipped phase) after one poll interval while it ends
 *                  pending (a CI wait past --timeout, a transient GitHub
 *                  error); --drive-max hours turn into blocked
 *   lock           `<dir>/<name>.drive.json` { pid, startedAt, argv, host,
 *                  identity }, created exclusively (wx); a second driver
 *                  refuses while the holder is alive and takes a stale lock
 *                  over (dead pid, or a pid reused by another process)
 *   detach         re-spawns the same CLI without --detach as a detached
 *                  node child (stdio to `<name>.drive.log`, windowsHide,
 *                  unref), the pattern of src/hooks/session-end/worker.ts;
 *                  it is outside the session's job object and outlives it
 *   status / stop  print the lock and the last events; stop kills the
 *                  holder's process tree only when its start identity
 *                  matches the lock (a reused pid is never signalled)
 */

import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { dirname, join } from 'path';
import { getProcessStartIdentity, isProcessAlive, isProcessIdentityLive, killProcessTree } from '../platform/process-utils.js';
import { runRelease, type ReleaseDeps, type ReleaseOptions, type ReleaseResult } from './engine.js';
import type { ReleaseProgressInput } from './progress.js';

/** Pause between two pending runs of the drive loop. */
export const DRIVE_POLL_MS = 60_000;
/** Default --drive-max (hours). */
export const DRIVE_MAX_HOURS = 6;
/** Heartbeats are written at most this often under --drive. */
export const DRIVE_HEARTBEAT_MS = 5 * 60_000;

export interface DriveLock {
  pid: number;
  startedAt: string;
  argv: string[];
  host: string;
  /** Process start identity (PID-reuse guard); null when it could not be read. */
  identity: string | null;
}

export type DriverLiveness = 'live' | 'dead' | 'mismatch' | 'unknown';

/** Process probes, injectable for tests. */
export interface DriveProcess {
  identity: (pid: number) => Promise<string | null>;
  liveness: (lock: DriveLock) => Promise<DriverLiveness>;
  /** Kill the process tree; true when it is gone. */
  kill: (pid: number) => Promise<boolean>;
}

export const defaultDriveProcess: DriveProcess = {
  identity: (pid) => getProcessStartIdentity(pid, Date.now() + 5_000),
  liveness: async (lock) => {
    // Another machine's pid (a shared state dir) cannot be probed: never treated as dead.
    if (lock.host !== hostname()) return 'unknown';
    if (!lock.identity) return isProcessAlive(lock.pid) ? 'live' : 'dead';
    return isProcessIdentityLive(lock.pid, lock.identity, Date.now() + 5_000);
  },
  // taskkill /F /T on Windows (a windowless node child ignores a plain taskkill); the process group elsewhere.
  kill: (pid) => killProcessTree(pid, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM'),
};

export function driveLockPath(dir: string, name: string): string {
  return join(dir, `${name}.drive.json`);
}

export function driveLogPath(dir: string, name: string): string {
  return join(dir, `${name}.drive.log`);
}

export function readDriveLock(path: string): DriveLock | null {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as DriveLock;
    return Number.isInteger(lock?.pid) && lock.pid > 0 ? lock : null;
  } catch {
    return null;
  }
}

export type AcquireResult = { ok: true; lock: DriveLock } | { ok: false; holder: DriveLock | null; liveness: DriverLiveness };

/**
 * Take the single-driver lock for this process. A live (or unprobeable)
 * holder refuses; a dead or pid-reused holder, or an unreadable lock file,
 * is logged and taken over.
 */
export async function acquireDriveLock(path: string, argv: string[], proc: DriveProcess, log: (line: string) => void, now: () => number = Date.now): Promise<AcquireResult> {
  const lock: DriveLock = { pid: process.pid, startedAt: new Date(now()).toISOString(), argv, host: hostname(), identity: await proc.identity(process.pid) };
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
      return { ok: true, lock };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readDriveLock(path);
    if (holder) {
      const liveness = await proc.liveness(holder);
      if (liveness === 'live' || liveness === 'unknown') return { ok: false, holder, liveness };
      log(`taking over the stale drive lock ${path} of pid ${holder.pid} (${liveness}, started ${holder.startedAt})`);
    } else {
      log(`taking over the unreadable drive lock ${path}`);
    }
    rmSync(path, { force: true });
  }
  return { ok: false, holder: readDriveLock(path), liveness: 'unknown' };
}

/** Remove the lock only while it is still this process's. */
export function releaseDriveLock(path: string, pid: number = process.pid): void {
  if (readDriveLock(path)?.pid === pid) rmSync(path, { force: true });
}

/** Under --drive, heartbeats at most every DRIVE_HEARTBEAT_MS; every other event passes. */
export function throttleHeartbeats(progress: (event: ReleaseProgressInput) => void, now: () => number, everyMs = DRIVE_HEARTBEAT_MS): (event: ReleaseProgressInput) => void {
  let last = -Infinity;
  return (event) => {
    if (event.status === 'heartbeat') {
      if (now() - last < everyMs) return;
      last = now();
    }
    progress(event);
  };
}

export interface DriveOptions {
  maxHours?: number;
  pollMs?: number;
}

/**
 * runRelease until it is no longer pending. The first run keeps --from;
 * later runs resume (the pending phase left no record). Bounded by
 * --drive-max on the clock and by the matching number of rounds when the
 * clock does not move.
 */
export async function driveRelease(deps: ReleaseDeps, opts: ReleaseOptions, drive: DriveOptions = {}): Promise<ReleaseResult> {
  const maxHours = drive.maxHours ?? DRIVE_MAX_HOURS;
  const pollMs = drive.pollMs ?? DRIVE_POLL_MS;
  const maxMs = maxHours * 3_600_000;
  const until = deps.now() + maxMs;
  const rounds = Math.max(1, Math.ceil(maxMs / pollMs));
  let request: ReleaseOptions = { ...opts, drive: true };
  for (let round = 1; ; round++) {
    const result = await runRelease(deps, request);
    if (!result.pending) return result;
    const { phase, note } = result.pending;
    if (deps.now() >= until || round >= rounds) {
      const stop = `--drive-max ${maxHours} h reached while ${note}; check it, then re-run omg release ${opts.version} --drive --detach to keep driving`;
      deps.progress({ phase, status: 'blocked', note: stop });
      deps.log(`[${phase}] blocked: ${stop}`);
      return { ...result, pending: undefined, phases: [...result.phases, { id: phase, status: 'blocked', note: stop }] };
    }
    await deps.sleep(pollMs);
    request = { ...request, from: undefined };
  }
}

export type DriveSpawn = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => { pid?: number; unref(): void };

/**
 * Spawn `node <entry> <argv>` detached, stdout / stderr appended to `logPath`.
 * Returns the child's pid (undefined when the spawn failed).
 */
export function spawnDetachedDriver(entry: string, argv: string[], logPath: string, cwd: string, spawnImpl: DriveSpawn = spawn): number | undefined {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawnImpl(process.execPath, [entry, ...argv], { cwd, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Poll (up to `waitMs`) until the lock names `pid`: the detached driver is running. */
export async function awaitDriverLock(path: string, pid: number, sleep: (ms: number) => Promise<void>, waitMs = 15_000, stepMs = 250): Promise<boolean> {
  for (let waited = 0; ; waited += stepMs) {
    if (readDriveLock(path)?.pid === pid) return true;
    if (waited >= waitMs) return false;
    await sleep(stepMs);
  }
}

export type DetachResult = { ok: true; pid: number; locked: boolean } | { ok: false; reason: string };

/** `--detach`: refuse while a driver holds the lock, else spawn one and wait until it holds it. */
export async function detachDriver(o: {
  lockPath: string; logPath: string; entry: string; argv: string[]; cwd: string; proc: DriveProcess;
  sleep: (ms: number) => Promise<void>; spawnImpl?: DriveSpawn; statusCommand: string;
}): Promise<DetachResult> {
  const holder = readDriveLock(o.lockPath);
  if (holder) {
    const liveness = await o.proc.liveness(holder);
    if (liveness === 'live' || liveness === 'unknown') {
      return { ok: false, reason: `a driver already runs (pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}); see ${o.statusCommand}` };
    }
  }
  const pid = spawnDetachedDriver(o.entry, o.argv, o.logPath, o.cwd, o.spawnImpl);
  if (!pid) return { ok: false, reason: `could not spawn the detached driver (see ${o.logPath})` };
  return { ok: true, pid, locked: await awaitDriverLock(o.lockPath, pid, o.sleep) };
}

/** Run `fn` holding the drive lock; `held: false` (and `fn` not run) when another driver holds it. */
export async function withDriveLock<T>(path: string, argv: string[], proc: DriveProcess, log: (line: string) => void, fn: () => Promise<T>): Promise<{ held: true; value: T } | { held: false; holder: DriveLock | null }> {
  const acquired = await acquireDriveLock(path, argv, proc, log);
  if (!acquired.ok) return { held: false, holder: acquired.holder };
  try {
    return { held: true, value: await fn() };
  } finally {
    releaseDriveLock(path);
  }
}

/** The last `n` non-empty lines of a file (empty when it does not exist). */
export function lastLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n);
}

/** `refused`: a holder that may still run was left alone. */
export type StopResult = { stopped: true; pid: number } | { stopped: false; refused: boolean; reason: string };

/**
 * Stop the driver holding `path`: kill its tree when its identity matches,
 * then remove the lock. A dead or reused pid only loses its stale lock; an
 * unprobeable holder (another host) is left alone.
 */
export async function stopDriver(path: string, proc: DriveProcess): Promise<StopResult> {
  const lock = readDriveLock(path);
  if (!lock) {
    if (existsSync(path)) rmSync(path, { force: true });
    return { stopped: false, refused: false, reason: 'no driver is running (no drive lock)' };
  }
  const liveness = await proc.liveness(lock);
  if (liveness === 'unknown') return { stopped: false, refused: true, reason: `cannot verify pid ${lock.pid} on ${lock.host}; not signalled, lock kept (stop it there, or delete ${path} once it is gone)` };
  if (liveness !== 'live') {
    rmSync(path, { force: true });
    return { stopped: false, refused: false, reason: `pid ${lock.pid} is ${liveness === 'dead' ? 'not running' : 'another process now'}; removed the stale lock` };
  }
  if (!(await proc.kill(lock.pid))) return { stopped: false, refused: true, reason: `could not kill pid ${lock.pid}; lock kept` };
  rmSync(path, { force: true });
  return { stopped: true, pid: lock.pid };
}
