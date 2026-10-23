import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasAncestorWithIdentity, isUsableVersionPath, sameFileSystemIdentity } from '../plugin-cache-validation.js';
import { canCreateJunctions } from '../../__tests__/helpers/platform.js';

const lossyInodes = vi.hoisted(() => ({ enabled: false }));

// NTFS file IDs exceed 2^53, so the Number `ino` of distinct links can round to
// the same value. With `enabled`, every Number-valued lstat of a link and every
// Number-valued stat reports one shared inode while bigint stats keep the real,
// distinct IDs.
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  const lstatSync = ((path: Parameters<typeof original.lstatSync>[0], options?: { bigint?: boolean }) => {
    const stat = original.lstatSync(path, options as never);
    if (!lossyInodes.enabled || options?.bigint || !stat?.isSymbolicLink()) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 2 ** 53 });
  }) as typeof original.lstatSync;
  const statSync = ((path: Parameters<typeof original.statSync>[0], options?: { bigint?: boolean }) => {
    const stat = original.statSync(path, options as never);
    if (!lossyInodes.enabled || options?.bigint || !stat) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 2 ** 53 });
  }) as typeof original.statSync;
  return { ...original, lstatSync, statSync, default: { ...original, lstatSync, statSync } };
});

describe('isUsableVersionPath', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-plugin-cache-validation-'));
  });

  afterEach(() => {
    lossyInodes.enabled = false;
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!canCreateJunctions())('detects a nested link into the stale version when Number inode values collide', () => {
    const stale = join(root, 'stale');
    const candidate = join(root, 'candidate');
    mkdirSync(join(stale, 'next'), { recursive: true });
    writeFileSync(join(stale, 'next', 'run.cjs'), 'module.exports = {};\n');
    mkdirSync(join(candidate, 'hooks'), { recursive: true });
    writeFileSync(join(candidate, 'hooks', 'hooks.json'), '{}');
    // candidate/scripts -> root/hop/next, and root/hop -> stale: the second link is
    // followed while the first is still being resolved.
    symlinkSync(stale, join(root, 'hop'), 'junction');
    symlinkSync(join(root, 'hop', 'next'), join(candidate, 'scripts'), 'junction');
    const staleIdentity = statSync(stale, { bigint: true });
    lossyInodes.enabled = true;

    expect(lstatSync(join(root, 'hop')).ino).toBe(lstatSync(join(candidate, 'scripts')).ino);
    expect(isUsableVersionPath(candidate, staleIdentity)).toBe(false);
  });
});

describe('sameFileSystemIdentity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-plugin-cache-identity-'));
  });

  afterEach(() => {
    lossyInodes.enabled = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps distinct directories apart when their Number inode values collide', () => {
    const other = join(root, 'other');
    const nested = join(root, 'tree', 'nested');
    mkdirSync(other);
    mkdirSync(nested, { recursive: true });
    lossyInodes.enabled = true;

    expect(statSync(other).ino).toBe(statSync(nested).ino);
    expect(sameFileSystemIdentity(statSync(other, { bigint: true }), statSync(nested, { bigint: true }))).toBe(false);
    expect(hasAncestorWithIdentity(nested, statSync(other, { bigint: true }))).toBe(false);
    expect(hasAncestorWithIdentity(nested, statSync(root, { bigint: true }))).toBe(true);
  });

  it('does not accept a rounded Number inode as proof of identity', () => {
    const lossy = statSync(root);
    const rounded = Object.assign(Object.create(Object.getPrototypeOf(lossy)), lossy, { ino: 2 ** 53 });

    expect(sameFileSystemIdentity(rounded, rounded)).toBe(false);
    expect(sameFileSystemIdentity(lossy, statSync(root, { bigint: true }))).toBe(Number.isSafeInteger(lossy.ino));
  });
});
