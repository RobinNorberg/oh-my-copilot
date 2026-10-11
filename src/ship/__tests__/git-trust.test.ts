import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { defaultExec, guardExec, type Exec } from '../exec.js';
import { loadBaseKnownFlaky, loadTrustedShipConfig, readBaseFile, resolveShipConfig } from '../config.js';
import { evaluateChecks } from '../gates.js';
import { decideMerge, listChangedFiles, protectedChanges, readCommitsSinceReview } from '../merge.js';
import { runPrepare } from '../prepare.js';
import { createShipState, recordVerdict, sealShipState, transition } from '../state.js';

/**
 * The trust layer against a real git: replace refs, injected git config and
 * renames, run through defaultExec (scrubbed environment) behind the guard.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe('trusted reads against a real git', () => {
  let dir: string;
  let up: string;
  let clone: string;
  let baseSha: string;
  const exec = guardExec(defaultExec);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-ship-git-'));
    up = join(dir, 'up');
    clone = join(dir, 'clone');
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'dev');
    write(up, '.copilot/omg.jsonc', '{ "ship": { "allowAdminMerge": false } }\n');
    write(up, '.github/known-flaky-tests.json', '{ "tests": [] }\n');
    write(up, '.github/workflows/ci.yml', 'name: CI\n');
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'base');
    baseSha = git(up, 'rev-parse', 'HEAD');
    git(dir, 'clone', '-q', up, clone);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('H1: `git replace <config blob> <evil>` in the checkout does not change what the trusted read sees', () => {
    const good = git(clone, 'rev-parse', `${baseSha}:.copilot/omg.jsonc`);
    const evil = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: clone, encoding: 'utf8', input: '{ "ship": { "allowAdminMerge": true, "advisoryChecks": ["Test"] } }\n',
    }).trim();
    const flakyGood = git(clone, 'rev-parse', `${baseSha}:.github/known-flaky-tests.json`);
    const flakyEvil = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: clone, encoding: 'utf8', input: '{ "tests": [{ "file": "src/a.test.ts", "title": "anything" }] }\n',
    }).trim();
    git(clone, 'replace', good, evil);
    git(clone, 'replace', flakyGood, flakyEvil);
    try {
      // The attack works against a plain read...
      expect(git(clone, 'show', 'origin/dev:.copilot/omg.jsonc')).toContain('"allowAdminMerge": true');
      // ...but not against the engine's.
      const config = loadTrustedShipConfig({ exec, root: clone, base: 'dev', baseSha, repoUrl: up, strict: true, user: null, project: {}, warn: () => {} });
      expect(config.allowAdminMerge).toBe(false);
      expect(config.advisoryChecks).not.toContain('Test');
      expect(config.trustedBaseCommit).toBe(baseSha);
      expect(loadBaseKnownFlaky(exec, clone, config.trustedBaseCommit, config.knownFlakyFile)).toEqual([]);
    } finally {
      git(clone, 'replace', '-d', good);
      git(clone, 'replace', '-d', flakyGood);
    }
  });

  it('a file absent at the base commit reads as null; an unknown commit throws', () => {
    expect(readBaseFile(exec, clone, baseSha, 'nope.json')).toBeNull();
    write(clone, 'untracked.json', '{}');
    try {
      expect(readBaseFile(exec, clone, baseSha, 'untracked.json')).toBeNull();
    } finally {
      rmSync(join(clone, 'untracked.json'));
    }
    expect(() => readBaseFile(exec, clone, 'e'.repeat(40), '.copilot/omg.jsonc')).toThrow(/base commit eeeeeeeeeeee is not in the local object store/);
  });

  it('H1: a base sha GitHub did not report fails closed', () => {
    const other = 'e'.repeat(40);
    expect(() => loadTrustedShipConfig({ exec, root: clone, base: 'dev', baseSha: other, repoUrl: up, strict: true, user: null, project: {}, warn: () => {} }))
      .toThrow(/refs\/remotes\/origin\/dev is [0-9a-f]{40}, but GitHub reports dev at e{40}.*fail closed/);
  });

  it('H1: injected GIT_CONFIG_* variables never reach the engine\'s git', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'ship.probe', GIT_CONFIG_VALUE_0: 'injected' });
      expect(execFileSync('git', ['config', '--get', 'ship.probe'], { cwd: clone, encoding: 'utf8' }).trim()).toBe('injected');
      const res = defaultExec('git', ['config', '--get', 'ship.probe'], { cwd: clone });
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
    } finally {
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('H3: a rename out of .github/workflows/, a non-ASCII path and 350 files are all listed', () => {
    git(clone, 'checkout', '-q', '-b', 'feat/x');
    mkdirSync(join(clone, 'docs'));
    git(clone, 'mv', '.github/workflows/ci.yml', 'docs/ci.yml');
    const nonAscii = 'src/ünïcödé-名前.ts';
    write(clone, nonAscii, 'export {};\n');
    for (let i = 0; i < 350; i++) write(clone, `src/gen/f${i}.ts`, `export const f${i} = ${i};\n`);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'move ci out of workflows');
    const head = git(clone, 'rev-parse', 'HEAD');

    // What gh pr diff --name-only showed: rename detection hides the old path.
    expect(git(clone, 'diff', '--name-only', '-M', `${baseSha}...${head}`).split('\n')).not.toContain('.github/workflows/ci.yml');

    const files = listChangedFiles(exec, clone, baseSha, head);
    expect(files).not.toBeNull();
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('docs/ci.yml');
    expect(files).toContain(nonAscii);
    expect(files).toHaveLength(353);
    expect(protectedChanges(files!)).toEqual(['.github/workflows/ci.yml']);
    // Any read failure is null (fail closed).
    expect(listChangedFiles(exec, clone, 'f'.repeat(40), head)).toBeNull();
    expect(listChangedFiles(exec, clone, 'origin/dev', head)).toBeNull();
  });
});

describe('prepare and merge against a real git: the base is GitHub\'s sha, from the PR\'s repository', () => {
  /** Real git through the guard; repo scripts (node) are stubbed as passing. */
  const exec = guardExec(((cmd, args, opts) => (/node(\.exe)?$/i.test(cmd)
    ? { status: 0, stdout: '', stderr: '' }
    : defaultExec(cmd, args, opts))) as Exec);
  const T = '2026-10-11T00:00:00.000Z';
  const config = resolveShipConfig({ requiredChecks: ['Test'] });
  const green = evaluateChecks(9, [{ name: 'Test', state: 'SUCCESS' }], config);
  let dir: string;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `up` (GitHub) with dev at `baseSha`, which moved past the PR's fork point;
   * `clone` on feat/x at `reviewed` (the approved commit); `evil`, a commit
   * only in the clone, branched from the old base.
   */
  function setup(name: string) {
    dir ??= mkdtempSync(join(tmpdir(), 'omg-ship-prep-'));
    const up = join(dir, `${name}-up`);
    const clone = join(dir, `${name}-clone`);
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'dev');
    write(up, 'a.txt', 'a\n');
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'base');
    git(dir, 'clone', '-q', up, clone);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(clone, 'config', k, v);
    git(clone, 'checkout', '-q', '-b', 'feat/x');
    write(clone, 'feature.txt', 'feature\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'feature');
    const reviewed = git(clone, 'rev-parse', 'HEAD');
    write(up, 'b.txt', 'b\n');
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'base moved');
    const baseSha = git(up, 'rev-parse', 'HEAD');
    git(clone, 'checkout', '-q', '-b', 'evil', 'origin/dev');
    write(clone, 'evil.txt', 'evil\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'evil');
    const evil = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'checkout', '-q', 'feat/x');
    return { up, clone, reviewed, baseSha, evil };
  }

  function approvedState(reviewed: string, housekeeping: string[]) {
    let s = createShipState({ pr: 9, base: 'dev', branch: 'feat/x', implementer: 'executor-1', maxFixRounds: 2 }, T);
    s = recordVerdict(s, { reviewer: 'verifier-1', verdict: 'approve', sha: reviewed, at: T });
    s = transition({ ...s, housekeepingCommits: housekeeping }, 'gates', 'prepared', T);
    return sealShipState(transition(s, 'ready', 'green', T));
  }

  function decide(clone: string, reviewed: string, baseSha: string, housekeeping: string[]) {
    const head = git(clone, 'rev-parse', 'HEAD');
    const since = readCommitsSinceReview(exec, clone, reviewed, head, baseSha, housekeeping);
    return decideMerge({
      state: approvedState(reviewed, housekeeping),
      pr: { number: 9, state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefOid: head },
      gate: green,
      changedFiles: [],
      ...since,
    });
  }

  it('the legitimate path: merges GitHub\'s base sha, and merge accepts the recorded merge', () => {
    const { up, clone, reviewed, baseSha } = setup('ok');
    const r = runPrepare({ exec, cwd: clone, base: 'dev', branch: 'feat/x', reviewedSha: reviewed, baseSha, repoUrl: up, checks: false });
    expect(r.ok, r.blockedReason).toBe(true);
    expect(r.housekeepingCommits).toHaveLength(1);
    expect(git(clone, 'rev-parse', 'HEAD^2')).toBe(baseSha);
    expect(decide(clone, reviewed, baseSha, r.housekeepingCommits)).toMatchObject({ ok: true, reasons: [] });
  });

  it('a tag named origin/dev does not shadow the base: the merge takes GitHub\'s sha', () => {
    const { up, clone, reviewed, baseSha, evil } = setup('tag');
    git(clone, 'fetch', '-q', 'origin', 'dev');
    git(clone, 'tag', 'origin/dev', evil);
    // The attack works against a ref-name merge...
    expect(git(clone, 'rev-parse', 'origin/dev^{commit}')).toBe(evil);
    // ...but not against the engine's.
    const r = runPrepare({ exec, cwd: clone, base: 'dev', branch: 'feat/x', reviewedSha: reviewed, baseSha, repoUrl: up, checks: false });
    expect(r.ok, r.blockedReason).toBe(true);
    expect(git(clone, 'rev-parse', 'HEAD^2')).toBe(baseSha);
    expect(() => git(clone, 'merge-base', '--is-ancestor', evil, 'HEAD')).toThrow();
    expect(decide(clone, reviewed, baseSha, r.housekeepingCommits).ok).toBe(true);
  });

  it('remote.origin.url pointing at another repository (or rewritten by insteadOf) is refused before any fetch', () => {
    const { up, clone, reviewed, baseSha } = setup('url');
    const other = join(dir, 'url-other');
    git(dir, 'clone', '-q', '--bare', up, other);
    const before = git(clone, 'rev-parse', 'HEAD');

    git(clone, 'remote', 'set-url', 'origin', other);
    const r = runPrepare({ exec, cwd: clone, base: 'dev', branch: 'feat/x', reviewedSha: reviewed, baseSha, repoUrl: up, checks: false });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(/^remote: remote origin points at .*url-other, but the PR is in .*url-up/);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => loadTrustedShipConfig({ exec, root: clone, base: 'dev', baseSha, repoUrl: up, strict: true, user: null, project: {}, warn: () => {} }))
      .toThrow(/remote origin points at .*url-other.*fail closed/);

    // The configured URL is right, but insteadOf rewrites what fetch really uses.
    git(clone, 'remote', 'set-url', 'origin', up);
    git(clone, 'config', `url.${other}.insteadOf`, up);
    const rewritten = runPrepare({ exec, cwd: clone, base: 'dev', branch: 'feat/x', reviewedSha: reviewed, baseSha, repoUrl: up, checks: false });
    expect(rewritten.blockedReason).toMatch(/^remote: remote origin points at .*url-other/);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('merge refuses a recorded housekeeping merge whose second parent is not in GitHub\'s base history', () => {
    const { clone, reviewed, baseSha, evil } = setup('forged');
    git(clone, 'fetch', '-q', 'origin', 'dev');
    // What the old ref-name prepare produced with a shadowing tag: a merge of the lane's commit, recorded as housekeeping.
    git(clone, 'merge', '-q', '--no-ff', '--no-edit', evil);
    const forged = git(clone, 'rev-parse', 'HEAD');
    const d = decide(clone, reviewed, baseSha, [forged]);
    expect(d.ok).toBe(false);
    expect(d.reasons.join('\n')).toMatch(new RegExp(`housekeeping merge ${forged.slice(0, 12)} brings in ${evil.slice(0, 12)}, which is not in GitHub's base history`));
  });
});
