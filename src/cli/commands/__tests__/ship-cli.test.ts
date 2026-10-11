import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipCommand, EXIT_PENDING } from '../ship.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { readShipState } from '../../../ship/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS_GREEN = readFileSync(join(HERE, '../../../ship/__tests__/fixtures/checks-pr233-green.json'), 'utf8');
const HEAD = '1234567890abcdef1234567890abcdef12345678';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

describe('omg ship CLI (scripted gh/git, no network)', () => {
  let root: string;
  let calls: string[];
  let checks: string;
  let logs: string[];

  const exec: Exec = (cmd, args) => {
    const key = `${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`;
    calls.push(key);
    if (key === 'git rev-parse --show-toplevel') return ok(`${root}\n`);
    if (key.startsWith('gh pr view 42 --json headRefName')) return ok('{"headRefName":"feat/x","baseRefName":"dev"}');
    if (key.startsWith('gh pr view 42 --json number')) {
      return ok(JSON.stringify({ number: 42, state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefName: 'feat/x', headRefOid: HEAD }));
    }
    if (key.startsWith('git rev-parse --verify')) return ok(`${HEAD}\n`);
    if (key.startsWith('gh pr checks 42')) return ok(checks);
    if (key === 'git rev-parse --abbrev-ref HEAD') return ok('feat/x\n');
    if (key === 'git rev-parse -q --verify MERGE_HEAD') return { status: 1, stdout: '', stderr: '' };
    if (key.startsWith('git rev-parse --git-path')) return ok(`.git/${args[2]}\n`);
    if (key === 'git rev-parse HEAD') return ok(`${HEAD}\n`);
    return ok();
  };

  async function run(...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    await shipCommand(exec).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  }

  beforeEach(() => {
    // A real repo: a non-git dir would anchor state under the home directory.
    root = mkdtempSync(join(tmpdir(), 'omg-ship-cli-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    calls = [];
    logs = [];
    checks = CHECKS_GREEN;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('init -> verdict -> prepare -> gates -> merge (prints the admin command by default)', async () => {
    expect(await run('init', '42', '--implementer', 'executor-1')).toBe(0);
    expect(readShipState(root, 42)).toMatchObject({ phase: 'review', base: 'dev', branch: 'feat/x' });

    expect(await run('merge', '42')).toBe(1);
    expect(logs.join('\n')).toMatch(/no independent verifier verdict/);

    expect(await run('verdict', '42', '--reviewer', 'executor-1', '--sha', HEAD, '--approve')).toBe(1);
    expect(logs.join('\n')).toMatch(/self-approval is refused/);

    expect(await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--approve')).toBe(0);
    expect(readShipState(root, 42)?.phase).toBe('prepare');

    expect(await run('prepare', '42', '--no-checks')).toBe(0);
    expect(readShipState(root, 42)?.phase).toBe('gates');

    checks = JSON.stringify(JSON.parse(CHECKS_GREEN).map((c: { name: string }) => (c.name === 'Test' ? { ...c, state: 'IN_PROGRESS' } : c)));
    expect(await run('gates', '42')).toBe(EXIT_PENDING);
    checks = CHECKS_GREEN;
    expect(await run('gates', '42')).toBe(0);
    expect(readShipState(root, 42)?.phase).toBe('ready');

    logs = [];
    expect(await run('merge', '42')).toBe(0);
    expect(logs.join('\n')).toContain(`gh pr merge 42 --admin --merge --match-head-commit ${HEAD}`);
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);

    expect(await run('merge', '42', '--allow-admin-merge')).toBe(0);
    expect(calls).toContain(`gh pr merge 42 --admin --merge --match-head-commit ${HEAD}`);
    expect(readShipState(root, 42)?.phase).toBe('merged');
  });

  it('prepare refuses before an approve verdict', async () => {
    await run('init', '42', '--implementer', 'executor-1');
    expect(await run('prepare', '42')).toBe(2);
    expect(logs.join('\n')).toMatch(/prepare runs after an approve verdict/);
  });

  it('usage errors exit 2', async () => {
    expect(await run('status', 'abc')).toBe(2);
    expect(await run('status', '42')).toBe(2);
    await run('init', '42', '--implementer', 'executor-1');
    expect(await run('init', '42', '--implementer', 'executor-2')).toBe(2);
    expect(await run('verdict', '42', '--reviewer', 'v', '--sha', HEAD)).toBe(2);
  });

  it('a spent fix-round budget blocks the run', async () => {
    await run('init', '42', '--implementer', 'executor-1', '--max-fix-rounds', '1');
    expect(await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--request-changes')).toBe(0);
    expect(await run('verdict', '42', '--reviewer', 'verifier-2', '--sha', HEAD, '--request-changes')).toBe(1);
    expect(readShipState(root, 42)?.phase).toBe('blocked');
  });
});
