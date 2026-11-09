import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendNoFollow, noLinkPath, withFileLock, writeAtomic } from '../store.js';
let tmp;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omg-store-locks-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
describe('withFileLock: stale-lock breaking', () => {
    it('breaks a stale lock whose owner is gone', () => {
        const path = join(tmp, 'prs.json');
        const lock = `${path}.lock`;
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner'), 'dead-writer');
        const old = new Date(Date.now() - 10 * 60_000);
        utimesSync(lock, old, old);
        expect(withFileLock(path, () => 'ran', { staleMs: 1000, timeoutMs: 2000 })).toBe('ran');
        expect(existsSync(lock)).toBe(false);
    });
    it('never breaks a lock that is not stale: its owner token and directory survive a waiter', () => {
        const path = join(tmp, 'prs.json');
        const lock = `${path}.lock`;
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner'), 'fresh-owner');
        // Fresh mtime: not stale, so a waiter times out instead of breaking it, and the lock survives intact.
        expect(() => withFileLock(path, () => 'ran', { staleMs: 60_000, timeoutMs: 150 })).toThrow(/timed out waiting for the lock/);
        expect(existsSync(join(lock, 'owner'))).toBe(true);
    });
});
describe('noLinkPath: the anchor itself', () => {
    const linkTo = (target, at) => {
        try {
            symlinkSync(target, at, 'junction');
            return true;
        }
        catch {
            return false;
        }
    };
    it('refuses a runtime root that is a link when asked to, writes through a real one', () => {
        const real = join(tmp, 'elsewhere');
        mkdirSync(real);
        const omg = join(tmp, '.omg');
        if (!linkTo(real, omg))
            return; // no link privilege on this host
        expect(() => writeAtomic(join(omg, 'a', 'b.json'), '{}', omg, true)).toThrow(/symbolic link/);
        expect(() => appendNoFollow(omg, join(omg, 'c.md'), 'x', true)).toThrow(/symbolic link/);
        expect(existsSync(join(real, 'a'))).toBe(false);
        // A checkout root may be a link (the default does not look at the anchor).
        expect(noLinkPath(omg, join(omg, 'd', 'e.txt'))).toBe(true);
    });
    it('accepts a plain runtime root', () => {
        const omg = join(tmp, '.omg');
        writeAtomic(join(omg, 'a', 'b.json'), '{}', omg, true);
        expect(existsSync(join(omg, 'a', 'b.json'))).toBe(true);
    });
});
//# sourceMappingURL=store.locks.test.js.map