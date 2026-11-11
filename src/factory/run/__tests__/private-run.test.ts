/**
 * private-run.ts (item 2 B1b): the engine side of the private layout with
 * real git in temp dirs: run start, the import section around a push (guard,
 * imports, re-check against the pre-import baseline), refusals and their
 * parks, the layout keys, the lane deny list. No Copilot session, no network.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultExec, type Exec } from '../../../ship/exec.js';
import type { FactoryRunState } from '../state.js';
import { gitVersionProblem, printableKey, type UserRepoGuard } from '../private-store.js';
import { IMPORT_REFUSED_GATE, PrivateRun, REPO_GUARD_GATE, resolveGateInstall, resolveRunLayout } from '../private-run.js';

const T = 240_000;

let dir: string;
let emptyGlobal: string;
let root: string;
let base: string;
let work: string;

/** Plain git for fixtures and controls, the developer's own config kept out. */
function g(cwd: string, args: string[], o: { input?: string; env?: Record<string, string>; allowFail?: boolean } = {}): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input: o.input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobal, ...o.env } });
  if (r.status !== 0 && !o.allowFail) throw new Error(`git ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** A commit in `gitDir` on `parents` with `files` changed (content, or a mode and oid). */
function mkCommit(gitDir: string, parents: string[], files: Array<{ path: string; content?: string; mode?: string; oid?: string }>): string {
  const index = join(dir, `idx-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  g(dir, [`--git-dir=${gitDir}`, 'read-tree', parents[0]], { env });
  for (const f of files) {
    const oid = f.oid ?? g(dir, [`--git-dir=${gitDir}`, 'hash-object', '-w', '--stdin'], { input: f.content ?? '' });
    g(dir, [`--git-dir=${gitDir}`, 'update-index', '--add', '--cacheinfo', `${f.mode ?? '100644'},${oid},${f.path}`], { env });
  }
  const tree = g(dir, [`--git-dir=${gitDir}`, 'write-tree'], { env });
  rmSync(index, { force: true });
  return g(dir, [`--git-dir=${gitDir}`, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, ...parents.flatMap((x) => ['-p', x]), '-m', 'lane']);
}

function writeHook(hooksDir: string, name: string, marker: string): void {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, name), `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n`);
  chmodSync(join(hooksDir, name), 0o755);
}

function create(): PrivateRun {
  return PrivateRun.create({ root, omcRoot: join(root, '.omg'), slug: 'issue-7', repoUrl: 'https://github.com/o/r', userConfig: { factory: { run: { workDir: work } } }, ledgerDir: join(dir, 'ledger') }, base).run;
}

/** publishImports with a baseline the test holds; body pushes nothing unless told. */
function publish(p: PrivateRun, sha: string, parents: string[], start: string, o: { baseline?: UserRepoGuard; body?: () => { parked: boolean; pushed: boolean } } = {}) {
  let n = 0;
  const set: UserRepoGuard[] = [];
  const out = p.publishImports({
    steps: [{ sha, parents, start }], slug: 'issue-7', nextImport: () => n++, baseline: o.baseline, setBaseline: (b) => set.push(b),
    extraProtected: [], what: 'the lane commit', resume: 'omg factory run 7', cancel: 'omg factory run cancel 7',
    body: o.body ?? (() => ({ parked: false, pushed: false })), pushed: (v) => v.pushed,
  });
  return { out, set };
}

