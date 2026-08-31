import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { acquireStateFileLockSync, isStateFileLockingSupported, PORTABLE_LOCK_MAX_AGE_MS, releaseStateFileLockSync, withStateFileLockSync } from '../../../scripts/lib/atomic-write.mjs';
import { tmpdir } from 'os';
const __dirname = dirname(fileURLToPath(import.meta.url));
/** Process-start identity the lock module accepts for a live owner on this platform. */
function liveProcessStart() {
    if (process.platform !== 'linux')
        return String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1000)));
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}
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
import { atomicWriteBatchSync, atomicWriteFileSync, atomicWriteJson, } from '../atomic-write.js';
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
        fsPromisesControl.writeHook = fd => {
            const tempPath = readlinkSync(`/proc/self/fd/${fd.fd}`);
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
    it('bypasses stale generic lock artifacts without flock', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const filePath = join(directory, 'state.json');
        writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));
        expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
    });
    it('preserves legacy unlocked behavior without flock even when a lock artifact exists', () => {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-live-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
        const filePath = join(directory, 'state.json');
        writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: process.pid, processStart: liveProcessStart(), createdAt: new Date().toISOString(), nonce: randomUUID() }));
        expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
    });
});
describe('portable state file locking', () => {
    const directories = [];
    afterEach(() => {
        delete process.env.OMC_TEST_STATE_LOCK_MODE;
        delete process.env.OMC_TEST_FLOCK_AVAILABLE;
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });
    it('reports locking as supported without flock and unsupported only when locking is disabled', () => {
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
        expect(isStateFileLockingSupported()).toBe(true);
        process.env.OMC_TEST_STATE_LOCK_MODE = 'none';
        expect(isStateFileLockingSupported()).toBe(false);
    });
    it('holds the lock against a second exclusive acquisition and releases it cleanly', () => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-hold-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        const held = acquireStateFileLockSync(filePath, 5, true);
        expect(held).not.toBeNull();
        expect(existsSync(lockPath)).toBe(true);
        expect(acquireStateFileLockSync(filePath, 5, true)).toBeNull();
        releaseStateFileLockSync(held);
        expect(existsSync(lockPath)).toBe(false);
    });
    it('reclaims a lock left behind by a dead owner', () => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-stale-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));
        expect(withStateFileLockSync(filePath, () => 'written', true)).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(lockPath)).toBe(false);
    });
    it('refuses to claim exclusivity over an unreadable lock artifact', () => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-corrupt-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
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
    it('reclaims an unreadable lock artifact once it ages past the ceiling', () => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-aged-debris-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        writeFileSync(lockPath, 'not a lock owner');
        // Debris nobody can attribute would otherwise wedge this path forever; age is the only escape.
        const aged = (Date.now() - (PORTABLE_LOCK_MAX_AGE_MS + 60_000)) / 1000;
        utimesSync(lockPath, aged, aged);
        expect(withStateFileLockSync(filePath, () => 'written', true)).toEqual({ acquired: true, value: 'written' });
        expect(existsSync(lockPath)).toBe(false);
    });
    it.each([
        ['well past the old sixty-second ceiling', 120_000],
        ['stamped in the future by a backwards clock', -3_600_000],
    ])('keeps a live holder whose stamp is %s', (_name, ageMs) => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-clock-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
        const filePath = join(directory, 'state.json');
        writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({
            version: 1,
            pid: process.pid,
            processStart: '1',
            createdAt: new Date(Date.now() - ageMs).toISOString(),
            nonce: randomUUID(),
        }));
        expect(withStateFileLockSync(filePath, () => 'stolen', true)).toEqual({ acquired: false, value: undefined });
    });
    it('still reclaims a live-looking holder past the ceiling so a recycled pid cannot deadlock it', () => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-ceiling-'));
        directories.push(directory);
        process.env.NODE_ENV = 'test';
        process.env.OMC_TEST_STATE_LOCK_MODE = 'portable';
        const filePath = join(directory, 'state.json');
        const lockPath = `${filePath}.mutation.lock`;
        writeFileSync(lockPath, JSON.stringify({
            version: 1,
            pid: process.pid,
            processStart: '1',
            createdAt: new Date(Date.now() - (PORTABLE_LOCK_MAX_AGE_MS + 60_000)).toISOString(),
            nonce: randomUUID(),
        }));
        expect(withStateFileLockSync(filePath, () => 'reclaimed', true)).toEqual({ acquired: true, value: 'reclaimed' });
        expect(existsSync(lockPath)).toBe(false);
    });
    it('serializes concurrent processes so no counter increment is lost', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'portable-lock-concurrent-'));
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
                env: { ...process.env, NODE_ENV: 'test', OMC_TEST_STATE_LOCK_MODE: 'portable' },
            });
            let output = '';
            child.stdout.on('data', chunk => { output += String(chunk); });
            child.on('close', () => resolve(Number(output)));
        })));
        const total = acquisitions.reduce((sum, value) => sum + value, 0);
        expect(total).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(counterPath, 'utf8')).value).toBe(total);
    }, 60_000);
});
//# sourceMappingURL=atomic-write.test.js.map