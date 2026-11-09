import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryCommand } from '../../../cli/commands/factory.js';
import type { Exec } from '../../../ship/exec.js';
import { healCommand, runHealScan, type HealDeps, type ScanResult } from '../cli.js';
import { DEFAULT_HEAL_CONFIG } from '../config.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { acquireFileLockSync, releaseFileLockSync } from '../../../lib/file-lock.js';
import { TRUSTED_READ_ENV } from '../../../ship/exec.js';
import { assertHealCommand, healGuardExec, HealSafetyError } from '../history.js';
import { readHealScanRecord } from '../run.js';
import { enqueueWebhookRun, healStateDir, listHealStates, readWebhookQueue, writeHealState } from '../state.js';
import { createFactoryState, EXIT_BUSY, factoryCancelRequested, factoryRepoOwnerPath, moveTo, overwriteFactoryState, type FactoryHealRecord } from '../../run/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const KNOWN_FILE = readFileSync(join(HERE, '../../../../.github/known-flaky-tests.json'), 'utf8');
const CI_FILE = readFileSync(join(HERE, '../../../../.github/workflows/ci.yml'), 'utf8');
const NOW = new Date('2026-10-28T00:00:00Z');
const RED_SHA = '15e3c590ca6eaadf0a0d1efe38f89092b3ae6269';

interface RunFixture { databaseId: number; headSha: string; headBranch: string; event: string; conclusion: string; status: string; createdAt: string; jobs: unknown[] }
const RUNS = (JSON.parse(fixture('runs.json')) as { runs: RunFixture[] }).runs;
const run = (id: number) => RUNS.find((r) => r.databaseId === id)!;
/** A second PR branch failing with the same Test failure (cross-PR rule). */
const SECOND_PR: RunFixture = {
  ...run(40542274776), databaseId: 40551187199, headBranch: 'feat/other', createdAt: '2026-10-27T17:30:11Z',
  jobs: [{ databaseId: 500, name: 'Test', conclusion: 'failure', steps: [{ name: 'Run functional tests', conclusion: 'failure' }] }],
};
const LOGS: Record<string, string> = {
  122329975951: fixture('git256-red.log'),
  500: fixture('git256-red.log'),
  122329976558: fixture('policy-only.log'),
  122472797949: fixture('policy-only.log'),
  122472747061: fixture('git256-green.log'),
  122472798022: fixture('git256-green.log'),
};

let root: string;
let calls: string[][];
let out: string[];

function fakeExec(push: RunFixture[], pr: RunFixture[], range = { count: '0', files: '' }): Exec {
  const all = [...push, ...pr];
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'show refs/remotes/origin/dev:.github/known-flaky-tests.json') return ok(KNOWN_FILE);
      if (a === 'show refs/remotes/origin/dev:.github/workflows/ci.yml') return ok(CI_FILE);
      if (args[0] === 'cat-file') return ok('');
      if (args[0] === 'rev-list') return ok(`${range.count}\n`);
      if (args[0] === 'diff') return ok(range.files);
    }
    if (cmd === 'gh' && args[1] === 'list') {
      const list = args.includes('push') ? push : pr;
      return ok(JSON.stringify(list.map(({ jobs: _jobs, ...r }) => r)));
    }
    if (cmd === 'gh' && args[1] === 'view' && args[4] === 'jobs') return ok(JSON.stringify({ jobs: all.find((r) => String(r.databaseId) === args[2])!.jobs }));
    if (cmd === 'gh' && args[2] === '--job') return ok(LOGS[args[3]] ?? '');
    return { status: 1, stdout: '', stderr: `unexpected ${cmd} ${a}` };
  };
}

