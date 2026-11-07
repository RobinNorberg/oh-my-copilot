/**
 * A lock owner's own start identity must not cost a PowerShell spawn per hook process on win32
 * (each hook is a fresh process, and the probe ran over its budget under load, failing the lock
 * closed). Lock owners there record `ticksmax:<n>` (version 2), an upper bound on the process's
 * creation time, and a foreign prober compares its exact `ticks:<n>` probe against that bound.
 * These tests pin: no spawn on the own-identity path, a record this process wrote still reads
 * live to a foreign-style exact probe of its pid, a dead or pid-reusing owner still reads dead,
 * a version 1 record carrying a bound is malformed, and each twin adjudicates records the other
 * wrote.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const spawnCalls = vi.hoisted(() => [] as string[]);
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, ...rest: unknown[]) => {
      spawnCalls.push(command);
      return (actual.spawnSync as (...args: unknown[]) => unknown)(command, ...rest);
    },
  };
});

import {
  START_BOUND_PREFIX,
  acquireStateFileLockAtPathSync,
  acquireStateFileLockSync,
  getStateFileLockFailureKind,
  getStateFileLockFailureReason,
  processStartIdentity,
  releaseStateFileLockSync,
  startIdentityMatches,
} from '../../scripts/lib/state-lock.mjs';
import { startIdentityMatches as tsStartIdentityMatches, withStateFileMutationLock } from '../../src/lib/mode-state-io.js';

const REPO_ROOT = join(import.meta.dirname, '../..');
const isWin = process.platform === 'win32';
const tmpRoot = mkdtempSync(join(tmpdir(), 'omc-own-identity-'));
const stateDir = join(tmpRoot, 'state');
mkdirSync(stateDir, { recursive: true });
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  delete process.env.OMC_TEST_FLOCK_AVAILABLE;
});

afterAll(() => {
  for (const child of children) child.kill();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function readRecord(lockPath: string) {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as { version: number; pid: number; processStart: string; nonce: string };
}

/** A separate process takes the lock on `filePath` through the hook copy and holds it. */
async function holdLockInChild(filePath: string): Promise<{ child: ChildProcessWithoutNullStreams; record: ReturnType<typeof readRecord> }> {
  const script = join(tmpRoot, `holder-${randomUUID()}.mjs`);
  const lockModule = pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'state-lock.mjs')).href;
  writeFileSync(script, [
    `const { acquireStateFileLockSync } = await import(${JSON.stringify(lockModule)});`,
    `const lock = acquireStateFileLockSync(${JSON.stringify(filePath)}, 50, true);`,
    `process.stdout.write(lock ? 'held\\n' : 'failed\\n');`,
    `process.stdin.resume();`,
  ].join('\n'));
  const env = { ...process.env };
  delete env.NODE_ENV;
  const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('\n')) resolve(out.trim()); });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('exit', (code) => reject(new Error(`holder exited ${code}: ${err}`)));
  });
  expect(line).toBe('held');
  return { child, record: readRecord(`${filePath}.mutation.lock`) };
}

/** Holds the lock through the TS twin in a child; `mode` 'release' waits for `releaseFlag`, 'exit' dies holding it. */
async function holdTsLockInChild(filePath: string, releaseFlag: string, mode: 'release' | 'exit'): Promise<ChildProcessWithoutNullStreams> {
  const script = join(tmpRoot, `ts-holder-${randomUUID()}.mts`);
  const tsModule = pathToFileURL(join(REPO_ROOT, 'src', 'lib', 'mode-state-io.ts')).href;
  writeFileSync(script, [
    `import { existsSync, writeSync } from 'fs';`,
    `const { withStateFileMutationLock } = await import(${JSON.stringify(tsModule)});`,
    `const result = withStateFileMutationLock(${JSON.stringify(filePath)}, () => {`,
    `  writeSync(1, 'held\\n');`,
    `  ${mode === 'exit' ? 'process.exit(0);' : ''}`,
    `  while (!existsSync(${JSON.stringify(releaseFlag)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);`,
    `});`,
    `if (!result.acquired) writeSync(1, 'failed\\n');`,
  ].join('\n'));
  const env = { ...process.env };
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, script], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('\n')) resolve(out.trim()); });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('exit', (code) => { if (!out.includes('\n')) reject(new Error(`TS holder exited ${code}: ${err}`)); });
  });
  expect(line).toBe('held');
  return child;
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}

