/**
 * Engine-read staging and the secret-shape scan of commitLaneWork (audit H3
 * layer 2, L3): real git in temp repos, no Copilot.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorktreeGitLinks, recordWorktreeGitLinks, runHostGit, worktreeGitDirArgs } from '../../../team/git-worktree.js';
import { commitLaneWork, engineRead, pathGlobMatches } from '../lane-commit.js';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
// A fake token of the github-token shape, built so this source file never holds one.
const TOKEN = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
let dir;
let root;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-lane-staging-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.invalid');
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'core.autocrlf', 'false');
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
function commitAll(files) {
    for (const [p, c] of Object.entries(files)) {
        mkdirSync(join(root, p, '..'), { recursive: true });
        writeFileSync(join(root, p), c);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    return git(root, 'rev-parse', 'HEAD');
}
let n = 0;
function laneTree() {
    const worktree = join(dir, `lane-${++n}`);
    const start = git(root, 'rev-parse', 'HEAD');
    git(root, 'worktree', 'add', '-q', '--detach', worktree, start);
    recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree));
    return { worktree, start };
}
/** The tree the previous engine code staged: host git `add -A` into a fresh index from the start, then write-tree. */
function addAllTree(worktree, start) {
    const index = join(dir, `old-index-${n}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const dirs = worktreeGitDirArgs(worktree);
    runHostGit(worktree, [...dirs, 'read-tree', start], 60_000, env);
    runHostGit(worktree, [...dirs, 'add', '-A', '--', '.'], 60_000, env);
    return runHostGit(worktree, [...dirs, 'write-tree'], 60_000, env).trim();
}
const treeOf = (sha) => git(root, 'rev-parse', `${sha}^{tree}`);
/** Base fixtures: LF, CRLF (committed with CRs), a binary with CR and NUL, a file to delete, one to rename, a tree .gitattributes. */
function equivalenceFixture() {
    commitAll({
        'lf.txt': 'one\ntwo\n',
        'crlf-in-index.txt': 'a\r\nb\r\n',
        'was-binary.txt': Buffer.from([0, 13, 10, 0]),
        'mixed.txt': 'a\nb\n',
        'bin.dat': Buffer.from([0, 13, 10, 255, 13, 0]),
        'gone.txt': 'delete me\n',
        'old name.txt': 'moved\n',
        'nested/deep/keep.txt': 'k\n',
        '.gitattributes': '* text=auto eol=crlf\n*.dat binary\n',
    });
}
function laneEdits(worktree) {
    writeFileSync(join(worktree, 'lf.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(worktree, 'crlf-in-index.txt'), 'a\r\nb\r\nc\r\n');
    writeFileSync(join(worktree, 'new-crlf.txt'), 'x\r\ny\r\n');
    writeFileSync(join(worktree, 'was-binary.txt'), 'now text\r\n');
    writeFileSync(join(worktree, 'mixed.txt'), 'a\r\nb\nc\r\n');
    writeFileSync(join(worktree, 'lone-cr.txt'), 'a\rb\r\n');
    writeFileSync(join(worktree, 'ctrl-z.txt'), 'dos\r\n\x1a');
    writeFileSync(join(worktree, 'bin.dat'), Buffer.from([0, 13, 10, 1, 2, 3, 13]));
    writeFileSync(join(worktree, 'empty.txt'), '');
    unlinkSync(join(worktree, 'gone.txt'));
    unlinkSync(join(worktree, 'old name.txt'));
    writeFileSync(join(worktree, 'new name ü 名前.txt'), 'moved\n');
    mkdirSync(join(worktree, 'nested', 'deeper', 'still'), { recursive: true });
    writeFileSync(join(worktree, 'nested', 'deeper', 'still', 'n.txt'), 'n\n');
    writeFileSync(join(worktree, 'run.sh'), '#!/bin/sh\necho hi\n');
    if (process.platform !== 'win32')
        chmodSync(join(worktree, 'run.sh'), 0o755);
}
describe('engine-read staging: the tree equals the one `git add -A` staged', () => {
    for (const autocrlf of ['false', 'true', 'input']) {
        it(`core.autocrlf ${autocrlf}: text (LF, CRLF), binary, empty, deleted, renamed, unicode and spaced names, nested dirs, exec bit`, () => {
            equivalenceFixture();
            git(root, 'config', 'core.autocrlf', autocrlf);
            const { worktree, start } = laneTree();
            laneEdits(worktree);
            const expected = addAllTree(worktree, start);
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x' });
            expect(res.ok, JSON.stringify(res)).toBe(true);
            expect(treeOf(res.sha)).toBe(expected);
            if (process.platform !== 'win32')
                expect(git(root, 'ls-tree', res.sha, 'run.sh')).toMatch(/^100755 /);
            // The worktree's own index follows the commit, as `add -A` left it.
            expect(git(worktree, 'write-tree')).toBe(expected);
        });
    }
    it('a file replaced by a directory, and a directory replaced by a file', () => {
        commitAll({ 'a': 'file\n', 'd/x.txt': 'x\n' });
        const { worktree, start } = laneTree();
        unlinkSync(join(worktree, 'a'));
        mkdirSync(join(worktree, 'a'));
        writeFileSync(join(worktree, 'a', 'inner.txt'), 'i\n');
        rmSync(join(worktree, 'd'), { recursive: true });
        writeFileSync(join(worktree, 'd'), 'now a file\n');
        const expected = addAllTree(worktree, start);
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(treeOf(res.sha)).toBe(expected);
    });
});
describe('engine-read staging: links and swaps', () => {
    it('refuses a hard-linked file', () => {
        commitAll({ 'a.txt': 'a\n' });
        const { worktree, start } = laneTree();
        const outside = join(dir, 'secret.txt');
        writeFileSync(outside, 'SECRET\n');
        linkSync(outside, join(worktree, 'h.txt'));
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x' });
        expect(res).toMatchObject({ ok: false, refusal: 'escaped' });
        expect(res.reason).toMatch(/hard-linked.*h\.txt/);
    });
    it('refuses a junction or directory symlink (the link walk), and nothing is committed', () => {
        commitAll({ 'a.txt': 'a\n' });
        const { worktree, start } = laneTree();
        const outside = join(dir, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'id_rsa'), 'SECRET\n');
        symlinkSync(outside, join(worktree, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x' });
        expect(res).toMatchObject({ ok: false, refusal: 'escaped' });
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(start);
    });
    it('engineRead: a link on a parent component is a swap, a link at the path is a link; nothing behind either is read', () => {
        const wt = join(dir, 'wt');
        mkdirSync(join(wt, 'real'), { recursive: true });
        const outside = join(dir, 'outside2');
        mkdirSync(outside);
        writeFileSync(join(outside, 'f.txt'), 'SECRET\n');
        symlinkSync(outside, join(wt, 'swapped'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(engineRead(wt, 'swapped/f.txt')).toMatchObject({ kind: 'swapped' });
        expect(engineRead(wt, 'swapped')).toMatchObject({ kind: 'link' });
        writeFileSync(join(wt, 'real', 'ok.txt'), 'ok\n');
        const ok = engineRead(wt, 'real/ok.txt');
        expect(ok.kind).toBe('file');
        expect(ok.bytes.toString()).toBe('ok\n');
        expect(engineRead(wt, 'real/missing.txt')).toEqual({ kind: 'deleted' });
    });
});
describe('secret-shape scan', () => {
    it('parks on a token shape, naming the path and kind but never the value', () => {
        commitAll({ 'a.txt': 'a\n' });
        const { worktree, start } = laneTree();
        writeFileSync(join(worktree, 'config.js'), `module.exports = { token: '${TOKEN}' };\n`);
        writeFileSync(join(worktree, 'key.pem'), '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x' });
        expect(res).toMatchObject({ ok: false, refusal: 'secret' });
        const r = res;
        expect(r.findings).toEqual([{ path: 'config.js', kind: 'github-token' }, { path: 'key.pem', kind: 'private-key' }]);
        expect(r.reason).toContain('config.js (github-token)');
        expect(JSON.stringify(res)).not.toContain(TOKEN.slice(4));
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(start);
    });
    it('the acknowledged (path, kind) pairs pass; a new pair still parks', () => {
        commitAll({ 'a.txt': 'a\n' });
        const { worktree, start } = laneTree();
        writeFileSync(join(worktree, 'fixture.json'), `{"t":"${TOKEN}"}\n`);
        const ack = [{ path: 'fixture.json', kind: 'github-token' }];
        expect(commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x', secretAck: ack }).ok).toBe(true);
        const second = laneTree();
        writeFileSync(join(second.worktree, 'fixture.json'), `{"t":"${TOKEN}"}\n`);
        writeFileSync(join(second.worktree, 'other.txt'), `AKIA${'ABCDEFGHIJKLMNOP'}\n`);
        const res = commitLaneWork({ worktree: second.worktree, start: second.start, parents: [second.start], repoRoot: root, branch: null, message: 'x', secretAck: ack });
        expect(res).toMatchObject({ ok: false, refusal: 'secret', findings: [{ path: 'other.txt', kind: 'aws-access-key' }] });
    });
    it('an allowPaths glob skips the scan for matching paths only', () => {
        commitAll({ 'a.txt': 'a\n' });
        const { worktree, start } = laneTree();
        mkdirSync(join(worktree, 'test', 'fixtures', 'deep'), { recursive: true });
        writeFileSync(join(worktree, 'test', 'fixtures', 'deep', 'tok.txt'), `${TOKEN}\n`);
        expect(commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x', secretAllowPaths: ['test/fixtures/**'] }).ok).toBe(true);
        expect(pathGlobMatches('test/fixtures/**', 'test/fixtures/deep/tok.txt')).toBe(true);
        expect(pathGlobMatches('**/*.pem', 'a/b/c.pem')).toBe(true);
        expect(pathGlobMatches('**/*.pem', 'c.pem')).toBe(true);
        expect(pathGlobMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
    });
    it('content already in the start tree is not flagged (an unchanged fixture, or one copied to a new path)', () => {
        commitAll({ 'fixtures/tok.txt': `${TOKEN}\n`, 'a.txt': 'a\n' });
        const { worktree, start } = laneTree();
        copyFileSync(join(worktree, 'fixtures', 'tok.txt'), join(worktree, 'fixtures', 'copy.txt'));
        writeFileSync(join(worktree, 'a.txt'), 'b\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: root, branch: null, message: 'x' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
    });
});
//# sourceMappingURL=lane-commit.staging.test.js.map