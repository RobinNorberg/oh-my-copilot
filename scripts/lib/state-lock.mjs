import { closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const SQLITE_NATIVE_BINDING = 'better_sqlite3.node';
const SQLITE_NATIVE_BINDING_REMEDIATION =
  'Run `npm rebuild better-sqlite3` in the OMC plugin directory, then restart Claude Code.';
let Database = null;
let sqliteBindingLoadError = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nativeBindingDiagnostic(detail) {
  const normalizedDetail = detail?.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim().slice(0, 240);
  const suffix = normalizedDetail ? ` Loader error: ${normalizedDetail}` : '';
  return `better-sqlite3 native binding (${SQLITE_NATIVE_BINDING}) is unavailable. State mutation is using the file-lock fallback. ${SQLITE_NATIVE_BINDING_REMEDIATION}${suffix}`;
}

function isNativeBindingError(error) {
  return /better[_-]sqlite3(?:\.node)?|bindings(?:\.js)?|MODULE_NOT_FOUND|NODE_MODULE_VERSION|did not self-register|Could not locate the bindings file/i.test(errorMessage(error));
}

try {
  const loaded = require('better-sqlite3');
  const candidate = typeof loaded === 'function' ? loaded : loaded?.default;
  if (typeof candidate !== 'function') throw new Error('better-sqlite3 did not export a Database constructor');
  Database = candidate;
} catch (error) {
  sqliteBindingLoadError = nativeBindingDiagnostic(errorMessage(error));
}

const localLocks = new Map();
const recoveryLocks = new Map();
// Pre-upgrade PostToolUseFailure locks contain only a PID and timestamp.
const LEGACY_PROCESS_START_UNCERTAINTY_MS = { linux: 1000, darwin: 1000, win32: 1 };
let linuxClockTicksPerSecond;
let ownIdentityCache = null;
let lastLockFailure = null;
let lastLockFailureDetail = null;
// Fork fix: 'malformed-owner' when an unverifiable failure came from owner metadata that no
// retry can repair, as opposed to a probe that ran out of time. Reset by every recordFailure.
let lastLockFailureReason = null;
// Fork fix: nonces of lock owners this module published but no longer holds (a failed release,
// or a failed acquire after publication). Only this module instance could hold them, so a row or
// artifact carrying one is orphaned-by-self and reclaimable instead of self-deadlocking the
// process for its lifetime. Keyed by nonce, not pid+processStart, so another thread's live lock
// in the same process is never mistaken for an orphan.
const abandonedOwnNonces = new Set();
// Fork fix: an inconclusive (null) owner probe is retried at most this many times per acquire.
// A slow win32 probe can turn conclusive on a retry (#4727), but most nulls never can (a legacy
// owner on a platform without a start-time tolerance, an unreadable procfs entry, an invalid
// pid), and retrying those on every one of 50 attempts stalled the acquire for 0.5-1 s.
const INCONCLUSIVE_PROBE_RETRY_LIMIT = 2;

function wallClockNowMs(testHooks) {
  return typeof testHooks?.nowMs === 'function' ? testHooks.nowMs() : Date.now();
}

function startProcessIdentity(pid, timeoutMs, testHooks) {
  return typeof testHooks?.processStartIdentity === 'function'
    ? testHooks.processStartIdentity(pid, timeoutMs)
    : processStartIdentity(pid, timeoutMs);
}

function ownProcessStartIdentity(timeoutMs = 3000, testHooks) {
  if (ownIdentityCache === null) ownIdentityCache = startProcessIdentity(process.pid, timeoutMs, testHooks);
  return ownIdentityCache;
}

// Fork fix: on win32 the exact own identity (GetProcessTimes CreationTime) is reachable only
// through a PowerShell spawn, 0.4-3 s per hook process, which made lock acquires fail closed
// under load. A lock owner record instead carries `ticksmax:<n>` (version 2), an upper bound on
// this process's creation time in the .NET UTC ticks the PowerShell probe returns:
// performance.timeOrigin is the wall clock Node read during bootstrap, after the kernel stamped
// CreationTime. A foreign prober reads the owner as live iff the pid's exact creation ticks are
// <= the bound (startIdentityMatches). That holds for this process and fails for any later
// process reusing the pid: the bound lies before the first publication (the slack is waited out
// below), and a reuser is created after this process exits. Old readers reject version 2 as
// malformed, which fails closed.
// Residual risk: the bound comes from the wall clock, so if the clock steps backward after this
// process starts and the process dies, a later process reusing the pid can get creation ticks
// <= the bound and read as this (dead) owner. The lock then stays held while that unrelated
// process lives. This fails closed (no second holder); the lock frees when the reuser exits.
// The bound is built in BigInt from whole milliseconds, rounded up, so it stays an upper bound
// without the double-precision loss of a ticks value above 2^53.
export const START_BOUND_PREFIX = 'ticksmax:';
// Covers the 15.6 ms default clock tick between a coarse and a precise system time read.
const START_BOUND_SLACK_MS = 20;
// performance.timeOrigin must agree with Date.now() - uptime: a stale (snapshot-time) origin
// would make every live owner read as dead, so a mismatch falls back to the exact probe.
const START_BOUND_ORIGIN_TOLERANCE_MS = 1000;
let ownStartBoundCache = null;

function ownStartBoundIdentity() {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(process.pid)) return null;
  if (ownStartBoundCache !== null) return ownStartBoundCache;
  const origin = performance.timeOrigin;
  const uptimeOrigin = Date.now() - process.uptime() * 1000;
  if (!Number.isFinite(origin) || origin <= 0 || Math.abs(origin - uptimeOrigin) > START_BOUND_ORIGIN_TOLERANCE_MS) return null;
  const wait = Math.ceil(START_BOUND_SLACK_MS - performance.now());
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  ownStartBoundCache = `${START_BOUND_PREFIX}${BigInt(Math.ceil(origin + START_BOUND_SLACK_MS)) * 10000n + 621355968000000000n}`;
  return ownStartBoundCache;
}

