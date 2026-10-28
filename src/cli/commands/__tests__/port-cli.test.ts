import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../../../ship/exec.js';
import { portCommand } from '../port.js';

describe('omg port drive CLI', () => {
  let calls: string[];
  let err: string[];
  let lanesBuilt: number;

  const exec: Exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { status: 128, stdout: '', stderr: 'not a git repository' };
  };

  async function run(...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    const lanes = () => { lanesBuilt++; throw new Error('no live lanes in tests'); };
    await portCommand({ exec, lanes }).parseAsync(['drive', ...argv], { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  }

  beforeEach(() => {
    calls = [];
    err = [];
    lanesBuilt = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses --reconcile-lane without the mandatory --max-credits cap before running anything', async () => {
    expect(await run('--head', 'abc', '--reconcile-lane')).toBe(2);
    expect(err.join('\n')).toContain('--reconcile-lane needs --max-credits');
    expect(calls).toEqual([]);
    expect(lanesBuilt).toBe(0);
  });

  it('is a usage error outside a git repository', async () => {
    expect(await run('--head', 'abc')).toBe(2);
    expect(err.join('\n')).toContain('must run inside a git repository');
  });
});