describe('own start identity without a PowerShell spawn', () => {
  it.each([
    ['SQLite backend', undefined],
    ['owner-file fallback', '0'],
  ])('acquires and releases through the %s without spawning PowerShell', (_label, flock) => {
    if (flock) process.env.OMC_TEST_FLOCK_AVAILABLE = flock;
    const lockPath = join(stateDir, `no-spawn-${flock ?? 'sqlite'}.lock`);
    spawnCalls.length = 0;

    const lock = acquireStateFileLockAtPathSync(lockPath, 1, true);

    expect(lock).not.toBeNull();
    const record = readRecord(lockPath);
    if (isWin) {
      expect(record.version).toBe(2);
      expect(record.processStart.startsWith(START_BOUND_PREFIX)).toBe(true);
    } else {
      expect(record.version).toBe(1);
    }
    // Re-entering as a contender adjudicates this process's own record without a probe either.
    expect(releaseStateFileLockSync(lock)).toBe(true);
    expect(spawnCalls.filter(command => /powershell/i.test(command))).toEqual([]);
  });

  it.runIf(isWin)('records a bound that an exact foreign-style probe of this pid proves live', () => {
    const lockPath = join(stateDir, 'self-bound.lock');
    const lock = acquireStateFileLockAtPathSync(lockPath, 1, true);
    expect(lock).not.toBeNull();
    const record = readRecord(lockPath);
    releaseStateFileLockSync(lock);

    const exact = processStartIdentity(process.pid, 15_000);
    expect(exact).toMatch(/^ticks:\d+$/);
    expect(startIdentityMatches(record.processStart, exact)).toBe(true);
    expect(tsStartIdentityMatches(record.processStart, exact)).toBe(true);
    // The bound sits within a few seconds of the true creation time, not arbitrarily late.
    const slackTicks = BigInt(record.processStart.slice(START_BOUND_PREFIX.length)) - BigInt(exact.slice('ticks:'.length));
    expect(slackTicks).toBeGreaterThanOrEqual(0n);
    expect(slackTicks).toBeLessThan(300_000_000n);
  }, 30_000);
});

