/**
 * Night 3 goal 2 (L2a): `omg factory pr list|view|diff|review` on the local
 * forge. A real repository with no origin, a real bare mirror and the
 * engine-owned PR store (OMC_HOME is a temp dir). review plays a human review
 * back; the local forge's reviewFeedback then reads it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryPrCommand, type FactoryPrDeps } from '../factory-pr.js';
import { checkDeps, commitAll, localRepo, LOCAL_PROJECT_CONFIG, programs, writeFile, type LocalRepo } from '../../../factory/check/__tests__/local-repo.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { localReviews } from '../../../forge/local/reviews.js';
import { readLocalReviews } from '../../../forge/local/store.js';
import { ReviewHeadMovedError } from '../../../forge/review-feedback.js';
import { getGlobalOmcStatePath } from '../../../utils/paths.js';

let repo: LocalRepo;
let ledger: string;
let scratch: string;
let storeDir: string;
let head: string;
let mirror: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = localRepo();
  ledger = mkdtempSync(join(tmpdir(), 'omg-pr-ledger-'));
  scratch = mkdtempSync(join(tmpdir(), 'omg-pr-scratch-'));
  mirror = resolveForgeConfig(undefined, undefined, LOCAL_PROJECT_CONFIG, undefined, { root: repo.root, stateDir: getGlobalOmcStatePath('forge') }).config.repo.url;
  storeDir = mirror.replace(/\.git$/, '');
  mkdirSync(join(mirror, '..'), { recursive: true });
  git(repo.root, 'init', '-q', '--bare', mirror);
  git(repo.root, 'checkout', '-q', '-b', 'factory/issue-1');
  writeFile(repo, 'src/flag.ts', 'export const version = "1.0.0";\n// \u001b[31mred\u001b[0m\nconst isAdmin = false; /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */\n');
  commitAll(repo, 'lane work');
  head = git(repo.root, 'rev-parse', 'HEAD');
  git(repo.root, 'checkout', '-q', 'main');
  git(repo.root, 'push', '-q', mirror, 'main', 'factory/issue-1');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'prs.json'), JSON.stringify({
    version: 1, next: 2,
    prs: [{ number: 1, head: 'factory/issue-1', base: 'main', title: 'Add a version flag\u001b]0;pwned\u0007\u200b', state: 'OPEN', isDraft: true, itemId: 1, createdAt: '2026-11-09T09:00:00.000Z' }],
  }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  for (const d of [repo.root, repo.home, ledger, scratch]) rmSync(d, { recursive: true, force: true });
});

const deps = (): FactoryPrDeps => ({ ...checkDeps(repo), user: () => 'Robin', ledgerDir: ledger });

