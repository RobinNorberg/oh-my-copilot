/**
 * quarantineTamper on real git dirs (review-484 H1, H2, H3, L5, L6): the
 * allowlist of benign config keys, the per-item quarantine, what stays
 * active and holds. Real git in temp repos, no engine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from '../../../ship/exec.js';
import { factoryGuardExec } from '../exec.js';
import { compareSnapshots, RESTORE_SCOPE_KEY, snapshotRepo } from '../review-guard.js';
import { BENIGN_KEYS, benignKey, quarantineTamper, readTamperHold, STILL_ACTIVE } from '../tamper-quarantine.js';
const exec = factoryGuardExec(defaultExec);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let dir;
let root;
let common;
let ledgerDir;
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
        try {
            execFileSync('icacls', [dir, '/reset', '/T', '/Q'], { stdio: 'pipe' });
        }
        catch { /* best effort */ }
    }
    rmSync(dir, { recursive: true, force: true });
});
let stamp = 0;
function quarantine(before) {
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
function makeUnreadable(path, strict = false) {
    try {
        if (process.platform === 'win32')
            execFileSync('icacls', [path, '/deny', `*S-1-1-0:${strict ? '(R)' : '(RD)'}`], { stdio: 'pipe' });
        else
            execFileSync('chmod', ['000', path]);
    }
    catch {
        return false;
    }
    try {
        readFileSync(path);
        return false;
    }
    catch {
        return true;
    }
}
describe('H1: config keys are an allowlist', () => {
    it('diff.external (a key the old denylist missed) runs on a plain `git diff`; the quarantine puts the old value back and holds, the user\'s benign key stays', () => {
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
        expect(readFileSync(join(hold.quarantine, 'config'), 'utf8')).toContain('external');
        expect(hold.undo.join('\n')).toMatch(/config: if the change was yours, put your version back: cp ".*config" ".*config"/);
        expect(readFileSync(join(hold.quarantine, 'undo.txt'), 'utf8')).toContain('cp "');
        expect(readTamperHold(ledgerDir, root)).not.toBeNull();
        execFileSync('git', ['diff'], { cwd: root, stdio: 'pipe' });
        expect(existsSync(marker)).toBe(false);
    });
    it('only allowlisted keys (user.email, a remote, a branch upstream): left in place, copied, no hold', () => {
        const before = snapshotRepo(exec, root);
        git(root, 'config', 'user.email', 'me@example.invalid');
        git(root, 'remote', 'add', 'fork', 'https://example.invalid/fork.git');
        git(root, 'config', 'branch.main.merge', 'refs/heads/main');
        const configNow = readFileSync(join(common, 'config'));
        const { hold } = quarantine(before);
        expect(hold.held).toBeUndefined();
        expect(hold.kept.join('\n')).toMatch(/config \(only branch\.main\.merge, remote\.fork\.fetch, remote\.fork\.url, user\.email changed: allowlisted keys that name no program; left as it is; a copy is in /);
        expect(readFileSync(join(common, 'config')).equals(configNow)).toBe(true);
        expect(readTamperHold(ledgerDir, root)).toBeNull();
    });
    it('a removed program key counts too, and an unknown key is never benign', () => {
        expect(benignKey('diff.external')).toBe(false);
        expect(benignKey('interactive.difffilter')).toBe(false);
        expect(benignKey('trailer.sign.cmd')).toBe(false);
        expect(benignKey('core.hookspath')).toBe(false);
        expect(benignKey('branch.main.mergeoptions')).toBe(false);
        expect(benignKey('remote.origin.uploadpack')).toBe(false);
        expect(benignKey('user.email')).toBe(true);
        expect(benignKey('branch.feat/x.y.remote')).toBe(true);
        expect(BENIGN_KEYS.every((b) => b.why.length > 0)).toBe(true);
        git(root, 'config', 'core.hooksPath', '.githooks');
        const before = snapshotRepo(exec, root);
        git(root, 'config', '--unset', 'core.hooksPath');
        const { hold } = quarantine(before);
        expect(hold.held).toBe(true);
        expect(git(root, 'config', '--file', join(common, 'config'), '--get', 'core.hookspath')).toBe('.githooks');
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
        delete before.restore[RESTORE_SCOPE_KEY];
        mkdirSync(join(common, 'objects', 'info'), { recursive: true });
        writeFileSync(join(common, 'objects', 'info', 'alternates'), `${join(dir, 'elsewhere')}\n`);
        writeFileSync(join(mod, 'hooks', 'post-checkout'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
        const { hold } = quarantine(before);
        expect(hold.held).toBe(true);
        const active = hold.active.join('\n');
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
        expect(existsSync(join(hold.quarantine, 'hooks', 'pre-commit'))).toBe(true);
        if (unreadable)
            expect(hold.undo.join('\n')).toMatch(/hooks\/pre-commit: if it was yours, put it back: cp /);
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
        if (existsSync(locked))
            expect(hold.active.join('\n')).toMatch(/^hooks\/pre-commit: STILL ACTIVE \(it can run on your next git command\): it could not be moved or restored/m);
        else
            expect(hold.moved).toContain('hooks/pre-commit');
    });
    it('a link `x` and a file `x.link` are both kept (no collision)', () => {
        const before = snapshotRepo(exec, root);
        const target = join(dir, 'target');
        mkdirSync(target);
        symlinkSync(target, join(common, 'hooks', 'x'), process.platform === 'win32' ? 'junction' : 'dir');
        writeFileSync(join(common, 'hooks', 'x.link'), 'a real file\n');
        const { hold } = quarantine(before);
        expect(hold.active).toEqual([]);
        expect(readFileSync(join(hold.quarantine, 'hooks', 'x.link'), 'utf8')).toBe('a real file\n');
        expect(readFileSync(join(hold.quarantine, '.links', 'hooks', 'x'), 'utf8')).toContain('target');
        expect(existsSync(join(common, 'hooks', 'x'))).toBe(false);
        expect(existsSync(target)).toBe(true);
    });
    it('config.lock held by git: the config is left (named STILL ACTIVE), the planted hook is still removed', () => {
        const before = snapshotRepo(exec, root);
        git(root, 'config', 'core.fsmonitor', 'evil');
        writeFileSync(join(common, 'hooks', 'pre-push'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
        writeFileSync(join(common, 'config.lock'), '');
        const { hold } = quarantine(before);
        expect(hold.active.join('\n')).toMatch(new RegExp(`^config: ${STILL_ACTIVE.replace(/[()]/g, '\\$&')}: .*config\\.lock exists`, 'm'));
        expect(existsSync(join(common, 'hooks', 'pre-push'))).toBe(false);
        expect(readFileSync(join(common, 'config'), 'utf8')).toContain('evil');
        expect(hold.held).toBe(true);
        unlinkSync(join(common, 'config.lock'));
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
});
//# sourceMappingURL=tamper-quarantine.test.js.map