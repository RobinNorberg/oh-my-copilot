import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { releaseCommand } from '../release.js';
import type { ReleaseExec } from '../../../release/engine.js';

describe('omg release CLI', () => {
  let root: string;
  let calls: string[];
  let out: string[];
  let err: string[];

  const exec: ReleaseExec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  };

  async function run(...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    await releaseCommand({ exec, root, stateRoot: join(root, '.omg'), progress: () => {} }).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-release-cli-'));
    calls = [];
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('--dry-run prints the numbered plan of all eleven phases and runs nothing', async () => {
    expect(await run('5.12.2', '--dry-run')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('omg release 5.12.2 --dry-run: plan only, nothing runs');
    for (const [i, id] of ['preflight', 'bump', 'build', 'gates', 'smoke', 'commit', 'suite', 'pr', 'promote', 'tag', 'verify'].entries()) {
      expect(text).toMatch(new RegExp(`${String(i + 1).padStart(2)}\\S* \\S*${id}`));
    }
    expect(calls).toEqual([]);
    expect(existsSync(join(root, '.omg'))).toBe(false);
  });

  it('--dry-run --json emits the plan as JSON', async () => {
    expect(await run('v5.12.2', '--dry-run', '--json', '--from', 'pr', '--to', 'promote')).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { dryRun: boolean; version: string; phases: Array<{ id: string; steps: string[] }> };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.version).toBe('5.12.2');
    expect(parsed.phases.map((p) => p.id)).toEqual(['pr', 'promote']);
  });

  it.each([
    [['5.12'], /version must be X\.Y\.Z/],
    [['5.12.2', '--from', 'publish'], /--from must be one of/],
    [['5.12.2', '--from', 'verify', '--to', 'tag'], /--from verify comes after --to tag/],
    [['5.12.2', '--suite', 'all'], /--suite must be none, targeted or full/],
    [['5.12.2', '--baseline', 'x.json'], /--baseline needs --suite full/],
    [['5.12.2', '--timeout', '0'], /--timeout must be a positive number/],
  ])('usage error %j exits 2', async (argv, message) => {
    expect(await run(...argv, '--dry-run')).toBe(2);
    expect(err.join('\n')).toMatch(message);
    expect(calls).toEqual([]);
  });
});
