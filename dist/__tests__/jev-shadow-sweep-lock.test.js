import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { acquireSweepLock, releaseSweepLock } from '../../scripts/lib/jev-shadow.mjs';
const lossyInodes = vi.hoisted(() => ({ enabled: false }));
// NTFS file IDs exceed 2^53, so the Number `ino` of distinct files can round to
// the same value. With `enabled`, every Number-valued fstat and lstat reports one
// shared inode while bigint stats keep the real, distinct IDs.
vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal();
    const lossy = (stat) => ((target, options) => {
        const stats = stat(target, options);
        if (!lossyInodes.enabled || options?.bigint || !stats)
            return stats;
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: 2 ** 53 });
    });
    const fstatSync = lossy(original.fstatSync);
    const lstatSync = lossy(original.lstatSync);
    return { ...original, fstatSync, lstatSync, default: { ...original, fstatSync, lstatSync } };
});
describe('jev-shadow sweep lock', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'omc-jev-sweep-lock-'));
    });
    afterEach(() => {
        lossyInodes.enabled = false;
        rmSync(dir, { recursive: true, force: true });
    });
    it('does not release a replacement lock when Number inode values collide', () => {
        lossyInodes.enabled = true;
        const lock = acquireSweepLock(join(dir, '.jev-sweep-throttle'));
        expect(lock).toBeDefined();
        // Another process's lock now sits at the same path.
        renameSync(lock.path, join(dir, 'released-elsewhere'));
        writeFileSync(lock.path, 'other process');
        releaseSweepLock(lock);
        expect(existsSync(lock.path)).toBe(true);
        expect(readFileSync(lock.path, 'utf8')).toBe('other process');
    });
    it('releases its own lock', () => {
        lossyInodes.enabled = true;
        const lock = acquireSweepLock(join(dir, '.jev-sweep-throttle'));
        expect(lock).toBeDefined();
        releaseSweepLock(lock);
        expect(existsSync(lock.path)).toBe(false);
    });
});
//# sourceMappingURL=jev-shadow-sweep-lock.test.js.map