/** The identity this process records in lock owners: the win32 bound, else the exact probe. */
function ownLockStartIdentity(timeoutMs = 3000, testHooks) {
  if (process.platform === 'win32' && typeof testHooks?.processStartIdentity !== 'function') {
    const bound = ownStartBoundIdentity();
    if (bound !== null) return bound;
  }
  return ownProcessStartIdentity(timeoutMs, testHooks);
}

function lockOwnerVersion(processStart) {
  return processStart.startsWith(START_BOUND_PREFIX) ? 2 : 1;
}

/** Version 1 owners carry an exact identity; version 2 owners carry the win32 creation bound. */
function validOwnerIdentity(version, processStart) {
  if (typeof processStart !== 'string') return false;
  if (version === 2) return /^ticksmax:\d+$/.test(processStart);
  return version === 1 && /^\S+$/.test(processStart) && !processStart.startsWith(START_BOUND_PREFIX);
}

/** Whether exact probe result `current` proves the recorded identity live; null when incomparable. */
export function startIdentityMatches(recorded, current) {
  if (!recorded.startsWith(START_BOUND_PREFIX)) return current === recorded;
  const ticks = current.match(/^ticks:(\d+)$/)?.[1];
  const bound = recorded.slice(START_BOUND_PREFIX.length);
  if (!ticks || !/^\d+$/.test(bound)) return null;
  return BigInt(ticks) <= BigInt(bound);
}

function writeAllSync(fd, content, label) {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error(`${label} made no progress`);
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) throw new Error(`${label} size verification failed`);
}

