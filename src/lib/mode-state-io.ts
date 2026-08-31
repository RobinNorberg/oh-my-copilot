/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */

import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  getOmcRoot,
  probeGitTopLevel,
  resolveStatePath,
  resolveSessionStatePath,
  ensureSessionStateDir,
  ensureOmcDir,
  listSessionIds,
} from './worktree-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

type MutationLockOwner = { version: 1; pid: number; processStart: string; createdAt: string; nonce: string };
type MutationLock = { fd: number; path: string; owner: MutationLockOwner } | { unlocked: true };
const LOCK_OWNER_KEYS = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
/**
 * Reclaim a lock whose owner still looks live only once it is this old. Deliberately generous: the
 * critical sections here are synchronous and measured in milliseconds, so this ceiling exists only to
 * break a deadlock against a recycled pid, never as routine expiry. It is compared against a
 * wall-clock stamp, and a laptop suspend or an NTP step can age a healthy holder by hours — at a
 * shorter ceiling that would admit a second writer, so the window is sized to make that implausible.
 * Death of the owning pid, not elapsed time, is the signal that actually frees a lock.
 */
const PORTABLE_LOCK_MAX_AGE_MS = 1_800_000;
const PORTABLE_GUARD_MAX_AGE_MS = 5_000;
const PORTABLE_GUARD_ATTEMPTS = 200;
/** Transient read failures (EACCES, EBUSY, a scanner holding the file) get this many retries before we fail closed. */
const PORTABLE_UNVERIFIABLE_RETRIES = 5;

/** 'none' suppresses locking entirely, 'portable' forces the lockfile fallback; null means probe the platform. */
function testLockMode(): 'none' | 'portable' | null {
  if (process.env.NODE_ENV !== 'test') return null;
  if (process.env.OMC_TEST_STATE_LOCK_MODE === 'portable') return 'portable';
  if (process.env.OMC_TEST_STATE_LOCK_MODE === 'none' || process.env.OMC_TEST_FLOCK_AVAILABLE === '0') return 'none';
  return null;
}
function flockPath(): string | null { return testLockMode() ? null : existsSync('/usr/bin/flock') ? '/usr/bin/flock' : existsSync('/bin/flock') ? '/bin/flock' : null; }
function portableLockingAvailable(): boolean { return testLockMode() !== 'none'; }

/** True when state mutations can be serialized across processes on this platform. */
export function isStateMutationLockingSupported(): boolean { return Boolean(flockPath()) || portableLockingAvailable(); }
const LOCK_REMOVAL_SCRIPT = String.raw`
const fs = require('fs');
const [operation, lockPath, expectedRaw] = process.argv.slice(1);
const keys = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
function readOwner() {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index]) || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
    return value;
  } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); return null; }
}
const owner = readOwner();
if (!owner) process.exit(3);
if (operation === 'release') {
  let expected;
  try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
  if (owner.pid !== expected.pid || owner.processStart !== expected.processStart || owner.nonce !== expected.nonce) process.exit(4);
  try { fs.unlinkSync(lockPath); process.exit(0); } catch { process.exit(3); }
}
if (process.platform !== 'linux') process.exit(3);
let currentStart;
try {
  const stat = fs.readFileSync('/proc/' + owner.pid + '/stat', 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  currentStart = fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
} catch (error) { currentStart = error && error.code === 'ENOENT' ? 'absent' : null; }
if (currentStart === null) process.exit(3);
if (currentStart !== 'absent' && currentStart === owner.processStart) process.exit(2);
try { fs.unlinkSync(lockPath); process.exit(0); } catch { process.exit(3); }
`;

function processStartIdentity(pid: number): string | 'absent' | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'linux') return pid === process.pid ? String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1000))) : null;
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
}

function writeAllSync(fd: number, content: string, label: string): void {
  const bytes = Buffer.from(content, 'utf-8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`${label} made no progress`);
    }
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) {
    throw new Error(`${label} size verification failed`);
  }
}


function readLockOwnerAt(path: string): MutationLockOwner | 'absent' | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null; }
  const actual = Object.keys(value ?? {}).sort();
  if (actual.length !== LOCK_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OWNER_KEYS[index]) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
  return value as unknown as MutationLockOwner;
}