const scan = (exec: Exec, dryRun = false): ScanResult => runHealScan({ exec, root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun, warn: () => {}, ledgerDir: join(root, '.omg', 'test-ledger') });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-heal-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  calls = [];
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('omg factory heal scan', () => {
  it('model case: two PR branches red on git 2.56 while dev is green -> env-change, rerun recorded not issued; policy-only run ignored', () => {
    const result = scan(fakeExec([run(40584638028)], [run(40542274776), SECOND_PR, run(40584652986)]));
    const policy = result.entries.find((e) => e.runId === '40584652986')!;
    expect(policy.reason).toMatch(/ignored: only PR-policy job\(s\) failed \(No Committed Build Artifacts\)/);
    expect(policy.sig8).toBeUndefined();
    const red = result.entries.filter((e) => e.sig8);
    expect(red.map((e) => e.runId).sort()).toEqual(['40542274776', '40551187199']);
    expect(red[0]).toMatchObject({ class: 'env-change', next: 'rerun-probe', rerunIntent: 'gh run rerun 40542274776 --failed (recorded, not issued)', recorded: true });
    const [state] = listHealStates(root);
    expect(state).toMatchObject({ class: 'env-change', source: 'pr', count: 2, prBranches: ['feat/other', 'release/v5.14.0'] });
    expect(state.classification.jobs[0].env.changed.map((c) => c.field)).toEqual(['imageVersion', 'git']);
    expect(state.classification.lastGreen).toEqual({ runId: '40584638028', sha: run(40584638028).headSha });
    // No GitHub write: only list/view shapes ran, and nothing named rerun.
    expect(calls.filter((c) => c[0] === 'gh').every((c) => c[2] === 'list' || c[2] === 'view')).toBe(true);
    expect(calls.some((c) => c.includes('rerun'))).toBe(false);
  });

  it('a PR signature on one head branch only never becomes a heal signature', () => {
    const result = scan(fakeExec([run(40584638028)], [run(40542274776)]));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].reason).toMatch(/one head branch only/);
    expect(listHealStates(root)).toEqual([]);
  });

  it('a red dev push run with code in range and a new image -> regression-or-env, queued for a debug lane; rescans are idempotent', () => {
    const redPush: RunFixture = { ...SECOND_PR, databaseId: 40700000001, event: 'push', headBranch: 'dev', headSha: 'a'.repeat(40), createdAt: '2026-10-27T22:00:00Z' };
    const exec = fakeExec([redPush, run(40584638028)], [], { count: '2', files: 'src/tools/state-tools.ts\ndocs/x.md\n' });
    const first = scan(exec);
    expect(first.entries).toEqual([expect.objectContaining({ runId: '40700000001', class: 'regression-or-env', next: 'debug-lane', blocked: false })]);
    const again = scan(exec);
    expect(again.entries).toEqual([]);
    expect(listHealStates(root)[0].count).toBe(1);
  });

  it('the scan keeps the class and classification it derived from GitHub outside the repository, and restores a missing record', () => {
    const ledgerDir = join(root, '.omg', 'test-ledger');
    const redPush: RunFixture = { ...SECOND_PR, databaseId: 40700000001, event: 'push', headBranch: 'dev', headSha: 'a'.repeat(40), createdAt: '2026-10-27T22:00:00Z' };
    const exec = fakeExec([redPush, run(40584638028)], [], { count: '2', files: 'src/tools/state-tools.ts\ndocs/x.md\n' });
    scan(exec);
    const [state] = listHealStates(root);
    expect(readHealScanRecord(ledgerDir, root, state.sig8)).toEqual({ sig8: state.sig8, class: 'regression-or-env', source: 'push', classification: state.classification });
    // An in-repo edit never reaches the record; a lost record is classified again from GitHub, counted once.
    writeHealState(root, { ...state, class: 'regression' });
    expect(readHealScanRecord(ledgerDir, root, state.sig8)!.class).toBe('regression-or-env');
    rmSync(join(ledgerDir, 'heal'), { recursive: true, force: true });
    expect(scan(exec, true).entries).toEqual([]);
    expect(readHealScanRecord(ledgerDir, root, state.sig8)).toBeNull();
    expect(scan(exec).entries).toEqual([expect.objectContaining({ runId: '40700000001', recorded: true, reason: expect.stringMatching(/recorded outside the repository again/) })]);
    expect(readHealScanRecord(ledgerDir, root, state.sig8)!.class).toBe('regression-or-env');
    expect(listHealStates(root)[0].count).toBe(1);
  });

  it('a PR run never rewrites the out-of-repo record of a push signature, even when the in-repo source is flipped to pr', () => {
    const ledgerDir = join(root, '.omg', 'test-ledger');
    const redPush: RunFixture = { ...SECOND_PR, databaseId: 40700000001, event: 'push', headBranch: 'dev', headSha: 'a'.repeat(40), createdAt: '2026-10-27T22:00:00Z' };
    scan(fakeExec([redPush, run(40584638028)], [], { count: '2', files: 'src/tools/state-tools.ts\ndocs/x.md\n' }));
    const [state] = listHealStates(root);
    const before = readHealScanRecord(ledgerDir, root, state.sig8)!;
    expect(before.source).toBe('push');
    writeHealState(root, { ...state, source: 'pr' });
    const prRun: RunFixture = { ...SECOND_PR, databaseId: 40700000002, headBranch: 'feat/third', createdAt: '2026-10-27T23:00:00Z' };
    const second = scan(fakeExec([run(40584638028)], [prRun, { ...prRun, databaseId: 40700000003, headBranch: 'feat/fourth' }]));
    expect(second.entries.some((e) => e.sig8 === state.sig8)).toBe(true);
    expect(readHealScanRecord(ledgerDir, root, state.sig8)).toEqual(before);
    expect(listHealStates(root)[0]).toMatchObject({ source: 'push', classification: before.classification });
  });

  it('policy-only PR failures never starve a real cross-branch failure of a candidate slot', () => {
    const policy = Array.from({ length: 6 }, (_, i): RunFixture => ({ ...run(40584652986), databaseId: 40600000000 + i, headBranch: `feat/p${i}`, createdAt: `2026-10-27T20:0${i}:00Z` }));
    const result = scan(fakeExec([run(40584638028)], [...policy, run(40542274776), SECOND_PR]));
    expect(result.entries.filter((e) => e.reason.startsWith('ignored:'))).toHaveLength(6);
    expect(result.entries.filter((e) => e.sig8).map((e) => e.runId).sort()).toEqual(['40542274776', '40551187199']);
    expect(listHealStates(root)).toHaveLength(1);
  });

  it('a scan holding the heal lock blocks a second writing scan; dry runs do not need it', () => {
    const exec = fakeExec([run(40584638028)], [run(40542274776), SECOND_PR]);
    const handle = acquireFileLockSync(join(healStateDir(root), 'scan.lock'))!;
    try {
      expect(() => runHealScan({ exec, root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => {}, ledgerDir: join(root, '.omg', 'test-ledger'), lockTimeoutMs: 100 })).toThrow(/Failed to acquire file lock/);
      expect(() => scan(exec, true)).not.toThrow();
    } finally {
      releaseFileLockSync(handle);
    }
    expect(() => scan(exec)).not.toThrow();
    expect(existsSync(join(healStateDir(root), 'scan.lock'))).toBe(false);
  });

  it('CI Gate and the Test summary failing only because a shard failed are classified by the shard', () => {
    const ship = (name: string) => readFileSync(join(HERE, '../../../ship/__tests__/fixtures', name), 'utf8');
    Object.assign(LOGS, { 601: ship('job-log-shard-flaky.txt'), 602: ship('job-log-test-shards-failed.txt'), 603: ship('job-log-ci-gate-needs-failed.txt'), 604: ship('job-log-ci-gate-own-failure.txt') });
    const job = (databaseId: number, name: string, step: string) => ({ databaseId, name, conclusion: 'failure', steps: [{ name: step, conclusion: 'failure' }] });
    const shard = job(601, 'Test shard 2 of 4', 'Run functional tests');
    const redPush = (databaseId: number, jobs: unknown[]): RunFixture => ({ ...SECOND_PR, databaseId, event: 'push', headBranch: 'dev', headSha: 'a'.repeat(40), createdAt: '2026-10-27T22:00:00Z', jobs });
    const jobsOf = () => listHealStates(root)[0].classification.jobs.map((j) => j.job);

    expect(scan(fakeExec([redPush(40700000011, [shard, job(602, 'Test', 'Merge shard reports'), job(603, 'CI Gate', 'Check needed job results')]), run(40584638028)], [])).entries).toHaveLength(1);
    expect(jobsOf()).toEqual(['Test shard 2 of 4']);

    rmSync(healStateDir(root), { recursive: true, force: true });
    scan(fakeExec([redPush(40700000012, [shard, job(604, 'CI Gate', 'Check needed job results')]), run(40584638028)], []));
    expect(jobsOf().sort()).toEqual(['CI Gate', 'Test shard 2 of 4']);

    // CI Gate failing only because an ignored PR-policy job failed starts no heal.
    LOGS[605] = ship('job-log-ci-gate-needs-failed.txt').replace('not success or skipped: test-shards, test', 'not success or skipped: version-check');
    const policyOnly = scan(fakeExec([redPush(40700000013, [job(122329976558, 'Version Consistency Check', 'Check versions'), job(605, 'CI Gate', 'Check needed job results')])], []));
    expect(policyOnly.entries[0].reason).toMatch(/ignored: only PR-policy job\(s\) failed \(Version Consistency Check\)/);

    // A CI Gate naming a job that has no failed job in the run stays counted.
    rmSync(healStateDir(root), { recursive: true, force: true });
    LOGS[606] = ship('job-log-ci-gate-needs-failed.txt').replace('not success or skipped: test-shards, test', 'not success or skipped: test-shards, build');
    scan(fakeExec([redPush(40700000014, [shard, job(606, 'CI Gate', 'Check needed job results')]), run(40584638028)], []));
    expect(jobsOf().sort()).toEqual(['CI Gate', 'Test shard 2 of 4']);

    // A cancelled or timed-out job CI Gate names is non-passing but never parsed: CI Gate stays counted,
    // so a flaky shard plus a cancelled Build is not classified as the shard alone.
    LOGS[607] = ship('job-log-ci-gate-needs-failed.txt').replace('not success or skipped: test-shards, test', 'not success or skipped: test-shards, build');
    for (const [i, conclusion] of (['cancelled', 'timed_out'] as const).entries()) {
      rmSync(healStateDir(root), { recursive: true, force: true });
      const build = { databaseId: 608, name: 'Build', conclusion, steps: [] };
      scan(fakeExec([redPush(40700000015 + i, [shard, build, job(607, 'CI Gate', 'Check needed job results')]), run(40584638028)], []));
      expect(jobsOf().sort()).toEqual(['CI Gate', 'Test shard 2 of 4']);
    }
  });

  it('--dry-run writes no state', () => {
    const result = scan(fakeExec([run(40584638028)], [run(40542274776), SECOND_PR]), true);
    expect(result.entries.some((e) => e.class === 'env-change' && e.recorded === false)).toBe(true);
    expect(existsSync(healStateDir(root))).toBe(false);
  });
});

