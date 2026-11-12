/**
 * git-view.ts: a one-commit standalone repository built from trusted
 * objects. Real git on throwaway repositories, through the engine's own
 * hardened host git (runHostGit / runHostGitBuffer).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scrubShipEnv } from '../../../ship/exec.js';
import { runHostGit, runHostGitBuffer } from '../../../team/git-worktree.js';
import { buildGitView, type GitViewGit, type GitViewSource } from '../git-view.js';

let dir: string;
let repo: string;
const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
/** git in the view, never above it. */
const inView = (cwd: string, ...args: string[]): { status: number; out: string } => {
  try {
    return { status: 0, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...scrubShipEnv(process.env), GIT_CEILING_DIRECTORIES: join(cwd, '..') } }).trim() };
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 1, out: '' };
  }
};
const env = scrubShipEnv(process.env);
const source = (root: string): GitViewSource => (args, input) => runHostGitBuffer(root, args, undefined, env, input);
const viewGit: GitViewGit = (cwd, args, input) => runHostGit(cwd, args, undefined, env, input);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-gitview-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'first');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildGitView', () => {
  it('holds exactly the one commit: its tree and files, HEAD detached at it, no parent, no ref, no remote, no hooks', () => {
    const parent = g(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'b.txt'), 'two\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'second');
    const sha = g(repo, 'rev-parse', 'HEAD');
    // Other refs, objects and a remote in the source: none may reach the view.
    g(repo, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(repo, 'secret.txt'), 'other branch only\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'other');
    const otherBlob = g(repo, 'rev-parse', 'HEAD:secret.txt');
    g(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n');

    const out = join(dir, 'export');
    const gitDir = buildGitView(out, sha, source(repo), viewGit);
    expect(gitDir).toBe(join(out, '.git'));
    expect(readdirSync(gitDir).sort()).toEqual(['HEAD', 'config', 'index', 'objects', 'refs', 'shallow']);
    expect(readFileSync(join(gitDir, 'HEAD'), 'utf8')).toBe(`${sha}\n`);
    expect(readFileSync(join(gitDir, 'shallow'), 'utf8')).toBe(`${sha}\n`);
    expect(readFileSync(join(gitDir, 'config'), 'utf8')).not.toMatch(/remote|hooksPath|fsmonitor/);
    expect(inView(out, 'rev-parse', 'HEAD')).toEqual({ status: 0, out: sha });
    expect(inView(out, 'ls-files').out.split('\n')).toEqual(['a.txt', 'src/b.txt']);
    expect(inView(out, 'merge-base', '--is-ancestor', sha, 'HEAD').status).toBe(0);
    expect(inView(out, 'rev-list', '--all').out).toBe(sha);
    expect(inView(out, 'for-each-ref').out).toBe('');
    expect(inView(out, 'remote').out).toBe('');
    expect(inView(out, 'cat-file', '-e', parent).status).not.toBe(0);
    expect(inView(out, 'cat-file', '-e', otherBlob).status).not.toBe(0);
    expect(inView(out, 'count-objects', '-v').out).toMatch(/in-pack: 5\b/);
    // Removed with its dir (pack files are read-only on disk).
    rmSync(out, { recursive: true, force: true });
    expect(existsSync(out)).toBe(false);
  });

  it('reads the real commit when the source has a replace ref for it', () => {
    const sha = g(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'forged\n');
    g(repo, 'commit', '-q', '-am', 'forged');
    const forged = g(repo, 'rev-parse', 'HEAD');
    g(repo, 'replace', sha, forged);
    const out = join(dir, 'export');
    buildGitView(out, sha, source(repo), viewGit);
    expect(inView(out, 'show', 'HEAD:a.txt').out).toBe('one');
  });

  it('refuses a short id, a non-commit and an existing .git; a view of the base export works with the files present', () => {
    const sha = g(repo, 'rev-parse', 'HEAD');
    expect(() => buildGitView(join(dir, 'x'), sha.slice(0, 12), source(repo), viewGit)).toThrow(/full commit id/);
    expect(() => buildGitView(join(dir, 'x'), g(repo, 'rev-parse', 'HEAD^{tree}'), source(repo), viewGit)).toThrow(/not a commit/);
    const out = join(dir, 'export');
    mkdirSync(join(out, '.git'), { recursive: true });
    expect(() => buildGitView(out, sha, source(repo), viewGit)).toThrow(/already exists/);
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'a.txt'), 'one\n');
    buildGitView(plain, sha, source(repo), viewGit);
    expect(inView(plain, 'status', '--porcelain').out).toBe('');
  });

  it('refuses a commit whose objects sum above the byte cap before any pack is made, and an object size git cannot read', () => {
    const sha = g(repo, 'rev-parse', 'HEAD');
    const seen: string[] = [];
    const watched: GitViewSource = (args, input) => { seen.push(args[0]); return source(repo)(args, input); };
    // The commit, its tree and a.txt ("one\n", 4 bytes) sum to more than 4 bytes.
    expect(() => buildGitView(join(dir, 'big'), sha, watched, viewGit, 4)).toThrow(/bytes of objects, above the 4 a git view holds/);
    expect(seen).not.toContain('pack-objects');
    expect(existsSync(join(dir, 'big'))).toBe(false);
    const isCheck = (args: readonly string[]): boolean => args[0] === 'cat-file' && args[1].startsWith('--batch-check');
    const sizes = (input: Buffer | undefined): string[] => String(input).split('\n').filter(Boolean).map(() => '4');
    const missing: GitViewSource = (args, input) => (isCheck(args) ? Buffer.from(['4', '4', `${'0'.repeat(40)} missing`].join('\n')) : source(repo)(args, input));
    expect(() => buildGitView(join(dir, 'gone'), sha, missing, viewGit)).toThrow(/could not be read/);
    // L3: fewer (or more) size lines than objects refuse: a short answer must not sum to a small total.
    const short: GitViewSource = (args, input) => (isCheck(args) ? Buffer.from(`${sizes(input).slice(1).join('\n')}\n`) : source(repo)(args, input));
    expect(() => buildGitView(join(dir, 'short'), sha, short, viewGit)).toThrow(/reported 2 object sizes for the 3 objects/);
    const extra: GitViewSource = (args, input) => (isCheck(args) ? Buffer.from(`${[...sizes(input), '4'].join('\n')}\n`) : source(repo)(args, input));
    expect(() => buildGitView(join(dir, 'extra'), sha, extra, viewGit)).toThrow(/reported 4 object sizes for the 3 objects/);
    expect(existsSync(join(dir, 'short'))).toBe(false);
    // Under the default cap the same commit builds.
    expect(buildGitView(join(dir, 'ok'), sha, source(repo), viewGit)).toBe(join(dir, 'ok', '.git'));
  });
});
