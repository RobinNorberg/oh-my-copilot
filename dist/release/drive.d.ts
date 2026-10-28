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
import { type ReleaseDeps, type ReleaseOptions, type ReleaseResult } from './engine.js';
import type { ReleaseProgressInput } from './progress.js';
/** Pause between two pending runs of the drive loop. */
export declare const DRIVE_POLL_MS = 60000;
/** Default --drive-max (hours). */
export declare const DRIVE_MAX_HOURS = 6;
/** Heartbeats are written at most this often under --drive. */
export declare const DRIVE_HEARTBEAT_MS: number;
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
export declare const defaultDriveProcess: DriveProcess;
export declare function driveLockPath(dir: string, name: string): string;
export declare function driveLogPath(dir: string, name: string): string;
export declare function readDriveLock(path: string): DriveLock | null;
export type AcquireResult = {
    ok: true;
    lock: DriveLock;
} | {
    ok: false;
    holder: DriveLock | null;
    liveness: DriverLiveness;
};
/** File operations of the stale takeover, injectable so a race can be staged in tests. */
export interface DriveLockFs {
    rename: (from: string, to: string) => void;
}
/**
 * Take the single-driver lock for this process. A live (or unprobeable)
 * holder refuses; a dead or pid-reused holder, or an unreadable lock file,
 * is logged and taken over. The takeover renames the stale lock to a unique
 * name, re-reads it, and only deletes it when it is still the stale holder
 * (else it goes back and the lock is refused), so two drivers cannot both
 * remove each other's fresh lock. Throws when this process's start identity
 * cannot be read: without it `--stop` could never tell the driver from a
 * reused pid.
 */
export declare function acquireDriveLock(path: string, argv: string[], proc: DriveProcess, log: (line: string) => void, now?: () => number, fsx?: DriveLockFs): Promise<AcquireResult>;
/** Remove the lock only while it is still this process's. */
export declare function releaseDriveLock(path: string, pid?: number): void;
/** Under --drive, heartbeats at most every DRIVE_HEARTBEAT_MS; every other event passes. */
export declare function throttleHeartbeats(progress: (event: ReleaseProgressInput) => void, now: () => number, everyMs?: number): (event: ReleaseProgressInput) => void;
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
export declare function driveRelease(deps: ReleaseDeps, opts: ReleaseOptions, drive?: DriveOptions): Promise<ReleaseResult>;
export type DriveSpawn = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    pid?: number;
    unref(): void;
};
/**
 * Spawn `node <entry> <argv>` detached, stdout / stderr appended to `logPath`.
 * Returns the child's pid (undefined when the spawn failed).
 */
export declare function spawnDetachedDriver(entry: string, argv: string[], logPath: string, cwd: string, spawnImpl?: DriveSpawn): number | undefined;
/** Poll (up to `waitMs`) until the lock names `pid`: the detached driver is running. */
export declare function awaitDriverLock(path: string, pid: number, sleep: (ms: number) => Promise<void>, waitMs?: number, stepMs?: number): Promise<boolean>;
export type DetachResult = {
    ok: true;
    pid: number;
    locked: boolean;
} | {
    ok: false;
    reason: string;
};
/** `--detach`: refuse while a driver holds the lock, else spawn one and wait until it holds it. */
export declare function detachDriver(o: {
    lockPath: string;
    logPath: string;
    entry: string;
    argv: string[];
    cwd: string;
    proc: DriveProcess;
    sleep: (ms: number) => Promise<void>;
    spawnImpl?: DriveSpawn;
    statusCommand: string;
}): Promise<DetachResult>;
/** Run `fn` holding the drive lock; `held: false` (and `fn` not run) when another driver holds it. */
export declare function withDriveLock<T>(path: string, argv: string[], proc: DriveProcess, log: (line: string) => void, fn: () => Promise<T>): Promise<{
    held: true;
    value: T;
} | {
    held: false;
    holder: DriveLock | null;
}>;
/** The last `n` non-empty lines of a file (empty when it does not exist). */
export declare function lastLines(path: string, n: number): string[];
/** `refused`: a holder that may still run was left alone. */
export type StopResult = {
    stopped: true;
    pid: number;
} | {
    stopped: false;
    refused: boolean;
    reason: string;
};
/**
 * Stop the driver holding `path`: kill its tree when its identity matches,
 * then remove the lock. A dead or reused pid only loses its stale lock; an
 * unprobeable holder (another host) is left alone.
 */
export declare function stopDriver(path: string, proc: DriveProcess): Promise<StopResult>;
//# sourceMappingURL=drive.d.ts.map