describe('foreign adjudication of a bound owner record', () => {
  it('reads a later process reusing the pid as dead and the owner itself as live', () => {
    const bound = `${START_BOUND_PREFIX}639296028002683759`;
    expect(startIdentityMatches(bound, 'ticks:639296028002683759')).toBe(true);
    expect(startIdentityMatches(bound, 'ticks:639296028002000000')).toBe(true);
    expect(startIdentityMatches(bound, 'ticks:639296028002683760')).toBe(false);
    expect(startIdentityMatches(bound, '12345')).toBeNull();
    expect(startIdentityMatches('ticks:5', 'ticks:5')).toBe(true);
    expect(startIdentityMatches('ticks:5', 'ticks:4')).toBe(false);
    for (const [recorded, current] of [[bound, 'ticks:639296028002683759'], [bound, 'ticks:639296028002683760'], [bound, 'x'], ['ticks:5', 'ticks:4']]) {
      expect(tsStartIdentityMatches(recorded, current)).toBe(startIdentityMatches(recorded, current));
    }
  });

  it('keeps a live bound owner and reclaims one whose pid was reused', () => {
    const ownerPid = 2_000_000_003;
    const boundTicks = 639296028002683759n;
    const seed = (lockPath: string) => writeFileSync(lockPath, JSON.stringify({
      version: 2, pid: ownerPid, processStart: `${START_BOUND_PREFIX}${boundTicks}`, createdAt: new Date().toISOString(), nonce: randomUUID(),
    }));
    const hooks = (ownerTicks: bigint) => ({
      nowMs: () => Date.now(),
      processStartIdentity: (pid: number) => (pid === process.pid ? 'self-start' : `ticks:${ownerTicks}`),
    });
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

    const liveLock = join(stateDir, 'bound-live.lock');
    seed(liveLock);
    expect(acquireStateFileLockAtPathSync(liveLock, 1, true, false, 2000, 3000, Infinity, hooks(boundTicks - 5_000_000n))).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');

    const reusedLock = join(stateDir, 'bound-reused.lock');
    seed(reusedLock);
    const lock = acquireStateFileLockAtPathSync(reusedLock, 1, true, false, 2000, 3000, Infinity, hooks(boundTicks + 1n));
    expect(lock).not.toBeNull();
    expect(readRecord(reusedLock).pid).toBe(process.pid);
    releaseStateFileLockSync(lock);
  });

  it('holds off a contender while the owning process lives and yields once it exits', async () => {
    const target = join(stateDir, 'cross-process.json');
    const { child, record } = await holdLockInChild(target);
    expect(record.pid).toBe(child.pid);
    if (isWin) expect(record.version).toBe(2);

    // Foreign-style: this process probes the child's pid exactly (PowerShell on win32).
    expect(acquireStateFileLockSync(target, 1, true, false, 2000, 15_000)).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');
    // The TS twin reads the hook copy's record as a live owner, not as malformed metadata.
    expect(withStateFileMutationLock(target, () => 'ran').acquired).toBe(false);

    await stop(child);
    const lock = acquireStateFileLockSync(target, 5, true, false, 2000, 15_000);
    expect(lock).not.toBeNull();
    expect(readRecord(`${target}.mutation.lock`).pid).toBe(process.pid);
    expect(releaseStateFileLockSync(lock)).toBe(true);
  }, 90_000);
  it('rejects a version 1 record that carries a bound as malformed in both twins', () => {
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const target = join(stateDir, 'v1-bound.json');
    writeFileSync(`${target}.mutation.lock`, JSON.stringify({
      version: 1, pid: 2_000_000_005, processStart: `${START_BOUND_PREFIX}639296028002683759`, createdAt: new Date().toISOString(), nonce: randomUUID(),
    }));

    expect(acquireStateFileLockSync(target, 1, true)).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('unverifiable');
    expect(getStateFileLockFailureReason()).toBe('malformed-owner');
    expect(withStateFileMutationLock(target, () => 'ran').acquired).toBe(false);
  });

  it('judges a record the TS twin wrote: live while its owner runs, dead once it exits', async () => {
    const target = join(stateDir, 'ts-owner.json');
    const releaseFlag = join(tmpRoot, `release-${randomUUID()}`);
    const holder = await holdTsLockInChild(target, releaseFlag, 'release');
    const record = readRecord(`${target}.mutation.lock`);
    expect(record.pid).toBe(holder.pid);
    if (isWin) expect(record.version).toBe(2);
    expect(acquireStateFileLockSync(target, 1, true, false, 2000, 15_000)).toBeNull();
    expect(getStateFileLockFailureKind()).toBe('contention');
    const released = new Promise<void>(resolve => holder.once('exit', () => resolve()));
    writeFileSync(releaseFlag, '');
    await released;

    // An owner that dies holding the lock leaves its record behind; the hook copy reclaims it.
    const crashed = join(stateDir, 'ts-owner-crashed.json');
    const dead = await holdTsLockInChild(crashed, releaseFlag, 'exit');
    if (dead.exitCode === null) await new Promise<void>(resolve => dead.once('exit', () => resolve()));
    expect(existsSync(`${crashed}.mutation.lock`)).toBe(true);
    expect(readRecord(`${crashed}.mutation.lock`).pid).toBe(dead.pid);
    const lock = acquireStateFileLockSync(crashed, 5, true, false, 2000, 15_000);
    expect(lock).not.toBeNull();
    expect(readRecord(`${crashed}.mutation.lock`).pid).toBe(process.pid);
    expect(releaseStateFileLockSync(lock)).toBe(true);
  }, 90_000);
});
