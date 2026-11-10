import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from '../../../ship/exec.js';
import { protectedChanges } from '../../../ship/merge.js';
import { LANE_PROTECTED_PATHS } from '../lane-commit.js';
import { checkUserRepoGuard, createPrivateRepo, dropImportRef, ensureSeed, fetchIntoPrivate, importFromPrivate, lockfileUnchanged, longPathProblem, privateGitEnv, privateGitPins, privateGitTools, privateRepoConfigHash, privateRepoProblem, privateRunLayout, privateWorkRoot, removeRunDir, resolveUserGitDir, userRepoGuardSnapshot, userRepoProblem, } from '../private-store.js';
const T = 180_000;
const win = process.platform === 'win32';
let dir;
let emptyGlobal;
let ctx;
let user;
let userGit;
let base;
let layout;
let p;
/** Plain, UNHARDENED git (the controls and fixture setup): only the user's own global/system config kept out. */
function g(cwd, args, o = {}) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', input: o.input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobal, ...o.env } });
    if (r.status !== 0 && !o.allowFail)
        throw new Error(`git ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}
const fwd = (s) => s.replace(/\\/g, '/');
const touchCmd = (marker) => `touch '${fwd(marker)}'`;
/** A commit in `gitDir` on `parent`, with `files` set in a temp index (mode, content or an oid). */
function mkCommit(gitDir, parent, files, parents = [parent]) {
    const index = join(dir, `idx-${Math.random().toString(16).slice(2)}`);
    const env = { GIT_INDEX_FILE: index };
    g(dir, [`--git-dir=${gitDir}`, 'read-tree', parent], { env });
    for (const f of files) {
        const oid = f.oid ?? g(dir, [`--git-dir=${gitDir}`, 'hash-object', '-w', '--stdin'], { input: f.content ?? '' });
        g(dir, [`--git-dir=${gitDir}`, 'update-index', '--add', '--cacheinfo', `${f.mode ?? '100644'},${oid},${f.path}`], { env });
    }
    const tree = g(dir, [`--git-dir=${gitDir}`, 'write-tree'], { env });
    rmSync(index, { force: true });
    return g(dir, [`--git-dir=${gitDir}`, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, ...parents.flatMap((x) => ['-p', x]), '-m', 'lane'], {});
}
function writeHook(hooksDir, name, marker) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, name), `#!/bin/sh\n${touchCmd(marker)}\n`);
    chmodSync(join(hooksDir, name), 0o755);
}
/** An exec that runs `before` once, right before the first git command whose args satisfy `when` (a change after the checks passed). */
function racingExec(when, before) {
    let done = false;
    return (cmd, args, opts) => {
        if (!done && when(args)) {
            done = true;
            before();
        }
        return defaultExec(cmd, args, opts);
    };
}
const isFetch = (args) => args.includes('fetch');
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-private-store-'));
    emptyGlobal = join(dir, 'global.gitconfig');
    writeFileSync(emptyGlobal, '');
    ctx = { tools: privateGitTools(join(dir, 'ledger')) };
    user = join(dir, 'user');
    g(dir, ['init', '-q', '-b', 'main', user]);
    writeFileSync(join(user, 'a.txt'), 'a\n');
    writeFileSync(join(user, 'package-lock.json'), '{"lockfileVersion":3}\n');
    g(user, ['add', '.']);
    g(user, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    base = g(user, ['rev-parse', 'HEAD']);
    userGit = resolveUserGitDir(user, ctx);
    layout = privateRunLayout(join(dir, 'fw'), 'abcdef0123456789', 'issue-1');
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
function makePrivate() {
    ensureSeed(layout, userGit, base, ctx);
    p = createPrivateRepo(layout, base, ctx);
}
describe('privateWorkRoot and layout', () => {
    const root = win ? 'C:\\Code\\repo' : '/code/repo';
    const omcRoot = win ? 'C:\\Code\\repo\\.omg' : '/code/repo/.omg';
    it('uses factory.run.workDir, else LOCALAPPDATA (win32) or XDG_CACHE_HOME / ~/.cache', () => {
        const wd = win ? 'D:\\fw' : '/srv/fw';
        expect(privateWorkRoot({ userConfig: { factory: { run: { workDir: wd } } }, root, omcRoot })).toBe(wd);
        if (win)
            expect(privateWorkRoot({ userConfig: {}, root, omcRoot, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32' })).toBe('C:\\Users\\u\\AppData\\Local\\omg\\fw');
        else {
            expect(privateWorkRoot({ userConfig: {}, root, omcRoot, env: { XDG_CACHE_HOME: '/x/cache' }, platform: 'linux' })).toBe('/x/cache/omg/fw');
            expect(privateWorkRoot({ userConfig: {}, root, omcRoot, env: {}, platform: 'linux', home: '/home/u' })).toBe('/home/u/.cache/omg/fw');
        }
    });
    it('refuses a relative workDir, one under the repository or the OMC state root, or one containing the repository', () => {
        expect(() => privateWorkRoot({ userConfig: { factory: { run: { workDir: 'rel/fw' } } }, root, omcRoot })).toThrow(/absolute/);
        expect(() => privateWorkRoot({ userConfig: { factory: { run: { workDir: join(root, 'fw') } } }, root, omcRoot: join(dir, 'elsewhere') })).toThrow(/the repository/);
        expect(() => privateWorkRoot({ userConfig: { factory: { run: { workDir: join(dir, 'state', 'fw') } } }, root, omcRoot: join(dir, 'state') })).toThrow(/OMC state root/);
        expect(() => privateWorkRoot({ userConfig: { factory: { run: { workDir: join(root, '..') } } }, root, omcRoot: join(dir, 'x') })).toThrow(/the repository/);
    });
    it('lays out <work>/<repo8>/seed.git and <work>/<repo8>/<slug>/{repo,w,jobs,run.lock}', () => {
        expect(layout.seed).toBe(join(dir, 'fw', 'abcdef01', 'seed.git'));
        expect(layout.gitDir).toBe(join(dir, 'fw', 'abcdef01', 'issue-1', 'repo', '.git'));
        expect(layout.lock).toBe(join(dir, 'fw', 'abcdef01', 'issue-1', 'run.lock'));
        expect(() => privateRunLayout(join(dir, 'fw'), 'abcdef01', '../x')).toThrow();
    });
    it('flags a Windows path over what git for Windows handles', () => {
        expect(longPathProblem('C:\\fw\\w\\prep', 5000, 'win32')).toMatch(/4095/);
        expect(longPathProblem('C:\\fw\\w\\prep', 200, 'win32')).toBeNull();
        expect(longPathProblem('/fw/w/prep', 5000, 'linux')).toBeNull();
    });
});
describe('seed and private clone', () => {
    it('creates the seed and a private clone: HEAD == base, no alternates (a full copy), no origin, no refs, longpaths', () => {
        makePrivate();
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'rev-parse', 'HEAD'])).toBe(base);
        expect(existsSync(join(p.gitDir, 'objects', 'info', 'alternates'))).toBe(false);
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'cat-file', '-p', `${base}:a.txt`])).toBe('a');
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'remote'])).toBe('');
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'for-each-ref'])).toBe('');
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'config', '--get', 'core.longpaths'])).toBe('true');
        expect(existsSync(join(p.gitDir, 'hooks'))).toBe(false);
        expect(existsSync(join(layout.repo, 'a.txt'))).toBe(false);
        // Idempotent seed: a second ensureSeed for the same base fetches nothing.
        ensureSeed(layout, userGit, base, ctx);
    }, T);
    it('refuses a user repository with replace refs, grafts or alternates before any fetch', () => {
        const other = mkCommit(userGit, base, [{ path: 'evil.txt', content: 'x' }]);
        g(user, ['replace', base, other]);
        expect(userRepoProblem(userGit, ctx)).toMatch(/replace refs/);
        expect(() => ensureSeed(layout, userGit, base, ctx)).toThrow(/replace refs/);
        g(user, ['replace', '-d', base]);
        mkdirSync(join(userGit, 'info'), { recursive: true });
        writeFileSync(join(userGit, 'info', 'grafts'), `${base}\n`);
        expect(userRepoProblem(userGit, ctx)).toMatch(/grafts/);
        rmSync(join(userGit, 'info', 'grafts'));
        writeFileSync(join(userGit, 'objects', 'info', 'alternates'), `${fwd(join(dir, 'x'))}\n`);
        expect(userRepoProblem(userGit, ctx)).toMatch(/alternates/);
    }, T);
    it('copies no refs/replace into the seed even when one is planted after the check window', () => {
        const other = mkCommit(userGit, base, [{ path: 'evil.txt', content: 'x' }]);
        const realTree = g(user, ['--no-replace-objects', 'rev-parse', `${base}^{tree}`]);
        ctx = { ...ctx, exec: racingExec(isFetch, () => g(user, ['replace', base, other])) };
        ensureSeed(layout, userGit, base, ctx);
        expect(g(dir, [`--git-dir=${layout.seed}`, 'for-each-ref', 'refs/replace/'])).toBe('');
        expect(g(dir, [`--git-dir=${layout.seed}`, 'rev-parse', `${base}^{tree}`])).toBe(realTree);
        ctx = { tools: ctx.tools };
        p = createPrivateRepo(layout, base, ctx);
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'for-each-ref', 'refs/replace/'])).toBe('');
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'rev-parse', 'HEAD^{tree}'])).toBe(realTree);
    }, T);
    it('refuses a seed with a commondir redirect or a planted config key', () => {
        ensureSeed(layout, userGit, base, ctx);
        writeFileSync(join(layout.seed, 'commondir'), `${fwd(join(dir, 'evil.git'))}\n`);
        expect(() => ensureSeed(layout, userGit, base, ctx)).toThrow(/redirect/);
        rmSync(join(layout.seed, 'commondir'));
        g(dir, ['config', '--file', join(layout.seed, 'config'), 'core.alternateRefsCommand', 'x']);
        expect(() => createPrivateRepo(layout, base, ctx)).toThrow(/key the engine did not write/);
    }, T);
    it('fetchIntoPrivate brings a new user commit in by sha', () => {
        makePrivate();
        writeFileSync(join(user, 'b.txt'), 'b\n');
        g(user, ['add', 'b.txt']);
        g(user, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'moved base']);
        const moved = g(user, ['rev-parse', 'HEAD']);
        fetchIntoPrivate(layout, p, userGit, moved, ctx);
        expect(g(dir, [`--git-dir=${p.gitDir}`, 'cat-file', '-t', moved])).toBe('commit');
    }, T);
    it('alternates + a core.alternateRefsCommand planted in the private repository: runs on a plain fetch (control), refused by fetchIntoPrivate, and not run when planted after the checks', () => {
        makePrivate();
        const marker = join(dir, 'alt-marker');
        const alternates = join(p.gitDir, 'objects', 'info', 'alternates');
        const plant = () => {
            mkdirSync(dirname(alternates), { recursive: true });
            writeFileSync(alternates, `${fwd(join(layout.seed, 'objects'))}\n`);
            g(dir, ['config', '--file', join(p.gitDir, 'config'), 'core.alternateRefsCommand', touchCmd(marker)]);
        };
        plant();
        g(dir, [`--git-dir=${p.gitDir}`, 'fetch', '--no-write-fetch-head', layout.seed, base]);
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        expect(() => fetchIntoPrivate(layout, p, userGit, base, ctx)).toThrow(/changed since the engine wrote them/);
        expect(existsSync(marker)).toBe(false);
        g(dir, ['config', '--file', join(p.gitDir, 'config'), '--unset', 'core.alternateRefsCommand']);
        rmSync(alternates);
        // The race: planted after privateRepoProblem passed, right before the transport. The command-line pin wins; the check after the transport refuses before any read.
        expect(() => fetchIntoPrivate(layout, p, userGit, base, { ...ctx, exec: racingExec((a) => isFetch(a) && a.some((x) => x === `--git-dir=${p.gitDir}`), plant) })).toThrow(/changed since the engine wrote them/);
        expect(existsSync(marker)).toBe(false);
    }, T);
    it('a commondir redirect in the private git dir: runs the evil config on a plain fetch (control), refused by fetchIntoPrivate and the import', () => {
        makePrivate();
        const marker = join(dir, 'redirect-marker');
        const evil = join(dir, 'evil.git');
        g(dir, ['init', '-q', '--bare', evil]);
        writeFileSync(join(evil, 'objects', 'info', 'alternates'), `${fwd(join(layout.seed, 'objects'))}\n`);
        g(dir, ['config', '--file', join(evil, 'config'), 'core.alternateRefsCommand', touchCmd(marker)]);
        writeFileSync(join(p.gitDir, 'commondir'), `${fwd(evil)}\n`);
        g(dir, [`--git-dir=${p.gitDir}`, 'fetch', '--no-write-fetch-head', layout.seed, base]);
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        expect(() => fetchIntoPrivate(layout, p, userGit, base, ctx)).toThrow(/redirect/);
        const r = importFromPrivate({ userGitDir: userGit, privateRepo: p, sha: base, expectedParents: [], startSha: base, run: 'issue-1', n: 1 }, ctx);
        expect(r).toMatchObject({ ok: false, code: 'private-repo' });
        expect(existsSync(marker)).toBe(false);
    }, T);
});
describe('importFromPrivate', () => {
    const run = 'issue-1';
    const imp = (sha, parents, extra) => importFromPrivate({ userGitDir: userGit, privateRepo: p, sha, expectedParents: parents, startSha: base, run, n: 1, ...extra }, ctx);
    const userRef = () => g(user, ['for-each-ref', 'refs/omg-import/']);
    it('imports a clean lane commit onto refs/omg-import/<run>/<n> only, with the changed files; dropImportRef deletes it', () => {
        makePrivate();
        const sha = mkCommit(p.gitDir, base, [{ path: 'src/x.ts', content: 'x\n' }]);
        const r = imp(sha, [base]);
        expect(r).toEqual({ ok: true, ref: 'refs/omg-import/issue-1/1', files: ['src/x.ts'] });
        expect(g(user, ['rev-parse', 'refs/omg-import/issue-1/1'])).toBe(sha);
        expect(g(user, ['for-each-ref', 'refs/heads/'])).toBe(`${base} commit\trefs/heads/main`);
        expect(() => dropImportRef(userGit, run, 1, base, ctx)).toThrow(/import ref left/);
        dropImportRef(userGit, run, 1, sha, ctx);
        expect(userRef()).toBe('');
    }, T);
    it('refuses wrong parents, protected paths (ship, CLAUDE.md, .github/, configured), a new gitlink and a new symlink; the ref is dropped each time', () => {
        makePrivate();
        const ok = mkCommit(p.gitDir, base, [{ path: 'src/x.ts', content: 'x\n' }]);
        expect(imp(ok, [])).toMatchObject({ ok: false, code: 'parents-mismatch' });
        expect(imp(ok, [base, base])).toMatchObject({ ok: false, code: 'parents-mismatch' });
        for (const path of ['CLAUDE.md', '.github/dependabot.yml', '.copilot/omg.jsonc', 'AGENTS.md', '.claude/settings.json']) {
            expect(imp(mkCommit(p.gitDir, base, [{ path, content: 'evil\n' }]), [base])).toMatchObject({ ok: false, code: 'protected-path' });
        }
        expect(imp(mkCommit(p.gitDir, base, [{ path: 'docs/policy.md', content: 'x' }]), [base], { extraProtected: ['docs/'] })).toMatchObject({ ok: false, code: 'protected-path' });
        expect(imp(mkCommit(p.gitDir, base, [{ path: 'vendor/sub', mode: '160000', oid: base }]), [base])).toMatchObject({ ok: false, code: 'gitlink' });
        expect(imp(mkCommit(p.gitDir, base, [{ path: 'link', mode: '120000', content: '../../.ssh/id_rsa' }]), [base])).toMatchObject({ ok: false, code: 'symlink' });
        expect(userRef()).toBe('');
        // Reasons are fixed text: nothing the lane chose.
        const r = imp(mkCommit(p.gitDir, base, [{ path: 'CLAUDE.md', content: 'x' }]), [base]);
        expect(r.ok === false && r.reason).toBe('the imported commit changes a protected path');
    }, T);
    it('refuses an fsck-bad object (a tree entry named .git); a plain fetch without fsck takes it (control)', () => {
        makePrivate();
        const blob = g(dir, [`--git-dir=${p.gitDir}`, 'hash-object', '-w', '--stdin'], { input: 'x' });
        const tree = g(dir, [`--git-dir=${p.gitDir}`, 'hash-object', '-w', '--literally', '-t', 'tree', '--stdin'], { input: Buffer.concat([Buffer.from('100644 .git\0'), Buffer.from(blob, 'hex')]) });
        const sha = g(dir, [`--git-dir=${p.gitDir}`, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', base, '-m', 'bad']);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'fetch-failed' });
        expect(userRef()).toBe('');
        const control = join(dir, 'control');
        g(dir, ['init', '-q', '--bare', control]);
        g(dir, [`--git-dir=${control}`, '-c', 'transfer.fsckObjects=false', 'fetch', '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', p.gitDir, `${sha}:refs/x`]);
        expect(g(dir, [`--git-dir=${control}`, 'rev-parse', 'refs/x'])).toBe(sha);
    }, T);
    it('a hook planted in the private repository: runs on a plain fetch into it (control), the import refuses and runs nothing', () => {
        makePrivate();
        const marker = join(dir, 'hook-marker');
        writeHook(join(p.gitDir, 'hooks'), 'reference-transaction', marker);
        g(dir, [`--git-dir=${p.gitDir}`, 'fetch', layout.seed, `+${base}:refs/control`]);
        expect(existsSync(marker)).toBe(true);
        g(dir, [`--git-dir=${p.gitDir}`, 'update-ref', '-d', 'refs/control']);
        rmSync(marker);
        const sha = mkCommit(p.gitDir, base, [{ path: 'x', content: 'x' }]);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'private-repo' });
        expect(existsSync(marker)).toBe(false);
    }, T);
    it('a hook in the user repository runs on a plain import fetch (control) but not on importFromPrivate', () => {
        makePrivate();
        const marker = join(dir, 'user-hook-marker');
        writeHook(join(userGit, 'hooks'), 'reference-transaction', marker);
        const sha = mkCommit(p.gitDir, base, [{ path: 'x', content: 'x' }]);
        g(user, ['fetch', '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', p.gitDir, `+${sha}:refs/control`]);
        expect(existsSync(marker)).toBe(true);
        g(user, ['update-ref', '-d', 'refs/control']);
        rmSync(marker);
        expect(imp(sha, [base])).toMatchObject({ ok: true });
        dropImportRef(userGit, run, 1, sha, ctx);
        expect(existsSync(marker)).toBe(false);
    }, T);
    it('core.alternateRefsCommand planted in the private config is refused', () => {
        makePrivate();
        const marker = join(dir, 'alt-marker');
        g(dir, ['config', '--file', join(p.gitDir, 'config'), 'core.alternateRefsCommand', touchCmd(marker)]);
        const sha = mkCommit(p.gitDir, base, [{ path: 'x', content: 'x' }]);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'private-repo' });
        expect(existsSync(marker)).toBe(false);
    }, T);
    it('bare=false + updateInstead + a smudge filter: a push runs it (control, receive side), a plain fetch from it does not (control, the import direction); the import refuses it, and runs nothing when it is planted after the checks', () => {
        makePrivate();
        const marker = join(dir, 'smudge-marker');
        const cfg = join(p.gitDir, 'config');
        const pristine = readFileSync(cfg);
        const plant = () => {
            g(dir, ['config', '--file', cfg, 'receive.denyCurrentBranch', 'updateInstead']);
            g(dir, ['config', '--file', cfg, 'filter.x.smudge', `${touchCmd(marker)}; cat`]);
            mkdirSync(join(p.gitDir, 'info'), { recursive: true });
            writeFileSync(join(p.gitDir, 'info', 'attributes'), '* filter=x\n');
        };
        plant();
        g(dir, [`--git-dir=${p.gitDir}`, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
        g(user, ['push', p.gitDir, `${base}:refs/heads/main`]);
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        const sha = mkCommit(p.gitDir, base, [{ path: 'x', content: 'x' }]);
        // The import's direction: the user repository fetches, the private side only runs upload-pack. No filter runs there.
        g(user, ['fetch', '--no-write-fetch-head', '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', p.gitDir, `+${sha}:refs/control`]);
        g(user, ['update-ref', '-d', 'refs/control']);
        expect(existsSync(marker)).toBe(false);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'private-repo' });
        expect(existsSync(marker)).toBe(false);
        // Planted after the checks passed, right before the import fetch: the fetch still runs no filter and the import goes through.
        writeFileSync(cfg, pristine);
        rmSync(join(p.gitDir, 'info'), { recursive: true });
        g(dir, [`--git-dir=${p.gitDir}`, 'update-ref', '--no-deref', 'HEAD', base]);
        g(dir, [`--git-dir=${p.gitDir}`, 'update-ref', '-d', 'refs/heads/main']);
        expect(privateRepoConfigHash(p.gitDir)).toBe(p.configHash);
        ctx = { ...ctx, exec: racingExec((a) => isFetch(a) && a.includes(`--git-dir=${userGit}`), plant) };
        expect(imp(sha, [base])).toMatchObject({ ok: true });
        expect(existsSync(marker)).toBe(false);
    }, T);
    it('refuses a changed config hash (info/ written), a gitfile redirect and extra alternates', () => {
        makePrivate();
        const sha = mkCommit(p.gitDir, base, [{ path: 'x', content: 'x' }]);
        mkdirSync(join(p.gitDir, 'info'), { recursive: true });
        writeFileSync(join(p.gitDir, 'info', 'exclude'), 'x\n');
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'private-repo', reason: expect.stringMatching(/changed since/) });
        rmSync(join(p.gitDir, 'info'), { recursive: true });
        expect(privateRepoConfigHash(p.gitDir)).toBe(p.configHash);
        writeFileSync(join(p.gitDir, '.git'), `gitdir: ${fwd(join(dir, 'evil.git'))}\n`);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'private-repo', reason: expect.stringMatching(/redirect/) });
        rmSync(join(p.gitDir, '.git'));
        appendFileSync(join(p.gitDir, 'objects', 'info', 'alternates'), `${fwd(join(userGit, 'objects'))}\n`);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'private-repo', reason: expect.stringMatching(/alternates/) });
    }, T);
    it('refuses a user config that rewrites the private path or relaxes fsck', () => {
        makePrivate();
        const sha = mkCommit(p.gitDir, base, [{ path: 'x', content: 'x' }]);
        g(user, ['config', `url.${fwd(join(dir, 'evil.git'))}.insteadOf`, fwd(layout.runDir)]);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'user-repo', reason: expect.stringMatching(/rewrites/) });
        g(user, ['config', '--remove-section', `url.${fwd(join(dir, 'evil.git'))}`]);
        g(user, ['config', 'fetch.fsck.hasDotgit', 'ignore']);
        expect(imp(sha, [base])).toMatchObject({ ok: false, code: 'user-repo', reason: expect.stringMatching(/fsck/) });
    }, T);
});
describe('import hardening (review-481)', () => {
    const run = 'issue-1';
    const imp = (sha, parents, extra, c = ctx) => importFromPrivate({ userGitDir: userGit, privateRepo: p, sha, expectedParents: parents, startSha: base, run, n: 1, ...extra }, c);
    const userRef = () => g(user, ['for-each-ref', 'refs/omg-import/']);
    const loose = (gitDir, oid) => join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
    it('HIGH-1: a planted promisor remote + a missing object runs its uploadpack on the module\'s ls-tree / cat-file -e shapes without GIT_NO_LAZY_FETCH (control); the module refuses it, and runs nothing when it is planted after the checks', () => {
        makePrivate();
        const marker = join(dir, 'lazy-marker');
        const cfg = join(p.gitDir, 'config');
        const pristine = readFileSync(cfg);
        const plant = () => {
            for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'evil'], ['remote.evil.promisor', 'true'], ['remote.evil.url', fwd(userGit)], ['remote.evil.uploadpack', `${touchCmd(marker)}; git upload-pack`]]) {
                g(dir, ['config', '--file', cfg, k, v]);
            }
        };
        const head = mkCommit(p.gitDir, base, [{ path: 'src/x.ts', content: 'x\n' }]);
        const tree = g(dir, [`--git-dir=${p.gitDir}`, 'rev-parse', `${head}^{tree}`]);
        expect(existsSync(loose(p.gitDir, tree))).toBe(true);
        rmSync(loose(p.gitDir, tree), { force: true });
        plant();
        // Control: the module's exact pins and environment minus GIT_NO_LAZY_FETCH.
        const env = { ...process.env, ...privateGitEnv(ctx.tools) };
        delete env.GIT_NO_LAZY_FETCH;
        spawnSync('git', [...privateGitPins(ctx.tools), `--git-dir=${p.gitDir}`, 'ls-tree', '-z', '--full-tree', '--full-name', head, '--', 'package-lock.json'], { cwd: dir, env, encoding: 'utf8' });
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        spawnSync('git', [...privateGitPins(ctx.tools), `--git-dir=${p.gitDir}`, 'cat-file', '-e', `${tree}^{commit}`], { cwd: dir, env, encoding: 'utf8' });
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        // Planted before: refused by privateRepoProblem (now run by lockfileUnchanged too).
        expect(() => lockfileUnchanged(p, base, head, ctx)).toThrow(/changed since the engine wrote them/);
        expect(existsSync(marker)).toBe(false);
        // Planted after the checks, right before the read: the read fails closed, nothing runs.
        writeFileSync(cfg, pristine);
        expect(privateRepoConfigHash(p.gitDir)).toBe(p.configHash);
        expect(() => lockfileUnchanged(p, base, head, { ...ctx, exec: racingExec((a) => a.includes('ls-tree'), plant) })).toThrow(/lockfile listing/);
        expect(existsSync(marker)).toBe(false);
        // The hasCommit shape (cat-file -e <sha>^{commit}) after fetchIntoPrivate's transport.
        writeFileSync(cfg, pristine);
        writeFileSync(join(user, 'b.txt'), 'b\n');
        g(user, ['add', 'b.txt']);
        g(user, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'moved']);
        const moved = g(user, ['rev-parse', 'HEAD']);
        const raceCatFile = racingExec((a) => a.includes('cat-file'), () => {
            plant();
            // `moved` arrived loose or in a pack: remove both forms (every pack; the read below only needs `moved` missing).
            rmSync(loose(p.gitDir, moved), { force: true });
            const packDir = join(p.gitDir, 'objects', 'pack');
            for (const f of readdirSync(packDir)) {
                chmodSync(join(packDir, f), 0o666);
                rmSync(join(packDir, f));
            }
        });
        expect(() => fetchIntoPrivate(layout, p, userGit, moved, { ...ctx, exec: raceCatFile })).toThrow(/does not have/);
        expect(existsSync(marker)).toBe(false);
    }, T);
    it('HIGH-1: refuses a private config that makes a partial clone or a format version the engine did not write', () => {
        makePrivate();
        const cfg = join(p.gitDir, 'config');
        g(dir, ['config', '--file', cfg, 'core.repositoryformatversion', '1']);
        const s = { ...p, configHash: privateRepoConfigHash(p.gitDir) };
        expect(privateRepoProblem(s, ctx)).toMatch(/format version/);
        g(dir, ['config', '--file', cfg, 'remote.evil.promisor', 'true']);
        expect(privateRepoProblem({ ...p, configHash: privateRepoConfigHash(p.gitDir) }, ctx)).toMatch(/partial clone/);
    }, T);
    it('M2: refuses a private-only parent or start before any transport; a second new commit is refused by default', () => {
        makePrivate();
        const c1 = mkCommit(p.gitDir, base, [{ path: 'src/a.ts', content: 'a' }]);
        const c2 = mkCommit(p.gitDir, c1, [{ path: 'src/b.ts', content: 'b' }]);
        const calls = [];
        const spy = (cmd, args, opts) => {
            calls.push(args);
            return defaultExec(cmd, args, opts);
        };
        expect(imp(c2, [c1], {}, { ...ctx, exec: spy })).toEqual({ ok: false, code: 'bad-input', reason: 'the start commit and every expected parent must already be commits in the repository' });
        expect(imp(c2, [base], { startSha: c1 }, { ...ctx, exec: spy })).toMatchObject({ ok: false, code: 'bad-input' });
        expect(calls.some((a) => a.includes('fetch') || a.some((x) => x.startsWith('--upload-pack')))).toBe(false);
        expect(spawnSync('git', ['--git-dir', userGit, 'cat-file', '-e', c1]).status).not.toBe(0);
        // Two new commits on the user's base: the tip's parent is private-only, so the default (exactly one new commit) refuses.
        expect(imp(c2, [base])).toMatchObject({ ok: false, code: 'parents-mismatch' });
        expect(userRef()).toBe('');
    }, T);
    it('L1: a refusal whose ref cannot be deleted says "import ref left"; dropImportRef checks the status and the old value', () => {
        makePrivate();
        const bad = mkCommit(p.gitDir, base, [{ path: 'CLAUDE.md', content: 'x' }]);
        const lock = join(userGit, 'refs', 'omg-import', run, '1.lock');
        const c = { ...ctx, exec: racingExec((a) => a.includes('update-ref'), () => writeFileSync(lock, '')) };
        const r = imp(bad, [base], {}, c);
        expect(r).toMatchObject({ ok: false, code: 'ref-left' });
        expect(r.ok === false && r.reason.startsWith('import ref left')).toBe(true);
        expect(() => dropImportRef(userGit, run, 1, bad, ctx)).toThrow(/import ref left/);
        rmSync(lock);
        dropImportRef(userGit, run, 1, bad, ctx);
        expect(userRef()).toBe('');
    }, T);
    it('L7: a git command over its timeout is killed and refuses with a fixed reason', () => {
        makePrivate();
        const sha = mkCommit(p.gitDir, base, [{ path: 'src/x.ts', content: 'x' }]);
        expect(imp(sha, [base], {}, { ...ctx, timeoutMs: 1 })).toEqual({ ok: false, code: 'timeout', reason: 'a git command of the import timed out and was killed' });
        expect(() => ensureSeed(layout, userGit, sha, { ...ctx, timeoutMs: 1 })).toThrow(/timed out after 1 ms/);
    }, T);
    it('L3: protected-path matching folds Unicode look-alikes and default-ignorable code points', () => {
        expect(protectedChanges(['.huſky/pre-commit', 'CLAUDE‌.md', '.ｇithub/x', '.copilot/omg.jſonc'], [...LANE_PROTECTED_PATHS])).toHaveLength(4);
        expect(protectedChanges(['.github/workflowſ/ci.yml', '.copilot/omg.jſonc'])).toHaveLength(2);
        expect(protectedChanges(['src/huſky.ts', 'docs/claude.md'])).toEqual([]);
    });
});
describe('seed integrity (review-481 M1)', () => {
    it('a seed blob replaced by another object\'s bytes: a shared clone shows the evil content (control); createPrivateRepo refuses before its clone, and a --no-local clone never carries it', () => {
        ensureSeed(layout, userGit, base, ctx);
        // The fetch kept a pack: explode it into loose objects, so one object's bytes can be swapped.
        const packDir = join(layout.seed, 'objects', 'pack');
        for (const name of readdirSync(packDir).filter((n) => n.endsWith('.pack'))) {
            const bytes = readFileSync(join(packDir, name));
            for (const f of readdirSync(packDir).filter((n) => n.startsWith(name.slice(0, -5)))) {
                chmodSync(join(packDir, f), 0o666);
                rmSync(join(packDir, f));
            }
            g(dir, [`--git-dir=${layout.seed}`, 'unpack-objects', '-q'], { input: bytes });
        }
        const blob = g(dir, [`--git-dir=${layout.seed}`, 'rev-parse', `${base}:a.txt`]);
        const other = g(dir, [`--git-dir=${layout.seed}`, 'rev-parse', `${base}:package-lock.json`]);
        const at = (oid) => join(layout.seed, 'objects', oid.slice(0, 2), oid.slice(2));
        expect(existsSync(at(blob)) && existsSync(at(other))).toBe(true);
        chmodSync(at(blob), 0o666);
        writeFileSync(at(blob), readFileSync(at(other)));
        // Control: alternates (what --reference made) read the bad bytes unverified.
        const shared = join(dir, 'shared');
        g(dir, ['clone', '-q', '--shared', '--no-checkout', layout.seed, shared]);
        expect(g(shared, ['cat-file', '-p', blob])).toContain('lockfileVersion');
        expect(() => createPrivateRepo(layout, base, ctx)).toThrow(/fails git fsck/);
        expect(existsSync(layout.repo)).toBe(false);
        const full = join(dir, 'full');
        const r = spawnSync('git', ['-c', 'transfer.fsckObjects=true', 'clone', '-q', '--no-local', '--no-checkout', layout.seed, full], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobal } });
        const carried = r.status === 0 ? spawnSync('git', ['--git-dir', join(full, '.git'), 'cat-file', '-p', blob], { encoding: 'utf8' }).stdout : '';
        expect(carried).not.toContain('lockfileVersion');
    }, T);
});
describe('user repository guard', () => {
    const snap = () => userRepoGuardSnapshot(userGit, ctx);
    it('does not change on the user\'s ordinary git activity: push -u, remote add / set-url, user.name, info/exclude, sparse-checkout, worktree add, gc, commit-graph write', () => {
        const remote = join(dir, 'remote.git');
        g(dir, ['init', '-q', '--bare', remote]);
        const before = snap();
        g(user, ['remote', 'add', 'origin', remote]);
        g(user, ['remote', 'set-url', 'origin', fwd(remote)]);
        g(user, ['push', '-q', '-u', 'origin', 'main']);
        g(user, ['branch', '--set-upstream-to=origin/main', 'main']);
        g(user, ['config', 'user.name', 'Someone']);
        mkdirSync(join(userGit, 'info'), { recursive: true });
        appendFileSync(join(userGit, 'info', 'exclude'), 'tmp/\n');
        g(user, ['sparse-checkout', 'set', 'src']);
        g(user, ['sparse-checkout', 'disable']);
        g(user, ['worktree', 'add', '-q', '-b', 'side', join(dir, 'wt2')]);
        g(user, ['commit-graph', 'write', '--reachable']);
        g(user, ['gc', '-q']);
        expect(checkUserRepoGuard(before, ctx)).toEqual([]);
    }, T);
    it('notices a planted hook, a hooksPath set through an included file (and a hook there), a filter, an alias, a url.insteadOf, alternates, a replace ref, a submodule hook and a worktree commondir redirect', () => {
        let before = snap();
        writeHook(join(userGit, 'hooks'), 'pre-commit', join(dir, 'm'));
        expect(checkUserRepoGuard(before, ctx)).toEqual(['hooks']);
        rmSync(join(userGit, 'hooks', 'pre-commit'));
        writeFileSync(join(userGit, 'inc.cfg'), '');
        g(user, ['config', 'include.path', 'inc.cfg']);
        before = snap();
        const hp = join(dir, 'evil-hooks');
        mkdirSync(hp);
        writeFileSync(join(userGit, 'inc.cfg'), `[core]\n\thooksPath = ${fwd(hp)}\n`);
        expect(checkUserRepoGuard(before, ctx)).toEqual(['config', 'hooksPath']);
        before = snap();
        writeHook(hp, 'pre-commit', join(dir, 'm'));
        expect(checkUserRepoGuard(before, ctx)).toEqual(['hooksPath']);
        before = snap();
        for (const [k, v] of [['filter.x.smudge', 'evil'], ['alias.st', '!evil'], [`url.${fwd(join(dir, 'evil'))}.insteadOf`, 'https://example.invalid/']]) {
            g(user, ['config', k, v]);
            expect(checkUserRepoGuard(before, ctx)).toEqual(['config']);
            g(user, ['config', '--unset', k]);
            expect(checkUserRepoGuard(before, ctx)).toEqual([]);
        }
        writeFileSync(join(userGit, 'objects', 'info', 'alternates'), 'x\n');
        expect(checkUserRepoGuard(before, ctx)).toEqual(['alternates']);
        rmSync(join(userGit, 'objects', 'info', 'alternates'));
        const other = mkCommit(userGit, base, [{ path: 'e', content: 'e' }]);
        g(user, ['replace', base, other]);
        expect(checkUserRepoGuard(before, ctx)).toEqual(['replace']);
        g(user, ['replace', '-d', base]);
        g(dir, ['init', '-q', '--bare', join(userGit, 'modules', 'lib', 'sub')]);
        before = snap();
        writeHook(join(userGit, 'modules', 'lib', 'sub', 'hooks'), 'post-checkout', join(dir, 'm'));
        expect(checkUserRepoGuard(before, ctx)).toEqual(['modules']);
        g(user, ['worktree', 'add', '-q', '-b', 'side3', join(dir, 'wt3')]);
        before = snap();
        const [id] = readdirSync(join(userGit, 'worktrees'));
        writeFileSync(join(userGit, 'worktrees', id, 'commondir'), `${fwd(join(dir, 'evil.git'))}\n`);
        expect(checkUserRepoGuard(before, ctx)).toEqual(['worktrees']);
    }, T);
});
describe('removeRunDir', () => {
    it('unlinks junctions/symlinks at any depth without emptying their targets, then removes the dir (read-only files too)', () => {
        const work = join(dir, 'fw');
        const run = join(work, 'abcdef01', 'issue-1');
        const target = join(dir, 'main-node_modules');
        mkdirSync(join(target, 'pkg'), { recursive: true });
        writeFileSync(join(target, 'pkg', 'marker.txt'), 'keep me');
        mkdirSync(join(run, 'w', 'prep', 'deep'), { recursive: true });
        symlinkSync(target, join(run, 'w', 'prep', 'node_modules'), win ? 'junction' : 'dir');
        symlinkSync(target, join(run, 'w', 'prep', 'deep', 'nm2'), win ? 'junction' : 'dir');
        writeFileSync(join(run, 'w', 'prep', 'ro.txt'), 'ro');
        chmodSync(join(run, 'w', 'prep', 'ro.txt'), 0o444);
        removeRunDir(run, work);
        expect(existsSync(run)).toBe(false);
        expect(readFileSync(join(target, 'pkg', 'marker.txt'), 'utf8')).toBe('keep me');
    });
    it('removes a real private repository (read-only git objects) and refuses a dir outside the work root', () => {
        makePrivate();
        removeRunDir(layout.runDir, layout.work);
        expect(existsSync(layout.runDir)).toBe(false);
        expect(existsSync(layout.seed)).toBe(true);
        expect(() => removeRunDir(user, layout.work)).toThrow(/not under the private work root/);
        expect(() => removeRunDir(layout.work, layout.work)).toThrow(/not under the private work root/);
    }, T);
    it('moves the dir to a .trash-<random> name first, and refuses a directory swapped for a junction between walk steps (the target marker survives)', () => {
        const work = join(dir, 'fw');
        const run = join(work, 'abcdef01', 'issue-1');
        const target = join(dir, 'outside');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'marker.txt'), 'keep me');
        mkdirSync(join(run, 'w', 'prep', 'sub'), { recursive: true });
        writeFileSync(join(run, 'w', 'prep', 'sub', 'f.txt'), 'f');
        const seen = [];
        let swapped = false;
        const seam = {
            beforeReaddir: (d) => {
                seen.push(d);
                if (!swapped && basename(d) === 'sub') {
                    swapped = true;
                    renameSync(d, `${d}-moved`);
                    symlinkSync(target, d, win ? 'junction' : 'dir');
                }
            },
        };
        expect(() => removeRunDir(run, work, process.platform, seam)).toThrow(/was replaced/);
        expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep me');
        expect(existsSync(run)).toBe(false);
        expect(basename(dirname(seen[0]))).toBe('abcdef01');
        expect(basename(seen[0])).toMatch(/^\.trash-[0-9a-f]{16}$/);
    });
});
describe('lockfileUnchanged', () => {
    it('junction only when every base lockfile is byte-identical at the head and none was added', () => {
        makePrivate();
        const same = mkCommit(p.gitDir, base, [{ path: 'src/x.ts', content: 'x' }]);
        expect(lockfileUnchanged(p, base, same, ctx)).toEqual({ policy: 'junction', lockfiles: ['package-lock.json'], changed: [] });
        const changed = mkCommit(p.gitDir, base, [{ path: 'package-lock.json', content: '{"lockfileVersion":3,"x":1}\n' }]);
        expect(lockfileUnchanged(p, base, changed, ctx)).toMatchObject({ policy: 'park', changed: ['package-lock.json'] });
        const added = mkCommit(p.gitDir, base, [{ path: 'yarn.lock', content: 'y' }]);
        expect(lockfileUnchanged(p, base, added, ctx)).toMatchObject({ policy: 'park', changed: ['yarn.lock'] });
        const noLock = mkCommit(p.gitDir, base, [], []);
        expect(lockfileUnchanged(p, noLock, noLock, ctx).policy).toBe('junction');
        const emptyTree = g(dir, [`--git-dir=${p.gitDir}`, 'hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' });
        const empty = g(dir, [`--git-dir=${p.gitDir}`, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', emptyTree, '-m', 'empty']);
        expect(lockfileUnchanged(p, empty, empty, ctx)).toEqual({ policy: 'park', lockfiles: [], changed: [] });
    }, T);
});
//# sourceMappingURL=private-store.test.js.map