const importRefs = () => g(root, ['for-each-ref', '--format=%(refname)', 'refs/omg-import/']);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-private-run-'));
  emptyGlobal = join(dir, 'global.gitconfig');
  writeFileSync(emptyGlobal, '');
  root = join(dir, 'user');
  work = join(dir, 'fw');
  g(dir, ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'a.txt'), 'a\n');
  g(root, ['add', '.']);
  g(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  base = g(root, ['rev-parse', 'HEAD']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the layout keys and small helpers', () => {
  it('reads factory.run.layout and gateInstall from the user config, then the base config; refuses other values', () => {
    expect(resolveRunLayout(undefined, undefined)).toEqual({ layout: 'shared', source: 'default' });
    expect(resolveRunLayout({ factory: { run: { layout: 'private' } } }, { factory: { run: { layout: 'shared' } } })).toEqual({ layout: 'private', source: 'user config' });
    expect(resolveRunLayout(null, { factory: { run: { layout: 'private' } } })).toEqual({ layout: 'private', source: 'the base .copilot/omg.jsonc' });
    expect(() => resolveRunLayout({ factory: { run: { layout: 'separate' } } }, undefined)).toThrow(/factory\.run\.layout must be "shared" or "private"/);
    expect(resolveGateInstall(undefined, undefined)).toEqual({ mode: 'park', source: 'default' });
    expect(resolveGateInstall(undefined, { factory: { run: { gateInstall: 'sandboxed' } } }).mode).toBe('sandboxed');
    expect(() => resolveGateInstall({ factory: { run: { gateInstall: 'npm' } } }, undefined)).toThrow(/gateInstall must be "park" or "sandboxed"/);
  });

  it('requires git 2.44 (GIT_NO_LAZY_FETCH)', () => {
    const v = (out: string): Exec => () => ({ status: 0, stdout: out, stderr: '' });
    expect(gitVersionProblem(v('git version 2.43.5\n'))).toMatch(/needs git 2\.44 or later \(GIT_NO_LAZY_FETCH\), and this git is 2\.43/);
    expect(gitVersionProblem(v('git version 2.44.0.windows.1\n'))).toBeNull();
    expect(gitVersionProblem(v('git version 3.0.0\n'))).toBeNull();
    expect(gitVersionProblem(() => ({ status: 1, stdout: '', stderr: 'nope' }))).toMatch(/could not be read/);
  });

  it('review-481c N4: a URL query in a config key name is masked like userinfo', () => {
    expect(printableKey('url.https://h/?t=SECRET.insteadof')).toBe('url.https://h/?***.insteadof');
    expect(printableKey('url.https://user:tok@h/x?a=b#c.pushinsteadof')).toBe('url.https://***@h/x?***.pushinsteadof');
    expect(printableKey('filter.lfs.smudge')).toBe('filter.lfs.smudge');
  });
});

