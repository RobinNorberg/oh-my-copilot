/**
 * `omg port drive` against fixture repos: a fake upstream, a fake fork that
 * shares its history, and a bare `origin`. Real git and the real drift
 * script; the gate scripts, inventory and `gh` are stubbed through the Exec
 * seam, and the reconcile lane is a mock LaneBackend (no live Copilot).
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LaneBackend, LaneResult, LaneStartInput } from '../../factory/run/lane.js';
import type { Exec } from '../../ship/exec.js';
import { DRIFT_SCRIPT, runPortDrive, type PortDriveOptions } from '../engine.js';

const REPO = join(import.meta.dirname, '../../..');
const roots: string[] = [];
const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=dev'];

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function commit(repo: string, message: string, files: Record<string, string | null>): string {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    if (content === null) { rmSync(abs); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const pkg = (version: string, extra: object = {}) => `${JSON.stringify({ name: 'oh-my-claudecode', version, ...extra }, null, 2)}\n`;
/** Header the fork renamed, far enough from upstream's later hunk to apply cleanly. */
const GAP = "// oh-my-claudecode\n// one\n// two\n// three\n// four\n";
const RUNBOOK = '# Port Upstream\n\n## Fork Features to Preserve\n\n- `RecentTools` in HUD\n\n## Key Gotchas\n\n- none\n';

interface Fixture { fork: string; origin: string; head: string; base: string }

function fixture(base: Record<string, string>, forkChange: Record<string, string | null>, change: Record<string, string | null>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'port-drive-'));
  roots.push(root);
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q');
  const baseSha = commit(upstream, 'base', base);
  git(root, 'clone', '-q', upstream, 'fork');
  const fork = join(root, 'fork');
  git(fork, 'config', 'core.autocrlf', 'false');
  git(fork, 'config', 'user.name', 'fixture');
  git(fork, 'config', 'user.email', 'fixture@example.invalid');
  git(fork, 'remote', 'rename', 'origin', 'upstream');
  commit(fork, 'fork', {
    ...forkChange,
    '.gitignore': '.omg/\n*.log\n',
    '.omc/skills/port-upstream.md': RUNBOOK,
    '.github/upstream-port.json': `${JSON.stringify({ upstream_sha: baseSha, upstream_branch: 'dev', ported_at: '2026-10-01', fork_version: '5.0.0' }, null, 2)}\n`,
  });
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', 'origin.git');
  git(fork, 'remote', 'add', 'origin', origin);
  const head = commit(upstream, 'upstream: next', change);
  git(fork, 'fetch', '-q', 'upstream');
  return { fork, origin, head, base: baseSha };
}

interface Harness { calls: string[][]; failGate?: string }