async function cli(...argv: string[]): Promise<number> {
  repo.out.length = 0;
  repo.err.length = 0;
  process.exitCode = undefined;
  await factoryPrCommand(deps()).parseAsync(argv, { from: 'user' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}
const out = () => repo.out.join('\n');
const body = (text: string): string => {
  const p = join(scratch, `body-${Math.random().toString(16).slice(2)}.md`);
  writeFileSync(p, text);
  return p;
};

describe('omg factory pr on the local forge', () => {
  it('list: the store\'s PRs, titles without control characters (text and JSON)', async () => {
    expect(await cli('list'), repo.err.join('\n')).toBe(0);
    expect(out()).toBe('#1  OPEN (draft)  factory/issue-1 -> main  Add a version flag]0;pwned<U+200B>');
    expect(await cli('list', '--json')).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ schemaVersion: 1, ok: true, prs: [{ number: 1, state: 'OPEN', head: 'factory/issue-1', base: 'main', itemId: 1 }] });
    expect(programs(repo)).toEqual(['git']);
  });

  it('diff: base...head through the hardened factory git, control characters stripped', async () => {
    expect(await cli('diff', '1'), repo.err.join('\n')).toBe(0);
    expect(out()).toContain('+export const version = "1.0.0";');
    expect(out()).toContain('+// [31mred[0m');
    expect(out()).not.toMatch(/\u001b/);
    // MEDIUM-5: bidi and zero-width controls are shown, never applied.
    expect(out()).toContain('/*<U+202E> } <U+2066>if (isAdmin)<U+2069> <U+2066> begin admins only */');
    expect(out()).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/);
    // MEDIUM-6: the diff names the head it shows.
    expect(repo.out[0]).toBe(`local PR #1 head ${head} base ${git(repo.root, 'rev-parse', 'main')} (review it with --head ${head})`);
    const diff = repo.calls.find((c) => c.args.includes('diff'))!;
    expect(diff.args.slice(-4)).toEqual(['diff', '--no-ext-diff', '--no-textconv', expect.stringMatching(/^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/)]);
    expect(diff.args).toEqual(expect.arrayContaining([expect.stringMatching(/^core\.hooksPath=/), 'core.fsmonitor=false', 'diff.external=']));
  });

  it('M-D: diff and view refuse when the mirror base is not your local base (the merge base would hide commits)', async () => {
    // The mirror's main moves to the PR head itself: base...head would be empty and the lane's change hidden.
    git(repo.root, 'push', '-q', mirror, `${head}:refs/heads/main`);
    const local = git(repo.root, 'rev-parse', 'main');
    expect(await cli('diff', '1')).toBe(1);
    expect(repo.err.join('\n')).toContain(`the local forge mirror's main is at ${head}, but your main is at ${local}`);
    expect(repo.calls.some((c) => c.args.includes('diff'))).toBe(false);
    expect(await cli('view', '1', '--json')).toBe(1);
    expect(JSON.parse(out())).toMatchObject({ ok: false, error: expect.stringMatching(/the view would use a base you do not have/) });
    // Synced back: both read again.
    git(repo.root, 'push', '-q', '-f', mirror, `${local}:refs/heads/main`);
    expect(await cli('diff', '1'), repo.err.join('\n')).toBe(0);
  });

  it('review --request-changes records the head; view and the forge read it as an open thread', async () => {
    expect(await cli('review', '1', '--request-changes', '--head', head, '--body-file', body('Please add a --version test.\r\n')), repo.err.join('\n')).toBe(0);
    expect(out()).toBe(`recorded changes-requested by robin on local PR #1 at ${head.slice(0, 8)}; the next omg factory run of its item reads it`);
    const records = readLocalReviews(storeDir, 1);
    expect(records).toEqual([expect.objectContaining({ pr: 1, author: 'robin', state: 'changes-requested', body: 'Please add a --version test.\n', head })]);

    expect(await cli('view', '1', '--json')).toBe(0);
    const v = JSON.parse(out()) as { pr: { headRefOid: string; title: string }; reviews: unknown[]; openThreads: number };
    expect(v.pr.headRefOid).toBe(head);
    expect(v.pr.title).toBe('Add a version flag]0;pwned<U+200B>');
    expect(v.reviews).toHaveLength(1);
    expect(v.openThreads).toBe(1);

    expect(await cli('review', '1', '--approve', '--head', head.toUpperCase(), '--json')).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ ok: true, review: { state: 'approved', author: 'robin', head } });
    expect(await cli('view', '1')).toBe(0);
    expect(out()).toContain('review changes-requested by robin');
    expect(out()).toContain('review approved by robin');
    expect(out()).toContain(`  head ${head} (factory/issue-1) -> base `);
    // LOW-4: robin's approval on this head closes robin's own request.
    expect(out()).toContain('0 open review note(s) on the current head');
  });

  it('usage: one decision flag, a body for request-changes and comment, a known PR (exit 2)', async () => {
    expect(await cli('review', '1', '--comment')).toBe(2);
    expect(repo.err.join('\n')).toMatch(/--body-file is required with --comment/);
    expect(await cli('review', '1', '--approve', '--comment', '--body-file', body('x'))).toBe(2);
    expect(await cli('review', '1', '--request-changes', '--body-file', body('  \n'))).toBe(2);
    expect(await cli('review', '1', '--comment', '--body-file', join(scratch, 'missing.md'))).toBe(2);
    expect(await cli('review', '9', '--approve', '--head', head)).toBe(2);
    expect(repo.err.join('\n')).toMatch(/local PR #9 does not exist/);
    expect(await cli('view', 'x1')).toBe(2);
    expect(readLocalReviews(storeDir, 1)).toEqual([]);
  });

  it('a PR that is not open takes no review', async () => {
    writeFileSync(join(storeDir, 'prs.json'), JSON.stringify({
      version: 1, next: 2, prs: [{ number: 1, head: 'factory/issue-1', base: 'main', title: 't', state: 'CLOSED', isDraft: true, createdAt: '2026-11-09T09:00:00.000Z' }],
    }));
    expect(await cli('review', '1', '--approve', '--head', head, '--json')).toBe(2);
    expect(JSON.parse(out())).toMatchObject({ ok: false, error: expect.stringMatching(/is closed; only an open PR takes a review/) });
  });

  it('MEDIUM-6: review needs --head as a full sha and refuses a head that moved since', async () => {
    expect(await cli('review', '1', '--approve')).toBe(2);
    expect(repo.err.join('\n')).toMatch(/--head <sha> is required/);
    expect(await cli('review', '1', '--approve', '--head', head.slice(0, 12))).toBe(2);
    expect(repo.err.join('\n')).toMatch(/--head <sha> is required/);
    // A push after the diff the human read: the approval would bind to code they never saw.
    git(repo.root, 'checkout', '-q', 'factory/issue-1');
    writeFile(repo, 'src/flag.ts', 'export const version = "6.6.6";\n');
    commitAll(repo, 'sneaky');
    const moved = git(repo.root, 'rev-parse', 'HEAD');
    git(repo.root, 'checkout', '-q', 'main');
    git(repo.root, 'push', '-q', mirror, 'factory/issue-1');
    expect(await cli('review', '1', '--approve', '--head', head)).toBe(2);
    expect(repo.err.join('\n')).toMatch(new RegExp(`head moved: it is ${moved} now`));
    expect(readLocalReviews(storeDir, 1)).toEqual([]);
    expect(await cli('review', '1', '--approve', '--head', moved)).toBe(0);
  });

  it('MEDIUM-2: the local forge\'s reviewFeedback refuses a head that is not the refreshed PR head', () => {
    const reviews = localReviews({ exec: repo.exec, root: repo.root, mirror, storePath: join(storeDir, 'prs.json'), humanDir: join(scratch, 'omg', 'factory', 'local') });
    expect(reviews.reviewFeedback!(1, head).threads).toEqual([]);
    expect(() => reviews.reviewFeedback!(1, 'e'.repeat(40))).toThrow(ReviewHeadMovedError);
    expect(() => reviews.reviewFeedback!(1, head.slice(0, 7))).toThrow(/not a full commit sha/);
  });
});