/** true = running, false = gone, null = undecidable. */
function pidIsLive(pid: number): boolean | null {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

/**
 * Best-effort serialization of the reclaim section with an O_EXCL marker. This is deliberately not a
 * mutex: two processes that both observe a stale marker can both delete it and enter, and the loser's
 * delete can remove the winner's fresh marker. That is tolerable because the section re-reads the
 * owner record under the marker and every removal is conditional on what it re-reads, so a double
 * admission costs an extra adjudication pass rather than an unsafe removal. The fd is closed before
 * returning so the later unlink stays portable on Windows.
 */
function acquirePortableGuard(guardPath: string): boolean {
  for (let attempt = 0; attempt < PORTABLE_GUARD_ATTEMPTS; attempt += 1) {
    let fd: number | undefined;
    let published = false;
    try {
      fd = openSync(guardPath, 'wx', 0o600);
      writeAllSync(fd, String(process.pid), 'lock guard publication');
      published = true;
      closeSync(fd);
      return true;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
      // We created the marker but never published it. Drop it now rather than leaving debris that
      // blocks every other contender until the staleness window expires.
      if (fd !== undefined && !published) { try { unlinkSync(guardPath); } catch { /* already gone */ } }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let age: number | null = null;
      try { age = Date.now() - statSync(guardPath).mtimeMs; } catch { /* guard vanished under us */ }
      if (age !== null && age > PORTABLE_GUARD_MAX_AGE_MS) { try { unlinkSync(guardPath); } catch { /* another process won the sweep */ } continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return false;
}

function portableLockIsLive(observed: MutationLockOwner): boolean | null {
  const live = pidIsLive(observed.pid);
  if (live === null) return null;
  if (!live) return false;
  // A clock that stepped backwards yields a negative age; that is not expiry, so compare in the
  // direction that keeps an unreadable or implausible stamp on the holder's side.
  return !(Date.now() - Date.parse(observed.createdAt) > PORTABLE_LOCK_MAX_AGE_MS);
}

/** An owner record we cannot parse can never be adjudicated by identity, so its age is the only escape. */
function unparseableLockIsStale(path: string): boolean {
  try { return Date.now() - statSync(path).mtimeMs > PORTABLE_LOCK_MAX_AGE_MS; }
  catch { return false; }
}

function portableLockRemoval(path: string, operation: 'reclaim' | 'release', owner?: MutationLockOwner): 'retry' | 'live' | 'replaced' | 'unverifiable' {
  // Reading the owner needs no guard; skipping it keeps the common "holder is alive" path off the filesystem.
  if (operation !== 'release') {
    const observed = readLockOwnerAt(path);
    if (observed && observed !== 'absent') {
      const live = portableLockIsLive(observed);
      if (live === null) return 'unverifiable';
      if (live) return 'live';
    }
  }
  const guardPath = `${path}.reclaim.guard`;
  if (!acquirePortableGuard(guardPath)) return 'unverifiable';
  try {
    const current = readLockOwnerAt(path);
    if (current === 'absent') return 'retry';
    if (!current) {
      // Debris we cannot attribute. Release never removes it — an unattributable record is not ours
      // to delete — but reclaim must have some escape or the path stays wedged forever.
      if (operation === 'release' || !unparseableLockIsStale(path)) return 'unverifiable';
    } else if (operation === 'release') {
      if (!owner || current.pid !== owner.pid || current.processStart !== owner.processStart || current.nonce !== owner.nonce) return 'replaced';
    } else {
      const live = portableLockIsLive(current);
      if (live === null) return 'unverifiable';
      if (live) return 'live';
    }
    try { unlinkSync(path); return 'retry'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'retry' : 'unverifiable'; }
  } finally {
    try { unlinkSync(guardPath); } catch { /* best-effort guard cleanup */ }
  }
}

function guardedLockRemoval(path: string, operation: 'reclaim' | 'release', owner?: MutationLockOwner): 'retry' | 'live' | 'replaced' | 'unverifiable' {
  const flock = flockPath();
  if (!flock) return portableLockingAvailable() ? portableLockRemoval(path, operation, owner) : 'unverifiable';
  const result = spawnSync(flock, ['-x', `${path}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, operation, path, owner ? JSON.stringify(owner) : ''], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'retry';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  // The removal script adjudicates liveness only through /proc, so off Linux it reports unverifiable
  // even where an flock binary exists. Fall through instead of wedging on a platform we do support.
  return portableLockingAvailable() ? portableLockRemoval(path, operation, owner) : 'unverifiable';
}

function lockBackoff(attempt: number): void {
  // Jittered so contending processes do not re-collide in lockstep.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1 + Math.floor(Math.random() * Math.min(40, 4 * (attempt + 1))));
}

/**
 * Clear or wait out a lock someone else holds. Returns false only once the holder has stayed
 * unadjudicable across several attempts: a single unreadable read is usually transient (a scanner or
 * backup agent holding the file, EACCES, EBUSY) and must not abandon the acquisition outright.
 */
function awaitLockTurn(path: string, attempt: number, unverifiable: { count: number }): boolean {
  const disposition = guardedLockRemoval(path, 'reclaim');
  if (disposition === 'unverifiable' && (unverifiable.count += 1) > PORTABLE_UNVERIFIABLE_RETRIES) return false;
  if (disposition === 'live' || disposition === 'unverifiable') lockBackoff(attempt);
  return true;
}

function acquireLockAt(path: string, requireExclusive = false): MutationLock | null {
  if (!flockPath() && !portableLockingAvailable()) {
    // Non-exclusive mode state retains its historical best-effort behavior,
    // but safety-critical callers (notably PRD mutations) must fail closed
    // rather than silently running without an inter-process lock.
    if (requireExclusive) return null;
    mkdirSync(dirname(path), { recursive: true });
    return { unlocked: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') {
    console.error(`[omc-lock] state_mutation_lock_owner_unverifiable: ${path}`);
    return null;
  }
  const unverifiable = { count: 0 };
  // Report once on any give-up that saw an unadjudicable holder, whichever budget ran out first —
  // the attempt budget can be smaller than the retry budget, and failing closed silently would leave
  // an operator with no signal at all.
  const abandon = (): null => {
    if (unverifiable.count > 0) console.error(`[omc-lock] state_mutation_lock_unverifiable: ${path}`);
    return null;
  };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Adjudicate a held lock before paying for owner publication.
    if (existsSync(path)) {
      if (!awaitLockTurn(path, attempt, unverifiable)) return abandon();
      continue;
    }
    const owner: MutationLockOwner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    const tempPath = `${path}.${process.pid}.${owner.nonce}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
      fsyncSync(fd);
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      return { fd, path, owner };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
      try { unlinkSync(tempPath); } catch { /* best-effort unpublished temp cleanup */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (!awaitLockTurn(path, attempt, unverifiable)) return abandon();
    }
  }
  return abandon();
}

function acquireMutationLock(filePath: string): MutationLock | null {
  return acquireLockAt(`${filePath}.mutation.lock`);
}

function releaseMutationLock(lock: MutationLock | null): void {
  if (!lock || 'unlocked' in lock) return;
  try { closeSync(lock.fd); } catch { /* lock metadata ownership still guards release */ }
  guardedLockRemoval(lock.path, 'release', lock.owner);
}

/** Executes a read or mutation against a state file under its mutation lock. */
export function withStateFileMutationLock<T>(
  filePath: string,
  callback: () => T,
  requireExclusive = false,
): { acquired: boolean; value: T | undefined } {
  const lock = acquireLockAt(`${filePath}.mutation.lock`, requireExclusive);
  if (!lock) return { acquired: false, value: undefined };
  try {
    return { acquired: true, value: callback() };
  } finally {
    releaseMutationLock(lock);
  }
}

export function writeStateFileLocked(filePath: string, state: Record<string, unknown>): boolean {
  if (!recoverEmergencyStateFile(filePath)) return false;
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
    atomicWriteJsonSync(filePath, state);
    return true;
  } catch {
    return false;
  } finally {
    releaseMutationLock(lock);
  }
}

export function clearStateFileLocked(filePath: string, expectedGeneration?: StateFileGeneration): boolean {
  if (!recoverEmergencyStateFile(filePath)) return false;
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
    if (existsSync(filePath)) {
      if (expectedGeneration && !sameStateFileGeneration(filePath, expectedGeneration)) return false;
      if (expectedGeneration) {
        replaceGenerationForTest(filePath);
        if (!sameStateFileGeneration(filePath, expectedGeneration)) return false;
      }
      unlinkSync(filePath);
    }
    return true;
  } catch {
    return false;
  } finally {
    releaseMutationLock(lock);
  }
}

export type EmergencyStateAuthorization = (state: Record<string, unknown>) => boolean;
export interface EmergencyRecoveryOptions {
  /** Evaluated under the recovery claim before a recovered generation is mutated. */
  authorizeState?: EmergencyStateAuthorization;
}

export type ConditionalClearResult = 'cleared' | 'skipped' | 'failed';

export function clearStateFileLockedIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  recoveryOptions?: EmergencyRecoveryOptions,
  expectedGeneration?: StateFileGeneration,
): ConditionalClearResult {
  if (!recoverEmergencyStateFile(filePath, recoveryOptions)) return 'failed';
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
    }
  }
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    if (!existsSync(filePath)) return 'skipped';
    if (expectedGeneration && !sameStateFileGeneration(filePath, expectedGeneration)) return 'skipped';
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return 'failed';
    }
    if (!predicate(current)) return 'skipped';
    if (expectedGeneration) {
      replaceGenerationForTest(filePath);
      if (!sameStateFileGeneration(filePath, expectedGeneration)) return 'skipped';
    }
    unlinkSync(filePath);
    return 'cleared';
  } catch {
    return 'failed';
  } finally {
    releaseMutationLock(lock);
  }
}

export type ConditionalWriteResult = 'written' | 'skipped' | 'failed';

export function writeStateFileLockedIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): ConditionalWriteResult {
  if (!recoverEmergencyStateFile(filePath)) return 'failed';
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64;
    }
  }
  if (!existsSync(filePath)) return 'skipped';
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    if (!existsSync(filePath)) return 'skipped';
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return 'failed';
    }
    if (!predicate(current)) return 'skipped';
    atomicWriteJsonSync(filePath, transform(current));
    return 'written';
  } catch {
    return 'failed';
  } finally {
    releaseMutationLock(lock);
  }
}