/** git and the drift script run for real; gate scripts, inventory and gh are recorded and stubbed. */
function harnessExec(h: Harness): Exec {
  return (cmd, args, opts) => {
    h.calls.push([cmd, ...args]);
    if (cmd === 'gh') return { status: 0, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' };
    if (cmd === 'git') {
      const r = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8' });
      return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    }
    if (args[0] === DRIFT_SCRIPT) {
      const r = spawnSync(process.execPath, [join(REPO, DRIFT_SCRIPT), ...args.slice(1)], { cwd: opts?.cwd, encoding: 'utf8' });
      return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    }
    if (h.failGate && args.join(' ').includes(h.failGate)) return { status: 1, stdout: '  3:1  error  unused import  no-unused-vars\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

function drive(f: Fixture, h: Harness, extra: Partial<PortDriveOptions> = {}) {
  const events: string[] = [];
  const promise = runPortDrive({
    cwd: f.fork, head: f.head, exec: harnessExec(h), node: 'node', date: '2026-10-28',
    progress: (phase, status, note) => events.push(`${phase} ${status} ${note}`),
    log: () => {},
    ...extra,
  });
  return { events, promise };
}

const lastCommitFiles = (repo: string, rev = 'HEAD') => git(repo, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean).sort();

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('omg port drive: clean range', () => {
  it('applies, drops .gjc, ignores a version-only delta, runs the gates, commits, pushes and opens a draft PR', async () => {
    const f = fixture(
      { 'src/a.ts': `${GAP}export const a = 1;\n`, 'package.json': pkg('1.0.0') },
      { 'src/a.ts': `${GAP.replace('oh-my-claudecode', 'oh-my-copilot')}export const a = 1;\n`, 'package.json': pkg('5.0.0') },
      { 'src/a.ts': `${GAP}export const a = 1;\nexport const b = 'oh-my-claudecode';\n`, 'src/a.test.ts': 'test\n', 'src/__tests__/fixtures/run.log': 'captured\n', '.gjc/session.json': '{}\n', 'package.json': pkg('1.1.0') },
    );
    const h: Harness = { calls: [] };
    const { events, promise } = drive(f, h);
    const r = await promise;
    expect(r.status, r.message).toBe('done');
    expect(r.exitCode).toBe(0);
    expect(r.branch).toBe(`port/upstream-${f.head.slice(0, 9)}`);
    expect(git(f.fork, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(r.branch);
    expect(r.packageDelta).toEqual([{ key: 'version', before: '1.0.0', after: '1.1.0', action: 'ignored' }]);
    expect(r.blockers).toEqual([]);
    // the gitignored `.log` fixture is ported too (a manual `git add -A` port once dropped one)
    expect(lastCommitFiles(f.fork)).toEqual(['.github/upstream-port.json', 'src/__tests__/fixtures/run.log', 'src/a.test.ts', 'src/a.ts']);
    expect(readFileSync(join(f.fork, 'src/a.ts'), 'utf8')).toBe(`${GAP.replace('oh-my-claudecode', 'oh-my-copilot')}export const a = 1;\nexport const b = 'oh-my-copilot';\n`);
    expect(git(f.origin, 'rev-parse', `refs/heads/${r.branch}`)).toBe(git(f.fork, 'rev-parse', 'HEAD'));
    expect(r.gates).toEqual(['tsc', 'eslint', 'path gate', 'prompt projections', 'copilot hooks', 'copilot agents', 'tests']);
    const scripts = h.calls.filter((c) => c[0] === 'node').map((c) => c.slice(1).join(' '));
    expect(scripts).toContain('node_modules/eslint/bin/eslint.js src');
    expect(scripts).toContain('scripts/ci/check-multirepo-paths.mjs');
    expect(scripts).toContain('node_modules/vitest/vitest.mjs run src/a.test.ts');
    const gh = h.calls.find((c) => c[0] === 'gh') as string[];
    expect(gh.slice(1, 7)).toEqual(['pr', 'create', '--draft', '--base', 'dev', '--head']);
    expect(r.pr).toBe('https://github.com/o/r/pull/7');
    expect(h.calls.some((c) => c[0] === 'git' && (c.includes('--force') || c.includes('-f') && c[1] === 'push'))).toBe(false);
    expect(events.at(-1)).toMatch(/^report done draft PR/);
  });

  it('fails the gates on an eslint error and commits nothing', async () => {
    const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'b\n' });
    const before = git(f.fork, 'rev-parse', 'HEAD');
    const r = await drive(f, { calls: [], failGate: 'eslint' }).promise;
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain('eslint failed');
    expect(r.message).toContain('3:1  error  unused import');
    expect(r.next).toContain('--continue');
    expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(before);
  });
});

describe('omg port drive: human gates', () => {
  it('blocks on a scripts/files/deps delta, then --continue finishes after the human staged it', async () => {
    const f = fixture(
      { 'src/a.ts': 'a\n', 'package.json': pkg('1.0.0', { scripts: { test: 'vitest' } }) },
      {},
      { 'src/a.ts': 'b\n', 'package.json': pkg('1.0.1', { scripts: { test: 'vitest run' }, dependencies: { x: '^1.0.0' } }) },
    );
    const h: Harness = { calls: [] };
    const first = await drive(f, h).promise;
    expect(first.status).toBe('blocked');
    expect(first.exitCode).toBe(3);
    expect(first.blockers[0]).toContain('package.json delta needs a human: dependencies.x, scripts.test');
    expect(first.next).toBe(`omg port drive --head ${f.head} --continue`);
    expect(h.calls.some((c) => c[0] === 'gh')).toBe(false);

    const resumed = await drive(f, { calls: [] }, { resume: true }).promise;
    expect(resumed.status, resumed.message).toBe('done');
    expect(lastCommitFiles(f.fork)).toEqual(['.github/upstream-port.json', 'src/a.ts']);
  });

  it('blocks on conflicts without --reconcile-lane and writes a brief with the conflict list and the fork features', async () => {
    const f = fixture({ 'src/a.ts': 'base\n' }, { 'src/a.ts': 'fork\n' }, { 'src/a.ts': 'upstream\n' });
    let started = 0;
    const lanes = () => ({ start: () => { started++; throw new Error('no'); } }) as unknown as LaneBackend;
    const { events, promise } = drive(f, { calls: [] }, { lanes });
    const r = await promise;
    expect(r.status).toBe('blocked');
    expect(started).toBe(0);
    expect(r.brief).toBeTruthy();
    const brief = readFileSync(r.brief as string, 'utf8');
    expect(brief).toContain('- `UU` src/a.ts');
    expect(brief).toContain(`--apply --head ${f.head}`);
    expect(brief).toContain('`RecentTools` in HUD');
    expect(brief).toContain('take THEIRS');
    expect(events.some((e) => e.startsWith('reconcile blocked reconcile: 1 files; brief '))).toBe(true);
  });

  it('never starts the lane for conflicts in src/release (human review before PR)', async () => {
    const f = fixture({ 'src/release/x.ts': 'base\n' }, { 'src/release/x.ts': 'fork\n' }, { 'src/release/x.ts': 'upstream\n' });
    let started = 0;
    const lanes = () => ({ start: () => { started++; throw new Error('no'); } }) as unknown as LaneBackend;
    const r = await drive(f, { calls: [] }, { lanes, reconcileLane: { maxCredits: 30, timeoutMs: 60_000 } }).promise;
    expect(r.status).toBe('blocked');
    expect(started).toBe(0);
    expect(r.blockers[0]).toContain('1 need human review (src/release/x.ts)');
  });

  it('blocks on a leak the rename map could not fix', async () => {
    const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'see github.com/Yeachan-Heo/oh-my-copilot\n' });
    const r = await drive(f, { calls: [] }).promise;
    expect(r.status).toBe('blocked');
    expect(r.blockers.join(' ')).toContain('leak sweep: 1 new');
  });
});

describe('omg port drive: reconcile lane', () => {
  /** A write lane that applies the range in its own worktree, resolves to `resolved`, and commits. */
  function mockLane(f: Fixture, resolved: string, seen: LaneStartInput[]): LaneBackend {
    let headSha: string | null = null;
    const result = (): LaneResult => ({
      state: 'completed', branch: 'lane', pr: null, headSha, baseSha: null, worktree: null, changes: null, finalText: 'staged',
      logsUrl: null, usage: { premiumRequests: 1, credits: 2.5, source: 'measured', detail: '' }, remoteId: 'job-1', error: null, notes: [], process: null,
    });
    return {
      kind: 'local-sdk',
      start: async (input) => {
        seen.push(input);
        const wt = join(dirname(f.fork), 'lane-wt');
        git(f.fork, 'worktree', 'add', '-q', '--detach', wt, input.baseRef);
        spawnSync(process.execPath, [join(REPO, DRIFT_SCRIPT), '--apply', '--head', f.head, '--date', '2026-10-28'], { cwd: wt, encoding: 'utf8' });
        writeFileSync(join(wt, 'src/a.ts'), resolved);
        git(wt, 'add', '-A');
        git(wt, 'commit', '-q', '--no-verify', '-m', 'port: reconcile upstream conflicts');
        headSha = git(wt, 'rev-parse', 'HEAD');
        return { remoteId: 'job-1' };
      },
      poll: async () => result(),
      wait: async () => result(),
      cancel: async () => ({ supported: false, result: result() }),
    };
  }

  it('runs the brief as a capped write lane and adopts its tree into the port commit', async () => {
    const f = fixture(
      { 'src/a.ts': 'base\n', 'src/b.ts': 'b\n' },
      { 'src/a.ts': 'fork\n' },
      { 'src/a.ts': 'upstream\n', 'src/b.ts': 'b2\n', 'src/c.ts': 'c\n' },
    );
    const seen: LaneStartInput[] = [];
    const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', seen), reconcileLane: { maxCredits: 40, timeoutMs: 600_000 } }).promise;
    expect(r.status, r.message).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ profile: 'write', maxCredits: 40, timeoutMs: 600_000 });
    expect(seen[0].prompt).toContain('- `UU` src/a.ts');
    expect(r.laneCredits).toBe(2.5);
    expect(readFileSync(join(f.fork, 'src/a.ts'), 'utf8')).toBe('fork+upstream\n');
    expect(git(f.fork, 'show', 'HEAD:src/c.ts')).toBe('c');
    expect(lastCommitFiles(f.fork)).toEqual(['.github/upstream-port.json', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(existsSync(join(f.fork, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('blocks when the lane leaves conflict markers', async () => {
    const f = fixture({ 'src/a.ts': 'base\n' }, { 'src/a.ts': 'fork\n' }, { 'src/a.ts': 'upstream\n' });
    const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, '<<<<<<< HEAD\nfork\n=======\nupstream\n>>>>>>> x\n', []), reconcileLane: { maxCredits: 30, timeoutMs: 60_000 } }).promise;
    expect(r.status).toBe('blocked');
    expect(r.message).toContain('conflict markers: src/a.ts');
  });
});
