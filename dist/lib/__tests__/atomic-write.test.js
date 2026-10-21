import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { getProcessStartIdentitySync } from '../../platform/process-utils.js';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { acquireStateFileLockAtPathSync, acquireStateFileLockSync, getStateFileLockFailureKind, isExclusiveStateLockingAvailable, isStateFileLockingSupported, releaseStateFileLockSync, withStateFileLockAtPathSync, withStateFileLockSync } from '../../../scripts/lib/atomic-write.mjs';
import { tmpdir } from 'os';
const __dirname = dirname(fileURLToPath(import.meta.url));
const fsPromisesControl = vi.hoisted(() => ({
    renameHook: undefined,
    openHook: undefined,
    writeHook: undefined,
}));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        rename: async (from, to) => {
            await fsPromisesControl.renameHook?.(from, to);
            await actual.rename(from, to);
        },
        open: async (filePath, flags, mode) => {
            await fsPromisesControl.openHook?.();
            const fd = await actual.open(filePath, flags, mode);
            fsPromisesControl.writeHook?.(fd);
            return fd;
        },
    };
});
import { atomicWriteBatchSync, atomicWriteFileSync, atomicWriteJson, fileIdentityOf, sameFileIdentity, } from '../atomic-write.js';
// SQLite's busy handler sums the sleeps it requests (about 75 ms of them here)
// instead of watching a clock, so a loaded or virtualized runner stretches the
// real wait: macOS CI runners were observed at 533 and 575 ms for 75 ms. The
// ceiling stays well under the 2000 ms default busy timeout, so a lock call
// that ignores the caller's value still fails, while the floor proves the
// caller's value was waited on at all.
const SQLITE_CONTENTION_BUSY_TIMEOUT_MS = 75;
const SQLITE_CONTENTION_MIN_WAIT_MS = 50;
const SQLITE_CONTENTION_RUNNER_MARGIN_MS = 1000;
function deferred() {
    let resolve;
    return { promise: new Promise(done => { resolve = done; }), resolve };
}
describe('atomicWriteJson', () => {
    const directories = [];
    afterEach(() => {
        fsPromisesControl.renameHook = undefined;
        fsPromisesControl.openHook = undefined;
        fsPromisesControl.writeHook = undefined;
        delete process.env.OMC_TEST_FLOCK_AVAILABLE;
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });
    it('publishes only complete JSON while rename is pending', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const oldValue = { status: 'old' };
        const nextValue = { status: 'new', items: ['complete'] };
        const renameEntered = deferred();
        const releaseRename = deferred();
        writeFileSync(filePath, JSON.stringify(oldValue));
        fsPromisesControl.renameHook = async (_from, to) => {
            if (to === filePath) {
                renameEntered.resolve();
                await releaseRename.promise;
            }
        };
        const writer = atomicWriteJson(filePath, nextValue);
        try {
            await renameEntered.promise;
            expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
        }
        finally {
            releaseRename.resolve();
        }
        await writer;
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(nextValue);
    });
    it('completes short writes before renaming the JSON payload', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-short-write-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const nextValue = { status: 'new', items: ['complete', 'utf8-✓'] };
        const expectedContent = JSON.stringify(nextValue, null, 2);
        const writeOffsets = [];
        fsPromisesControl.writeHook = fd => {
            const originalWrite = fd.write.bind(fd);
            Object.defineProperty(fd, 'write', {
                value: async (buffer, offset, length, position) => {
                    writeOffsets.push(offset);
                    return originalWrite(buffer, offset, Math.min(length, 3), position);
                },
            });
        };
        fsPromisesControl.renameHook = async (from, to) => {
            if (to === filePath) {
                expect(readFileSync(from)).toEqual(Buffer.from(expectedContent, 'utf8'));
            }
        };
        await atomicWriteJson(filePath, nextValue);
        expect(writeOffsets).toEqual(Array.from({ length: Math.ceil(Buffer.byteLength(expectedContent) / 3) }, (_, index) => index * 3));
        expect(readFileSync(filePath, 'utf8')).toBe(expectedContent);
    });
    it('rejects zero-byte write progress, preserves the old target, and removes the temp file', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-zero-progress-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const oldValue = { status: 'old' };
        writeFileSync(filePath, JSON.stringify(oldValue));
        fsPromisesControl.writeHook = fd => {
            Object.defineProperty(fd, 'write', {
                value: async (buffer) => ({ bytesWritten: 0, buffer }),
            });
        };
        await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toThrow('Failed to write complete JSON payload');
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
        expect(readdirSync(directory)).toEqual(['state.json']);
    });
    it('propagates FileHandle write failures, preserves the old target, and removes the temp file', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-write-error-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const oldValue = { status: 'old' };
        const failure = new Error('temp write failed');
        writeFileSync(filePath, JSON.stringify(oldValue));
        fsPromisesControl.writeHook = fd => {
            Object.defineProperty(fd, 'write', {
                value: async () => { throw failure; },
            });
        };
        await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toBe(failure);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
        expect(readdirSync(directory)).toEqual(['state.json']);
    });
    it('creates missing parents and publishes owner-only replacement files', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-parent-'));
        directories.push(directory);
        const filePath = join(directory, 'nested', 'state.json');
        await atomicWriteJson(filePath, { status: 'new' });
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ status: 'new' });
        expect(statSync(filePath).mode & 0o777).toBe(0o600);
    });
    it('publishes a normal atomic write under Windows stat semantics', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-win32-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
        try {
            await atomicWriteJson(filePath, { status: 'new' });
        }
        finally {
            Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
        }
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ status: 'new' });
    });
    it.each(['hardlink', 'special', 'replacement', 'permissions'])('rejects an untrusted temporary generation (%s) before rename', async (kind) => {
        const directory = mkdtempSync(join(tmpdir(), `atomic-write-${kind}-`));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const oldValue = { status: 'old' };
        writeFileSync(filePath, JSON.stringify(oldValue));
        let extraPath;
        fsPromisesControl.writeHook = () => {
            const tempName = readdirSync(directory).find(name => name.startsWith('.state.json.tmp.'));
            if (!tempName)
                throw new Error('atomic temp generation unavailable');
            const tempPath = join(directory, tempName);
            if (kind === 'hardlink') {
                extraPath = `${tempPath}.link`;
                linkSync(tempPath, extraPath);
            }
            else if (kind === 'special') {
                unlinkSync(tempPath);
                mkdirSync(tempPath);
            }
            else if (kind === 'replacement') {
                unlinkSync(tempPath);
                writeFileSync(tempPath, 'attacker replacement');
            }
            else {
                chmodSync(tempPath, 0o644);
            }
        };
        await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toThrow(/private regular single-link|replaced before rename/);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
        if (extraPath !== undefined)
            rmSync(extraPath, { force: true });
    });
    it('rejects a temp replacement at rename without overwriting the foreign target', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-publication-race-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const oldValue = { status: 'old' };
        writeFileSync(filePath, JSON.stringify(oldValue));
        let raced = false;
        fsPromisesControl.renameHook = async (from) => {
            if (raced)
                return;
            raced = true;
            unlinkSync(from.toString());
            writeFileSync(from.toString(), JSON.stringify({ status: 'attacker' }));
        };
        await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toThrow('target was replaced at publication');
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ status: 'attacker' });
        expect(readdirSync(directory)).toEqual(['state.json']);
    });
    it.each(['sync', 'batch'])('rolls back the prior target when %s publication loses its ownership hook', kind => {
        const directory = mkdtempSync(join(tmpdir(), `atomic-write-${kind}-boundary-`));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        writeFileSync(filePath, 'old', 'utf8');
        const hooks = { afterRename: () => { throw new Error('publication fenced'); } };
        if (kind === 'sync') {
            expect(() => atomicWriteFileSync(filePath, 'new', hooks)).toThrow('publication fenced');
        }
        else {
            expect(() => atomicWriteBatchSync([{ path: filePath, content: 'new' }], hooks)).toThrow('publication fenced');
        }
        expect(readFileSync(filePath, 'utf8')).toBe('old');
        expect(readdirSync(directory)).toEqual(['state.json']);
    });
    it('propagates temp write failures without publishing a target', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-write-error-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const failure = new Error('temp write failed');
        fsPromisesControl.openHook = async () => { throw failure; };
        await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toBe(failure);
        expect(existsSync(filePath)).toBe(false);
        expect(readdirSync(directory)).toEqual([]);
    });
    it('propagates rename failures, preserves the old target, and removes the temp file', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-error-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const oldValue = { status: 'old' };
        const failure = new Error('rename failed');
        writeFileSync(filePath, JSON.stringify(oldValue));
        fsPromisesControl.renameHook = async () => { throw failure; };
        await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toBe(failure);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
        expect(readdirSync(directory)).toEqual(['state.json']);
        expect(existsSync(filePath)).toBe(true);
    });
    it('reclaims stale generic lock artifacts under the SQLite guard', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const filePath = join(directory, 'state.json');
        writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));
        expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(`${filePath}.mutation.lock`)).toBe(false);
    });
    it('rejects a live lock artifact without an unlocked fallback', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-live-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const filePath = join(directory, 'state.json');
        const processStart = getProcessStartIdentitySync(process.pid);
        if (processStart === null)
            throw new Error('current process identity unavailable');
        writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() }));
        expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: false, value: undefined });
        expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
    });
    it('reclaims an exact-path lock whose PID has been reused', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-reused-pid-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const lockPath = join(directory, 'last-tool-error.json.lock');
        writeFileSync(lockPath, JSON.stringify({
            version: 1,
            pid: process.pid,
            processStart: 'previous-process-start',
            createdAt: new Date().toISOString(),
            nonce: randomUUID(),
        }));
        expect(withStateFileLockAtPathSync(lockPath, () => 'written')).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(lockPath)).toBe(false);
    });
    it('reclaims a legacy lock when its PID now belongs to a later process', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-legacy-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const lockPath = join(directory, 'last-tool-error.json.lock');
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: 1 }));
        expect(withStateFileLockAtPathSync(lockPath, () => 'written')).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(lockPath)).toBe(false);
    });
    it.skipIf(process.platform !== 'linux' && process.platform !== 'win32')('rejects a PID reused shortly after a legacy lock timestamp', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-legacy-reused-pid-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const timestamp = Date.now() - 2200;
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        try {
            await new Promise((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
            });
            if (typeof child.pid !== 'number')
                throw new Error('reused PID test child did not receive a PID');
            const lockPath = join(directory, 'last-tool-error.json.lock');
            writeFileSync(lockPath, JSON.stringify({ pid: child.pid, timestamp }));
            expect(withStateFileLockAtPathSync(lockPath, () => 'written', false, 2)).toEqual({ acquired: true, value: 'written' });
            expect(existsSync(lockPath)).toBe(false);
        }
        finally {
            child.kill();
        }
    });
    it.skipIf(process.platform !== 'linux')('reclaims legacy locks when getconf is unavailable', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-no-getconf-'));
        directories.push(directory);
        const lockPath = join(directory, 'last-tool-error.json.lock');
        const stateLockUrl = pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'lib', 'state-lock.mjs')).href;
        const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      const { withStateFileLockAtPathSync } = await import(process.argv[1]);
      const lockPath = process.argv[2];
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: 1 }));
      const result = withStateFileLockAtPathSync(lockPath, () => 'written', false, 2);
      process.stdout.write(JSON.stringify({ result, lockExists: existsSync(lockPath) }));
    `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, stateLockUrl, lockPath], {
            encoding: 'utf8',
            env: { ...process.env, NODE_ENV: 'test', OMC_TEST_FLOCK_AVAILABLE: '0', PATH: '' },
        });
        expect(JSON.parse(output)).toEqual({ result: { acquired: true, value: 'written' }, lockExists: false });
    });
    it.skipIf(process.platform !== 'linux')('keeps live legacy owners stable across wall-clock corrections', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-clock-correction-'));
        directories.push(directory);
        const lockPath = join(directory, 'last-tool-error.json.lock');
        const stateLockUrl = pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'lib', 'state-lock.mjs')).href;
        const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      const lockPath = process.argv[2];
      const realNow = Date.now.bind(Date);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: realNow() }));
      Date.now = () => realNow() + 60_000;
      process.env.NODE_ENV = 'test';
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      const { withStateFileLockAtPathSync } = await import(process.argv[1]);
      const result = withStateFileLockAtPathSync(lockPath, () => 'written');
      process.stdout.write(JSON.stringify({ result, lockExists: existsSync(lockPath) }));
    `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, stateLockUrl, lockPath], {
            encoding: 'utf8',
            env: { ...process.env, NODE_ENV: 'test', OMC_TEST_FLOCK_AVAILABLE: '0' },
        });
        expect(JSON.parse(output)).toEqual({ result: { acquired: false }, lockExists: true });
    });
    it.skipIf(process.platform !== 'linux')('bounds Windows process-start probes by the supplied timeout', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-process-probe-timeout-'));
        directories.push(directory);
        const powershell = join(directory, 'powershell');
        const stateLockUrl = pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'lib', 'state-lock.mjs')).href;
        writeFileSync(powershell, '#!/bin/sh\nwhile :; do :; done\n');
        chmodSync(powershell, 0o755);
        const script = `
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const { processStartIdentity } = await import(process.argv[1]);
      const startedAt = Date.now();
      const identity = processStartIdentity(process.pid, 75);
      process.stdout.write(JSON.stringify({ identity, elapsedMs: Date.now() - startedAt }));
    `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, stateLockUrl], {
            encoding: 'utf8',
            env: { ...process.env, NODE_ENV: 'test', PATH: directory },
            timeout: 1000,
        });
        expect(JSON.parse(output)).toMatchObject({ identity: null });
        expect(JSON.parse(output).elapsedMs).toBeLessThan(500);
    });
    it.skipIf(process.platform !== 'linux')('shares one deadline across Windows lock-owner probes', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-shared-probe-deadline-'));
        directories.push(directory);
        const lockPath = join(directory, 'last-tool-error.json.lock');
        const stateLockUrl = pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'lib', 'state-lock.mjs')).href;
        writeFileSync(lockPath, JSON.stringify({
            version: 1,
            pid: process.pid,
            processStart: 'ticks:638933184000000001',
            createdAt: new Date().toISOString(),
            nonce: '123e4567-e89b-12d3-a456-426614174000',
        }));
        const script = `
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.NODE_ENV = 'test';
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      const { acquireStateFileLockAtPathSync, getStateFileLockFailureKind } = await import(process.argv[1]);
      let nowMs = 0;
      const probeTimeouts = [];
      const testHooks = {
        nowMs: () => nowMs,
        processStartIdentity(_pid, timeoutMs) {
          probeTimeouts.push(timeoutMs);
          if (probeTimeouts.length === 1) {
            nowMs += 250;
            return 'ticks:638933184000000001';
          }
          return timeoutMs >= 250 ? 'ticks:638933184000000001' : null;
        },
      };
      const lock = acquireStateFileLockAtPathSync(process.argv[2], 1, true, false, 300, 300, Infinity, testHooks);
      process.stdout.write(JSON.stringify({ lockAcquired: Boolean(lock), failure: getStateFileLockFailureKind(), probeTimeouts }));
    `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, stateLockUrl, lockPath], {
            encoding: 'utf8',
            env: { ...process.env, NODE_ENV: 'test' },
            timeout: 1500,
        });
        const result = JSON.parse(output);
        expect(result.lockAcquired).toBe(false);
        expect(result.failure).toBe('unverifiable');
        expect(result.probeTimeouts).toEqual([300, 50]);
    });
    it('bounds SQLite lock contention by the caller-provided busy timeout', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-sqlite-timeout-'));
        directories.push(directory);
        const stateDirectory = join(directory, 'state');
        mkdirSync(stateDirectory);
        const lockPath = join(stateDirectory, 'last-tool-error.json.lock');
        const databasePath = join(stateDirectory, '.state-mutation-locks.db');
        const script = `
      import Database from 'better-sqlite3';
      const database = new Database(process.argv[1]);
      database.pragma('journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      process.stdin.once('end', () => { database.exec('ROLLBACK'); database.close(); });
      process.stdin.resume();
    `;
        const holder = spawn(process.execPath, ['--input-type=module', '-e', script, databasePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let ready = false;
        const readyPromise = new Promise((resolve, reject) => {
            holder.stdout?.on('data', chunk => {
                if (String(chunk).includes('locked')) {
                    ready = true;
                    resolve();
                }
            });
            holder.stderr?.on('data', chunk => {
                if (!ready)
                    reject(new Error(String(chunk)));
            });
            holder.once('error', reject);
            holder.once('exit', code => {
                if (!ready)
                    reject(new Error(`SQLite lock holder exited before acquiring its transaction (${code})`));
            });
        });
        try {
            await readyPromise;
            const startedAt = performance.now();
            const lock = acquireStateFileLockAtPathSync(lockPath, 1, true, false, SQLITE_CONTENTION_BUSY_TIMEOUT_MS);
            const elapsedMs = performance.now() - startedAt;
            expect(lock).toBeNull();
            expect(elapsedMs).toBeGreaterThanOrEqual(SQLITE_CONTENTION_MIN_WAIT_MS);
            expect(elapsedMs).toBeLessThan(SQLITE_CONTENTION_BUSY_TIMEOUT_MS + SQLITE_CONTENTION_RUNNER_MARGIN_MS);
            expect(getStateFileLockFailureKind()).toBe('contention');
        }
        finally {
            holder.stdin?.end();
            if (holder.exitCode === null && holder.signalCode === null) {
                await new Promise(resolve => holder.once('exit', () => resolve()));
            }
        }
    });
    it('recovers SQLite lock release after contention', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-release-contention-'));
        directories.push(directory);
        const stateDirectory = join(directory, 'state');
        mkdirSync(stateDirectory);
        const lockPath = join(stateDirectory, 'last-tool-error.json.lock');
        const contendedLockPath = join(stateDirectory, 'other-state.json.lock');
        const databasePath = join(stateDirectory, '.state-mutation-locks.db');
        const heldLock = acquireStateFileLockAtPathSync(lockPath, 1, true, false, 75);
        expect(heldLock).not.toBeNull();
        const script = `
      import Database from 'better-sqlite3';
      const database = new Database(process.argv[1]);
      database.pragma('journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      process.stdin.once('end', () => { database.exec('ROLLBACK'); database.close(); });
      process.stdin.resume();
    `;
        const holder = spawn(process.execPath, ['--input-type=module', '-e', script, databasePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let releaseAttempted = false;
        let ready = false;
        const readyPromise = new Promise((resolve, reject) => {
            holder.stdout?.on('data', chunk => {
                if (String(chunk).includes('locked')) {
                    ready = true;
                    resolve();
                }
            });
            holder.stderr?.on('data', chunk => {
                if (!ready)
                    reject(new Error(String(chunk)));
            });
            holder.once('error', reject);
            holder.once('exit', code => {
                if (!ready)
                    reject(new Error(`SQLite lock holder exited before acquiring its transaction (${code})`));
            });
        });
        try {
            await readyPromise;
            const startedAt = performance.now();
            const lock = acquireStateFileLockAtPathSync(contendedLockPath, 1, true, false, SQLITE_CONTENTION_BUSY_TIMEOUT_MS);
            const elapsedMs = performance.now() - startedAt;
            expect(lock).toBeNull();
            expect(elapsedMs).toBeGreaterThanOrEqual(SQLITE_CONTENTION_MIN_WAIT_MS);
            expect(elapsedMs).toBeLessThan(SQLITE_CONTENTION_BUSY_TIMEOUT_MS + SQLITE_CONTENTION_RUNNER_MARGIN_MS);
            expect(getStateFileLockFailureKind()).toBe('contention');
            releaseAttempted = true;
            expect(releaseStateFileLockSync(heldLock)).toBe(false);
            expect(existsSync(lockPath)).toBe(true);
        }
        finally {
            holder.stdin?.end();
            if (holder.exitCode === null && holder.signalCode === null) {
                await new Promise(resolve => holder.once('exit', () => resolve()));
            }
            if (existsSync(lockPath)) {
                if (releaseAttempted) {
                    const recoveredLock = acquireStateFileLockAtPathSync(lockPath, 1, true, false, 75);
                    if (recoveredLock)
                        releaseStateFileLockSync(recoveredLock);
                }
                else {
                    releaseStateFileLockSync(heldLock);
                }
            }
        }
        const recoveredLock = acquireStateFileLockAtPathSync(lockPath, 1, true, false, 75);
        expect(recoveredLock).not.toBeNull();
        expect(releaseStateFileLockSync(recoveredLock)).toBe(true);
        expect(existsSync(lockPath)).toBe(false);
    });
    it.skipIf(process.platform !== 'linux')('shares the operation deadline with SQLite lock release', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-shared-deadline-'));
        directories.push(directory);
        const stateDirectory = join(directory, 'state');
        mkdirSync(stateDirectory);
        const lockPath = join(stateDirectory, 'last-tool-error.json.lock');
        const databasePath = join(stateDirectory, '.state-mutation-locks.db');
        const markerPath = join(directory, 'writer-locked');
        const holderScript = `
      import Database from 'better-sqlite3';
      import { writeFileSync } from 'node:fs';
      const database = new Database(process.argv[1]);
      database.pragma('journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
      database.exec('BEGIN IMMEDIATE');
      writeFileSync(process.argv[2], 'locked');
      setTimeout(() => {
        database.exec('ROLLBACK');
        database.close();
      }, 900);
    `;
        let holder;
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        try {
            const startedAt = Date.now();
            const result = withStateFileLockAtPathSync(lockPath, () => {
                holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript, databasePath, markerPath], {
                    stdio: ['ignore', 'ignore', 'ignore'],
                });
                const waitDeadline = Date.now() + 1000;
                while (!existsSync(markerPath) && Date.now() < waitDeadline) {
                    Atomics.wait(waitCell, 0, 0, 5);
                }
                expect(existsSync(markerPath)).toBe(true);
                return 'written';
            }, false, 1, 1000, 1000, 300);
            const elapsedMs = Date.now() - startedAt;
            expect(result).toEqual({ acquired: false, value: undefined, callbackRan: true });
            expect(getStateFileLockFailureKind()).toBe('contention');
            expect(existsSync(lockPath)).toBe(true);
            expect(elapsedMs).toBeLessThan(600);
        }
        finally {
            if (holder && holder.exitCode === null && holder.signalCode === null) {
                await new Promise(resolve => holder?.once('exit', () => resolve()));
            }
            if (existsSync(lockPath)) {
                const retainedLock = acquireStateFileLockAtPathSync(lockPath, 1, true, false, 100);
                if (retainedLock)
                    releaseStateFileLockSync(retainedLock);
            }
        }
    });
    it('keeps a live legacy owner lock after thirty seconds', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-legacy-live-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const lockPath = join(directory, 'last-tool-error.json.lock');
        const timestamp = Date.now() + 10_000;
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp }));
        vi.useFakeTimers();
        vi.setSystemTime(timestamp + 31_000);
        try {
            expect(withStateFileLockAtPathSync(lockPath, () => 'must not run', false, 1)).toEqual({ acquired: false, value: undefined });
            expect(getStateFileLockFailureKind()).toBe('contention');
            expect(existsSync(lockPath)).toBe(true);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('reports malformed exact-path lock metadata as unverifiable', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-malformed-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const lockPath = join(directory, 'last-tool-error.json.lock');
        writeFileSync(lockPath, 'not-json');
        expect(withStateFileLockAtPathSync(lockPath, () => 'must not run')).toEqual({ acquired: false, value: undefined });
        expect(getStateFileLockFailureKind()).toBe('unverifiable');
        expect(existsSync(lockPath)).toBe(true);
    });
    it('marks a callback as already run when lock release fails', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-release-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const lockPath = join(directory, 'last-tool-error.json.lock');
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        let callbackCalls = 0;
        try {
            const result = withStateFileLockAtPathSync(lockPath, () => {
                callbackCalls += 1;
                writeFileSync(lockPath, JSON.stringify({
                    version: 1,
                    pid: process.pid,
                    processStart: 'replacement-owner',
                    createdAt: new Date().toISOString(),
                    nonce: randomUUID(),
                }));
            });
            expect(result).toEqual({ acquired: false, value: undefined, callbackRan: true });
            expect(callbackCalls).toBe(1);
            expect(getStateFileLockFailureKind()).toBe('unverifiable');
        }
        finally {
            errorSpy.mockRestore();
        }
    });
});
// Upstream v5.4.0 replaced the flock / portable-lockfile backends with a platform-independent
// SQLite lock (scripts/lib/state-lock.mjs), so these fork tests now pin the SQLite semantics.
describe('state file locking without flock', () => {
    const directories = [];
    afterEach(() => {
        delete process.env.OMC_TEST_FLOCK_AVAILABLE;
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });
    // Upstream v5.5.0: the owner-file fallback is a real exclusive backend, so locking stays
    // supported under the simulation; only exclusive availability reports the simulated loss.
    it('reports locking as supported and unsupported only when locking is disabled', () => {
        process.env.NODE_ENV = 'test';
        expect(isStateFileLockingSupported()).toBe(true);
        expect(isExclusiveStateLockingAvailable()).toBe(true);
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        expect(isStateFileLockingSupported()).toBe(true);
        expect(isExclusiveStateLockingAvailable()).toBe(false);
    });
    it('publishes the lock while held, re-enters it in-process, and releases it cleanly', () => {
        const directory = mkdtempSync(join(tmpdir(), 'state-lock-hold-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        const held = acquireStateFileLockSync(filePath, 5, true);
        expect(held).not.toBeNull();
        expect(existsSync(lockPath)).toBe(true);
        const nested = acquireStateFileLockSync(filePath, 5, true);
        expect(nested).toBe(held);
        releaseStateFileLockSync(nested);
        expect(existsSync(lockPath)).toBe(true);
        releaseStateFileLockSync(held);
        expect(existsSync(lockPath)).toBe(false);
    });
    it('reclaims a lock left behind by a dead owner', () => {
        const directory = mkdtempSync(join(tmpdir(), 'state-lock-stale-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));
        expect(withStateFileLockSync(filePath, () => 'written', true)).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(lockPath)).toBe(false);
    });
    // Fork fix: an already-absent artifact must not strand the row this process still owns.
    it('releases a SQLite lock whose artifact already disappeared without stranding its row', () => {
        const directory = mkdtempSync(join(tmpdir(), 'state-lock-absent-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        const held = acquireStateFileLockSync(filePath, 5, true);
        expect(held?.backend).toBe('sqlite');
        unlinkSync(lockPath);
        expect(releaseStateFileLockSync(held)).toBe(true);
        const next = acquireStateFileLockSync(filePath, 1, true);
        expect(next).not.toBeNull();
        expect(releaseStateFileLockSync(next)).toBe(true);
        expect(existsSync(lockPath)).toBe(false);
    });
    // Fork fix: SQLITE_BUSY on release is transient contention, not a reason to strand the row.
    it('retries a SQLite release that meets SQLITE_BUSY', () => {
        const directory = mkdtempSync(join(tmpdir(), 'state-lock-busy-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        const held = acquireStateFileLockSync(filePath, 5, true);
        expect(held?.backend).toBe('sqlite');
        const exec = held.db.exec.bind(held.db);
        let injected = false;
        held.db.exec = (sql) => {
            if (sql === 'BEGIN IMMEDIATE' && !injected) {
                injected = true;
                throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
            }
            return exec(sql);
        };
        expect(releaseStateFileLockSync(held)).toBe(true);
        expect(injected).toBe(true);
        expect(existsSync(lockPath)).toBe(false);
    });
    it('refuses to claim exclusivity over an unreadable lock artifact', () => {
        const directory = mkdtempSync(join(tmpdir(), 'state-lock-corrupt-'));
        directories.push(directory);
        const filePath = join(directory, 'state.json');
        writeFileSync(`${filePath}.mutation.lock`, 'not a lock owner');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
        try {
            expect(withStateFileLockSync(filePath, () => 'written', true)).toEqual({ acquired: false, value: undefined });
            expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
        }
        finally {
            errors.mockRestore();
        }
    });
    // Fork fix: cover both backends; '0' forces the owner-file fallback, '1' keeps SQLite.
    it.each(['0', '1'])('serializes concurrent processes so no counter increment is lost (OMC_TEST_FLOCK_AVAILABLE=%s)', async (flock) => {
        const directory = mkdtempSync(join(tmpdir(), 'state-lock-concurrent-'));
        directories.push(directory);
        const counterPath = join(directory, 'counter.json');
        writeFileSync(counterPath, JSON.stringify({ value: 0 }));
        const childPath = join(directory, 'child.mjs');
        const modulePath = pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'lib', 'atomic-write.mjs')).href;
        writeFileSync(childPath, `
import { readFileSync, writeFileSync } from 'fs';
import { withStateFileLockSync } from ${JSON.stringify(modulePath)};
const counterPath = process.argv[2];
let acquired = 0;
for (let round = 0; round < 40; round += 1) {
  const result = withStateFileLockSync(counterPath, () => {
    const observed = JSON.parse(readFileSync(counterPath, 'utf8')).value;
    for (let spin = 0; spin < 100000; spin += 1) { /* widen the critical section */ }
    writeFileSync(counterPath, JSON.stringify({ value: observed + 1 }));
  }, true);
  if (result.acquired) acquired += 1;
}
process.stdout.write(String(acquired));
`);
        const acquisitions = await Promise.all([0, 1, 2].map(() => new Promise(resolve => {
            const child = spawn(process.execPath, [childPath, counterPath], {
                env: { ...process.env, NODE_ENV: 'test', OMC_TEST_FLOCK_AVAILABLE: flock },
            });
            let output = '';
            child.stdout.on('data', chunk => { output += String(chunk); });
            child.on('close', () => resolve(Number(output)));
        })));
        const total = acquisitions.reduce((sum, value) => sum + value, 0);
        expect(total).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(counterPath, 'utf8')).value).toBe(total);
    }, 120_000);
});
describe('sameFileIdentity (BigInt file ids)', () => {
    // Real NTFS file ids observed on one volume: sequence 75, MFT index 0x...06 and
    // 0x...08. Both round to the same Number, so a Number comparison merges them.
    const dev = 312828405n;
    const low = 21110623256064774n;
    const high = 21110623256064776n;
    it('keeps ids beyond 2^53 that differ only in their low bits distinct', () => {
        expect(Number(low)).toBe(Number(high));
        expect(sameFileIdentity({ dev, ino: low }, { dev, ino: high })).toBe(false);
    });
    it('matches equal ids beyond 2^53', () => {
        expect(sameFileIdentity({ dev, ino: high }, { dev, ino: high })).toBe(true);
    });
    it('normalizes Number and BigInt stats without losing exact ids', () => {
        expect(fileIdentityOf({ dev: 7, ino: 9 })).toEqual({ dev: 7n, ino: 9n });
        expect(fileIdentityOf({ dev, ino: low })).toEqual({ dev, ino: low });
    });
    it('keeps the #4156 zero-dev tolerance on win32 only', () => {
        const originalPlatform = process.platform;
        try {
            Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
            expect(sameFileIdentity({ dev: 0n, ino: high }, { dev, ino: high })).toBe(true);
            expect(sameFileIdentity({ dev: 0n, ino: low }, { dev, ino: high })).toBe(false);
            Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
            expect(sameFileIdentity({ dev: 0n, ino: high }, { dev, ino: high })).toBe(false);
        }
        finally {
            Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
        }
    });
});
//# sourceMappingURL=atomic-write.test.js.map