export function processStartIdentity(pid, timeoutMs = 3000) {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
      return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
    } catch (error) {
      return error?.code === 'ENOENT' ? 'absent' : null;
    }
  }
  if (process.platform === 'darwin') {
    if (timeoutMs <= 0) return null;
    try {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', timeout: Math.max(1, Math.min(2000, Math.floor(timeoutMs))), env: { ...process.env, LC_ALL: 'C' },
      });
      if (result.status === 0 && result.stdout) {
        const time = new Date(result.stdout.trim()).getTime();
        if (!Number.isNaN(time)) return String(time);
      }
    } catch {}
  }
  if (process.platform === 'win32') {
    if (timeoutMs <= 0) return null;
    try {
      const result = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`,
      ], { encoding: 'utf8', timeout: Math.max(1, Math.min(3000, Math.floor(timeoutMs))), windowsHide: true });
      const ticks = result.status === 0 ? result.stdout.trim().match(/^\d+$/)?.[0] : null;
      if (ticks) return `ticks:${ticks}`;
    } catch {}
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : null;
  }
}

function mutationDbPath(lockPath) {
  let current = dirname(lockPath);
  while (basename(current) !== 'state') {
    const parent = dirname(current);
    if (parent === current) return join(dirname(lockPath), '.state-mutation-locks.db');
    current = parent;
  }
  return join(current, '.state-mutation-locks.db');
}

function canonicalKey(lockPath) {
  try { return resolve(realpathSync(dirname(lockPath)), basename(lockPath)); }
  catch { return resolve(lockPath); }
}

function stateFileLockingTestOverride() {
  if (process.env.NODE_ENV !== 'test') return null;
  return process.env.OMC_TEST_FLOCK_AVAILABLE === '0' || process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE === '1'
    ? false
    : null;
}

function readOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const pid = value.pid;
    if (value.version === undefined && Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(value.timestamp)) {
      return { version: 0, pid, timestamp: value.timestamp };
    }
    if (
      !validOwnerIdentity(value.version, value.processStart) || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)
    ) return null;
    return value;
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : null;
  }
}

function ownerLive(owner, timeoutMs = 3000, testHooks) {
  if (owner.version === 0) {
    const identity = startProcessIdentity(owner.pid, timeoutMs, testHooks);
    if (identity === 'absent') return false;
    if (identity === null) return null;
    const startedAt = processStartTimestamp(owner.pid, identity);
    if (startedAt === null) return null;
    const uncertainty = LEGACY_PROCESS_START_UNCERTAINTY_MS[process.platform];
    if (uncertainty === undefined) return null;
    // The process-start probes have bounded precision; only a later start
    // beyond that uncertainty proves PID reuse.
    return startedAt - owner.timestamp <= uncertainty;
  }
  // Fork fix: an owner this module abandoned is orphaned-by-self (see abandonedOwnNonces).
  if (owner.pid === process.pid && abandonedOwnNonces.has(owner.nonce) && owner.processStart === ownLockStartIdentity(timeoutMs, testHooks)) return false;
  // Fork fix: this process's identity is already cached; re-probing it costs a PowerShell
  // spawn per retry on win32, turning a 50-attempt contended acquire into a ~30s stall.
  const simulatedUnknown = process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(owner.pid);
  if (owner.pid === process.pid && !simulatedUnknown && owner.processStart === ownLockStartIdentity(timeoutMs, testHooks)) return true;
  // Any other record for this pid (another thread's bound, a dead predecessor) needs the exact probe.
  const current = owner.pid === process.pid && !simulatedUnknown ? ownProcessStartIdentity(timeoutMs, testHooks) : startProcessIdentity(owner.pid, timeoutMs, testHooks);
  return current === null ? null : current === 'absent' ? false : startIdentityMatches(owner.processStart, current);
}

function processStartTimestamp(pid, expectedIdentity) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks || startTicks !== expectedIdentity) return null;
      const bootTimeSeconds = Number(readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m)?.[1]);
      if (!Number.isFinite(bootTimeSeconds)) return null;
      if (linuxClockTicksPerSecond === undefined) {
        const result = spawnSync('getconf', ['CLK_TCK'], {
          encoding: 'utf8', timeout: 250, windowsHide: true,
          env: { ...process.env, LC_ALL: 'C' },
        });
        const ticks = result.status === 0 ? Number(result.stdout.trim()) : NaN;
        // Linux procfs reports USER_HZ, which is 100 on supported Linux ABIs.
        // Keep legacy-lock migration functional on minimal hosts without getconf.
        linuxClockTicksPerSecond = Number.isSafeInteger(ticks) && ticks > 0 ? ticks : 100;
      }
      // /proc/stat's btime avoids reconstructing an epoch from mutable wall
      // time. Its one-second precision is reflected in the tolerance above.
      return bootTimeSeconds * 1000 + Number(startTicks) * 1000 / linuxClockTicksPerSecond;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const startedAt = Number(expectedIdentity);
    return Number.isFinite(startedAt) ? startedAt : null;
  }
  if (process.platform === 'win32') {
    const ticks = expectedIdentity.match(/^ticks:(\d+)$/)?.[1];
    if (!ticks) return null;
    try {
      return Number(BigInt(ticks) - 621355968000000000n) / 10000;
    } catch {
      return null;
    }
  }
  return null;
}

function sameOwner(left, right) {
  if (left?.version === 0 || right?.version === 0) {
    return left?.version === 0 && right?.version === 0 && left.pid === right.pid && left.timestamp === right.timestamp;
  }
  return Boolean(left && right && left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce);
}

// BigInt ids: NTFS file IDs exceed 2^53 once the MFT sequence number reaches
// 32, and a Number ino rounds distinct files onto the same value.
function ownerArtifactIdentity(path) {
  try {
    const stats = statSync(path, { bigint: true });
    return stats.isFile() ? { dev: stats.dev, ino: stats.ino } : null;
  } catch {
    return null;
  }
}

/** Mirrors sameFileIdentity in src/lib/atomic-write.ts: ino always, dev unless win32 reports 0 (#4156). */
function sameArtifactIdentity(a, b) {
  if (a.ino !== b.ino) return false;
  if (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)) return true;
  return a.dev === b.dev;
}

/** Remove only the exact dead publication that was inspected. */
function reclaimDeadOwner(path, observed, identity) {
  const quarantinePath = `${path}.reclaim.${process.pid}.${randomUUID()}`;
  // The liveness verdict can be seconds old (the win32 probe spawns PowerShell),
  // and the identity alone cannot tell a replacement apart when its inode reuses
  // the old one (or when the identity was captured after the probe). Renaming a
  // live replacement into quarantine opens a window in which a third contender
  // publishes, leaving two holders. Re-verify the exact artifact, owner record
  // AND file identity, immediately before the rename. Bracketing the read with
  // two stats binds the record that was read to the identity that was checked.
  const before = ownerArtifactIdentity(path);
  const current = readOwner(path);
  const after = ownerArtifactIdentity(path);
  if (current === 'absent' || !current || !sameOwner(current, observed) ||
      !before || !after || !sameArtifactIdentity(before, identity) || !sameArtifactIdentity(after, identity)) {
    return 'changed';
  }
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    return error?.code === 'ENOENT' ? 'changed' : 'failed';
  }

  let moved = null;
  let movedIdentity = null;
  try {
    moved = readOwner(quarantinePath);
    movedIdentity = ownerArtifactIdentity(quarantinePath);
    if (moved !== 'absent' && moved && movedIdentity &&
        sameArtifactIdentity(movedIdentity, identity) &&
        sameOwner(moved, observed)) {
      try {
        unlinkSync(quarantinePath);
        return 'removed';
      } catch {}
    }
  } catch {}

  // A replacement owner must survive. Restore the moved artifact only when no
  // newer publication has already claimed the final pathname.
  try {
    linkSync(quarantinePath, path);
    try { unlinkSync(quarantinePath); } catch {}
  } catch {}
  return 'changed';
}

function publishOwner(path, owner) {
  const tempPath = `${path}.${owner.pid}.${owner.nonce}.tmp`;
  let fd;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(tempPath, 'wx', 0o600);
    writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(tempPath, path);
    try {
      unlinkSync(tempPath);
    } catch (error) {
      const code = error?.code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw error;
    }
    return true;
  } catch {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    try { unlinkSync(tempPath); } catch {}
    return false;
  }
}

function openMutationDb(lockPath, bypassTestOverride = false, busyTimeoutMs = 2000) {
  // The flock simulation describes a host without the external flock binary,
  // not a host without SQLite. A caller that explicitly opts out of the
  // simulation (the emergency recovery claim) must still get the SQLite
  // backend, otherwise it retries into an 'unverifiable' failure and recovery
  // reports false with a perfectly healthy binding.
  if ((!bypassTestOverride && stateFileLockingTestOverride() === false) || !Database) return null;
  let db = null;
  try {
    const dbPath = mutationDbPath(lockPath);
    for (const sidecar of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      try {
        const stats = statSync(sidecar);
        if (!stats.isFile() || stats.nlink !== 1) return null;
      } catch (error) {
        if (error?.code !== 'ENOENT') return null;
      }
    }
    db = new Database(dbPath);
    const timeout = Number.isFinite(busyTimeoutMs) ? Math.max(0, Math.floor(busyTimeoutMs)) : 2000;
    db.pragma(`busy_timeout = ${timeout}`);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
    return db;
  } catch (error) {
    if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
      try { db?.close(); } catch {}
      recordFailure('contention');
      return null;
    }
    const detail = isNativeBindingError(error)
      ? errorMessage(error)
      : `SQLite backend initialization failed: ${errorMessage(error)}`;
    sqliteBindingLoadError = nativeBindingDiagnostic(detail);
    try { db?.close(); } catch {}
    return null;
  }
}

function recordFailure(kind, detail, reason) {
  lastLockFailure = kind;
  lastLockFailureDetail = detail || null;
  lastLockFailureReason = reason || null;
}

export function getStateFileLockDiagnostic() {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE === '1') {
    sqliteBindingLoadError = nativeBindingDiagnostic('simulated native binding load failure');
  }
  return sqliteBindingLoadError;
}

export function getStateFileLockFailureMessage() {
  getStateFileLockDiagnostic();
  if (lastLockFailureDetail) return lastLockFailureDetail;
  if (lastLockFailure === 'contention') {
    return sqliteBindingLoadError
      ? `State mutation lock contention prevented the file-lock fallback. ${sqliteBindingLoadError}`
      : 'State mutation lock contention prevented acquisition.';
  }
  if (lastLockFailure === 'unverifiable') {
    return sqliteBindingLoadError
      ? `${sqliteBindingLoadError} The file-lock fallback metadata could not be verified.`
      : 'State mutation lock metadata could not be verified.';
  }
  return sqliteBindingLoadError || 'state mutation lock unavailable';
}

export function getStateFileLockFailureKind() {
  return lastLockFailure;
}

export function getStateFileLockFailureReason() {
  return lastLockFailureReason;
}

export function isStateFileLockingSupported() {
  // The owner-file fallback is a real exclusive backend, so callers must not
  // downgrade to an unlocked read when SQLite is unavailable.
  return true;
}

/**
 * Whether exclusive acquisition can be relied on right now. This is a
 * different question from "is any locking backend present": the flock
 * simulation used by the pre-SQLite fallback tests describes a host where an
 * exclusive-required caller has no backend to fail closed against, while
 * emergency recovery still has SQLite. Callers that authenticate state before
 * acting on it (cancel-signal validation) must ask this one.
 */
export function isExclusiveStateLockingAvailable() {
  const override = stateFileLockingTestOverride();
  return override !== null ? override : true;
}

function remainingOperationTimeoutMs(deadline) {
  return deadline === null ? Infinity : Math.max(0, Number(deadline - process.hrtime.bigint()) / 1_000_000);
}

function boundedBusyTimeoutMs(timeoutMs, operationDeadline) {
  const configuredTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 2000;
  return Math.min(configuredTimeoutMs, Math.floor(remainingOperationTimeoutMs(operationDeadline)));
}

function remainingProcessProbeMs(deadline, operationDeadline = null, testHooks) {
  return Math.max(0, Math.min(deadline - wallClockNowMs(testHooks), remainingOperationTimeoutMs(operationDeadline)));
}

function processProbeDeadlineAfter(timeoutMs, testHooks) {
  const durationMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 3000;
  return wallClockNowMs(testHooks) + durationMs;
}

function operationDeadlineAfter(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) return null;
  return process.hrtime.bigint() + BigInt(Math.floor(Math.max(0, timeoutMs) * 1_000_000));
}

function acquireFileLock(lockPath, attempts, processProbeDeadline, operationDeadline, testHooks) {
  // This publication is also checked by SQLite contenders, so mixed backend
  // processes still serialize on one exact owner artifact.
  lastLockFailureDetail = null;
  const key = canonicalKey(lockPath);
  const processStart = ownLockStartIdentity(remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks), testHooks);
  if (!processStart || processStart === 'absent') {
    recordFailure('unverifiable');
    return null;
  }

  let verifiedLiveOwner = null;
  let inconclusiveRetries = 0;
  let reclaimRetried = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (remainingOperationTimeoutMs(operationDeadline) <= 0) {
      recordFailure('contention');
      return null;
    }
    const owner = {
      version: lockOwnerVersion(processStart),
      pid: process.pid,
      processStart,
      createdAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const tempPath = `${lockPath}.${owner.pid}.${owner.nonce}.tmp`;
    let fd;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(tempPath, lockPath);
      try { unlinkSync(tempPath); } catch (error) {
        if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      }
      const lock = { backend: 'file', key, path: lockPath, owner, depth: 1, operationDeadline };
      localLocks.set(key, lock);
      recordFailure(null);
      return lock;
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); } catch {}
      try { unlinkSync(tempPath); } catch {}
      if (error?.code !== 'EEXIST') {
        // Fork fix: the owner may already be published (e.g. temp cleanup failed after link).
        abandonedOwnNonces.add(owner.nonce);
        recordFailure('unverifiable');
        return null;
      }

      // Capture the artifact identity together with the owner record, before the slow liveness
      // probe; read afterwards it can belong to a newer, live owner (fork fix + upstream #4149).
      const identity = ownerArtifactIdentity(lockPath);
      if (!identity) {
        // Fork fix: a concurrent contender may reclaim the dead owner and release its own lock
        // in between. A vanished artifact is contention, not unverifiable metadata, so retry.
        if (readOwner(lockPath) === 'absent') continue;
        recordFailure('unverifiable');
        return null;
      }
      const existing = readOwner(lockPath);
      if (existing === 'absent') continue;
      if (!existing) {
        recordFailure('unverifiable', null, 'malformed-owner');
        console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
        return null;
      }
      // Re-verify the identity hasn't changed while the owner record was read.
      const recheck = ownerArtifactIdentity(lockPath);
      if (!recheck || !sameArtifactIdentity(recheck, identity)) continue;
      // Fork fix: on win32 each liveness probe is a PowerShell spawn, so re-probing the same
      // live owner on every retry turns a contended fallback into a hook timeout. An owner
      // already verified live in this loop is treated as still live (fail closed).
      const live = sameOwner(existing, verifiedLiveOwner) ? true : ownerLive(existing, remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks), testHooks);
      if (live === null) {
        // Fork fix: a deadline spent during the probe is contention, as after a conclusive probe.
        const remainingMs = remainingOperationTimeoutMs(operationDeadline);
        if (remainingMs <= 0) {
          recordFailure('contention');
          return null;
        }
        recordFailure('unverifiable');
        // Fork fix (#4727): retry an inconclusive probe while attempts and probe budget remain.
        if (attempt + 1 < attempts && inconclusiveRetries < INCONCLUSIVE_PROBE_RETRY_LIMIT &&
            remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks) > 0) {
          inconclusiveRetries += 1;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, Math.floor(remainingMs)));
          continue;
        }
        return null;
      }
      if (live) {
        verifiedLiveOwner = existing;
        recordFailure('contention');
        if (attempt + 1 < attempts) {
          const remainingMs = remainingOperationTimeoutMs(operationDeadline);
          if (remainingMs <= 0) return null;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, Math.floor(remainingMs)));
          continue;
        }
        return null;
      }
      const reclaimed = reclaimDeadOwner(lockPath, existing, identity);
      if (reclaimed === 'failed') {
        recordFailure('unverifiable');
        return null;
      }
      // Fork fix: a reclaim frees the path, so the link is retried without spending an attempt;
      // otherwise attempts=1 could never take over a dead owner. Once per acquire, so a stream of
      // dead owners cannot keep the loop alive.
      if (reclaimed === 'removed' && !reclaimRetried) {
        reclaimRetried = true;
        attempt -= 1;
      }
    }
  }
  recordFailure('contention');
  return null;
}

/** Optional deterministic probe hooks are honored only for NODE_ENV=test. */
export function acquireStateFileLockSync(filePath, attempts = 50, requireExclusive = false, bypassTestOverride = false, busyTimeoutMs = 2000, processProbeTimeoutMs = 3000, overallTimeoutMs = Infinity, testHooks) {
  return acquireStateFileLockAtPathSync(`${filePath}.mutation.lock`, attempts, requireExclusive, bypassTestOverride, busyTimeoutMs, processProbeTimeoutMs, overallTimeoutMs, testHooks);
}

export function acquireStateFileLockAtPathSync(lockPath, attempts = 50, requireExclusive = false, bypassTestOverride = false, busyTimeoutMs = 2000, processProbeTimeoutMs = 3000, overallTimeoutMs = Infinity, testHooks) {
  const activeTestHooks = process.env.NODE_ENV === 'test' ? testHooks : undefined;
  return acquireStateFileLockAtPathWithDeadline(
    lockPath,
    attempts,
    requireExclusive,
    bypassTestOverride,
    busyTimeoutMs,
    processProbeDeadlineAfter(processProbeTimeoutMs, activeTestHooks),
    operationDeadlineAfter(overallTimeoutMs),
    activeTestHooks,
  );
}

// Fork fix: `verified` (internal, threaded through the retries) remembers the row owner and the
// artifact owner already proven live in this acquire, plus owners proven dead (a dead pid+start
// never revives; an abandoned nonce stays abandoned). Each liveness probe is a PowerShell spawn
// on win32, so re-probing on all 50 attempts stalled for ~10 s. A cached live owner is treated as
// still live (fail closed). `probe` false returns undefined for an owner with no cached verdict.
// `inconclusiveRetries` counts the retries spent on null verdicts (INCONCLUSIVE_PROBE_RETRY_LIMIT).
function cachedOwnerLive(owner, verified, slot, probe, timeoutMs = 3000, testHooks) {
  if (sameOwner(owner, verified[slot])) return true;
  if (verified.dead.some(dead => sameOwner(owner, dead))) return false;
  if (!probe) return undefined;
  const live = ownerLive(owner, timeoutMs, testHooks);
  if (live) verified[slot] = owner;
  else if (live === false) verified.dead.push(owner);
  return live;
}

function acquireStateFileLockAtPathWithDeadline(lockPath, attempts, requireExclusive, bypassTestOverride, busyTimeoutMs, processProbeDeadline, operationDeadline, testHooks, verified = { row: null, artifact: null, dead: [], inconclusiveRetries: 0 }) {
  lastLockFailureDetail = null;
  lastLockFailure = null;
  lastLockFailureReason = null;
  void requireExclusive;
  if (remainingOperationTimeoutMs(operationDeadline) <= 0) {
    recordFailure('contention');
    return null;
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  const key = canonicalKey(lockPath);
  const held = localLocks.get(key);
  if (held) {
    held.depth += 1;
    return held;
  }
  const retryAcquisition = () => {
    const remainingMs = remainingOperationTimeoutMs(operationDeadline);
    if (remainingMs <= 0) {
      recordFailure('contention');
      return null;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, Math.floor(remainingMs)));
    return acquireStateFileLockAtPathWithDeadline(
      lockPath,
      attempts - 1,
      requireExclusive,
      bypassTestOverride,
      busyTimeoutMs,
      processProbeDeadline,
      operationDeadline,
      testHooks,
      verified,
    );
  };

  if (!bypassTestOverride && stateFileLockingTestOverride() === false) {
    if (process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE === '1') {
      sqliteBindingLoadError = nativeBindingDiagnostic('simulated native binding load failure');
    }
    return acquireFileLock(lockPath, attempts, processProbeDeadline, operationDeadline, testHooks);
  }

  const openBusyTimeoutMs = boundedBusyTimeoutMs(busyTimeoutMs, operationDeadline);
  const openStartedAt = wallClockNowMs(testHooks);
  const db = openMutationDb(lockPath, bypassTestOverride, openBusyTimeoutMs);
  if (!db) {
    // SQLite can answer SQLITE_BUSY at once, without running the busy handler,
    // while two processes open and set up the lock database together (a
    // duplicate Stop racing the same transition). Only a BUSY that outlasted
    // the busy timeout is real contention; an early one is retried.
    if (lastLockFailure === 'contention') return attempts > 1 && wallClockNowMs(testHooks) - openStartedAt < openBusyTimeoutMs ? retryAcquisition() : null;
    if (sqliteBindingLoadError) return acquireFileLock(lockPath, attempts, processProbeDeadline, operationDeadline, testHooks);
    if (attempts <= 1) {
      recordFailure('unverifiable');
      return null;
    }
    return retryAcquisition();
  }

  const processStart = ownLockStartIdentity(remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks), testHooks);
  if (!processStart || processStart === 'absent') {
    try { db.close(); } catch {}
    if (attempts <= 1) {
      recordFailure('unverifiable');
      return null;
    }
    return retryAcquisition();
  }

  const owner = {
    version: lockOwnerVersion(processStart),
    pid: process.pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const retry = code => code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'OMC_LOCK_PUBLICATION_RACE' || code === 'OMC_LOCK_RECLAIM_RACE';
  const selectRow = () => db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(key);
  const validRow = row => validOwnerIdentity(row.version, row.process_start) && Number.isSafeInteger(row.pid) && typeof row.created_at === 'string' && typeof row.nonce === 'string';
  // Fork fix: adjudicate liveness before BEGIN IMMEDIATE, so the slow win32 probe does not hold
  // the write lock (which also blocks the holder's own release). Inside the transaction only the
  // cached verdict for an unchanged owner is acted on; a changed owner is re-probed on a retry.
  let preLive = false;
  try {
    const preRow = selectRow();
    if (preRow && validRow(preRow)) preLive = cachedOwnerLive({ pid: preRow.pid, processStart: preRow.process_start, nonce: preRow.nonce }, verified, 'row', true, remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks), testHooks);
    if (preLive === false) {
      const preArtifact = readOwner(lockPath);
      if (preArtifact && preArtifact !== 'absent') preLive = cachedOwnerLive(preArtifact, verified, 'artifact', true, remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks), testHooks);
    }
  } catch {
    preLive = false;
  }
  if (preLive === null || preLive) {
    try { db.close(); } catch {}
    // Fork fix: a deadline spent during the probe is contention whatever the verdict was.
    if (remainingOperationTimeoutMs(operationDeadline) <= 0) {
      recordFailure('contention');
      return null;
    }
    // Fork fix (#4727): an inconclusive verdict is never cached, so a retry re-probes the owner;
    // one slow win32 probe must not sink the acquire while attempts and probe budget remain.
    if (attempts <= 1 || (preLive === null && (verified.inconclusiveRetries >= INCONCLUSIVE_PROBE_RETRY_LIMIT ||
        remainingProcessProbeMs(processProbeDeadline, operationDeadline, testHooks) <= 0))) {
      recordFailure(preLive === null ? 'unverifiable' : 'contention');
      return null;
    }
    if (preLive === null) verified.inconclusiveRetries += 1;
    return retryAcquisition();
  }
  // Fork fix (#4727): the probe above can spend the overall budget. Never re-enter the write
  // transaction after the deadline, and bound its busy wait by what remains of the budget.
  if (remainingOperationTimeoutMs(operationDeadline) <= 0) {
    try { db.close(); } catch {}
    recordFailure('contention');
    return null;
  }
  try {
    db.pragma(`busy_timeout = ${boundedBusyTimeoutMs(busyTimeoutMs, operationDeadline)}`);
    db.exec('BEGIN IMMEDIATE');
    const row = selectRow();
    if (row) {
      if (!validRow(row)) {
        db.exec('ROLLBACK');
        db.close();
        recordFailure('unverifiable', null, 'malformed-owner');
        return null;
      }
      const live = cachedOwnerLive({ pid: row.pid, processStart: row.process_start, nonce: row.nonce }, verified, 'row', false);
      if (live !== false) {
        db.exec('ROLLBACK');
        db.close();
        if (attempts <= 1) {
          recordFailure('contention');
          return null;
        }
        return retryAcquisition();
      }
      db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(key);
    }

    const artifact = readOwner(lockPath);
    if (artifact !== 'absent') {
      if (!artifact) {
        db.exec('ROLLBACK');
        db.close();
        recordFailure('unverifiable', null, 'malformed-owner');
        console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
        return null;
      }
      // Fork fix: capture the identity together with the owner record it is reclaimed under.
      const identity = ownerArtifactIdentity(lockPath);
      if (!identity) {
        db.exec('ROLLBACK');
        db.close();
        if (readOwner(lockPath) === 'absent' && attempts > 1) {
          return retryAcquisition();
        }
        recordFailure('unverifiable');
        return null;
      }
      const live = cachedOwnerLive(artifact, verified, 'artifact', false);
      if (live !== false) {
        db.exec('ROLLBACK');
        db.close();
        if (attempts <= 1) {
          recordFailure('contention');
          return null;
        }
        return retryAcquisition();
      }
      const reclaimed = reclaimDeadOwner(lockPath, artifact, identity);
      if (reclaimed !== 'removed') {
        db.exec('ROLLBACK');
        db.close();
        if (reclaimed === 'changed' && attempts > 1) {
          return retryAcquisition();
        }
        recordFailure(reclaimed === 'changed' ? 'contention' : 'unverifiable');
        return null;
      }
    }

    db.prepare('INSERT INTO state_mutation_locks (lock_key, version, pid, process_start, created_at, nonce) VALUES (?, ?, ?, ?, ?, ?)').run(key, owner.version, owner.pid, owner.processStart, owner.createdAt, owner.nonce);
    if (!publishOwner(lockPath, owner)) {
      abandonedOwnNonces.add(owner.nonce); // Fork fix: publication may have linked before failing.
      db.exec('ROLLBACK');
      db.close();
      if (attempts <= 1) {
        recordFailure('contention');
        return null;
      }
      return retryAcquisition();
    }
    db.exec('COMMIT');
    const lock = {
      backend: 'sqlite', db, key, path: lockPath, owner, depth: 1,
      busyTimeoutMs: Number.isFinite(busyTimeoutMs) ? Math.max(0, Math.floor(busyTimeoutMs)) : 2000,
      operationDeadline,
    };
    localLocks.set(key, lock);
    recordFailure(null);
    return lock;
  } catch (error) {
    abandonedOwnNonces.add(owner.nonce); // Fork fix: e.g. COMMIT failed after the owner was published.
    try { db.exec('ROLLBACK'); } catch {}
    try { db.close(); } catch {}
    if (isNativeBindingError(error)) sqliteBindingLoadError = nativeBindingDiagnostic(errorMessage(error));
    if (retry(error?.code) && attempts > 1) {
      return retryAcquisition();
    }
    recordFailure(error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' ? 'contention' : 'unverifiable');
    return null;
  }
}

// Fork fix: a contender adjudicates the holder's liveness inside its BEGIN IMMEDIATE, and on
// win32 that probe is a PowerShell spawn (~1-2s), so a release can exceed busy_timeout. Giving up
// on SQLITE_BUSY rolled the release back and left the row owned by this still-live process, which
// then deadlocked every later acquisition (including its own). Retry transient contention instead,
// bounded by wall clock: 30 attempts x busy_timeout 2000 ms blocked a hook for up to ~60 s.
// The budget also stops at the caller's operation deadline (upstream #4322).
const RELEASE_BUSY_BUDGET_MS = 5000;
export function releaseStateFileLockSync(lock, operationDeadline = undefined) {
  if (!lock) return true;
  if (operationDeadline === undefined) operationDeadline = lock.operationDeadline ?? null;
  if (lock.depth > 1) {
    lock.depth -= 1;
    return true;
  }
  if (lock.backend === 'file') {
    localLocks.delete(lock.key);
    try {
      const current = readOwner(lock.path);
      if (current === 'absent') return true;
      if (!current || !sameOwner(current, lock.owner)) {
        recordFailure('unverifiable', `State mutation lock release failed; owner metadata changed or disappeared: ${lock.path}`);
        console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path}`);
        return false;
      }
      unlinkSync(lock.path);
      return true;
    } catch (error) {
      abandonedOwnNonces.add(lock.owner.nonce); // Fork fix: a failed unlink must not self-deadlock.
      recordFailure('unverifiable', `State mutation lock release failed for ${lock.path}: ${error?.code || 'unknown error'}`);
      console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path} ${error?.code || ''}`.trim());
      return false;
    }
  }

  const deadline = Date.now() + Math.min(RELEASE_BUSY_BUDGET_MS, remainingOperationTimeoutMs(operationDeadline));
  let retainLockForRetry = false;
  try {
    for (;;) {
      try {
        lock.db.pragma(`busy_timeout = ${Math.max(0, Math.min(lock.busyTimeoutMs ?? 2000, Math.floor(deadline - Date.now())))}`);
        lock.db.exec('BEGIN IMMEDIATE');
        const row = lock.db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(lock.key);
        const current = readOwner(lock.path);
        // Fork fix: an already-absent artifact must not strand a row this process still owns, and
        // the row is deleted in the same transaction as the unlink so a failed unlink rolls back.
        const artifactOk = current === 'absent' || sameOwner(current, lock.owner);
        if (!row || row.version !== lock.owner.version || !sameOwner({ pid: row.pid, processStart: row.process_start, nonce: row.nonce }, lock.owner) || !artifactOk) {
          abandonedOwnNonces.add(lock.owner.nonce); // Fork fix: a row still ours must stay reclaimable.
          lock.db.exec('ROLLBACK');
          localLocks.delete(lock.key);
          recordFailure('unverifiable', `State mutation lock release failed; owner metadata changed or disappeared: ${lock.path}`);
          console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path}`);
          return false;
        }
        if (current !== 'absent') unlinkSync(lock.path);
        lock.db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(lock.key);
        lock.db.exec('COMMIT');
        localLocks.delete(lock.key);
        return true;
      } catch (error) {
        try { lock.db.exec('ROLLBACK'); } catch {}
        const busy = error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
        if (busy && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(10, Math.floor(deadline - Date.now()))));
          continue;
        }
        if (busy) {
          // Keep local ownership so a later same-process acquisition can retry the
          // release instead of leaving a live row that blocks the state path.
          lock.depth = 0;
          localLocks.set(lock.key, lock);
          retainLockForRetry = true;
          recordFailure('contention', `State mutation lock release deferred by contention: ${lock.path}`);
          console.error(`[omc-lock] state_mutation_lock_release_deferred: ${lock.path}`);
          return false;
        }
        abandonedOwnNonces.add(lock.owner.nonce); // Fork fix: a failed release must not self-deadlock.
        localLocks.delete(lock.key);
        recordFailure('unverifiable', `State mutation lock release failed for ${lock.path}: ${error?.code || 'unknown error'}`);
        console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path} ${error?.code || ''}`.trim());
        return false;
      }
    }
  } finally {
    if (!retainLockForRetry) {
      try { lock.db.close(); } catch {}
    }
  }
}

export function withStateFileLockSync(filePath, callback, requireExclusive = false, attempts = 50, busyTimeoutMs = 2000, processProbeTimeoutMs = 3000, overallTimeoutMs = Infinity) {
  return withStateFileLockAtPathSync(`${filePath}.mutation.lock`, callback, requireExclusive, attempts, busyTimeoutMs, processProbeTimeoutMs, overallTimeoutMs);
}

export function withStateFileLockAtPathSync(lockPath, callback, requireExclusive = false, attempts = 50, busyTimeoutMs = 2000, processProbeTimeoutMs = 3000, overallTimeoutMs = Infinity) {
  const lock = acquireStateFileLockAtPathSync(lockPath, attempts, requireExclusive, false, busyTimeoutMs, processProbeTimeoutMs, overallTimeoutMs);
  if (!lock) return { acquired: false, value: undefined };
  let value;
  let releaseFailed = false;
  try {
    value = callback();
  } finally {
    releaseFailed = !releaseStateFileLockSync(lock);
  }
  return releaseFailed
    ? { acquired: false, value: undefined, callbackRan: true }
    : { acquired: true, value };
}

export function acquireRecoveryClaim(path, attempts = 50) {
  const lock = acquireStateFileLockSync(path, attempts, true, true);
  if (!lock) return null;
  const existing = readOwner(path);
  if (existing !== 'absent') {
    const identity = ownerArtifactIdentity(path); // Fork fix: capture before the liveness probe.
    if (!existing || ownerLive(existing) !== false) {
      releaseStateFileLockSync(lock);
      return null;
    }
    const reclaimed = identity ? reclaimDeadOwner(path, existing, identity) : 'failed';
    if (reclaimed !== 'removed') {
      releaseStateFileLockSync(lock);
      return null;
    }
  }
  const processStart = ownProcessStartIdentity();
  if (!processStart || processStart === 'absent') {
    releaseStateFileLockSync(lock);
    if (attempts <= 1) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return acquireRecoveryClaim(path, attempts - 1);
  }
  const owner = {
    version: 1,
    pid: process.pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  if (!publishOwner(path, owner)) {
    releaseStateFileLockSync(lock);
    return null;
  }
  recoveryLocks.set(path, { lock, owner });
  return owner;
}

export function readRecoveryClaim(path) {
  const owner = readOwner(path);
  return owner === 'absent' ? null : owner;
}

export function releaseRecoveryClaim(path, owner) {
  const held = recoveryLocks.get(path);
  const lock = held?.lock || localLocks.get(canonicalKey(`${path}.mutation.lock`));
  if (!lock) return false;
  let released = true;
  try {
    const current = readRecoveryClaim(path);
    if (sameOwner(current, owner)) {
      try { unlinkSync(path); }
      catch (error) {
        recordFailure('unverifiable', `Recovery claim release failed for ${path}: ${error?.code || 'unknown error'}`);
        console.error(`[omc-lock] recovery_claim_release_failed: ${path} ${error?.code || ''}`.trim());
        released = false;
      }
    }
  } finally {
    recoveryLocks.delete(path);
    if (!releaseStateFileLockSync(lock)) released = false;
  }
  return released;
}

export function sameRecoveryClaim(left, right) {
  return sameOwner(left, right);
}

export function isEmergencyOwnerLive(owner) {
  return ownerLive(owner) !== false;
}
