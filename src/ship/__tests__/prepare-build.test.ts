import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeCommand, defaultExec, guardExec, type Exec } from '../exec.js';
import { loadTrustedShipConfig, resolveShipConfig, trustedPrepareBuild } from '../config.js';
import { readCommitsSinceReview } from '../merge.js';
import { BUILD_COMMIT_MESSAGE, PREPARE_BUILD_STEP, PREPARE_CONFIG_STEP, runPrepare } from '../prepare.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A repository on feat/x (one reviewed commit) whose base dev moved on; dist/ is git-ignored but committed, like oh-my-copilot's. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'omg-prepare-build-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'dev');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, 'config', k, v);
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  mkdirSync(join(dir, 'dist'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'dist', 'a.js'), 'old\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'a\n');
  git(dir, 'add', '.gitignore', 'src');
  git(dir, 'add', '-f', 'dist');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'src', 'x.ts'), 'x\n');
  git(dir, 'add', 'src');
  git(dir, 'commit', '-q', '-m', 'feature');
  const reviewed = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'dev');
  writeFileSync(join(dir, 'src', 'b.ts'), 'b\n');
  git(dir, 'add', 'src');
  git(dir, 'commit', '-q', '-m', 'base moves');
  const baseSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'feat/x');
  return { dir, reviewed, baseSha };
}

// `out` is never made: an output the build does not produce is no pathspec (git add would refuse it).
const BUILD = { argv: ['npm', 'run', 'build'], exe: 'npm', args: ['run', 'build'], outputs: ['dist', 'out'] };

function prepare(r: ReturnType<typeof repo>, build: (cwd: string) => number, extra: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const commandExec: Exec = (cmd, args, o) => {
    ran.push(`${cmd} ${args.join(' ')}`);
    return { status: build(o!.cwd!), stdout: '', stderr: '' };
  };
  const result = runPrepare({
    exec: guardExec(defaultExec), cwd: r.dir, base: 'dev', branch: 'feat/x', reviewedSha: r.reviewed, baseSha: r.baseSha,
    repoUrl: undefined, prefetchedBase: true, checks: false, build: BUILD, commandExec, ...extra,
  });
  return { result, ran };
}

