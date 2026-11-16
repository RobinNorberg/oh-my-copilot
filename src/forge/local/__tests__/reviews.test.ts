import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localReviews } from '../reviews.js';
import { readPrStore } from '../store.js';
import { git, makeFixture, recordingExec, type Fixture } from './git-fixture.js';

let fx: Fixture;
let base: string;
let head: string;
let bodyFile: string;
beforeEach(() => {
  fx = makeFixture();
  fx.write('README.md', 'hello\n');
  base = fx.commit('base');
  fx.push(base, 'main');
  git(fx.root, 'checkout', '-q', '-b', 'factory/1-add');
  fx.write('src/remove.js', 'export {};\n');
  head = fx.commit('add remove');
  fx.push(head, 'factory/1-add');
  git(fx.root, 'checkout', '-q', 'main');
  bodyFile = join(fx.tmp, 'body.md');
  writeFileSync(bodyFile, 'Closes #1\n');
});
afterEach(() => fx.cleanup());

const store = () => join(fx.tmp, 'state', 'store', 'prs.json');
const humanDir = () => join(fx.root, '.omg', 'factory', 'local');
const reviews = () => {
  const rec = recordingExec();
  return { r: localReviews({ exec: rec.exec, root: fx.root, mirror: fx.mirror, storePath: store(), humanDir: humanDir() }), calls: rec.calls };
};

describe('local reviews: symbolic links under the runtime root', () => {
  it('refuses to write a body or append a comment through a linked PR directory', () => {
    const { r } = reviews();
    const n = r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 'Add remove', bodyFile, itemId: 1 });
    git(fx.root, 'checkout', '-q', '-b', 'factory/2-more');
    fx.write('src/more.js', 'export {};\n');
    fx.push(fx.commit('more'), 'factory/2-more');
    git(fx.root, 'checkout', '-q', 'main');
    // Planted after the git steps: a committed link would leave the tree with the checkout.
    const outside = join(fx.tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(humanDir(), 'prs'), { recursive: true });
    symlinkSync(outside, join(humanDir(), 'prs', String(n + 1)), 'junction');
    expect(() => r.createDraftPr({ base: 'main', head: 'factory/2-more', title: 'More', bodyFile })).toThrow(/symbolic link/);
    expect(r.commentPr(n + 1, bodyFile)).toMatchObject({ ok: false, stderr: expect.stringMatching(/symbolic link/) });
    expect(existsSync(join(outside, 'body.md'))).toBe(false);
    expect(existsSync(join(outside, 'comments.md'))).toBe(false);
  });
});

describe('local reviews: mergeability (real git merge-tree against the mirror base)', () => {
  it('clean while the base has not moved or moved without touching the PR\'s files; conflicting when it did', () => {
    const { r, calls } = reviews();
    const n = r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 'Add remove', bodyFile });
    // The head contains the base: no merge-tree needed.
    expect(r.mergeability!(n)).toEqual({ state: 'mergeable', headRefOid: head });
    expect(calls.some((c) => c.args[0] === 'merge-tree')).toBe(false);
    // The base moved without a conflict.
    fx.write('other.md', 'x\n');
    const clean = fx.commit('base: other');
    fx.push(clean, 'main');
    expect(r.mergeability!(n)).toEqual({ state: 'mergeable', headRefOid: head });
    expect(calls.filter((c) => c.args[0] === 'merge-tree').at(-1)?.args).toEqual(['merge-tree', '--write-tree', head, clean]);
    // The base moved into the PR's own file.
    fx.write('src/remove.js', 'export const base = 1;\n');
    fx.push(fx.commit('base: remove.js'), 'main');
    expect(r.mergeability!(n)).toEqual({ state: 'conflicting', headRefOid: head });
  });
});

