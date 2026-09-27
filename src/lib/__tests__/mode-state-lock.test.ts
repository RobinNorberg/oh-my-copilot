import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProcessStartIdentitySync } from '../../platform/process-utils.js';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const fsControl = vi.hoisted(() => ({
  racePath: undefined as string | undefined,
  replacement: undefined as Record<string, unknown> | undefined,
  injected: false,
  renamed: [] as string[],
}));

// Liveness probes run through spawnSync (win32 PowerShell, darwin ps) or /proc reads (linux).
const probeControl = vi.hoisted(() => ({
  calls: [] as string[],
  onProbe: undefined as undefined | ((call: string) => void),
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      fsControl.renamed.push(from);
      actual.renameSync(from, to);
      if (from === fsControl.racePath && !fsControl.injected && fsControl.replacement) {
        fsControl.injected = true;
        actual.writeFileSync(from, JSON.stringify(fsControl.replacement));
      }
    },
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) => {
      if (typeof path === 'string' && /^\/proc\/\d+\/stat$/.test(path)) {
        probeControl.calls.push(path);
        probeControl.onProbe?.(path);
      }
      return actual.readFileSync(path, options);
    }) as typeof actual.readFileSync,
  };
});

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], options?: object) => {
      const call = [command, ...(args ?? [])].join(' ');
      probeControl.calls.push(call);
      probeControl.onProbe?.(call);
      return actual.spawnSync(command, args ?? [], options ?? {});
    }) as typeof actual.spawnSync,
  };
});

import { getStateMutationLockFailureMessage, withStateFileMutationLock } from '../mode-state-io.js';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as hookLock from '../../../scripts/lib/state-lock.mjs';

const require = createRequire(import.meta.url);
const directories: string[] = [];
const children: ChildProcess[] = [];

function processStart(): string {
  const identity = getProcessStartIdentitySync(process.pid);
  if (identity === null) throw new Error('current process identity unavailable');
  return identity;
}

function owner(pid: number, processStart: string): Record<string, unknown> {
  return {
    version: 1,
    pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
}

function fixture(prefix: string): { directory: string; statePath: string; lockPath: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const statePath = join(directory, 'state.json');
  return { directory, statePath, lockPath: `${statePath}.mutation.lock` };
}

function probesMatch(call: string, pid: number): boolean {
  return new RegExp(`(-Id ${pid}\\b|-p ${pid}\\b|^/proc/${pid}/stat$)`).test(call);
}

function probesFor(pid: number): number {
  return probeControl.calls.filter(call => probesMatch(call, pid)).length;
}

async function liveForeignOwner(): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  const pid = child.pid!;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const identity = getProcessStartIdentitySync(pid);
    if (identity !== null) return owner(pid, identity);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('live child identity unavailable');
}

