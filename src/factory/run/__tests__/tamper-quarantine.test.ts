/**
 * quarantineTamper on real git dirs (review-484 H1, H2, H3, L5, L6): the
 * allowlist of benign config keys, the per-item quarantine, what stays
 * active and holds. Real git in temp repos, no engine.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultExec } from '../../../ship/exec.js';
import { factoryGuardExec } from '../exec.js';
import { compareSnapshots, RESTORE_SCOPE_KEY, snapshotRepo, type RepoSnapshot } from '../review-guard.js';
import { BENIGN_KEYS, benignChange, benignKey, CONFIG_LOCKED, quarantineTamper, readTamperHold, STILL_ACTIVE, tamperHoldMessage } from '../tamper-quarantine.js';

const exec = factoryGuardExec(defaultExec);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

let dir: string;
let root: string;
let common: string;
let ledgerDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-quarantine-'));
  root = join(dir, 'repo');
  ledgerDir = join(dir, 'ledger');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.invalid');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  common = join(root, '.git');
});

afterEach(() => {
  if (process.platform === 'win32') {
    // A test may leave a file with a deny ACE: drop it so the temp dir can go.
    try { execFileSync('icacls', [dir, '/reset', '/T', '/Q'], { stdio: 'pipe' }); } catch { /* best effort */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

let stamp = 0;
function quarantine(before: RepoSnapshot) {
  const after = snapshotRepo(exec, root, '.omg', before);
  const problems = compareSnapshots(before, after);
  const hold = quarantineTamper({ ledgerDir, root, before, after, refsNow: after.refs, problems, run: '7', gate: 'lane-tampered', at: `2026-11-11T00:00:0${stamp++}.000Z` });
  return { hold, problems };
}

/**
 * A file the current user cannot read (POSIX mode 000; Windows a deny ACE
 * for read-data, or with `strict` for generic read, which also blocks the
 * open a rename needs); false when the platform will not do it.
 */
function makeUnreadable(path: string, strict = false): boolean {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [path, '/deny', `*S-1-1-0:${strict ? '(R)' : '(RD)'}`], { stdio: 'pipe' });
    else execFileSync('chmod', ['000', path]);
  } catch {
    return false;
  }
  try { readFileSync(path); return false; } catch { return true; }
}