describe('heal command guard', () => {
  it('refuses reruns, gh api and any non-read shape', () => {
    expect(() => assertHealCommand('gh', ['run', 'rerun', '1', '--failed'])).toThrow(HealSafetyError);
    expect(() => assertHealCommand('gh', ['api', 'repos/x/y'])).toThrow(HealSafetyError);
    expect(() => assertHealCommand('git', ['push', 'origin', 'HEAD'])).toThrow(HealSafetyError);
    expect(() => assertHealCommand('git', ['show', `refs/remotes/origin/dev:../etc/passwd`])).toThrow(HealSafetyError);
    expect(() => assertHealCommand('npm', ['ci'])).toThrow(HealSafetyError);
    expect(() => assertHealCommand('gh', ['run', 'view', '--job', '1', '--log'])).not.toThrow();
    expect(() => assertHealCommand('C:\\Program Files\\Git\\cmd\\git.exe', ['push'])).toThrow(HealSafetyError);
  });

  it('applies the trusted git env for any normalized git basename', () => {
    for (const cmd of ['git', 'git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', '/usr/bin/git']) {
      const seen: unknown[] = [];
      healGuardExec((_c, _a, o) => { seen.push(o?.env); return { status: 0, stdout: '', stderr: '' }; })(cmd, ['rev-parse', '--show-toplevel']);
      expect(seen[0]).toBe(TRUSTED_READ_ENV);
    }
    expect(() => assertHealCommand('git', ['rev-list', '--count', `${'b'.repeat(40)}..${RED_SHA}`])).not.toThrow();
  });
});

