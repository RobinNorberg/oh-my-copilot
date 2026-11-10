/**
 * Git hardening from the store audit (item 3): replace refs and grafts, the
 * engine's pinned config, the local forge mirror's receive-pack (its hooks
 * and config), and the snapshot's object store metadata. Real git.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from '../../../ship/exec.js';
import { hostGitEnv, hostGitHardeningArgs, runHostGit } from '../../../team/git-worktree.js';
import { FactorySafetyError, gitHardeningArgs, hardenedGitExec, MIRROR_UPLOAD_PACK_ARG, mirrorReceivePackArg } from '../exec.js';
import { compareSnapshots, objectStoreMetaHash, replaceObjectsProblem, snapshotRepo } from '../review-guard.js';
import { gitIn } from './fake-lanes.js';
let dir;
let root;
let hooks;
const git = (...args) => gitIn(root, ...args);
const commitEmpty = (msg) => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };
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
        expect(existsSync(env.GIT_GRAFT_FILE)).toBe(false);
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
    const seen = [];
    const recorder = (_cmd, args, opts) => { seen.push({ args, env: opts?.env }); return { status: 0, stdout: '', stderr: '' }; };
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
        for (const kv of ['commit.gpgSign=false', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false'])
            expect(local.args).toContain(kv);
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
    let mirror;
    let marker;
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
    describe('a mirror redirected to another repository (HIGH-1)', () => {
        let evil;
        let ranMarker;
        beforeEach(() => {
            // <evil> has alternates, so receive-pack runs its core.alternateRefsCommand while advertising refs.
            const other = join(dir, 'other.git');
            gitIn(dir, 'init', '-q', '--bare', other);
            gitIn(root, 'push', '-q', other, 'HEAD:refs/heads/o');
            evil = join(dir, 'evil.git');
            gitIn(dir, 'init', '-q', '--bare', evil);
            writeFileSync(join(evil, 'objects', 'info', 'alternates'), `${join(other, 'objects')}\n`);
            ranMarker = join(dir, 'alternate-refs-ran');
            const fwd = (p) => p.replace(/\\/g, '/');
            gitIn(dir, 'config', '--file', join(evil, 'config'), 'core.alternateRefsCommand', `echo x > '${fwd(ranMarker)}'; git --git-dir='${fwd(other)}' for-each-ref --format='%(objectname)'`);
        });
        it.each([
            ['a gitfile .git', (m, e) => writeFileSync(join(m, '.git'), `gitdir: ${e}\n`)],
            ['a commondir', (m, e) => writeFileSync(join(m, 'commondir'), `${e}\n`)],
        ])('%s pointing at a repository with alternateRefsCommand refuses the push and the fetch; a plain push runs the command', (_what, plant) => {
            const sha = git('rev-parse', 'HEAD');
            plant(mirror, evil);
            const exec = hardenedGitExec(defaultExec, hooks, () => mirror);
            expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(/would point git at another repository/);
            expect(() => exec('git', ['fetch', 'omg-local', 'main'], { cwd: root })).toThrow(/would point git at another repository/);
            expect(() => exec('git', ['ls-remote', 'omg-local'], { cwd: root })).toThrow(/would point git at another repository/);
            expect(existsSync(ranMarker)).toBe(false);
            expect(gitIn(dir, '--git-dir', evil, 'for-each-ref', '--format=%(refname)')).toBe('');
            // Control: git really follows the redirect and runs the command on a plain push.
            gitIn(root, 'push', '-q', mirror, `${sha}:refs/heads/control`);
            expect(existsSync(ranMarker)).toBe(true);
            expect(gitIn(dir, '--git-dir', evil, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/control');
        });
        it('the pinned receive-pack runs no alternateRefsCommand even when git follows a redirect written after the check', () => {
            const sha = git('rev-parse', 'HEAD');
            writeFileSync(join(mirror, 'commondir'), `${evil}\n`);
            // The engine's receive-pack command as hardenedGitExec appends it, without the refusal in front (a write between check and use).
            const pinned = gitIn(root, 'push', '-q', mirror, `${sha}:refs/heads/pinned`, mirrorReceivePackArg(hooks));
            expect(pinned).toBe('');
            expect(gitIn(dir, '--git-dir', evil, 'rev-parse', 'refs/heads/pinned')).toBe(sha);
            expect(existsSync(ranMarker)).toBe(false);
            gitIn(root, 'push', '-q', mirror, `${sha}:refs/heads/control`);
            expect(existsSync(ranMarker)).toBe(true);
        });
        it('a gitdir or config.worktree file, or a mirror that is a link or junction, refuses the transport', () => {
            const sha = git('rev-parse', 'HEAD');
            const exec = hardenedGitExec(defaultExec, hooks, () => mirror);
            for (const name of ['gitdir', 'config.worktree']) {
                writeFileSync(join(mirror, name), `${evil}\n`);
                expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(new RegExp(`has ${name.replace('.', '\\.')}, which would point`));
                rmSync(join(mirror, name));
            }
            const linked = join(dir, 'linked.git');
            symlinkSync(evil, linked, 'junction');
            const viaLink = hardenedGitExec(defaultExec, hooks, () => linked);
            expect(() => viaLink('git', ['fetch', 'omg-local', 'main'], { cwd: root })).toThrow(/is a link or junction/);
            expect(existsSync(ranMarker)).toBe(false);
            // The clean mirror still takes the push.
            expect(exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root }).status).toBe(0);
        });
        it('a fetch into a repository with alternates runs its alternateRefsCommand under plain git, never under the engine or host pins (L-1)', () => {
            const sha = git('rev-parse', 'HEAD');
            gitIn(root, 'push', '-q', mirror, `${sha}:refs/heads/main`);
            rmSync(ranMarker, { force: true });
            const me = join(dir, 'me');
            gitIn(dir, 'init', '-q', me);
            writeFileSync(join(me, '.git', 'objects', 'info', 'alternates'), `${join(dir, 'other.git', 'objects')}\n`);
            gitIn(me, 'config', 'core.alternateRefsCommand', gitIn(dir, 'config', '--file', join(evil, 'config'), 'core.alternateRefsCommand'));
            expect(gitHardeningArgs(hooks, 'fetch')).toContain('core.alternateRefsCommand=true');
            expect(hostGitHardeningArgs()).toContain('core.alternateRefsCommand=true');
            gitIn(me, ...gitHardeningArgs(hooks, 'fetch'), 'fetch', '-q', mirror, '+refs/heads/main:refs/remotes/m/main');
            expect(gitIn(me, 'rev-parse', 'refs/remotes/m/main')).toBe(sha);
            expect(existsSync(ranMarker)).toBe(false);
            gitIn(me, 'fetch', '-q', mirror, '+refs/heads/main:refs/remotes/c/main');
            expect(existsSync(ranMarker)).toBe(true);
        });
    });
    describe('a mirror turned non-bare with updateInstead and a smudge filter (B2)', () => {
        let smudged;
        /** What a foothold writes into a mirror between the engine's check and its push. */
        const plant = (m) => {
            const cfg = join(m, 'config');
            gitIn(dir, 'config', '--file', cfg, 'core.bare', 'false');
            gitIn(dir, 'config', '--file', cfg, 'receive.denyCurrentBranch', 'updateInstead');
            gitIn(dir, 'config', '--file', cfg, 'filter.x.smudge', `echo x >> '${smudged.replace(/\\/g, '/')}'; cat`);
            mkdirSync(join(m, 'info'), { recursive: true });
            writeFileSync(join(m, 'info', 'attributes'), '* filter=x\n');
        };
        beforeEach(() => {
            smudged = join(dir, 'smudge-ran');
            // main is the mirror's HEAD branch, the one updateInstead checks out.
            gitIn(dir, '--git-dir', mirror, 'symbolic-ref', 'HEAD', 'refs/heads/main');
            plant(mirror);
            writeFileSync(join(root, 'f.txt'), 'content\n');
            git('add', 'f.txt');
            commitEmpty('add f');
        });
        it('the pinned receive-pack checks nothing out and runs no filter; a plain push does both', () => {
            const sha = git('rev-parse', 'HEAD');
            // The engine's receive-pack arg alone (no check in front, as after a write between check and use), to the mirror's HEAD branch.
            gitIn(root, 'push', '-q', mirror, `${sha}:refs/heads/main`, mirrorReceivePackArg(hooks));
            expect(gitIn(dir, '--git-dir', mirror, 'rev-parse', 'refs/heads/main')).toBe(sha);
            expect(existsSync(smudged)).toBe(false);
            expect(existsSync(join(mirror, 'f.txt'))).toBe(false);
            // Control: the same plant in a second mirror; a plain push checks f.txt out there and runs the smudge command.
            const control = join(dir, 'control.git');
            gitIn(dir, 'init', '-q', '--bare', '-b', 'main', control);
            plant(control);
            gitIn(root, 'push', '-q', control, `${sha}:refs/heads/main`);
            expect(existsSync(join(control, 'f.txt'))).toBe(true);
            expect(existsSync(smudged)).toBe(true);
        });
        it('the check refuses core.bare=false, a missing core.bare and info/attributes before any transport', () => {
            const sha = git('rev-parse', 'HEAD');
            const exec = hardenedGitExec(defaultExec, hooks, () => mirror);
            const cfg = join(mirror, 'config');
            gitIn(dir, 'config', '--file', cfg, '--unset', 'receive.denyCurrentBranch');
            gitIn(dir, 'config', '--file', cfg, '--remove-section', 'filter.x');
            expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(/has info\/attributes/);
            rmSync(join(mirror, 'info', 'attributes'));
            expect(() => exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root })).toThrow(/must set core\.bare = true exactly once \(it has "false"\)/);
            expect(() => exec('git', ['fetch', 'omg-local', 'main'], { cwd: root })).toThrow(/must set core\.bare = true/);
            gitIn(dir, 'config', '--file', cfg, '--unset', 'core.bare');
            expect(() => exec('git', ['ls-remote', 'omg-local'], { cwd: root })).toThrow(/must set core\.bare = true exactly once \(it has none\)/);
            gitIn(dir, 'config', '--file', cfg, 'core.bare', 'true');
            expect(exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root }).status).toBe(0);
            expect(existsSync(smudged)).toBe(false);
        });
    });
    it('every omg-local transport refuses without the mirror path (B3); fetch and ls-remote pin the upload-pack', () => {
        const sha = git('rev-parse', 'HEAD');
        const noMirror = hardenedGitExec(defaultExec, hooks);
        for (const args of [['fetch', 'omg-local', 'main'], ['ls-remote', 'omg-local'], ['push', 'omg-local', `${sha}:refs/heads/main`]]) {
            expect(() => noMirror('git', args, { cwd: root })).toThrow(/the local forge mirror path is unknown here/);
        }
        expect(gitIn(dir, '--git-dir', mirror, 'for-each-ref', '--format=%(refname)')).toBe('');
        // With the mirror: the upload-pack runs with core.alternateRefsCommand pinned, and the local transport takes it.
        const seen = [];
        const exec = hardenedGitExec((cmd, args, opts) => { seen.push(args); return defaultExec(cmd, args, opts); }, hooks, () => mirror);
        expect(exec('git', ['push', 'omg-local', `${sha}:refs/heads/main`], { cwd: root }).status).toBe(0);
        expect(exec('git', ['fetch', 'omg-local', 'main'], { cwd: root }).status).toBe(0);
        expect(git('rev-parse', 'refs/remotes/omg-local/main')).toBe(sha);
        const listed = exec('git', ['ls-remote', 'omg-local', 'refs/heads/main'], { cwd: root });
        expect(listed.stdout.split(/\s+/)[0]).toBe(sha);
        expect(MIRROR_UPLOAD_PACK_ARG).toBe('--upload-pack=git -c core.alternateRefsCommand=true upload-pack');
        expect(seen.filter((a) => a.includes('fetch') || a.includes('ls-remote')).every((a) => a.includes(MIRROR_UPLOAD_PACK_ARG))).toBe(true);
    });
    it('the receive-pack command carries the empty hooks dir, quoted; a quote in the path is refused', () => {
        expect(mirrorReceivePackArg(hooks)).toBe(`--receive-pack=git -c core.hooksPath='${hooks}' -c core.fsmonitor=false -c core.alternateRefsCommand=true -c core.alternateRefsPrefixes= -c receive.autogc=false -c core.bare=true -c receive.denyCurrentBranch=refuse -c receive.denyDeleteCurrent=refuse receive-pack`);
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
    it('a planted shallow, objects/info/alternates or http-alternates is reported', () => {
        const common = join(root, '.git');
        const plant = [
            () => writeFileSync(join(common, 'shallow'), `${git('rev-parse', 'HEAD')}\n`),
            () => writeFileSync(join(common, 'objects', 'info', 'alternates'), `${join(dir, 'elsewhere')}\n`),
            () => writeFileSync(join(common, 'objects', 'info', 'http-alternates'), 'https://example.invalid/objects\n'),
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
        expect(compareSnapshots(before, snapshotRepo(exec, root))).toContain('the object store metadata changed (shallow, objects/info/alternates, objects/info/http-alternates)');
    });
    it("the user's own commit-graph, multi-pack-index and bitmap writes in the main checkout do not park (M-E)", () => {
        commitEmpty('two');
        const before = snapshotRepo(exec, root);
        git('commit-graph', 'write', '--reachable');
        git('repack', '-adb', '--write-midx');
        const common = join(root, '.git');
        expect(existsSync(join(common, 'objects', 'info', 'commit-graph')) || existsSync(join(common, 'objects', 'info', 'commit-graphs'))).toBe(true);
        expect(existsSync(join(common, 'objects', 'pack', 'multi-pack-index'))).toBe(true);
        expect(objectStoreMetaHash(common)).toBe(before.objectMeta);
        expect(compareSnapshots(before, snapshotRepo(exec, root))).toEqual([]);
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
//# sourceMappingURL=git-hardening.test.js.map