describe('H1: config keys are an allowlist', () => {
  it('diff.external (a key the old denylist missed) runs on a plain `git diff`; the quarantine puts the old value back and holds, the user\'s benign key stays', () => {
    git(root, 'config', 'remote.origin.url', 'https://example.invalid/repo.git');
    const before = snapshotRepo(exec, root);
    const marker = join(dir, 'ran.txt');
    const script = join(dir, 'ext.js');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    git(root, 'config', 'diff.external', `node "${script.replace(/\\/g, '/')}"`);
    git(root, 'config', 'branch.main.remote', 'origin');
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    // Control: without the restore the planted program runs on the user's next ordinary git command.
    execFileSync('git', ['diff'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);

    const { hold } = quarantine(before);
    expect(hold.held).toBe(true);
    expect(hold.restored.join('\n')).toMatch(/^config \(diff\.external put back\)$/m);
    expect(git(root, 'config', '--file', join(common, 'config'), '--get-all', 'branch.main.remote')).toBe('origin');
    expect(() => git(root, 'config', '--file', join(common, 'config'), '--get', 'diff.external')).toThrow();
    // The user's version (with the key) is in the quarantine, with the command that puts it back.
    expect(readFileSync(join(hold.quarantine!, 'config'), 'utf8')).toContain('external');
    expect(hold.undo!.join('\n')).toMatch(/config: if the change was yours, put your version back: cp ".*config" ".*config"/);
    expect(readFileSync(join(hold.quarantine!, 'undo.txt'), 'utf8')).toContain('cp "');
    expect(readTamperHold(ledgerDir, root)).not.toBeNull();

    execFileSync('git', ['diff'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(marker)).toBe(false);
  });

  it('only benign keys (user.email, a remote\'s prune option, `git push -u origin feature` with origin unchanged, a pull mode, a description, a removed upstream): left in place, copied, no hold', () => {
    git(root, 'config', 'remote.origin.url', 'https://example.invalid/repo.git');
    git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git(root, 'config', 'branch.old.remote', 'origin');
    git(root, 'config', 'branch.old.merge', 'refs/heads/old');
    const before = snapshotRepo(exec, root);
    git(root, 'config', 'user.email', 'me@example.invalid');
    git(root, 'config', 'remote.fork.prune', 'true');
    git(root, 'config', 'branch.feature.remote', 'origin');
    git(root, 'config', 'branch.feature.merge', 'refs/heads/feature');
    git(root, 'config', 'branch.feature.rebase', 'true');
    git(root, 'config', 'branch.feature.description', 'my work');
    git(root, 'config', '--unset', 'branch.old.merge');
    const configNow = readFileSync(join(common, 'config'));
    const { hold } = quarantine(before);
    expect(hold.held).toBeUndefined();
    expect(hold.kept!.join('\n')).toMatch(/config \(only branch\.feature\.description, branch\.feature\.merge, branch\.feature\.rebase, branch\.feature\.remote, branch\.old\.merge, \.\.\. changed: allowlisted keys that name no program; left as it is; a copy is in /);
    expect(readFileSync(join(common, 'config')).equals(configNow)).toBe(true);
    expect(readTamperHold(ledgerDir, root)).toBeNull();
  });

  it('review-484b 1: remote.origin.url pointed at another repository + a replace-ref refspec are both put back and hold; without that a plain `git fetch` brings the replace ref in', () => {
    // The user's real origin, there before the run.
    const legit = join(dir, 'legit.git');
    git(dir, 'clone', '-q', '--bare', root, legit);
    git(root, 'remote', 'add', 'origin', legit.replace(/\\/g, '/'));
    git(root, 'fetch', '-q', 'origin');
    const victimHead = git(root, 'rev-parse', 'HEAD');
    // The lane's repository: a replace ref that swaps the user's HEAD commit for one with other content.
    const evil = join(dir, 'evil');
    git(dir, 'clone', '-q', root, evil);
    git(evil, 'config', 'user.email', 't@example.invalid');
    git(evil, 'config', 'user.name', 't');
    writeFileSync(join(evil, 'a.txt'), 'EVIL\n');
    git(evil, 'commit', '-q', '-am', 'evil');
    git(evil, 'replace', victimHead, git(evil, 'rev-parse', 'HEAD'));

    const before = snapshotRepo(exec, root);
    git(root, 'remote', 'set-url', 'origin', evil.replace(/\\/g, '/'));
    git(root, 'config', 'remote.origin.fetch', '+refs/replace/*:refs/replace/*');
    // Control: a copy of the repository as the lane left it; the user's next plain fetch takes the replace ref.
    const control = join(dir, 'control');
    cpSync(root, control, { recursive: true });
    git(control, 'fetch', '-q');
    expect(git(control, 'show', 'HEAD:a.txt')).toBe('EVIL');

    const { hold } = quarantine(before);
    expect(hold.held).toBe(true);
    expect(hold.restored.join('\n')).toMatch(/^config \(remote\.origin\.fetch, remote\.origin\.url put back\)$/m);
    expect(git(root, 'config', '--file', join(common, 'config'), '--get', 'remote.origin.url')).toBe(legit.replace(/\\/g, '/'));
    expect(git(root, 'config', '--file', join(common, 'config'), '--get-all', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(hold.undo!.join('\n')).toMatch(/config: if the change was yours, put your version back: cp /);
    expect(readFileSync(join(hold.quarantine!, 'config'), 'utf8')).toContain('refs/replace/');
    // The message says the user's own `git remote set-url` triggers this, and how to clear it.
    const message = tamperHoldMessage(ledgerDir, root)!;
    expect(message).toContain('`git remote set-url`');
    expect(message).toContain('omg factory run release --tamper');
    git(root, 'fetch', '-q');
    expect(git(root, 'for-each-ref', 'refs/replace/')).toBe('');
    expect(git(root, 'show', 'HEAD:a.txt')).toBe('a');
  });

  it('a removed program key counts too, and an unknown key is never benign', () => {
    expect(benignKey('diff.external')).toBe(false);
    expect(benignKey('interactive.difffilter')).toBe(false);
    expect(benignKey('trailer.sign.cmd')).toBe(false);
    expect(benignKey('core.hookspath')).toBe(false);
    expect(benignKey('branch.main.mergeoptions')).toBe(false);
    expect(benignKey('remote.origin.uploadpack')).toBe(false);
    expect(benignKey('remote.origin.url')).toBe(false);
    expect(benignKey('remote.origin.pushurl')).toBe(false);
    expect(benignKey('remote.origin.fetch')).toBe(false);
    expect(benignKey('remote.origin.tagopt')).toBe(true);
    expect(benignKey('user.email')).toBe(true);
    expect(benignKey('branch.feat/x.y.rebase')).toBe(true);
    // Benign by value only (benignChange), never by name.
    expect(benignKey('branch.feat/x.y.remote')).toBe(false);
    expect(benignKey('branch.main.pushremote')).toBe(false);
    expect(benignKey('branch.main.merge')).toBe(false);
    expect(BENIGN_KEYS.every((b) => b.why.length > 0)).toBe(true);
    git(root, 'config', 'core.hooksPath', '.githooks');
    const before = snapshotRepo(exec, root);
    git(root, 'config', '--unset', 'core.hooksPath');
    const { hold } = quarantine(before);
    expect(hold.held).toBe(true);
    expect(git(root, 'config', '--file', join(common, 'config'), '--get', 'core.hookspath')).toBe('.githooks');
  });
});

describe('review-484c 1: a branch\'s remote, pushremote and merge are benign by value only', () => {
  type Cfg = Record<string, string[]>;
  const ORIGIN: Cfg = { 'remote.origin.url': ['https://example.invalid/repo.git'], 'remote.origin.fetch': ['+refs/heads/*:refs/remotes/origin/*'] };
  const cfg = (c: Cfg) => new Map(Object.entries(c));
  // [name, key, was, now, benign]
  const cases: [string, string, Cfg, Cfg, boolean][] = [
    ['`git push -u origin feature`: remote', 'branch.feature.remote', ORIGIN, { ...ORIGIN, 'branch.feature.remote': ['origin'], 'branch.feature.merge': ['refs/heads/feature'] }, true],
    ['`git push -u origin feature`: merge', 'branch.feature.merge', ORIGIN, { ...ORIGIN, 'branch.feature.remote': ['origin'], 'branch.feature.merge': ['refs/heads/feature'] }, true],
    ['pushremote naming the unchanged origin', 'branch.main.pushremote', ORIGIN, { ...ORIGIN, 'branch.main.pushremote': ['origin'] }, true],
    ['rebase', 'branch.main.rebase', ORIGIN, { ...ORIGIN, 'branch.main.rebase': ['true'] }, true],
    ['description', 'branch.main.description', ORIGIN, { ...ORIGIN, 'branch.main.description': ['x'] }, true],
    ['a removed remote', 'branch.main.remote', { ...ORIGIN, 'branch.main.remote': ['origin'] }, ORIGIN, true],
    ['a removed merge', 'branch.main.merge', { ...ORIGIN, 'branch.main.merge': ['refs/heads/main'] }, ORIGIN, true],
    ['remote=../evil', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'branch.main.remote': ['../evil'] }, false],
    ['remote=a URL', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'branch.main.remote': ['https://host.invalid/x'] }, false],
    ['remote=.', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'branch.main.remote': ['.'] }, false],
    ['remote=a Windows path', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'branch.main.remote': ['C:\\evil'] }, false],
    ['remote=a remote added in the same run', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'remote.sink.url': ['../sink'], 'branch.main.remote': ['sink'] }, false],
    ['remote=origin, but origin\'s url changed in the same run', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'remote.origin.url': ['../evil'], 'branch.main.remote': ['origin'] }, false],
    ['remote=origin, but origin\'s fetch changed in the same run', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'remote.origin.fetch': ['+refs/replace/*:refs/replace/*'], 'branch.main.remote': ['origin'] }, false],
    ['remote=origin, but origin got a pushurl in the same run', 'branch.main.pushremote', ORIGIN, { ...ORIGIN, 'remote.origin.pushurl': ['../sink'], 'branch.main.pushremote': ['origin'] }, false],
    ['remote naming a remote with no url before the run', 'branch.main.remote', { 'remote.bare.fetch': ['+refs/heads/*:refs/remotes/bare/*'] }, { 'remote.bare.fetch': ['+refs/heads/*:refs/remotes/bare/*'], 'branch.main.remote': ['bare'] }, false],
    ['merge=refs/replace/x', 'branch.main.merge', { ...ORIGIN, 'branch.main.remote': ['origin'] }, { ...ORIGIN, 'branch.main.remote': ['origin'], 'branch.main.merge': ['refs/replace/x'] }, false],
    ['merge=refs/remotes/...', 'branch.main.merge', { ...ORIGIN, 'branch.main.remote': ['origin'] }, { ...ORIGIN, 'branch.main.remote': ['origin'], 'branch.main.merge': ['refs/remotes/origin/main'] }, false],
    ['merge with `..`', 'branch.main.merge', { ...ORIGIN, 'branch.main.remote': ['origin'] }, { ...ORIGIN, 'branch.main.remote': ['origin'], 'branch.main.merge': ['refs/heads/../x'] }, false],
    ['merge on a branch whose remote is `.`', 'branch.main.merge', { ...ORIGIN, 'branch.main.remote': ['.'] }, { ...ORIGIN, 'branch.main.remote': ['.'], 'branch.main.merge': ['refs/heads/x'] }, false],
    ['merge on a branch with no remote', 'branch.main.merge', ORIGIN, { ...ORIGIN, 'branch.main.merge': ['refs/heads/main'] }, false],
    ['pushremote=../sink', 'branch.main.pushremote', ORIGIN, { ...ORIGIN, 'branch.main.pushremote': ['../sink'] }, false],
    ['pushremote=.', 'branch.main.pushremote', ORIGIN, { ...ORIGIN, 'branch.main.pushremote': ['.'] }, false],
    ['two remote values (git takes the last)', 'branch.main.remote', ORIGIN, { ...ORIGIN, 'branch.main.remote': ['origin', '../evil'] }, false],
    ['an unknown branch key', 'branch.main.mergeoptions', ORIGIN, { ...ORIGIN, 'branch.main.mergeoptions': ['--no-verify'] }, false],
  ];
  it.each(cases)('%s', (_name, key, was, now, benign) => {
    expect(benignChange(key, cfg(was), cfg(now))).toBe(benign);
  });

  it('A: branch.main.remote=<another repository> + merge: a plain `git pull` on a copy merges the lane\'s commit; the quarantine puts both keys back and holds', () => {
    const evil = join(dir, 'evil');
    git(dir, 'clone', '-q', root, evil);
    git(evil, 'config', 'user.email', 't@example.invalid');
    git(evil, 'config', 'user.name', 't');
    writeFileSync(join(evil, 'a.txt'), 'EVIL\n');
    git(evil, 'commit', '-q', '-am', 'evil');

    const before = snapshotRepo(exec, root);
    git(root, 'config', 'branch.main.remote', evil.replace(/\\/g, '/'));
    git(root, 'config', 'branch.main.merge', 'refs/heads/main');
    // Control: a copy of the repository as the lane left it; the user's next plain pull brings the lane's content.
    const control = join(dir, 'control');
    cpSync(root, control, { recursive: true });
    git(control, 'pull', '-q', '--ff-only');
    expect(git(control, 'show', 'HEAD:a.txt')).toBe('EVIL');

    const { hold } = quarantine(before);
    expect(hold.held).toBe(true);
    expect(hold.restored.join('\n')).toMatch(/^config \(branch\.main\.merge, branch\.main\.remote put back\)$/m);
    expect(() => git(root, 'config', '--file', join(common, 'config'), '--get', 'branch.main.remote')).toThrow();
    expect(() => git(root, 'config', '--file', join(common, 'config'), '--get', 'branch.main.merge')).toThrow();
    expect(readTamperHold(ledgerDir, root)).not.toBeNull();
    expect(() => git(root, 'pull', '-q', '--ff-only')).toThrow();
    expect(git(root, 'show', 'HEAD:a.txt')).toBe('a');
  });

  it('C: a lane branch + branch.main.remote=. + merge=refs/heads/<lane branch>: a plain `git pull` on a copy merges it; the quarantine puts both keys back and holds', () => {
    const before = snapshotRepo(exec, root);
    git(root, 'checkout', '-q', '-b', 'lane-x');
    writeFileSync(join(root, 'a.txt'), 'LOCALEVIL\n');
    git(root, 'commit', '-q', '-am', 'lane');
    git(root, 'checkout', '-q', 'main');
    git(root, 'config', 'branch.main.remote', '.');
    git(root, 'config', 'branch.main.merge', 'refs/heads/lane-x');
    const control = join(dir, 'control');
    cpSync(root, control, { recursive: true });
    git(control, 'pull', '-q', '--ff-only');
    expect(git(control, 'show', 'HEAD:a.txt')).toBe('LOCALEVIL');

    const { hold } = quarantine(before);
    expect(hold.held).toBe(true);
    expect(hold.restored.join('\n')).toMatch(/^config \(branch\.main\.merge, branch\.main\.remote put back\)$/m);
    expect(() => git(root, 'config', '--file', join(common, 'config'), '--get', 'branch.main.remote')).toThrow();
    expect(() => git(root, 'config', '--file', join(common, 'config'), '--get', 'branch.main.merge')).toThrow();
    expect(readTamperHold(ledgerDir, root)).not.toBeNull();
    expect(() => git(root, 'pull', '-q', '--ff-only')).toThrow();
    expect(git(root, 'show', 'HEAD:a.txt')).toBe('a');
  });
});