describe('omg factory heal CLI', () => {
  const noLanes = () => { throw new Error('no lane in these tests'); };
  const deps = (exec: Exec): HealDeps => ({ exec, base: () => 'dev', config: () => ({ config: DEFAULT_HEAL_CONFIG, warnings: [] }), now: () => NOW, lanes: noLanes, ledgerDir: join(root, '.omg', 'test-ledger'), runLimits: () => ({ limits: DEFAULT_FACTORY_RUN_LIMITS, warnings: [] }) });
  async function cli(d: HealDeps, ...argv: string[]): Promise<number> {
    process.exitCode = undefined;
    await healCommand(d).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  }

  it('scan clears webhook-queued runs it listed and keeps the others; a dry run writes nothing', () => {
    enqueueWebhookRun(root, '40584638028', NOW);
    enqueueWebhookRun(root, '99999999999', NOW);
    const exec = fakeExec([run(40584638028)], [run(40542274776)]);
    expect(scan(exec, true).queued).toBe(1);
    expect(readWebhookQueue(root)).toHaveLength(2);
    expect(scan(exec).queued).toBe(1);
    expect(readWebhookQueue(root).map((q) => q.runId)).toEqual(['99999999999']);
  });

  it('is registered under omg factory', () => {
    expect(factoryCommand().commands.map((c) => c.name())).toContain('heal');
  });

  it('busy is exit 6 before the Azure DevOps config loader fetches; cancel while an engine runs only drops the request', async () => {
    const lock = factoryRepoOwnerPath(root);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: NOW.toISOString(), run: '12' }));
    let loads = 0;
    const d: HealDeps = {
      ...deps(fakeExec([], [])),
      forgeKind: () => 'azure-devops',
      forge: () => { loads += 1; throw new Error('the loader must not run while an engine holds the checkout'); },
    };
    expect(await cli(d, 'approve', '0123abcd', '--json')).toBe(EXIT_BUSY);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: false, busy: true, error: expect.stringMatching(/another omg factory engine runs in this repository \(12, pid/) });
    out = [];
    expect(await cli(d, 'run', '0123abcd')).toBe(EXIT_BUSY);
    expect(out.join('\n')).toMatch(/^busy: another omg factory engine runs/);
    expect(loads).toBe(0);

    const T = NOW.toISOString();
    const heal: FactoryHealRecord = {
      sig8: '0123abcd', class: 'test-failure', firstRed: { runId: '77', sha: RED_SHA }, failingTests: ['src/a.test.ts > b'], env: [],
      diagnosis: { class: 'test-failure', rootCause: 'a flaky clock', evidence: [], reproduced: false, fix: null },
    };
    overwriteFactoryState(root, 'heal-0123abcd', moveTo({ ...createFactoryState({ issue: 0, repoUrl: 'https://github.com/o/r', base: 'dev', heal }, T), forgeKind: 'github' }, 'implement', 'approved', T));
    out = [];
    const cancelled = await cli(d, 'cancel', '0123abcd', '--json');
    expect(cancelled, out.join('\n')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ ok: true, sig8: '0123abcd', cancelRequested: true });
    expect(factoryCancelRequested(root, 'heal-0123abcd')).toBe(true);
    expect(loads).toBe(0);
  });

  it('heal scan, run and approve take the engine lock before any fetch or worktree on GitHub too: busy is exit 6 with nothing run but the root read; the lock is released after', async () => {
    const lock = factoryRepoOwnerPath(root);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: NOW.toISOString(), run: '12' }));
    const d: HealDeps = { ...deps(fakeExec([run(40584638028)], [])), forgeKind: () => 'github' };
    for (const argv of [['scan'], ['scan', '--dry-run'], ['run', '0123abcd'], ['approve', '0123abcd']]) {
      calls = [];
      out = [];
      expect(await cli(d, ...argv, '--json'), argv.join(' ')).toBe(EXIT_BUSY);
      expect(JSON.parse(out.join('\n')), argv.join(' ')).toMatchObject({ ok: false, busy: true, error: expect.stringMatching(/another omg factory engine runs in this repository \(12, pid/) });
      expect(calls, argv.join(' ')).toEqual([['git', 'rev-parse', '--show-toplevel']]);
    }
    expect(calls.some((c) => c.includes('fetch') || c.includes('worktree'))).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ run: '12' });
    // Free: the scan runs under the lock and releases it.
    rmSync(lock);
    out = [];
    expect(await cli(d, 'scan', '--json')).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('scan then status [sig8] [--json] reads the classification back', async () => {
    const d = deps(fakeExec([run(40584638028)], [run(40542274776), SECOND_PR]));
    expect(await cli(d, 'scan')).toBe(0);
    expect(out.join('\n')).toMatch(/env-change/);
    const [state] = listHealStates(root);
    out = [];
    expect(await cli(d, 'status', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).signatures[0].sig8).toBe(state.sig8);
    out = [];
    expect(await cli(d, 'status', state.sig8)).toBe(0);
    expect(out.join('\n')).toMatch(/env imageVersion: 20261012\.334\.1 -> 20261025\.353\.1/);
    expect(out.join('\n')).toMatch(/env git: 2\.55\.0 -> 2\.56\.0/);
    out = [];
    expect(await cli(d, 'status', state.sig8, '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ sig8: state.sig8, class: 'env-change' });
    expect(await cli(d, 'status', 'nothex!')).toBe(2);
    expect(await cli(d, 'status', '00000000')).toBe(2);
  });
});