export function writeStateFileLockedCreateIf(
  filePath: string,
  predicate: (current: Record<string, unknown> | null) => boolean,
  transform: (current: Record<string, unknown> | null) => Record<string, unknown>,
): ConditionalWriteResult {
  if (!recoverEmergencyStateFile(filePath)) return 'failed';
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64) {
      try {
        const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
        atomicWriteJsonSync(filePath, replacement);
      } finally {
        delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH;
        delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64;
      }
    }
    let current: Record<string, unknown> | null = null;
    if (existsSync(filePath)) {
      try { current = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>; }
      catch { return 'failed'; }
    }
    if (!predicate(current)) return 'skipped';
    atomicWriteJsonSync(filePath, transform(current));
    return 'written';
  } catch {
    return 'failed';
  } finally {
    releaseMutationLock(lock);
  }
}

/**
 * Durable exact mutation for named workflow emergency cancellation. The journal
 * records every externally-visible step so a later reader can finish a partial
 * transaction without guessing whether the primary is a replacement.
 */
type EmergencyJournalOwner = {
  pid: number;
  processStart: string;
  nonce: string;
};

type EmergencyMutationJournal = {
  version: 1;
  transactionId: string;
  owner: EmergencyJournalOwner;
  sessionOwner?: string;
  originalDigest?: string;
  intendedDigest?: string;
  intent?: 'clear' | 'publish';
  quarantinePath: string;
  phase: 'preparing' | 'prepared' | 'quarantined' | 'published';
};

type FileIdentity = { dev: number; ino: number };

/** A stable file generation used to bind cleanup to one publication. */
export interface StateFileGeneration {
  dev: number;
  ino: number;
  digest: string;
}

export interface CapturedStateFile {
  path: string;
  generation: StateFileGeneration;
  raw: string;
}

/** State and runtime surfaces captured before a terminal cleanup transaction. */
export interface ModeStateCleanupSnapshot {
  direct: CapturedStateFile | null;
  artifacts: CapturedStateFile[];
  legacy: CapturedStateFile[];
}

function stateDigest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function emergencyJournalPath(filePath: string): string {
  return `${filePath}.emergency-journal.json`;
}

function sessionOwnerFromStatePath(filePath: string): string | undefined {
  const match = filePath.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)(?:\/|$)/);
  return match?.[1];
}

function emergencyOwner(): EmergencyJournalOwner | null {
  const processStart = processStartIdentity(process.pid);
  return typeof processStart === 'string' ? { pid: process.pid, processStart, nonce: randomUUID() } : null;
}

function sameEmergencyOwner(left: EmergencyJournalOwner, right: EmergencyJournalOwner): boolean {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

/** Unknown process identity is treated as live: stealing a claim is never safe. */
function isEmergencyOwnerLive(owner: EmergencyJournalOwner): boolean {
  const current = processStartIdentity(owner.pid);
  return current === null || (current !== 'absent' && current === owner.processStart);
}

function journalIsOwned(path: string, transactionId: string, owner: EmergencyJournalOwner): boolean {
  const current = readEmergencyJournal(path);
  return current !== null && current.transactionId === transactionId && sameEmergencyOwner(current.owner, owner);
}

function writeEmergencyJournal(path: string, journal: EmergencyMutationJournal, requireOwnership = true): boolean {
  try {
    if (requireOwnership && !journalIsOwned(path, journal.transactionId, journal.owner)) return false;
    atomicWriteJsonSync(path, journal);
    return !requireOwnership || journalIsOwned(path, journal.transactionId, journal.owner);
  } catch { return false; }
}

function emergencyPublicationTempPath(path: string): string | null {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  return `${path}.${process.pid}.${processStart}.${randomUUID()}.tmp`;
}

/** Publishes a complete, durable transaction file without exposing a partial final path. */
function publishEmergencyFileExclusive(path: string, content: string): boolean {
  const tempPath = emergencyPublicationTempPath(path);
  let fd: number | undefined;
  try {
    if (!tempPath) return false;
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(tempPath, 'wx', 0o600);
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('emergency publication made no progress');
      offset += written;
    }
    fsyncSync(fd);
    if (statSync(tempPath).size !== bytes.length) throw new Error('emergency publication truncated');
    closeSync(fd);
    fd = undefined;
    linkSync(tempPath, path);
    unlinkSync(tempPath);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
    if (tempPath) {
      const generation = fileIdentity(tempPath);
      try { if (generation && sameFile(tempPath, generation)) unlinkSync(tempPath); } catch { /* best-effort unpublished temp cleanup */ }
    }
  }
}

const RECOVERY_CLAIM_SCRIPT = String.raw`
const fs = require('fs');
const [operation, claimPath, expectedRaw] = process.argv.slice(1);
const keys = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
function readOwner() {
  try {
    const value = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index]) || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
    return value;
  } catch (error) { return error && error.code === 'ENOENT' ? 'absent' : null; }
}
function exact(left, right) { return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce; }
function stale(owner) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync('/proc/' + owner.pid + '/stat', 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
    const start = fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
    return start === null ? null : start !== owner.processStart;
  } catch (error) { return error && error.code === 'ENOENT' ? true : null; }
}
let expected;
try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
if (operation === 'release') {
  const current = readOwner();
  if (current === 'absent') process.exit(0);
  if (!current || !exact(current, expected)) process.exit(4);
  try { fs.unlinkSync(claimPath); process.exit(0); } catch { process.exit(3); }
}
const current = readOwner();
if (current !== 'absent') {
  if (!current) process.exit(3);
  const isStale = stale(current);
  if (isStale !== true) process.exit(isStale === false ? 2 : 3);
  try { fs.unlinkSync(claimPath); } catch { process.exit(3); }
}
let fd;
try {
  fd = fs.openSync(claimPath, 'wx', 0o600);
  const bytes = Buffer.from(JSON.stringify(expected));
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('recovery claim made no progress');
    offset += written;
  }
  fs.fsyncSync(fd);
  if (fs.statSync(claimPath).size !== bytes.length) throw new Error('recovery claim truncated');
  fs.closeSync(fd);
  process.exit(0);
} catch { try { if (fd !== undefined) fs.closeSync(fd); } catch {} try { fs.unlinkSync(claimPath); } catch {} process.exit(3); }
`;

function guardedRecoveryClaim(path: string, operation: 'acquire' | 'release', owner: MutationLockOwner): 'claimed' | 'live' | 'replaced' | 'unverifiable' {
  const flock = flockPath();
  if (!flock) return 'unverifiable';
  const result = spawnSync(flock, ['-x', `${path}.recovery.guard`, process.execPath, '-e', RECOVERY_CLAIM_SCRIPT, operation, path, JSON.stringify(owner)], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'claimed';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  return 'unverifiable';
}

function acquireRecoveryClaim(path: string): MutationLockOwner | null {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  const owner: MutationLockOwner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
  if (!flockPath()) return publishEmergencyFileExclusive(path, JSON.stringify(owner)) ? owner : null;
  return guardedRecoveryClaim(path, 'acquire', owner) === 'claimed' ? owner : null;
}

function readRecoveryClaim(path: string): MutationLockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as MutationLockOwner;
    return owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.processStart === 'string' && typeof owner.createdAt === 'string' && typeof owner.nonce === 'string' ? owner : null;
  } catch { return null; }
}

