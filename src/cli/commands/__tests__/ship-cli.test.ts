import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipCommand, EXIT_PENDING } from '../ship.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { loadTrustedShipConfig, resolveShipConfig } from '../../../ship/config.js';
import { readShipState, shipStatePath } from '../../../ship/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS_GREEN = readFileSync(join(HERE, '../../../ship/__tests__/fixtures/checks-pr233-green.json'), 'utf8');
const HEAD = '1234567890abcdef1234567890abcdef12345678';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

describe('omg ship CLI (scripted gh/git, no network)', () => {
  let root: string;
  let calls: string[];
  let checks: string;
  let runs: string;
  let logs: string[];

  const exec: Exec = (cmd, args) => {
    const key = `${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`;
    calls.push(key);
    if (key === 'git rev-parse --show-toplevel') return ok(`${root}\n`);
    if (key.startsWith('gh pr view 42 --json headRefName')) return ok('{"headRefName":"feat/x","baseRefName":"dev"}');
    if (key.startsWith('gh pr view 42 --json number')) {
      return ok(JSON.stringify({ number: 42, state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefName: 'feat/x', headRefOid: HEAD }));
    }
    if (key.startsWith('gh pr view 42 --json headRefOid')) return ok(JSON.stringify({ headRefOid: HEAD }));
    if (key.startsWith(`gh run list --commit ${HEAD}`)) return ok(runs);
    if (key.startsWith('git rev-parse --verify')) return ok(`${HEAD}\n`);
    if (key.startsWith('gh pr checks 42')) return ok(checks);
    if (key === 'git rev-parse --abbrev-ref HEAD') return ok('feat/x\n');
    if (key.startsWith('git rev-parse -q --verify')) return { status: 1, stdout: '', stderr: '' };
    if (key.startsWith('git rev-parse --git-path')) return ok(`.git/${args[2]}\n`);
    if (key === 'git rev-parse HEAD') return ok(`${HEAD}\n`);
    if (key === 'git show origin/dev:.copilot/omg.jsonc' && baseConfig !== null) return ok(baseConfig);
    if (key.startsWith('git show ')) return { status: 128, stdout: '', stderr: 'fatal: path does not exist in origin/dev' };
    if (key === 'gh pr diff 42 --name-only') return ok(diffFiles);
    return ok();
  };

  /** `.copilot/omg.jsonc` committed on origin/dev (null = none), and the PR's changed files. */
  let baseConfig: string | null;
  let diffFiles: string;
  let userBlock: unknown;

  /** The real trust-model loader: user block + base-branch file + the temp repo's working tree. */
  async function runTrusted(...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    await shipCommand(exec, (ctx) => loadTrustedShipConfig({ ...ctx, user: userBlock, warn: (m) => logs.push(m) })).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  }

  /** Ship config the command sees (the owner's `.copilot/omg.jsonc` `ship` block). */
  let shipBlock: Record<string, unknown>;

  async function run(...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    await shipCommand(exec, () => resolveShipConfig(shipBlock)).parseAsync(argv, { from: 'user' });
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
    runs = '[{"databaseId":1,"status":"completed","conclusion":"success","workflowName":"CI"}]';
    shipBlock = {};
    baseConfig = null;
    diffFiles = 'src/a.ts\n';
    userBlock = null;
    delete process.env.OMG_SHIP_HUMAN;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });

  afterEach(() => {
    delete process.env.OMG_SHIP_HUMAN;
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
    // The needs: window: Build has no check run yet -> pending, never green.
    checks = JSON.stringify(JSON.parse(CHECKS_GREEN).filter((c: { name: string }) => c.name !== 'Build'));
    expect(await run('gates', '42')).toBe(EXIT_PENDING);
    // All checks reported but a workflow run for the head is still in progress -> pending.
    checks = CHECKS_GREEN;
    runs = '[{"databaseId":1,"status":"in_progress","workflowName":"CI"}]';
    expect(await run('gates', '42')).toBe(EXIT_PENDING);
    expect(readShipState(root, 42)?.phase).toBe('gates');
    runs = '[{"databaseId":1,"status":"completed","conclusion":"success","workflowName":"CI"}]';
    expect(await run('gates', '42')).toBe(0);
    expect(readShipState(root, 42)?.phase).toBe('ready');

    logs = [];
    expect(await run('merge', '42')).toBe(0);
    expect(logs.join('\n')).toContain(`gh pr merge 42 --admin --merge --match-head-commit ${HEAD}`);
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);

    // Only the owner-edited config key runs the admin merge.
    shipBlock = { allowAdminMerge: true };
    expect(await run('merge', '42')).toBe(0);
    expect(calls).toContain(`gh pr merge 42 --admin --merge --match-head-commit ${HEAD}`);
    expect(readShipState(root, 42)?.phase).toBe('merged');
  });

  it('merge has no CLI flag that enables the admin merge', () => {
    const merge = shipCommand(exec).commands.find((c) => c.name() === 'merge')!;
    expect(merge.options.map((opt) => opt.long)).toEqual(['--json']);
  });

  it('merge refuses a hand-edited state even when everything else is ready', async () => {
    shipBlock = { allowAdminMerge: true };
    await run('init', '42', '--implementer', 'executor-1');
    await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--approve');
    await run('prepare', '42', '--no-checks');
    expect(await run('gates', '42')).toBe(0);
    const path = shipStatePath(root, 42);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...state, implementer: 'nobody' }, null, 2));
    logs = [];
    expect(await run('merge', '42')).toBe(1);
    expect(logs.join('\n')).toMatch(/integrity check/);
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });

  it('init --force keeps the prior run, and refuses a blocked or merged run without OMG_SHIP_HUMAN=1', async () => {
    await run('init', '42', '--implementer', 'executor-1');
    expect(await run('init', '42', '--implementer', 'executor-2', '--force')).toBe(0);
    let s = readShipState(root, 42)!;
    expect(s.implementer).toBe('executor-2');
    expect(s.previousRuns?.map((p) => p.implementer)).toEqual(['executor-1']);

    await run('init', '42', '--implementer', 'executor-3', '--force', '--max-fix-rounds', '0');
    await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--request-changes');
    expect(readShipState(root, 42)?.phase).toBe('blocked');
    logs = [];
    expect(await run('init', '42', '--implementer', 'executor-4', '--force')).toBe(2);
    expect(logs.join('\n')).toMatch(/only the owner may replace it \(OMG_SHIP_HUMAN=1\)/);
    expect(readShipState(root, 42)?.phase).toBe('blocked');

    process.env.OMG_SHIP_HUMAN = '1';
    expect(await run('init', '42', '--implementer', 'executor-4', '--force')).toBe(0);
    s = readShipState(root, 42)!;
    expect(s.phase).toBe('review');
    expect(s.previousRuns?.map((p) => `${p.implementer}:${p.phase}`)).toEqual(['executor-1:review', 'executor-2:review', 'executor-3:blocked']);
  });

  it('refuses option-shaped --base and --sha before git sees them', async () => {
    expect(await run('init', '42', '--implementer', 'executor-1', '--base=--upload-pack=touch /tmp/pwned')).toBe(2);
    expect(await run('init', '42', '--implementer', 'executor-1', '--base', 'a..b')).toBe(2);
    expect(readShipState(root, 42)).toBeNull();
    await run('init', '42', '--implementer', 'executor-1');
    logs = [];
    expect(await run('verdict', '42', '--reviewer', 'verifier-1', '--sha=--upload-pack=x', '--approve')).toBe(2);
    expect(logs.join('\n')).toMatch(/--sha must be a hex commit id/);
    expect(calls.some((c) => c.includes('--upload-pack'))).toBe(false);
  });

  it('prepare refuses a checkout of another branch', async () => {
    await run('init', '42', '--implementer', 'executor-1');
    await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--approve');
    const other: Exec = (cmd, args, o) => (args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? ok('feat/other\n') : exec(cmd, args, o));
    process.exitCode = undefined;
    await shipCommand(other, () => resolveShipConfig({})).parseAsync(['prepare', '42', '--no-checks', '--push'], { from: 'user' });
    expect(Number(process.exitCode)).toBe(1);
    process.exitCode = undefined;
    expect(logs.join('\n')).toMatch(/ship run is for feat\/x/);
    expect(calls.some((c) => c.startsWith('git push') || c.startsWith('git fetch'))).toBe(false);
    expect(readShipState(root, 42)?.phase).toBe('prepare');
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

  async function approvedAndPrepared(runner: (...argv: string[]) => Promise<number>): Promise<void> {
    expect(await runner('init', '42', '--implementer', 'executor-1')).toBe(0);
    expect(await runner('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--approve')).toBe(0);
    expect(await runner('prepare', '42', '--no-checks')).toBe(0);
  }

  it('B1 probe: an untracked working-tree omg.jsonc (admin merge on, Test advisory) is ignored; a FAILED Test blocks', async () => {
    mkdirSync(join(root, '.copilot'));
    writeFileSync(join(root, '.copilot', 'omg.jsonc'), readFileSync(join(HERE, '../../../ship/__tests__/fixtures/project-config-admin-merge.jsonc'), 'utf8'));
    await approvedAndPrepared(runTrusted);
    checks = JSON.stringify(JSON.parse(CHECKS_GREEN).map((c: { name: string }) => (c.name === 'Test' ? { ...c, state: 'FAILURE' } : c)));
    logs = [];
    expect(await runTrusted('gates', '42')).toBe(1);
    expect(logs.join('\n')).toMatch(/ignoring ship\.allowAdminMerge from the working-tree project config/);
    expect(await runTrusted('merge', '42')).toBe(1);
    expect(logs.join('\n')).toMatch(/gates are failed \(failed: Test\)/);
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    expect(calls).toContain('git show origin/dev:.copilot/omg.jsonc');
  });

  it('B1: the config committed on the base branch is honored (admin merge runs when gates are green)', async () => {
    baseConfig = '{ "ship": { "allowAdminMerge": true } }';
    await approvedAndPrepared(runTrusted);
    expect(await runTrusted('gates', '42')).toBe(0);
    expect(await runTrusted('merge', '42')).toBe(0);
    expect(calls).toContain(`gh pr merge 42 --admin --merge --match-head-commit ${HEAD}`);
  });

  it('B1: the user config wins over the base branch', async () => {
    baseConfig = '{ "ship": { "allowAdminMerge": true } }';
    userBlock = { ship: { allowAdminMerge: false } };
    await approvedAndPrepared(runTrusted);
    expect(await runTrusted('merge', '42')).toBe(0);
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });

  it('merge refuses a PR touching the merge-rule files unless OMG_SHIP_HUMAN=1', async () => {
    baseConfig = '{ "ship": { "allowAdminMerge": true } }';
    await approvedAndPrepared(runTrusted);
    for (const file of ['.copilot/omg.jsonc', '.github/known-flaky-tests.json', '.github/workflows/ci.yml']) {
      diffFiles = `src/a.ts\n${file}\n`;
      logs = [];
      expect(await runTrusted('merge', '42')).toBe(1);
      expect(logs.join('\n')).toMatch(/touches merge-rule files/);
    }
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    process.env.OMG_SHIP_HUMAN = '1';
    expect(await runTrusted('merge', '42')).toBe(0);
    expect(calls).toContain(`gh pr merge 42 --admin --merge --match-head-commit ${HEAD}`);
  });

  it('init --force keeps the fix-round budget and implementer of a run with verdicts; resetting needs OMG_SHIP_HUMAN=1', async () => {
    await run('init', '42', '--implementer', 'executor-1', '--max-fix-rounds', '2');
    await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--request-changes');
    await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--request-changes');
    expect(readShipState(root, 42)).toMatchObject({ fixRounds: 2, phase: 'fix' });
    expect(await run('init', '42', '--implementer', 'executor-1', '--force', '--max-fix-rounds', '9')).toBe(0);
    expect(readShipState(root, 42)).toMatchObject({ fixRounds: 2, maxFixRounds: 2, implementer: 'executor-1', phase: 'review' });
    logs = [];
    expect(await run('init', '42', '--implementer', 'executor-2', '--force')).toBe(2);
    expect(logs.join('\n')).toMatch(/implementer stays executor-1/);
    // A third changes-requested still blocks: the budget was not reset.
    expect(await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--request-changes')).toBe(1);
    expect(readShipState(root, 42)?.phase).toBe('blocked');
    process.env.OMG_SHIP_HUMAN = '1';
    expect(await run('init', '42', '--implementer', 'executor-2', '--force')).toBe(0);
    expect(readShipState(root, 42)).toMatchObject({ fixRounds: 0, implementer: 'executor-2' });
  });

  it('a spent fix-round budget blocks the run', async () => {
    await run('init', '42', '--implementer', 'executor-1', '--max-fix-rounds', '1');
    expect(await run('verdict', '42', '--reviewer', 'verifier-1', '--sha', HEAD, '--request-changes')).toBe(0);
    expect(await run('verdict', '42', '--reviewer', 'verifier-2', '--sha', HEAD, '--request-changes')).toBe(1);
    expect(readShipState(root, 42)?.phase).toBe('blocked');
  });
});