describe('local reviews', () => {
  it('creates a draft PR from mirror refs, views it, marks it ready and comments', () => {
    const { r } = reviews();
    expect(r.findOpenPrForBranch('factory/1-add')).toBeUndefined();
    const n = r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 'Add remove', bodyFile, itemId: 1 });
    expect(n).toBe(1);
    expect(readFileSync(join(humanDir(), 'prs', '1', 'body.md'), 'utf8')).toBe('# Add remove\n\nCloses #1\n');
    expect(r.viewPr(1)).toEqual({ number: 1, state: 'OPEN', isDraft: true, baseRefName: 'main', baseRefOid: base, headRefName: 'factory/1-add', headRefOid: head, url: 'omg-local://pr/1' });
    expect(r.prHead(1)).toEqual({ headRefOid: head, state: 'OPEN' });
    expect(r.findOpenPrForBranch('factory/1-add')).toBe(1);
    r.markReady(1);
    expect(r.viewPr(1).isDraft).toBe(false);
    expect(r.commentPr(1, bodyFile)).toEqual({ ok: true, stderr: '' });
    expect(readFileSync(join(humanDir(), 'prs', '1', 'comments.md'), 'utf8')).toContain('Closes #1');
    expect(r.commentPr(9, bodyFile).ok).toBe(false);
    expect(() => r.viewPr(9)).toThrow(/#9 does not exist/);
    expect(() => r.markReady(9)).toThrow(/#9 does not exist/);
  });

  it('follows a new push to the branch', () => {
    const { r } = reviews();
    r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 't', bodyFile });
    git(fx.root, 'checkout', '-q', 'factory/1-add');
    fx.write('src/remove.js', 'export const x = 1;\n');
    const head2 = fx.commit('fix');
    fx.push(head2, 'factory/1-add');
    expect(r.viewPr(1).headRefOid).toBe(head2);
  });

  it('refuses a PR without commits, a branch not in the mirror, a second open PR and odd names', () => {
    const { r } = reviews();
    fx.push(base, 'factory/empty');
    expect(() => r.createDraftPr({ base: 'main', head: 'factory/empty', title: 't', bodyFile })).toThrow(/no commits between/);
    expect(() => r.createDraftPr({ base: 'main', head: 'factory/none', title: 't', bodyFile })).toThrow(/not in the mirror/);
    expect(() => r.createDraftPr({ base: 'dev', head: 'factory/1-add', title: 't', bodyFile })).toThrow(/base dev is not in the mirror/);
    expect(() => r.createDraftPr({ base: 'main', head: '-x', title: 't', bodyFile })).toThrow(/plain branch names/);
    r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 't', bodyFile });
    expect(() => r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 't', bodyFile })).toThrow(/#1 is already open/);
  });

  it('turns MERGED after the human merge and the base sync, and keeps the merged head', () => {
    const { r, calls } = reviews();
    r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 't', bodyFile });
    // The human runs the printed merge on main; the next run/poll fast-forwards the mirror base.
    git(fx.root, 'merge', '-q', '--no-ff', '--no-edit', head);
    fx.push(git(fx.root, 'rev-parse', 'HEAD'), 'main');
    expect(r.viewPr(1)).toMatchObject({ state: 'MERGED', headRefOid: head });
    expect(r.findOpenPrForBranch('factory/1-add')).toBeUndefined();
    expect(r.findMergedPrForBranch('factory/1-add', 'main')).toBe(1);
    expect(r.findMergedPrForBranch('factory/1-add', 'dev')).toBeUndefined();
    expect(readPrStore(store()).prs[0]).toMatchObject({ state: 'MERGED', mergedHead: head });
    // The ancestry check is the only git call: exact shas, in the user's checkout, trusted-read env.
    expect(calls.every((c) => c.cmd === 'git' && c.args[0] === 'merge-base' && c.args[1] === '--is-ancestor' && c.cwd === fx.root && c.env?.GIT_NO_REPLACE_OBJECTS === '1')).toBe(true);
    expect(existsSync(`${store()}.lock`)).toBe(false);
  });

  it('stays OPEN when the base moved without the head', () => {
    const { r } = reviews();
    r.createDraftPr({ base: 'main', head: 'factory/1-add', title: 't', bodyFile });
    fx.write('other.txt', 'x');
    fx.push(fx.commit('other'), 'main');
    expect(r.viewPr(1).state).toBe('OPEN');
  });
});