describe('H2: what the restore does not cover holds and is named', () => {
  it('a hook planted in a submodule git dir and a key in another worktree\'s config.worktree are restored', () => {
    const mod = join(common, 'modules', 'sub');
    mkdirSync(join(mod, 'hooks'), { recursive: true });
    writeFileSync(join(mod, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(mod, 'config'), '[core]\n\tbare = false\n');
    const other = join(dir, 'other');
    git(root, 'worktree', 'add', '-q', '--detach', other);
    const id = 'other';
    const before = snapshotRepo(exec, root);
    writeFileSync(join(mod, 'hooks', 'post-checkout'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    writeFileSync(join(common, 'worktrees', id, 'config.worktree'), '[core]\n\tfsmonitor = evil\n');
    const { hold, problems } = quarantine(before);
    expect(problems).toEqual(expect.arrayContaining(['modules/sub changed (config, hooks, info or alternates)', `worktrees/${id}/config.worktree changed`]));
    expect(existsSync(join(mod, 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(common, 'worktrees', id, 'config.worktree'))).toBe(false);
    expect(hold.moved).toEqual(expect.arrayContaining(['modules/sub/hooks/post-checkout', `worktrees/${id}/config.worktree`]));
    expect(hold.active).toEqual([]);
    expect(hold.held).toBe(true);
  });

  it('objects/info/alternates (not restored) is named STILL ACTIVE and holds; so is a submodule change under a snapshot from an older release', () => {
    const mod = join(common, 'modules', 'sub');
    mkdirSync(join(mod, 'hooks'), { recursive: true });
    writeFileSync(join(mod, 'HEAD'), 'ref: refs/heads/main\n');
    const before = snapshotRepo(exec, root);
    delete before.restore![RESTORE_SCOPE_KEY];
    mkdirSync(join(common, 'objects', 'info'), { recursive: true });
    writeFileSync(join(common, 'objects', 'info', 'alternates'), `${join(dir, 'elsewhere')}\n`);
    writeFileSync(join(mod, 'hooks', 'post-checkout'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    const { hold } = quarantine(before);
    expect(hold.held).toBe(true);
    const active = hold.active!.join('\n');
    expect(active).toContain(`objects/info/alternates changed: ${STILL_ACTIVE}`);
    expect(active).toContain(`modules/sub changed (config, hooks, info or alternates): ${STILL_ACTIVE}`);
    // Never touched under an old snapshot: it is named instead.
    expect(existsSync(join(mod, 'hooks', 'post-checkout'))).toBe(true);
  });

  it('the main checkout\'s files and a removed worktree run nothing: no hold', () => {
    const other = join(dir, 'gone');
    git(root, 'worktree', 'add', '-q', '--detach', other);
    const before = snapshotRepo(exec, root);
    git(root, 'worktree', 'remove', '--force', other);
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    const { hold } = quarantine(before);
    expect(hold.held).toBeUndefined();
    expect(hold.active).toEqual([]);
  });
});

describe('H3, L5, L6: each item on its own', () => {
  it('a planted hook the lane made unreadable is renamed into the quarantine without a read; the other planted hook goes too', () => {
    const before = snapshotRepo(exec, root);
    const locked = join(common, 'hooks', 'pre-commit');
    writeFileSync(locked, '#!/bin/sh\necho planted\n', { mode: 0o755 });
    writeFileSync(join(common, 'hooks', 'post-merge'), '#!/bin/sh\necho planted too\n', { mode: 0o755 });
    const unreadable = makeUnreadable(locked);
    const { hold } = quarantine(before);
    expect(hold.failed).toBeUndefined();
    expect(hold.active).toEqual([]);
    expect(hold.moved).toEqual(expect.arrayContaining(['hooks/pre-commit', 'hooks/post-merge']));
    expect(existsSync(locked)).toBe(false);
    expect(existsSync(join(common, 'hooks', 'post-merge'))).toBe(false);
    expect(existsSync(join(hold.quarantine!, 'hooks', 'pre-commit'))).toBe(true);
    if (unreadable) expect(hold.undo!.join('\n')).toMatch(/hooks\/pre-commit: if it was yours, put it back: cp /);
    expect(hold.held).toBe(true);
  });

  it('an item that can be neither copied nor renamed is named STILL ACTIVE; the rest still goes', () => {
    const before = snapshotRepo(exec, root);
    const locked = join(common, 'hooks', 'pre-commit');
    writeFileSync(locked, '#!/bin/sh\necho planted\n', { mode: 0o755 });
    writeFileSync(join(common, 'hooks', 'post-merge'), '#!/bin/sh\necho planted too\n', { mode: 0o755 });
    makeUnreadable(locked, true);
    const { hold } = quarantine(before);
    expect(existsSync(join(common, 'hooks', 'post-merge'))).toBe(false);
    expect(hold.moved).toContain('hooks/post-merge');
    expect(hold.held).toBe(true);
    // Windows (generic read denied) cannot rename it; POSIX can (rename needs only the directory).
    if (existsSync(locked)) expect(hold.active!.join('\n')).toMatch(/^hooks\/pre-commit: STILL ACTIVE \(it can run on your next git command\): it could not be moved or restored/m);
    else expect(hold.moved).toContain('hooks/pre-commit');
  });

  it('a link `x` and a file `x.link` are both kept (no collision)', () => {
    const before = snapshotRepo(exec, root);
    const target = join(dir, 'target');
    mkdirSync(target);
    symlinkSync(target, join(common, 'hooks', 'x'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(common, 'hooks', 'x.link'), 'a real file\n');
    const { hold } = quarantine(before);
    expect(hold.active).toEqual([]);
    expect(readFileSync(join(hold.quarantine!, 'hooks', 'x.link'), 'utf8')).toBe('a real file\n');
    expect(readFileSync(join(hold.quarantine!, '.links', 'hooks', 'x'), 'utf8')).toContain('target');
    expect(existsSync(join(common, 'hooks', 'x'))).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('config.lock held by git: the config is left (named STILL ACTIVE), the planted hook is still removed', () => {
    const before = snapshotRepo(exec, root);
    git(root, 'config', 'core.fsmonitor', 'evil');
    writeFileSync(join(common, 'hooks', 'pre-push'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    writeFileSync(join(common, 'config.lock'), '');
    const { hold } = quarantine(before);
    expect(hold.active!.join('\n')).toMatch(new RegExp(`^config: ${STILL_ACTIVE.replace(/[()]/g, '\\$&')}: it could not be moved or restored \\(${CONFIG_LOCKED}\\)`, 'm'));
    // The lock someone else holds is theirs: left in place.
    expect(existsSync(join(common, 'config.lock'))).toBe(true);
    expect(existsSync(join(common, 'hooks', 'pre-push'))).toBe(false);
    expect(readFileSync(join(common, 'config'), 'utf8')).toContain('evil');
    expect(hold.held).toBe(true);
    unlinkSync(join(common, 'config.lock'));
  });

  it('review-484b 3: a `git config` written between the first read and the restore survives; the restore merges onto the file as it is under the lock', () => {
    const before = snapshotRepo(exec, root);
    git(root, 'config', 'core.fsmonitor', 'evil');
    const after = snapshotRepo(exec, root, '.omg', before);
    let locked = false;
    const hold = quarantineTamper({
      ledgerDir, root, before, after, refsNow: after.refs, problems: compareSnapshots(before, after), run: '7', gate: 'lane-tampered', at: '2026-11-11T00:00:09.000Z',
      beforeConfigLock: (abs) => {
        // The user's own command, after the engine read the file and before it takes the lock.
        git(root, 'config', '--file', abs, 'user.name', 'written meanwhile');
        locked = true;
      },
    });
    expect(locked).toBe(true);
    expect(hold.active).toEqual([]);
    expect(hold.restored.join('\n')).toMatch(/^config \(core\.fsmonitor put back\)$/m);
    expect(git(root, 'config', '--file', join(common, 'config'), '--get', 'user.name')).toBe('written meanwhile');
    expect(() => git(root, 'config', '--file', join(common, 'config'), '--get', 'core.fsmonitor')).toThrow();
    expect(existsSync(join(common, 'config.lock'))).toBe(false);
    // The copy of the user's version is the one read under the lock (it holds the later value too).
    expect(readFileSync(join(hold.quarantine!, 'config'), 'utf8')).toContain('written meanwhile');
  });

  it('a changed hook is restored atomically from the snapshot\'s bytes', () => {
    writeFileSync(join(common, 'hooks', 'pre-commit'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const before = snapshotRepo(exec, root);
    writeFileSync(join(common, 'hooks', 'pre-commit'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    const { hold } = quarantine(before);
    expect(readFileSync(join(common, 'hooks', 'pre-commit'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(hold.restored).toContain('hooks/pre-commit');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('review-484c 8: a hold that cannot be written is not reported as held', () => {
    const before = snapshotRepo(exec, root);
    writeFileSync(join(common, 'hooks', 'post-checkout'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    // holds/ cannot be made: a file stands where the folder goes.
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'holds'), 'not a folder');
    const { hold } = quarantine(before);
    expect(existsSync(join(common, 'hooks', 'post-checkout'))).toBe(false);
    expect(hold.held).toBe(false);
    expect(hold.holdNotWritten).toBeTruthy();
    expect(hold.failed).toMatch(/the hold could not be written: /);
  });
});