describe('ship.prepare.build in prepare', () => {
  it('runs the build after the base merge and commits only the outputs as a housekeeping commit', () => {
    const r = repo();
    const { result, ran } = prepare(r, (cwd) => {
      writeFileSync(join(cwd, 'dist', 'x.js'), 'built x\n');
      writeFileSync(join(cwd, 'dist', 'a.js'), 'new\n');
      return 0;
    });
    expect(result.ok, result.blockedReason).toBe(true);
    expect(ran).toEqual(['npm run build']);
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual(['preflight:ok', 'fetch:ok', 'merge-base:ok', 'build:ok', 'checks:skipped', 'inventory:skipped']);
    expect(result.housekeepingCommits).toHaveLength(2);
    const head = git(r.dir, 'rev-parse', 'HEAD');
    expect(result.housekeepingCommits[1]).toBe(head);
    expect(git(r.dir, 'log', '-1', '--format=%s')).toBe(BUILD_COMMIT_MESSAGE);
    // The ignored dist/x.js is committed (-f), and nothing else.
    expect(git(r.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['dist/a.js', 'dist/x.js']);
    expect(git(r.dir, 'status', '--porcelain')).toBe('');

    // The merge rule accepts the build commit with the trusted outputs, and refuses it without them.
    const housekeeping = result.housekeepingCommits;
    const ok = readCommitsSinceReview(guardExec(defaultExec), r.dir, r.reviewed, head, r.baseSha, housekeeping, ['dist']);
    expect(ok.commitsSinceReview).toHaveLength(2);
    expect([...ok.housekeepingContent.values()]).toEqual([null, null]);
    const without = readCommitsSinceReview(guardExec(defaultExec), r.dir, r.reviewed, head, r.baseSha, housekeeping);
    expect(without.housekeepingContent.get(head)).toMatch(/outside inventory\/: dist\/a\.js, dist\/x\.js/);
  });

  it('a build that leaves the output current makes no commit', () => {
    const r = repo();
    const { result } = prepare(r, () => 0);
    expect(result.ok, result.blockedReason).toBe(true);
    expect(result.steps.find((s) => s.name === PREPARE_BUILD_STEP)).toMatchObject({ status: 'skipped' });
    expect(result.housekeepingCommits).toHaveLength(1);
  });

  it('a build that writes outside its outputs fails prepare and commits nothing', () => {
    const r = repo();
    const { result } = prepare(r, (cwd) => {
      writeFileSync(join(cwd, 'dist', 'x.js'), 'built x\n');
      writeFileSync(join(cwd, 'src', 'a.ts'), 'tampered\n');
      writeFileSync(join(cwd, 'stray.txt'), 'stray\n');
      return 0;
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: PREPARE_BUILD_STEP, status: 'failed' });
    expect(result.blockedReason).toMatch(/outside ship\.prepare\.build\.outputs \(dist, out\).*src\/a\.ts, stray\.txt/);
    expect(git(r.dir, 'log', '-1', '--format=%s')).not.toBe(BUILD_COMMIT_MESSAGE);
    expect(git(r.dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('a failing build fails its step before the checks; one that cannot start fails checks-config', () => {
    const r = repo();
    const { result } = prepare(r, () => 2);
    expect(result.steps.at(-1)).toMatchObject({ name: PREPARE_BUILD_STEP, status: 'failed' });
    const r2 = repo();
    const { result: missing, ran } = prepare(r2, () => 0, { build: { argv: ['npm.cmd'], missing: 'a cmd.exe script', outputs: ['dist'] } });
    expect(missing.steps.at(-1)).toMatchObject({ name: PREPARE_CONFIG_STEP, status: 'failed' });
    expect(ran).toEqual([]);
  });

  it('a build that commits by itself fails prepare', () => {
    const r = repo();
    const { result } = prepare(r, (cwd) => {
      writeFileSync(join(cwd, 'dist', 'x.js'), 'x\n');
      git(cwd, 'add', '-f', 'dist');
      git(cwd, 'commit', '-q', '-m', 'sneaky');
      return 0;
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toMatch(/moved HEAD/);
  });

  it('the merge rule refuses a one-parent housekeeping commit with non-output content', () => {
    const r = repo();
    writeFileSync(join(r.dir, 'dist', 'x.js'), 'x\n');
    writeFileSync(join(r.dir, 'src', 'evil.ts'), 'evil\n');
    git(r.dir, 'add', '-f', 'dist', 'src');
    git(r.dir, 'commit', '-q', '-m', BUILD_COMMIT_MESSAGE);
    const head = git(r.dir, 'rev-parse', 'HEAD');
    const since = readCommitsSinceReview(guardExec(defaultExec), r.dir, r.reviewed, head, r.baseSha, [head], ['dist']);
    expect(since.housekeepingContent.get(head)).toMatch(/outside inventory\/, dist\/: src\/evil\.ts/);
  });
});

describe('ship.prepare.build config', () => {
  it('parses a command and output directories, rejecting anything else', () => {
    expect(resolveShipConfig({}).prepareBuild).toBeUndefined();
    expect(resolveShipConfig({ prepare: { build: { command: ['npm', 'run', 'build'], outputs: ['dist', 'bridge/', 'dist'] } } }).prepareBuild)
      .toEqual({ command: ['npm', 'run', 'build'], outputs: ['dist', 'bridge'] });
    for (const bad of [
      'npm run build', { command: ['npm'] }, { command: [], outputs: ['dist'] }, { command: ['npm'], outputs: [] },
      { command: ['npm'], outputs: ['.'] }, { command: ['npm'], outputs: ['../x'] }, { command: ['npm'], outputs: ['.git'] },
      { command: ['npm'], outputs: ['.GIT/hooks'] }, { command: ['npm'], outputs: ['inventory'] }, { command: ['npm'], outputs: ['/abs'] }, { command: ['npm'], outputs: ['-f'] },
    ]) {
      expect(() => resolveShipConfig({ prepare: { build: bad } }), JSON.stringify(bad)).toThrow(/ship\.prepare\.build must be/);
    }
  });

  it('comes from the user config, else the base, never the working tree or the PR head', () => {
    const user = { ship: { prepare: { build: { command: ['make'], outputs: ['out'] } } } };
    const baseLayer = { ship: { prepare: { build: { command: ['npm', 'run', 'build'], outputs: ['dist'] } } } };
    expect(trustedPrepareBuild(user, baseLayer)).toEqual({ command: ['make'], outputs: ['out'] });
    expect(trustedPrepareBuild(null, baseLayer)).toEqual({ command: ['npm', 'run', 'build'], outputs: ['dist'] });
    expect(trustedPrepareBuild(null, undefined)).toBeUndefined();
    const warnings: string[] = [];
    const loaded = loadTrustedShipConfig({
      exec: () => ({ status: 0, stdout: '', stderr: '' }), root: '/repo', base: 'dev', user: {}, trustedUser: {},
      project: { ship: { prepare: { build: { command: ['node', 'evil.js'], outputs: ['src'] } } } }, warn: (m) => warnings.push(m),
    });
    expect(loaded.prepareBuild).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/ignoring ship\.prepare from the working-tree project config/);
  });

  it('the ship guard admits the build shapes only for plain output directories', () => {
    expect(() => assertSafeCommand('git', ['add', '-f', '-A', '--', 'dist', 'bridge'])).not.toThrow();
    expect(() => assertSafeCommand('git', ['commit', '--no-verify', '-m', BUILD_COMMIT_MESSAGE, '--', 'dist'])).not.toThrow();
    expect(() => assertSafeCommand('git', ['diff', '--cached', '--quiet', '--', 'dist', 'bridge'])).not.toThrow();
    expect(() => assertSafeCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).not.toThrow();
    for (const bad of [['add', '-f', '-A', '--', '.'], ['add', '-f', '-A', '--', '.git'], ['add', '-f', '-A', '--', '../x'], ['add', '-f', '-A', '--'], ['commit', '--no-verify', '-m', BUILD_COMMIT_MESSAGE, '--', ':/'], ['commit', '--no-verify', '-m', 'x', '--', 'dist'], ['add', '-f', '-A', '--', '*']]) {
      expect(() => assertSafeCommand('git', bad), bad.join(' ')).toThrow();
    }
  });
});