function sameRecoveryClaim(left: MutationLockOwner, right: MutationLockOwner): boolean {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

function releaseRecoveryClaim(path: string, owner: MutationLockOwner): void {
  if (!flockPath()) {
    try {
      const current = readRecoveryClaim(path);
      if (current && sameRecoveryClaim(current, owner)) unlinkSync(path);
    } catch { /* best-effort exact-owner release */ }
    return;
  }
  guardedRecoveryClaim(path, 'release', owner);
}

/** Claims a transaction journal without replacing a concurrent transaction. */
function createEmergencyJournal(path: string, journal: EmergencyMutationJournal): boolean {
  return publishEmergencyFileExclusive(path, JSON.stringify(journal));
}

function readEmergencyJournal(path: string): EmergencyMutationJournal | null {
  try {
    const journal = JSON.parse(readFileSync(path, 'utf8')) as EmergencyMutationJournal;
    if (journal.version !== 1 || typeof journal.transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.transactionId) ||
      !journal.owner || !Number.isInteger(journal.owner.pid) || journal.owner.pid <= 0 || typeof journal.owner.processStart !== 'string' ||
      typeof journal.owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.owner.nonce) ||
      (journal.sessionOwner !== undefined && typeof journal.sessionOwner !== 'string') ||
      (journal.originalDigest !== undefined && (typeof journal.originalDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.originalDigest))) ||
      (journal.intendedDigest !== undefined && (typeof journal.intendedDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.intendedDigest))) ||
      (journal.intent !== undefined && journal.intent !== 'clear' && journal.intent !== 'publish') ||
      typeof journal.quarantinePath !== 'string' ||
      (journal.phase !== 'preparing' && journal.phase !== 'prepared' && journal.phase !== 'quarantined' && journal.phase !== 'published')) return null;
    const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
    return journal.phase === 'preparing' || complete ? journal : null;
  } catch { return null; }
}

function fileIdentity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch { return null; }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function captureStateFile(path: string): CapturedStateFile | null {
  try {
    const before = fileIdentity(path);
    if (!before) return null;
    const raw = readFileSync(path, 'utf8');
    const after = fileIdentity(path);
    if (!after || !sameFileIdentity(before, after)) return null;
    const confirm = readFileSync(path, 'utf8');
    if (confirm !== raw || !sameFile(path, before)) return null;
    return {
      path,
      generation: { ...before, digest: stateDigest(raw) },
      raw,
    };
  } catch {
    return null;
  }
}

/** Capture one exact publication for callers whose state file is not a mode file. */
export function captureStateFileGeneration(path: string): CapturedStateFile | null {
  return captureStateFile(path);
}

function sameStateFileGeneration(path: string, expected: StateFileGeneration): boolean {
  try {
    const identity = fileIdentity(path);
    if (!identity || identity.dev !== expected.dev || identity.ino !== expected.ino) return false;
    return stateDigest(readFileSync(path, 'utf8')) === expected.digest;
  } catch {
    return false;
  }
}

