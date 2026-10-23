import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const renameFailures = vi.hoisted(() => ({ codes: [] as string[], calls: 0 }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (source: string, target: string) => {
      renameFailures.calls += 1;
      const code = renameFailures.codes.shift();
      if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      return actual.rename(source, target);
    },
  };
});

import { writeAtomic } from '../team-ops.js';

describe('team-ops writeAtomic rename contention', () => {
  const basePlatform = process.platform;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omc-team-ops-write-atomic-'));
    renameFailures.codes = [];
    renameFailures.calls = 0;
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: basePlatform, configurable: true });
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient win32 %s rename and publishes the data', async code => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    renameFailures.codes = [code, code];
    const target = join(dir, 'state.json');

    await writeAtomic(target, '{"ok":true}');

    expect(renameFailures.calls).toBe(3);
    expect(await readFile(target, 'utf8')).toBe('{"ok":true}');
    expect((await readdir(dir)).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('gives up after a bounded number of win32 retries and removes the temp file', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    renameFailures.codes = Array.from({ length: 20 }, () => 'EPERM');
    const target = join(dir, 'state.json');

    await expect(writeAtomic(target, '{}')).rejects.toMatchObject({ code: 'EPERM' });

    expect(renameFailures.calls).toBe(8);
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not retry on POSIX hosts, where rename over a busy target cannot fail this way', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    renameFailures.codes = ['EPERM'];

    await expect(writeAtomic(join(dir, 'state.json'), '{}')).rejects.toMatchObject({ code: 'EPERM' });

    expect(renameFailures.calls).toBe(1);
  });

  it('does not retry a non-transient win32 error', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    renameFailures.codes = ['ENOENT'];

    await expect(writeAtomic(join(dir, 'state.json'), '{}')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(renameFailures.calls).toBe(1);
  });
});