describe('PrivateRun', () => {
  it('run start makes the seed and the private clone under the work root; a lane worktree is detached at its start, with a deny list of the rest', () => {
    const p = create();
    expect(p.layout.runDir.startsWith(work)).toBe(true);
    expect(existsSync(p.layout.seed)).toBe(true);
    expect(g(p.repo.repo, [`--git-dir=${p.repo.gitDir}`, 'rev-parse', 'HEAD'])).toBe(base);
    const w1 = p.worktreePath(1);
    p.addWorktree(w1, base);
    expect(g(w1, ['rev-parse', 'HEAD'])).toBe(base);
    expect(g(w1, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).toBe('');
    expect(p.recordedGitDir(w1)?.startsWith(join(p.repo.gitDir, 'worktrees'))).toBe(true);
    p.addWorktree(p.worktreePath(2), base);
    const denied = p.deniedFor(w1);
    expect(denied).toContain(p.layout.seed);
    expect(denied).toContain(p.worktreePath(2));
    expect(denied).not.toContain(w1);
    expect(denied).not.toContain(p.layout.runDir);
    // Nothing of the store went into the user repository: no worktree, no ref.
    expect(existsSync(join(root, '.git', 'worktrees'))).toBe(false);
    expect(g(root, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
  }, T);

  it('imports one engine commit around the body, drops the import ref, and takes the new guard baseline', () => {
    const p = create();
    const sha = mkCommit(p.repo.gitDir, [base], [{ path: 'src/greet.js', content: 'hi\n' }]);
    const { out, set } = publish(p, sha, [base], base, { body: () => {
      // The body (the engine's checks and push) sees the commit in the user repository.
      expect(g(root, ['cat-file', '-t', sha])).toBe('commit');
      return { parked: false, pushed: true };
    } });
    expect(out).toEqual({ ok: true, value: { parked: false, pushed: true } });
    expect(importRefs()).toBe('');
    expect(set).toHaveLength(1);
  }, T);

  it('refuses wrong parents, a protected path and a gitlink with a park naming the command to continue or cancel; nothing reaches the body', () => {
    const p = create();
    let ran = 0;
    const body = () => { ran++; return { parked: false, pushed: true }; };
    const ok = mkCommit(p.repo.gitDir, [base], [{ path: 'b.txt', content: 'b\n' }]);
    const wrong = publish(p, ok, [], base, { body }).out;
    expect(wrong).toMatchObject({ ok: false, pushed: false, park: { name: IMPORT_REFUSED_GATE } });
    expect(!wrong.ok && wrong.park.reason).toMatch(/does not have exactly the expected parents; nothing of it was pushed\. Inspect the run's private repository .*omg factory run cancel 7/);
    const prot = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: '.github/workflows/ci.yml', content: 'x\n' }]), [base], base, { body }).out;
    expect(prot).toMatchObject({ ok: false, park: { name: 'protected-paths' } });
    expect(!prot.ok && prot.park.reason).toMatch(/changes a protected path; nothing of it was pushed\. .*omg factory run cancel 7/);
    const link = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'sub', mode: '160000', oid: base }]), [base], base, { body }).out;
    expect(!link.ok && link.park.reason).toMatch(/adds or changes a gitlink/);
    expect(ran).toBe(0);
    expect(importRefs()).toBe('');
  }, T);

  it('a hook planted in the private repository never runs: the import refuses (control: plain git runs it)', () => {
    const p = create();
    const sha = mkCommit(p.repo.gitDir, [base], [{ path: 'b.txt', content: 'b\n' }]);
    const marker = join(dir, 'hook-ran');
    writeHook(join(p.repo.gitDir, 'hooks'), 'reference-transaction', marker);
    const { out } = publish(p, sha, [base], base);
    expect(out).toMatchObject({ ok: false, park: { name: IMPORT_REFUSED_GATE } });
    expect(!out.ok && out.park.reason).toMatch(/config, hooks or info changed since the engine wrote them/);
    expect(existsSync(marker)).toBe(false);
    expect(() => p.gitOk(['rev-parse', 'HEAD'], 'a read')).toThrow(/changed since the engine wrote them/);
    expect(existsSync(marker)).toBe(false);
    // Control: the same repository with plain git runs the hook.
    g(p.repo.repo, [`--git-dir=${p.repo.gitDir}`, 'update-ref', 'refs/control', base]);
    expect(existsSync(marker)).toBe(true);
  }, T);

  it('a guard change before the import parks with the kind and path, and says your own change does it too and a rerun continues', () => {
    const p = create();
    const first = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'y', content: 'y\n' }]), [base], base);
    expect(first.out.ok).toBe(true);
    const guard = first.set[0];
    writeHook(join(root, '.git', 'hooks'), 'post-commit', join(dir, 'unused'));
    let ran = 0;
    const { out, set } = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'z', content: 'z\n' }]), [base], base, { baseline: guard, body: () => { ran++; return { parked: false, pushed: true }; } });
    expect(out).toMatchObject({ ok: false, pushed: false, park: { name: REPO_GUARD_GATE } });
    const reason = !out.ok ? out.park.reason : '';
    expect(reason).toContain(`your repository's hooks dir: ${join(root, '.git', 'hooks')} changed during the run`);
    expect(reason).toMatch(/Your own change does this too .*rerunning omg factory run 7 continues/);
    expect(ran).toBe(0);
    expect(set).toEqual([]);
  }, T);

  it('a guard change during the push parks after it against the PRE-import baseline, and no new baseline is taken', () => {
    const p = create();
    const first = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'y', content: 'y\n' }]), [base], base);
    const guard = first.set[0];
    const { out, set } = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'z', content: 'z\n' }]), [base], base, { baseline: guard, body: () => {
      g(root, ['config', 'core.hooksPath', '.husky']);
      return { parked: false, pushed: true };
    } });
    expect(out).toMatchObject({ ok: false, pushed: true, park: { name: REPO_GUARD_GATE } });
    expect(!out.ok && out.park.reason).toMatch(/^the lane commit was pushed, and then your repository's config key core\.hookspath in: .*config/);
    expect(set).toEqual([]);
    expect(importRefs()).toBe('');
  }, T);

  it('review-483 HIGH-1: run start refuses a guard item that can never compare (a hook over 1 MiB, core.hooksPath at the root, an unreadable include), naming it; nothing is made', () => {
    const layout = PrivateRun.runLayout({ root, omcRoot: join(root, '.omg'), slug: 'issue-7', repoUrl: 'https://github.com/o/r', userConfig: { factory: { run: { workDir: work } } } });
    const refused = (setup: () => void, what: RegExp) => {
      setup();
      expect(() => create()).toThrow(what);
      // Nothing was made: no seed, no run dir, no import ref.
      expect(existsSync(layout.seed)).toBe(false);
      expect(existsSync(layout.runDir)).toBe(false);
      expect(importRefs()).toBe('');
    };
    const big = join(root, '.git', 'hooks', 'pre-commit');
    refused(() => writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x61)), /import guard cannot compare your repository's hooks dir too large to compare \(.*\): .*hooks, so every import would park; fix it \(.*keep hook files under 1 MiB/);
    rmSync(big);
    refused(() => g(root, ['config', 'core.hooksPath', '.']), /core\.hooksPath at the work tree root or the git dir: .*so every import would park/);
    g(root, ['config', '--unset', 'core.hooksPath']);
    // A conditional include git never follows (its condition is false) that the guard cannot read to the end: it includes itself.
    const loop = join(dir, 'loop.gitconfig').replace(/\\/g, '/');
    writeFileSync(loop, `[include]\n\tpath = ${loop}\n`);
    refused(() => g(root, ['config', 'includeIf.gitdir:/nowhere/at/all/.path', loop]), /unreadable config, include or git state: .*loop\.gitconfig.*so every import would park/);
  }, T);

  it('review-483 HIGH-1 control: an ordinary repository (husky hooks path, git lfs hooks) starts, and a stuck item later parks without "rerunning continues"', () => {
    mkdirSync(join(root, '.husky'));
    writeHook(join(root, '.husky'), 'pre-commit', join(dir, 'unused'));
    g(root, ['config', 'core.hooksPath', '.husky']);
    for (const h of ['pre-push', 'post-checkout', 'post-commit', 'post-merge']) {
      writeFileSync(join(root, '.git', 'hooks', h), `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || exit 2\ngit lfs ${h} "$@"\n`);
    }
    g(root, ['config', 'filter.lfs.process', 'git-lfs filter-process']);
    const p = create();
    const first = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'y', content: 'y\n' }]), [base], base);
    expect(first.out.ok).toBe(true);
    // The user points core.hooksPath at the root during the run: the park says what to fix, not that a rerun continues.
    g(root, ['config', 'core.hooksPath', '.']);
    const { out } = publish(p, mkCommit(p.repo.gitDir, [base], [{ path: 'z', content: 'z\n' }]), [base], base, { baseline: first.set[0] });
    expect(out).toMatchObject({ ok: false, park: { name: REPO_GUARD_GATE } });
    const reason = !out.ok ? out.park.reason : '';
    expect(reason).toMatch(/The guard cannot compare your repository's core\.hooksPath at the work tree root or the git dir: .* at all, so every import parks while it stays\. Fix it \(.*\), then rerun omg factory run 7; or omg factory run cancel 7 stops the run/);
    expect(reason).not.toMatch(/rerunning .* continues/);
  }, T);

  it('review-483 M5 + L4: a resume requires the recorded dir to be where the config puts it, and git 2.44 still', () => {
    const made = PrivateRun.create({ root, omcRoot: join(root, '.omg'), slug: 'issue-7', repoUrl: 'https://github.com/o/r', userConfig: { factory: { run: { workDir: work } } }, ledgerDir: join(dir, 'ledger') }, base);
    const state = { layout: 2, privateDir: made.run.layout.runDir, privateStore: made.record, baseSha: base, repoUrl: 'https://github.com/o/r' } as unknown as FactoryRunState;
    const input = { root, omcRoot: join(root, '.omg'), slug: 'issue-7', userConfig: { factory: { run: { workDir: work } } }, ledgerDir: join(dir, 'ledger') };
    expect(PrivateRun.fromState(state, input).layout.runDir).toBe(made.run.layout.runDir);
    // A tampered record (another dir under the work root, or outside it) or a changed work root: refused, nothing touched.
    for (const privateDir of [join(work, 'x', 'issue-7'), join(dir, 'elsewhere'), join(made.run.layout.repoDir, 'issue-8')]) {
      expect(() => PrivateRun.fromState({ ...state, privateDir }, input)).toThrow(/the run's recorded private dir .* is not .*, so nothing was resumed or removed/);
    }
    expect(() => PrivateRun.fromState(state, { ...input, userConfig: { factory: { run: { workDir: join(dir, 'fw2') } } } })).toThrow(/is not .*fw2/);
    expect(() => PrivateRun.fromState(state, { ...input, slug: 'issue-8' })).toThrow(/is not .*issue-8/);
    // A git downgraded since the run started.
    const old: Exec = (cmd, args, o) => (args[0] === '--version' ? { status: 0, stdout: 'git version 2.43.0\n', stderr: '' } : defaultExec(cmd, args, o));
    expect(() => PrivateRun.fromState(state, { ...input, exec: old })).toThrow(/needs git 2\.44 or later/);
    expect(existsSync(made.run.layout.runDir)).toBe(true);
  }, T);

  it('run start again (resume) deletes this run\'s stale import refs and leftover trash', () => {
    const p = create();
    g(root, ['update-ref', 'refs/omg-import/issue-7/3', base]);
    g(root, ['update-ref', 'refs/omg-import/issue-8/1', base]);
    mkdirSync(join(p.layout.repoDir, '.trash-0123456789abcdef', 'x'), { recursive: true });
    p.resumeSweep('issue-7');
    expect(importRefs()).toBe('refs/omg-import/issue-8/1');
    expect(existsSync(join(p.layout.repoDir, '.trash-0123456789abcdef'))).toBe(false);
  }, T);
});