/** Deterministic test-only publication at the final generation-clear boundary. */
function replaceGenerationForTest(path: string): void {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_PATH !== path ||
    !process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_BASE64
  ) return;
  try {
    const replacement = JSON.parse(
      Buffer.from(process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_BASE64, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    atomicWriteJsonSync(path, replacement);
  } finally {
    delete process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_GENERATION_CLEAR_REPLACEMENT_BASE64;
  }
}

function sameFile(path: string, expected: FileIdentity): boolean {
  const actual = fileIdentity(path);
  return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}

function reconcileEmergencyPublicationTemps(filePath: string, authorizeState?: EmergencyStateAuthorization): boolean {
  const directory = dirname(filePath);
  const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.emergency-(journal\\.json|recovery\\.claim|quarantine\\.[0-9a-f-]{36}\\.payload)\\.(\\d+)\\.(\\d+)\\.([0-9a-f-]{36})\\.tmp$`, 'i');
  let names: string[];
  try { names = readdirSync(directory); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    const currentStart = processStartIdentity(Number(match[2]));
    if (currentStart === null || currentStart === match[3]) return false;
    const generation = fileIdentity(path);
    try {
      if (!generation) return false;
      const raw = readFileSync(path, 'utf8');
      if (authorizeState) {
        if (match[1] === 'journal.json') {
          const journal = readEmergencyJournal(path);
          if (!journal || !recoveryGenerationsAuthorized(filePath, journal, authorizeState)) return false;
        } else if (match[1].startsWith('quarantine.')) {
          const state = JSON.parse(raw) as unknown;
          if (!state || typeof state !== 'object' || Array.isArray(state) || !authorizeState(state as Record<string, unknown>)) return false;
        } else {
          const claim = readRecoveryClaim(path);
          if (!claim || claim.pid !== Number(match[2]) || claim.processStart !== match[3] || claim.nonce !== match[4]) return false;
        }
      }
      if (!sameFile(path, generation) || stateDigest(readFileSync(path, 'utf8')) !== stateDigest(raw)) return false;
      unlinkSync(path);
    } catch { return false; }
  }
  return true;
}

/** Captures only the authenticated source generation and never unlinks a replacement. */
function captureAndUnlinkPrimary(filePath: string, quarantinePath: string, expectedDigest: string): boolean {
  try {
    linkSync(filePath, quarantinePath);
    const captured = fileIdentity(quarantinePath);
    if (!captured || stateDigest(readFileSync(quarantinePath, 'utf8')) !== expectedDigest || !sameFile(filePath, captured)) return false;
    emergencyReplaceAtCaptureBoundary(filePath);
    if (!sameFile(filePath, captured) || stateDigest(readFileSync(filePath, 'utf8')) !== expectedDigest) return false;
    unlinkSync(filePath);
    return true;
  } catch { return false; }
}

function removeOwnedEmergencyArtifacts(journalPath: string, journal: EmergencyMutationJournal, removeQuarantine: boolean): boolean {
  try {
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return false;
    if (removeQuarantine) {
      try { unlinkSync(journal.quarantinePath); } catch { /* absent */ }
    }
    try { unlinkSync(`${journal.quarantinePath}.payload`); } catch { /* absent */ }
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return false;
    unlinkSync(journalPath);
    return true;
  } catch { return false; }
}

function recoveryGenerationsAuthorized(
  filePath: string,
  journal: EmergencyMutationJournal | null,
  authorizeState: EmergencyStateAuthorization | undefined,
): boolean {
  if (!authorizeState) return true;
  const paths = [
    filePath,
    ...(journal ? [journal.quarantinePath, `${journal.quarantinePath}.payload`] : []),
  ];
  let authenticatedJournalGeneration = journal === null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw: string;
    let state: Record<string, unknown>;
    try {
      raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      state = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!authorizeState(state)) return false;
    if (journal && (
      stateDigest(raw) === journal.originalDigest ||
      (journal.intent === 'publish' && stateDigest(raw) === journal.intendedDigest)
    )) authenticatedJournalGeneration = true;
  }
  return authenticatedJournalGeneration;
}

/** Shared-home recovery claims contain no project identity, so pre-existing
 * claim publications are never attributable to the caller and must survive. */
function hasUnattributableRecoveryClaimArtifact(filePath: string, recoveryClaim?: MutationLockOwner): boolean {
  const directory = dirname(filePath);
  const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tempPattern = new RegExp(`^${base}\\.emergency-recovery\\.claim\\.\\d+\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`, 'i');
  try {
    if (readdirSync(directory).some((name) => tempPattern.test(name))) return true;
    const claimPath = `${filePath}.emergency-recovery.claim`;
    if (!existsSync(claimPath)) return recoveryClaim !== undefined;
    if (!recoveryClaim) return true;
    const current = readRecoveryClaim(claimPath);
    return !current || !sameRecoveryClaim(current, recoveryClaim);
  } catch {
    return true;
  }
}

function sharedRecoveryArtifactsAuthorized(
  filePath: string,
  authorizeState: EmergencyStateAuthorization | undefined,
  recoveryClaim?: MutationLockOwner,
): boolean {
  if (!authorizeState) return true;
  if (hasUnattributableRecoveryClaimArtifact(filePath, recoveryClaim)) return false;
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) {
    if (!existsSync(filePath)) return true;
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      return state !== null && typeof state === 'object' && !Array.isArray(state) && authorizeState(state as Record<string, unknown>);
    } catch {
      return false;
    }
  }
  const journal = readEmergencyJournal(journalPath);
  return journal !== null && recoveryGenerationsAuthorized(filePath, journal, authorizeState);
}

function emergencyReplaceAtRecoveryBoundary(filePath: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64) return;
  try {
    const replacements = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Array<{ path: string; content: string }>;
    const directory = dirname(filePath);
    for (const name of readdirSync(directory)) {
      if (name === basename(filePath) || name.startsWith(`${basename(filePath)}.emergency-`)) unlinkSync(join(directory, name));
    }
    for (const replacement of replacements) {
      if (dirname(replacement.path) !== directory) throw new Error('invalid recovery replacement path');
      writeFileSync(replacement.path, replacement.content);
    }
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64;
  }
}

/** A dead transaction is recovered under a state-scoped, generation-verified exclusive claim. */
export function recoverEmergencyStateFile(filePath: string, options?: EmergencyRecoveryOptions): boolean {
  const pathSessionId = sessionOwnerFromStatePath(filePath);
  const authorizeState = options?.authorizeState ?? (pathSessionId
    ? (state: Record<string, unknown>) => {
      const owner = getStateSessionOwner(state);
      return owner === undefined || owner === pathSessionId;
    }
    : undefined);
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(filePath) && !existsSync(journalPath)) return true;
  // Prefilter before taking a claim so stale shared-home artifacts cannot be
  // reclaimed solely because their process owner is dead. Revalidate while
  // holding our own claim below.
  if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState)) return false;
  if (!existsSync(journalPath)) {
    if (!authorizeState) return reconcileEmergencyPublicationTemps(filePath);
    const claimPath = `${filePath}.emergency-recovery.claim`;
    const claim = acquireRecoveryClaim(claimPath);
    if (!claim) return false;
    try {
      if (existsSync(journalPath) || !sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim)) return false;
      return reconcileEmergencyPublicationTemps(filePath, authorizeState);
    } finally {
      releaseRecoveryClaim(claimPath, claim);
    }
  }
  const journal = readEmergencyJournal(journalPath);
  if (!journal) {
    if (authorizeState) return false;
    const claimPath = `${filePath}.emergency-recovery.claim`;
    const claim = acquireRecoveryClaim(claimPath);
    if (!claim) return false;
    try {
      const generation = fileIdentity(journalPath);
      emergencyReplaceAtRecoveryBoundary(filePath);
      const current = readEmergencyJournal(journalPath);
      if (!recoveryGenerationsAuthorized(filePath, current, authorizeState)) return true;
      if (!reconcileEmergencyPublicationTemps(filePath, authorizeState)) return false;
      if (!generation || readEmergencyJournal(journalPath) !== null || !existsSync(filePath) || !sameFile(journalPath, generation)) return false;
      unlinkSync(journalPath);
      return true;
    } catch { return false; } finally {
      releaseRecoveryClaim(claimPath, claim);
    }
  }
  const claimPath = `${filePath}.emergency-recovery.claim`;
  const claim = acquireRecoveryClaim(claimPath);
  if (!claim) return false;
  try {
    if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim)) return false;
    emergencyReplaceAtRecoveryBoundary(filePath);
    const current = readEmergencyJournal(journalPath);
    if (!recoveryGenerationsAuthorized(filePath, current, authorizeState)) return true;
    if (!reconcileEmergencyPublicationTemps(filePath, authorizeState)) return false;
    if (!current || current.quarantinePath !== `${filePath}.emergency-quarantine.${current.transactionId}` || isEmergencyOwnerLive(current.owner)) return false;
    return recoverDeadEmergencyStateFile(filePath, authorizeState);
  } finally {
    releaseRecoveryClaim(claimPath, claim);
  }
}

/** Recover a previously interrupted emergency mutation while holding the recovery claim. */
function recoverDeadEmergencyStateFile(filePath: string, authorizeState?: EmergencyStateAuthorization): boolean {
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) return true;
  const journal = readEmergencyJournal(journalPath);
  if (!journal || journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}`) return false;
  if (isEmergencyOwnerLive(journal.owner)) return false;
  if (!recoveryGenerationsAuthorized(filePath, journal, authorizeState)) return true;
  const owned = () => journalIsOwned(journalPath, journal.transactionId, journal.owner);
  if (!owned()) return false;
  const payloadPath = `${journal.quarantinePath}.payload`;
  const digest = (path: string): string | null => {
    try { return stateDigest(readFileSync(path, 'utf8')); } catch { return null; }
  };
  if (journal.phase === 'preparing') {
    const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
    if (!complete) {
      if (existsSync(journal.quarantinePath) || existsSync(payloadPath)) return false;
      return removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    const originalStillPrimary = !existsSync(journal.quarantinePath) && digest(filePath) === journal.originalDigest;
    if (journal.intent === 'publish' && digest(payloadPath) !== journal.intendedDigest) {
      return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    if (journal.intent === 'clear' && existsSync(payloadPath)) {
      return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    journal.phase = 'prepared';
    return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
  }
  const originalDigest = journal.originalDigest!;
  const intent = journal.intent!;
  const intendedDigest = journal.intendedDigest;
  const hasPrimary = existsSync(filePath);
  const hasQuarantine = existsSync(journal.quarantinePath);
  const finalize = (): boolean => removeOwnedEmergencyArtifacts(journalPath, journal, hasQuarantine);

  if (hasPrimary && hasQuarantine) {
    if (intent === 'publish' && digest(filePath) === intendedDigest && digest(journal.quarantinePath) === originalDigest) return finalize();
    // The primary is an unrelated replacement. It wins; discard only this transaction.
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  }
  if (hasPrimary) {
    if (!hasQuarantine && journal.phase === 'prepared' && digest(filePath) === originalDigest) {
      if (intent === 'publish' && digest(payloadPath) !== intendedDigest) return false;
      if (!owned()) return false;
      if (!captureAndUnlinkPrimary(filePath, journal.quarantinePath, originalDigest)) {
        if (owned() && existsSync(filePath) && existsSync(journal.quarantinePath) && digest(filePath) !== originalDigest) {
          removeOwnedEmergencyArtifacts(journalPath, journal, true);
        }
        return false;
      }
      journal.phase = 'quarantined';
      return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
    }
    return false;
  }
  if (!hasQuarantine) {
    return intent === 'clear' && journal.phase === 'published' && removeOwnedEmergencyArtifacts(journalPath, journal, false);
  }
  if (digest(journal.quarantinePath) !== originalDigest || !owned()) return false;
  try {
    if (intent === 'clear') return removeOwnedEmergencyArtifacts(journalPath, journal, true);
    const payload = readFileSync(payloadPath, 'utf8');
    if (stateDigest(payload) !== intendedDigest || !owned()) return false;
    linkSync(payloadPath, filePath); // exclusive: never overwrite a replacement
    journal.phase = 'published';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  } catch { return false; }
}

function emergencyCrashAt(phase: string): boolean {
  return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_CRASH_PHASE === phase;
}

/** A writer that cannot capture its authenticated source relinquishes its claim. */
function abandonEmergencyJournal(journalPath: string, journal: EmergencyMutationJournal): void {
  if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return;
  journal.owner = { ...journal.owner, pid: 999999999, processStart: 'abandoned' };
  try { atomicWriteJsonSync(journalPath, journal); } catch { /* original claim remains safe */ }
}

/** Test crashes must relinquish ownership; a real crashed process is not live. */
function abandonEmergencyJournalForTest(journalPath: string, journal: EmergencyMutationJournal): void {
  if (!emergencyCrashAt('after-payload') && !emergencyCrashAt('before-rename') && !emergencyCrashAt('after-rename') && !emergencyCrashAt('after-publication') && !emergencyCrashAt('before-cleanup')) return;
  abandonEmergencyJournal(journalPath, journal);
}

function emergencyReplaceAfterPredicate(filePath: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64) return;
  try {
    const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
    atomicWriteJsonSync(filePath, replacement);
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64;
  }
}

function emergencyReplaceAtCaptureBoundary(filePath: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64) return;
  try {
    const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
    atomicWriteJsonSync(filePath, replacement);
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64;
  }
}

export function emergencyMutateStateFileIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  transform: ((current: Record<string, unknown>) => Record<string, unknown>) | null,
  recoveryOptions?: EmergencyRecoveryOptions,
): boolean {
  if (!recoverEmergencyStateFile(filePath, recoveryOptions)) return false;
  const owner = emergencyOwner();
  if (!owner) return false;
  const transactionId = randomUUID();
  const quarantinePath = `${filePath}.emergency-quarantine.${transactionId}`;
  const journalPath = emergencyJournalPath(filePath);
  const payloadPath = `${quarantinePath}.payload`;
  let journal: EmergencyMutationJournal | null = null;
  try {
    journal = { version: 1, transactionId, owner, quarantinePath, phase: 'preparing' };
    if (!createEmergencyJournal(journalPath, journal)) return false;
    const owns = () => journal !== null && journalIsOwned(journalPath, transactionId, owner);
    if (!existsSync(filePath)) { removeOwnedEmergencyArtifacts(journalPath, journal, false); return false; }
    const originalRaw = readFileSync(filePath, 'utf8');
    const current = JSON.parse(originalRaw) as Record<string, unknown>;
    if (!predicate(current)) { removeOwnedEmergencyArtifacts(journalPath, journal, false); return false; }
    const transformedRaw = transform ? JSON.stringify(transform(current)) : undefined;
    Object.assign(journal, {
      ...(getStateSessionOwner(current) ? { sessionOwner: getStateSessionOwner(current) } : {}),
      originalDigest: stateDigest(originalRaw),
      ...(transformedRaw === undefined ? { intent: 'clear' as const } : { intent: 'publish' as const, intendedDigest: stateDigest(transformedRaw) }),
    });
    if (!owns() || !writeEmergencyJournal(journalPath, journal)) return false;
    if (transformedRaw !== undefined) {
      if (!owns()) return false;
      if (!publishEmergencyFileExclusive(payloadPath, transformedRaw)) return false;
      if (!owns()) return false;
    }
    if (emergencyCrashAt('after-payload')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    journal.phase = 'prepared';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    const authenticatedRaw = readFileSync(filePath, 'utf8');
    const authenticated = JSON.parse(authenticatedRaw) as Record<string, unknown>;
    if (!owns() || stateDigest(authenticatedRaw) !== journal.originalDigest || !predicate(authenticated)) {
      removeOwnedEmergencyArtifacts(journalPath, journal, false);
      return false;
    }
    emergencyReplaceAfterPredicate(filePath);
    if (emergencyCrashAt('before-rename')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    if (!owns() || !captureAndUnlinkPrimary(filePath, quarantinePath, journal.originalDigest!)) {
      removeOwnedEmergencyArtifacts(journalPath, journal, true);
      return false;
    }
    journal.phase = 'quarantined';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    if (emergencyCrashAt('after-rename')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    if (transformedRaw !== undefined) {
      if (!owns()) return false;
      linkSync(payloadPath, filePath);
      journal.phase = 'published';
      if (!writeEmergencyJournal(journalPath, journal)) return false;
      if (emergencyCrashAt('after-publication')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    } else {
      journal.phase = 'published';
      if (!writeEmergencyJournal(journalPath, journal)) return false;
    }
    if (emergencyCrashAt('before-cleanup')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  } catch {
    if (journal) abandonEmergencyJournal(journalPath, journal);
    return false;
  }
}

export function getStateSessionOwner(state: Record<string, unknown> | null | undefined): string | undefined {
  if (!state || typeof state !== 'object') {
    return undefined;
  }

  const meta = state._meta;
  if (meta && typeof meta === 'object') {
    const metaSessionId = (meta as Record<string, unknown>).sessionId;
    if (typeof metaSessionId === 'string' && metaSessionId) {
      return metaSessionId;
    }
  }

  const topLevelSessionId = state.session_id;
  return typeof topLevelSessionId === 'string' && topLevelSessionId
    ? topLevelSessionId
    : undefined;
}

export function canClearStateForSession(
  state: Record<string, unknown> | null | undefined,
  sessionId: string,
): boolean {
  const ownerSessionId = getStateSessionOwner(state);
  return !ownerSessionId || ownerSessionId === sessionId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveStateRoot(directory?: string): string {
  const baseDir = directory || process.cwd();
  const probe = probeGitTopLevel(baseDir);
  if (probe.status === 'ok') return probe.root;
  // Keep the confirmed non-Git directory as the identity input. Converting it
  // to HOME here is unsafe when HOME itself is a Git checkout: a later
  // getOmcRoot() call would reclassify HOME as that repository.
  if (probe.status === 'not_a_repository') return baseDir;
  throw new Error('Git probe failed while resolving runtime state root');
}

/**
 * Resolve the state file path for a given mode.
 * When sessionId is provided, returns the session-scoped path.
 * Otherwise returns the legacy (global) path.
 */
function resolveFile(mode: string, directory?: string, sessionId?: string): string {
  const baseDir = resolveStateRoot(directory);
  if (sessionId) {
    return resolveSessionStatePath(mode, sessionId, baseDir);
  }
  return resolveStatePath(mode, baseDir);
}

function getLegacyStateCandidates(mode: string, directory?: string): string[] {
  const baseDir = resolveStateRoot(directory);
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;

  return [
    resolveStatePath(mode, baseDir),
    join(getOmcRoot(baseDir), `${normalizedName}.json`),
  ];
}

function getRuntimeArtifactCandidates(mode: string, directory?: string, sessionId?: string): string[] {
  const baseDir = resolveStateRoot(directory);
  const stateRoot = join(getOmcRoot(baseDir), 'state');
  const artifactNames = [
    `${mode}-stop-breaker.json`,
    `${mode}-last-steer-at`,
    `${mode}-continue-steer.lock`,
  ];
  const candidateDirs = new Set<string>([stateRoot]);

  if (sessionId) {
    candidateDirs.add(join(stateRoot, 'sessions', sessionId));
  } else {
    for (const sid of listSessionIds(baseDir)) {
      candidateDirs.add(join(stateRoot, 'sessions', sid));
    }
  }

  return [...candidateDirs].flatMap((dir) => artifactNames.map((name) => join(dir, name)));
}

/**
 * Capture every cleanup surface before a terminal request is consumed.
 * Missing/unreadable surfaces are deliberately not synthesized: a later
 * clear can only touch generations that were authenticated at this boundary.
 */
export function captureModeStateCleanup(
  mode: string,
  directory?: string,
  sessionId?: string,
): ModeStateCleanupSnapshot {
  const baseDir = resolveStateRoot(directory);
  const direct = captureStateFile(resolveFile(mode, directory, sessionId));
  const artifacts = getRuntimeArtifactCandidates(mode, baseDir, sessionId)
    .map(captureStateFile)
    .filter((candidate): candidate is CapturedStateFile => candidate !== null);
  const legacy = sessionId
    ? getLegacyStateCandidates(mode, baseDir)
      .map(captureStateFile)
      .filter((candidate): candidate is CapturedStateFile => candidate !== null)
    : [];
  return { direct, artifacts, legacy };
}


/**
 * Find session-scoped state files that belong to the requested session.
 *
 * Normally the state file lives under `.omg/state/sessions/{sessionId}/`.
 * When a file is stranded under a different session directory (for example
 * after session continuation or manual recovery), this scans all session
 * directories and returns any file whose embedded owner still matches the
 * requested session.
 */
export interface StateFileDiscovery {
  path: string;
  snapshot: string;
  state: Record<string, unknown>;
  ownerSessionId?: string;
  workflowRunId?: string;
  completedSessionId?: string;
  completionEvidencePath?: string;
}

function discoverStateFile(path: string, extra: Partial<StateFileDiscovery> = {}): StateFileDiscovery | null {
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return {
      path,
      snapshot: JSON.stringify(state),
      state,
      ownerSessionId: getStateSessionOwner(state),
      workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
      ...extra,
    };
  } catch {
    return null;
  }
}

function hasAuthenticatedCompletionEvidence(path: string, sessionId: string): boolean {
  try {
    const evidence = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return evidence.session_id === sessionId
      && typeof evidence.ended_at === 'string'
      && evidence.ended_at.trim().length > 0
      && Number.isFinite(Date.parse(evidence.ended_at));
  } catch {
    return false;
  }
}

export function findSessionOwnedStateCandidates(
  mode: string,
  sessionId: string,
  directory?: string,
): StateFileDiscovery[] {
  const matches = new Map<string, StateFileDiscovery>();
  const baseDir = resolveStateRoot(directory);
  const expectedPath = resolveSessionStatePath(mode, sessionId, baseDir);
  const expected = discoverStateFile(expectedPath);
  if (expected && canClearStateForSession(expected.state, sessionId)) {
    matches.set(expectedPath, expected);
  }

  for (const sid of listSessionIds(baseDir)) {
    const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
    const candidate = discoverStateFile(candidatePath);
    if (candidate?.ownerSessionId === sessionId) matches.set(candidatePath, candidate);
  }
  return [...matches.values()];
}

export function findSessionOwnedStateFiles(mode: string, sessionId: string, directory?: string): string[] {
  return findSessionOwnedStateCandidates(mode, sessionId, directory).map((candidate) => candidate.path);
}

/**
 * Find active session-scoped state files that are safe to treat as orphaned.
 *
 * A fresh `/cancel` invocation may run in a new Claude session id while the
 * state files that keep the Stop hook alive still live under the completed
 * session's directory.  We intentionally require durable completion evidence
 * (`.omg/sessions/{sessionId}.json`) before returning a sibling session's file
 * so active parallel sessions are not cleared just because their ids differ
 * from the caller's fresh cancel session.
 */
export function findCompletedSessionStateCandidates(
  mode: string,
  directory?: string,
  requesterSessionId?: string,
): StateFileDiscovery[] {
  const matches: StateFileDiscovery[] = [];
  const baseDir = resolveStateRoot(directory);

  for (const sid of listSessionIds(baseDir)) {
    if (requesterSessionId && sid === requesterSessionId) continue;
    const completionEvidencePath = join(getOmcRoot(baseDir), 'sessions', `${sid}.json`);
    if (!hasAuthenticatedCompletionEvidence(completionEvidencePath, sid)) continue;
    const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
    const candidate = discoverStateFile(candidatePath, { completedSessionId: sid, completionEvidencePath });
    if (candidate?.state.active === true && candidate.ownerSessionId === sid) matches.push(candidate);
  }
  return matches;
}

export function findCompletedSessionStateFiles(mode: string, directory?: string, requesterSessionId?: string): string[] {
  return findCompletedSessionStateCandidates(mode, directory, requesterSessionId).map((candidate) => candidate.path);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write mode state to disk.
 *
 * - Ensures parent directories exist.
 * - Writes with mode 0o600 (owner-only) for security.
 * - Adds `_meta` envelope with write timestamp.
 *
 * @returns true on success, false on failure
 */
export function writeModeState(
  mode: string,
  state: Record<string, unknown>,
  directory?: string,
  sessionId?: string,
): boolean {
  try {
    const baseDir = resolveStateRoot(directory);
    if (sessionId) {
      ensureSessionStateDir(sessionId, baseDir);
    } else {
      ensureOmcDir('state', baseDir);
    }
    const filePath = resolveFile(mode, directory, sessionId);
    // owner_pid is written at the top level (not only inside _meta) so external
    // hook scripts can perform process-liveness checks without parsing _meta.
    // Existing state shapes carry session_id at top level; owner_pid follows
    // the same convention. Readers that don't know the field ignore it.
    const ownerPid = typeof process.pid === 'number' ? process.pid : undefined;
    const envelope = {
      ...state,
      ...(ownerPid !== undefined && (state.owner_pid === undefined) ? { owner_pid: ownerPid } : {}),
      _meta: {
        written_at: new Date().toISOString(),
        mode,
        ...(sessionId ? { sessionId } : {}),
        ...(ownerPid !== undefined ? { ownerPid } : {}),
      },
    };
    if (sessionId) {
      return writeStateFileLockedCreateIf(
        filePath,
        current => current === null || canClearStateForSession(current, sessionId),
        () => envelope,
      ) === 'written';
    }
    return writeStateFileLocked(filePath, envelope);
  } catch {
    return false;
  }
}

/** Restore a mode state only when no newer state has been published. */
export function writeModeStateIfAbsent(
  mode: string,
  state: Record<string, unknown>,
  directory?: string,
  sessionId?: string,
): boolean {
  try {
    const baseDir = resolveStateRoot(directory);
    if (sessionId) ensureSessionStateDir(sessionId, baseDir);
    else ensureOmcDir('state', baseDir);
    const result = writeStateFileLockedCreateIf(
      resolveFile(mode, directory, sessionId),
      current => current === null,
      () => state,
    );
    return result === 'written';
  } catch {
    return false;
  }
}

/**
 * Read mode state from disk.
 *
 * When sessionId is provided, ONLY reads the session-scoped file (no legacy fallback)
 * to prevent cross-session state leakage.
 *
 * Strips the `_meta` envelope so callers get the original state shape.
 * Handles files written before _meta was introduced (no-op strip).
 *
 * @returns The parsed state (without _meta) or null if not found / unreadable.
 */
export function readModeState<T = Record<string, unknown>>(
  mode: string,
  directory?: string,
  sessionId?: string,
): T | null {
  const filePath = resolveFile(mode, directory, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (sessionId && parsed && typeof parsed === 'object' && !canClearStateForSession(parsed as Record<string, unknown>, sessionId)) {
      return null;
    }
    // Strip _meta envelope if present
    if (parsed && typeof parsed === 'object' && '_meta' in parsed) {
      const { _meta: _, ...rest } = parsed;
      return rest as T;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/** Read the persisted state envelope, retaining `_meta` for authorization checks. */
export function readModeStateWithMeta<T = Record<string, unknown>>(
  mode: string,
  directory?: string,
  sessionId?: string,
): T | null {
  const filePath = resolveFile(mode, directory, sessionId);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (sessionId && parsed && typeof parsed === 'object' && !canClearStateForSession(parsed as Record<string, unknown>, sessionId)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Clear (delete) a mode state file from disk.
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped file.
 * 2. Ghost-legacy cleanup: also removes the legacy file if it belongs to
 *    this session or has no session_id (orphaned).
 *
 * @returns true on success (or file already absent), false on failure.
 */
export function clearModeStateFile(
  mode: string,
  directory?: string,
  sessionId?: string,
  expectedState?: Record<string, unknown>,
  cleanupSnapshot?: ModeStateCleanupSnapshot,
): boolean {
  let success = true;
  const baseDir = resolveStateRoot(directory);
  const captured = expectedState
    ? cleanupSnapshot ?? captureModeStateCleanup(mode, baseDir, sessionId)
    : undefined;
  const unlinkIfPresent = (filePath: string): void => {
    if (!clearStateFileLocked(filePath)) success = false;
  };

  const unlinkCapturedIfPresent = (candidate: CapturedStateFile): void => {
    if (!clearStateFileLocked(candidate.path, candidate.generation)) success = false;
  };

  const markUncapturedPresent = (paths: string[], capturedPaths: Set<string>): void => {
    for (const path of paths) {
      if (existsSync(path) && !capturedPaths.has(path)) success = false;
    }
  };

  if (sessionId) {
    const directPath = resolveFile(mode, directory, sessionId);
    if (expectedState) {
      if (!captured?.direct) return false;
      const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
      const result = clearStateFileLockedIf(
        directPath,
        (current) => canClearStateForSession(current, sessionId)
          && JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot,
        undefined,
        captured.direct.generation,
      );
      if (result === 'failed' || (result === 'skipped' && existsSync(directPath))) return false;
      const artifactPaths = getRuntimeArtifactCandidates(mode, baseDir, sessionId);
      const artifactPathsCaptured = new Set(captured.artifacts.map(candidate => candidate.path));
      markUncapturedPresent(artifactPaths, artifactPathsCaptured);
      for (const candidate of captured.artifacts) unlinkCapturedIfPresent(candidate);
      const legacyPaths = getLegacyStateCandidates(mode, baseDir);
      const legacyPathsCaptured = new Set(captured.legacy.map(candidate => candidate.path));
      for (const legacyPath of legacyPaths) {
        if (!existsSync(legacyPath) || legacyPathsCaptured.has(legacyPath)) continue;
        try {
          const current = JSON.parse(readFileSync(legacyPath, 'utf8')) as Record<string, unknown>;
          if (canClearStateForSession(current, sessionId)) success = false;
        } catch {
          // Preserve unreadable/foreign legacy state exactly as the historical
          // ghost cleanup path does.
        }
      }
      for (const candidate of captured.legacy) {
        try {
          const observed = JSON.parse(candidate.raw) as Record<string, unknown>;
          if (!canClearStateForSession(observed, sessionId)) continue;
          const observedSnapshot = JSON.stringify(observed);
          const legacyResult = clearStateFileLockedIf(
            candidate.path,
            (current) => canClearStateForSession(current, sessionId) && JSON.stringify(current) === observedSnapshot,
            undefined,
            candidate.generation,
          );
          if (legacyResult === 'failed') {
            success = false;
          } else if (legacyResult === 'skipped' && existsSync(candidate.path)) {
            try {
              const current = JSON.parse(readFileSync(candidate.path, 'utf8')) as Record<string, unknown>;
              if (canClearStateForSession(current, sessionId)) success = false;
            } catch {
              // Preserve unreadable/foreign replacements.
            }
          }
        } catch {
          success = false;
        }
      }
    } else {
      const directResult = clearStateFileLockedIf(
        directPath,
        current => canClearStateForSession(current, sessionId),
      );
      if (directResult === 'failed' || (directResult === 'skipped' && existsSync(directPath))) success = false;
      for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir, sessionId)) {
        unlinkIfPresent(artifactPath);
      }
    }
  } else if (expectedState) {
    const directPath = resolveFile(mode, directory);
    if (!captured?.direct) return false;
    const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
    const result = clearStateFileLockedIf(
      directPath,
      (current) => JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot,
      undefined,
      captured.direct.generation,
    );
    if (result === 'failed' || (result === 'skipped' && existsSync(directPath))) return false;
    const artifactPaths = getRuntimeArtifactCandidates(mode, baseDir);
    const artifactPathsCaptured = new Set(captured.artifacts.map(candidate => candidate.path));
    markUncapturedPresent(artifactPaths, artifactPathsCaptured);
    for (const candidate of captured.artifacts) unlinkCapturedIfPresent(candidate);
  } else {
    for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) unlinkIfPresent(legacyPath);
    for (const sid of listSessionIds(baseDir)) unlinkIfPresent(resolveSessionStatePath(mode, sid, baseDir));
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir)) unlinkIfPresent(artifactPath);
  }

  // Ghost-legacy cleanup: if sessionId provided, also check legacy path.
  // Expected-state clears already process only their pre-captured legacy
  // generations above; recapturing here would make a replacement deletable.
  if (sessionId && !expectedState) {
    for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) {
      if (!existsSync(legacyPath)) {
        continue;
      }

      try {
        const observed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Record<string, unknown>;
        if (!canClearStateForSession(observed, sessionId)) continue;
        const observedSnapshot = JSON.stringify(observed);
        const result = clearStateFileLockedIf(
          legacyPath,
          (current) => canClearStateForSession(current, sessionId) && JSON.stringify(current) === observedSnapshot,
        );
        if (result === 'failed') success = false;
      } catch {
        // Can't read/parse — leave it alone.
      }
    }
  }

  return success;
}
