/**
 * Git hardening from the store audit (item 3): replace refs and grafts, the
 * engine's pinned config, the local forge mirror's receive-pack (its hooks
 * and config), and the snapshot's object store metadata. Real git.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultExec, type Exec } from '../../../ship/exec.js';
import { hostGitEnv, runHostGit } from '../../../team/git-worktree.js';
import { FactorySafetyError, gitHardeningArgs, hardenedGitExec, mirrorReceivePackArg } from '../exec.js';
import { compareSnapshots, objectStoreMetaHash, replaceObjectsProblem, snapshotRepo } from '../review-guard.js';
import { gitIn } from './fake-lanes.js';

let dir: string;
let root: string;
let hooks: string;

const git = (...args: string[]) => gitIn(root, ...args);
const commitEmpty = (msg: string) => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-git-hardening-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  gitIn(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'hi\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  hooks = join(dir, 'empty-hooks');
  mkdirSync(hooks);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('replace refs and grafts (M1)', () => {
  it('host git ignores a planted replace ref and info/grafts', () => {
    const one = git('rev-parse', 'HEAD');
    const two = commitEmpty('two');
    const other = commitEmpty('other');
    git('replace', two, other);
    git('update-ref', 'refs/heads/main', two);
    // Plain git follows the replacement; host git reads the real commit.
    expect(git('rev-parse', `${two}^{tree}`)).toBe(git('rev-parse', `${other}^{tree}`));
    expect(runHostGit(root, ['log', '-1', '--format=%s', two]).trim()).toBe('two');
    // A graft that cuts `two` off from its parent: git honours it even under GIT_NO_REPLACE_OBJECTS.
    git('replace', '-d', two);
    writeFileSync(join(root, '.git', 'info', 'grafts'), `${two}\n`);
    expect(gitIn(root, 'rev-list', '--count', two)).toBe('1');
    expect(runHostGit(root, ['rev-list', '--count', two]).trim()).toBe('2');
    expect(runHostGit(root, ['merge-base', '--is-ancestor', one, two])).toBe('');
  });

  it('hostGitEnv pins GIT_NO_REPLACE_OBJECTS and a missing GIT_GRAFT_FILE, and drops GIT_REPLACE_REF_BASE', () => {
    const env = hostGitEnv([], { PATH: process.env.PATH, GIT_REPLACE_REF_BASE: 'refs/x/', GIT_NO_REPLACE_OBJECTS: '0', GIT_GRAFT_FILE: join(root, 'g') });
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(env.GIT_REPLACE_REF_BASE).toBeUndefined();
    expect(env.GIT_GRAFT_FILE).not.toBe(join(root, 'g'));
    expect(existsSync(env.GIT_GRAFT_FILE!)).toBe(false);
  });

  it('replaceObjectsProblem finds loose and packed replace refs and info/grafts, and nothing in a clean repo', () => {
    const exec = defaultExec;
    expect(replaceObjectsProblem(exec, root)).toBeNull();
    const two = commitEmpty('two');
    const other = commitEmpty('other');
    git('replace', two, other);
    expect(replaceObjectsProblem(exec, root)).toMatch(new RegExp(`replace refs or grafts \\(refs/replace/${two}`));
    git('pack-refs', '--all');
    expect(existsSync(join(root, '.git', 'refs', 'replace', two))).toBe(false);
    expect(replaceObjectsProblem(exec, root)).toMatch(/refs\/replace\//);
    git('replace', '-d', two);
    expect(replaceObjectsProblem(exec, root)).toBeNull();
    writeFileSync(join(root, '.git', 'info', 'grafts'), `${two}\n`);
    expect(replaceObjectsProblem(exec, root)).toMatch(/info[\\/]grafts/);
  });
});

describe('the engine git pins (M2, L2)', () => {
  const seen: Array<{ args: string[]; env?: Readonly<Record<string, string>> }> = [];
  const recorder: Exec = (_cmd, args, opts) => { seen.push({ args, env: opts?.env }); return { status: 0, stdout: '', stderr: '' }; };
  beforeEach(() => { seen.length = 0; });

  it('every command reads no commit-graph or MIDX, never repacks, and names a graft file that does not exist', () => {
    hardenedGitExec(recorder, hooks)('git', ['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)], { cwd: root });
    const [call] = seen;
    for (const kv of ['core.commitGraph=false', 'core.multiPackIndex=false', 'gc.auto=0', 'maintenance.auto=false', 'fetch.writeCommitGraph=false', 'protocol.ext.allow=never', `core.hooksPath=${hooks}`]) {
      expect(call.args).toContain(kv);
    }
    expect(call.env?.GIT_GRAFT_FILE).toBe(join(hooks, 'grafts'));
  });

  it('a local-only command blanks LFS smudging and signing; a transport keeps the user setup', () => {
    hardenedGitExec(recorder, hooks)('git', ['worktree', 'add', '-B', 'b', join(dir, 'wt'), 'a'.repeat(40)], { cwd: root });
    hardenedGitExec(recorder, hooks)('git', ['push', 'origin', `${'a'.repeat(40)}:refs/heads/factory/x`], { cwd: root });
    const [local, push] = seen;
    for (const kv of ['commit.gpgSign=false', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false']) expect(local.args).toContain(kv);
    expect(local.env?.GIT_LFS_SKIP_SMUDGE).toBe('1');
    expect(push.args).not.toContain('filter.lfs.smudge=');
    expect(push.args).not.toContain('commit.gpgSign=false');
    expect(push.env?.GIT_LFS_SKIP_SMUDGE).toBeUndefined();
    // credential.helper and core.sshCommand are the user's own for origin.
    expect(push.args.some((a) => /^credential\.helper=|^core\.sshCommand=/.test(a))).toBe(false);
    expect(gitHardeningArgs(hooks)).toEqual(gitHardeningArgs(hooks, 'push'));
  });
});

describe('the local forge mirror push (H1)', () => {
  let mirror: string;
  let marker: string;

  beforeEach(() => {
    mirror = join(dir, 'mirror.git');
    gitIn(dir, 'init', '-q', '--bare', mirror);
    git('remote', 'add', 'omg-local', mirror);
    marker = join(dir, 'hook-ran');
    const script = `#!/bin/sh\necho "$0" >> "${marker.replace(/\\/g, '/')}"\n`;
    mkdirSync(join(mirror, 'hooks'), { recursive: true });
    for (const hook of ['pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction', 'proc-receive']) {
      writeFileSync(join(mirror, 'hooks', hook), script, { mode: 0o755 });
    }
  });

  it('hooks planted in the mirror do not run on the engine push; a plain push to the same mirror runs them', () => {
    const sha = git('rev-parse', 'HEAD');
    const exec = hardenedGitExec(defaultExec, hooks, () => mirror);
    const pushed = exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root });
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(gitIn(dir, '--git-dir', mirror, 'rev-parse', 'refs/heads/main')).toBe(sha);
    expect(existsSync(marker)).toBe(false);
    // Control: the planted hooks are live, so their silence above is the hardening.
    gitIn(root, 'push', '-q', mirror, `${sha}:refs/heads/control`);
    expect(existsSync(marker)).toBe(true);
  });

  it('the receive-pack command carries the empty hooks dir, quoted; a quote in the path is refused', () => {
    expect(mirrorReceivePackArg(hooks)).toBe(`--receive-pack=git -c core.hooksPath='${hooks}' -c core.fsmonitor=false receive-pack`);
    expect(() => mirrorReceivePackArg(join(dir, "it's"))).toThrow(FactorySafetyError);
  });

  it('a mirror config key the engine never writes, or mirror alternates, refuses the transport before it runs', () => {
    const sha = git('rev-parse', 'HEAD');
    const exec = hardenedGitExec(defaultExec, hooks, () => mirror);
    gitIn(dir, 'config', '--file', join(mirror, 'config'), 'core.hooksPath', join(mirror, 'hooks'));
    expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(/sets core\.hookspath/);
    expect(() => exec('git', ['fetch', 'omg-local', 'main'], { cwd: root })).toThrow(/sets core\.hookspath/);
    gitIn(dir, 'config', '--file', join(mirror, 'config'), '--unset', 'core.hooksPath');
    gitIn(dir, 'config', '--file', join(mirror, 'config'), 'include.path', join(dir, 'evil.cfg'));
    expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(/include\.path/);
    gitIn(dir, 'config', '--file', join(mirror, 'config'), '--unset', 'include.path');
    writeFileSync(join(mirror, 'objects', 'info', 'alternates'), `${join(root, '.git', 'objects')}\n`);
    expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(/objects\/info\/alternates/);
    expect(gitIn(dir, '--git-dir', mirror, 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('the snapshot sees what steers ancestry (M2)', () => {
  const exec = defaultExec;

  it('a planted shallow, objects/info/alternates or commit-graph, or a bitmap name, is reported', () => {
    const common = join(root, '.git');
    const plant: Array<() => void> = [
      () => writeFileSync(join(common, 'shallow'), `${git('rev-parse', 'HEAD')}\n`),
      () => writeFileSync(join(common, 'objects', 'info', 'alternates'), `${join(dir, 'elsewhere')}\n`),
      () => writeFileSync(join(common, 'objects', 'info', 'commit-graph'), 'CGPH forged'),
      () => { mkdirSync(join(common, 'objects', 'info', 'commit-graphs'), { recursive: true }); writeFileSync(join(common, 'objects', 'info', 'commit-graphs', 'commit-graph-chain'), 'x\n'); },
      () => { mkdirSync(join(common, 'objects', 'pack'), { recursive: true }); writeFileSync(join(common, 'objects', 'pack', 'multi-pack-index'), 'MIDX'); },
      () => writeFileSync(join(common, 'objects', 'pack', 'pack-1.bitmap'), 'b'),
      () => writeFileSync(join(common, 'objects', 'pack', 'pack-1.promisor'), ''),
    ];
    // Each plant changes the hash (fs only); one full snapshot pair shows the compare reports it.
    const before = snapshotRepo(exec, root);
    let last = before.objectMeta;
    for (const p of plant) {
      p();
      const now = objectStoreMetaHash(common);
      expect(now, String(p)).not.toBe(last);
      last = now;
    }
    expect(compareSnapshots(before, snapshotRepo(exec, root))).toContain('the object store metadata changed (shallow, objects/info/: commit-graph, commit-graphs/, alternates; objects/pack/multi-pack-index, *.bitmap, *.promisor)');
  });

  it('a baseline from an older release (no objectMeta) is not compared on it; an unchanged store passes', () => {
    const before = snapshotRepo(exec, root);
    expect(compareSnapshots(before, snapshotRepo(exec, root))).toEqual([]);
    const { objectMeta: _o, ...old } = before;
    writeFileSync(join(root, '.git', 'shallow'), `${git('rev-parse', 'HEAD')}\n`);
    expect(compareSnapshots(old, snapshotRepo(exec, root))).toEqual([]);
    expect(objectStoreMetaHash(join(root, '.git'))).not.toBe(before.objectMeta);
  });
});
