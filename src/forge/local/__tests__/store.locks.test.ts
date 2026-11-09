import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendNoFollow, breakStaleLock, noLinkPath, withFileLock, writeAtomic } from '../store.js';

let tmp: string;
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

  it('does not break a lock whose owner changed after it was judged stale', () => {
    const path = join(tmp, 'prs.json');
    const lock = `${path}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), 'new-owner');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    // The breaker judged the lock of 'old-owner' stale; the lock now belongs to 'new-owner'.
    breakStaleLock(lock, 1000, 'tok', 'old-owner');
    expect(existsSync(join(lock, 'owner'))).toBe(true);
    // The same owner it judged is broken.
    breakStaleLock(lock, 1000, 'tok', 'new-owner');
    expect(existsSync(lock)).toBe(false);
  });
});

const probeDir = mkdtempSync(join(tmpdir(), 'omg-link-probe-'));
const canLink = ((): boolean => {
  try {
    mkdirSync(join(probeDir, 'real'));
    symlinkSync(join(probeDir, 'real'), join(probeDir, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe('noLinkPath: the anchor itself', () => {
  it.skipIf(!canLink)('refuses an anchor that is a link by default, and writes through it only when allowed', () => {
    const real = join(tmp, 'elsewhere');
    mkdirSync(real);
    const omg = join(tmp, '.omg');
    symlinkSync(real, omg, 'junction');
    expect(() => writeAtomic(join(omg, 'a', 'b.json'), '{}', omg)).toThrow(/symbolic link/);
    expect(() => appendNoFollow(omg, join(omg, 'c.md'), 'x')).toThrow(/symbolic link/);
    expect(() => noLinkPath(omg, join(omg, 'd', 'e.txt'))).toThrow(/symbolic link/);
    expect(existsSync(join(real, 'a'))).toBe(false);
    // A checkout root may be a link: the caller says so.
    expect(noLinkPath(omg, join(omg, 'd', 'e.txt'), true, true)).toBe(true);
  });

  it('accepts a plain runtime root', () => {
    const omg = join(tmp, '.omg');
    writeAtomic(join(omg, 'a', 'b.json'), '{}', omg);
    expect(existsSync(join(omg, 'a', 'b.json'))).toBe(true);
  });
});