function seedRow(lockPath: string, seeded: Record<string, unknown>): void {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(join(dirname(lockPath), '.state-mutation-locks.db'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
    db.prepare('INSERT INTO state_mutation_locks (lock_key, version, pid, process_start, created_at, nonce) VALUES (?, 1, ?, ?, ?, ?)')
      .run(resolve(realpathSync(dirname(lockPath)), basename(lockPath)), seeded.pid, seeded.processStart, seeded.createdAt, seeded.nonce);
  } finally {
    db.close();
  }
}

type Backend = 'ts-sqlite' | 'ts-file' | 'mjs-sqlite' | 'mjs-file';

function useBackend(backend: Backend): void {
  process.env.NODE_ENV = 'test';
  if (backend === 'ts-file') process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE = '1';
  if (backend === 'mjs-file') process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
}

function acquireOnce(backend: Backend, statePath: string): boolean {
  if (backend.startsWith('ts-')) return withStateFileMutationLock(statePath, () => true).acquired;
  const lock = hookLock.acquireStateFileLockSync(statePath, 50, true);
  if (!lock) return false;
  hookLock.releaseStateFileLockSync(lock);
  return true;
}

afterEach(() => {
  fsControl.racePath = undefined;
  fsControl.replacement = undefined;
  fsControl.injected = false;
  fsControl.renamed = [];
  probeControl.calls = [];
  probeControl.onProbe = undefined;
  delete process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE;
  delete process.env.OMC_TEST_FLOCK_AVAILABLE;
  for (const child of children.splice(0)) child.kill();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('state mutation lock fallback', () => {
  it('does not delete a replacement owner observed during stale reclamation', () => {
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE = '1';
    const { directory, statePath, lockPath } = fixture('mode-state-lock-race-');
    mkdirSync(directory, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner(999999999, '1')));
    fsControl.racePath = lockPath;
    fsControl.replacement = owner(process.pid, processStart());

    const result = withStateFileMutationLock(statePath, () => 'held');

    expect(fsControl.injected).toBe(true);
    expect(result).toEqual({ acquired: false, value: undefined });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(fsControl.replacement);
    expect(getStateMutationLockFailureMessage()).toContain('contention');
  });
});

// Fork fix coverage: each of these fails against the upstream lock implementation.
describe.each<Backend>(['ts-sqlite', 'ts-file', 'mjs-sqlite', 'mjs-file'])('state mutation lock fork fixes (%s)', backend => {
  it('probes a live foreign artifact owner at most once per acquire', async () => {
    const { statePath, lockPath } = fixture('mode-state-lock-probe-');
    const live = await liveForeignOwner();
    writeFileSync(lockPath, JSON.stringify(live));
    useBackend(backend);
    probeControl.calls = [];

    expect(acquireOnce(backend, statePath)).toBe(false);
    expect(probesFor(live.pid as number)).toBe(1);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(live);
  }, 60_000);

  it('never renames an owner artifact replaced while the dead owner was being probed', () => {
    const { statePath, lockPath } = fixture('mode-state-lock-swap-');
    const dead = owner(999999999, '1');
    const replacement = owner(process.pid, processStart());
    writeFileSync(lockPath, JSON.stringify(dead));
    useBackend(backend);
    let swapped = false;
    probeControl.onProbe = call => {
      if (swapped || !probesMatch(call, 999999999)) return;
      swapped = true;
      unlinkSync(lockPath);
      writeFileSync(lockPath, JSON.stringify(replacement));
    };

    expect(acquireOnce(backend, statePath)).toBe(false);
    expect(swapped).toBe(true);
    expect(fsControl.renamed).not.toContain(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  }, 60_000);

  it('reclaims a lock whose pid is live but whose processStart differs', () => {
    const { statePath, lockPath } = fixture('mode-state-lock-recycled-');
    writeFileSync(lockPath, JSON.stringify({ ...owner(process.pid, '1'), createdAt: new Date(Date.now() - 3_600_000).toISOString() }));
    useBackend(backend);

    expect(acquireOnce(backend, statePath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe.each<Backend>(['ts-sqlite', 'mjs-sqlite'])('SQLite lock rows (%s)', backend => {
  it('probes a live foreign row owner at most once per acquire', async () => {
    const { statePath, lockPath } = fixture('mode-state-lock-row-probe-');
    const live = await liveForeignOwner();
    seedRow(lockPath, live);
    useBackend(backend);
    probeControl.calls = [];

    expect(acquireOnce(backend, statePath)).toBe(false);
    expect(probesFor(live.pid as number)).toBe(1);
  }, 60_000);
});

describe('SQLite release (TypeScript backend)', () => {
  it('releases a lock whose artifact already disappeared without stranding its row', () => {
    const { statePath, lockPath } = fixture('mode-state-lock-absent-');
    process.env.NODE_ENV = 'test';

    expect(withStateFileMutationLock(statePath, () => { unlinkSync(lockPath); return 'held'; }))
      .toEqual({ acquired: true, value: 'held' });
    expect(withStateFileMutationLock(statePath, () => 'again')).toEqual({ acquired: true, value: 'again' });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('retries a release that meets SQLITE_BUSY instead of stranding the row', async () => {
    const { directory, statePath, lockPath } = fixture('mode-state-lock-busy-');
    process.env.NODE_ENV = 'test';
    const marker = join(directory, 'holder.ready');
    const holderScript = `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2]);
      db.pragma('busy_timeout = 10000');
      db.exec('BEGIN IMMEDIATE');
      require('fs').writeFileSync(process.argv[3], '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      db.exec('COMMIT');
      db.close();
    `;
    let holder: ChildProcess | undefined;

    const result = withStateFileMutationLock(statePath, () => {
      holder = spawn(process.execPath, ['-e', holderScript, require.resolve('better-sqlite3'), join(directory, '.state-mutation-locks.db'), marker], { stdio: 'ignore' });
      const deadline = Date.now() + 20_000;
      while (!existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return existsSync(marker);
    });
    await new Promise(done => holder?.once('exit', done));

    expect(result).toEqual({ acquired: true, value: true });
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);
});
