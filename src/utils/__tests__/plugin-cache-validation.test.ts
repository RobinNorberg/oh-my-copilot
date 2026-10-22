import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isUsableVersionPath } from '../plugin-cache-validation.js';
import { canCreateJunctions } from '../../__tests__/helpers/platform.js';

const lossyInodes = vi.hoisted(() => ({ enabled: false }));

// NTFS file IDs exceed 2^53, so the Number `ino` of distinct links can round to
// the same value. With `enabled`, every Number-valued lstat of a link reports one
// shared inode while bigint stats keep the real, distinct IDs.
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  const lstatSync = ((path: Parameters<typeof original.lstatSync>[0], options?: { bigint?: boolean }) => {
    const stat = original.lstatSync(path, options as never);
    if (!lossyInodes.enabled || options?.bigint || !stat?.isSymbolicLink()) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 2 ** 53 });
  }) as typeof original.lstatSync;
  return { ...original, lstatSync, default: { ...original, lstatSync } };
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
    const staleIdentity = statSync(stale);
    lossyInodes.enabled = true;

    expect(lstatSync(join(root, 'hop')).ino).toBe(lstatSync(join(candidate, 'scripts')).ino);
    expect(isUsableVersionPath(candidate, staleIdentity)).toBe(false);
  });
});
