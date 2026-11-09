import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForgeTracker, LocalTrackerOptions } from '../../types.js';
import { localTracker } from '../tracker.js';
import { makeFixture, recordingExec, type Fixture } from './git-fixture.js';

const ITEM1 = '---\ntitle: Add remove()\nlabels: [factory]\npriority: 2\nsize: 2\n---\nRemove an item.\n\n## Acceptance\n- [ ] `remove(id)` works\n';
const ITEM2 = '---\ntitle: Child\nparent: 1\ndependsOn: [1]\n---\nshipyard-key: 3/child-key\n';
const ITEM3 = '---\ntitle: Done\nstate: closed\n---\n';

let fx: Fixture;
let base: string;
beforeEach(() => {
  fx = makeFixture();
  fx.write('.copilot/backlog/1-add-remove.md', ITEM1);
  fx.write('.copilot/backlog/2-child.md', ITEM2);
  fx.write('.copilot/backlog/3-done.md', ITEM3);
  fx.write('.copilot/backlog/README.md', 'not an item');
  fx.write('.copilot/backlog/nested/4-deep.md', '---\ntitle: nested is ignored\n---\n');
  base = fx.commit('backlog');
});
afterEach(() => fx.cleanup());

const tracker = (options: LocalTrackerOptions, extra: { trackerBodyDir?: string } = {}) => {
  const rec = recordingExec();
  const t: ForgeTracker = localTracker({ exec: rec.exec, root: fx.root, backlogDir: '.copilot/backlog', repoUrl: fx.mirror, humanDir: join(fx.root, '.omg', 'factory', 'local'), options, ...extra });
  return { t, calls: rec.calls };
};

describe('local tracker: committed items (run)', () => {
  it('reads items at the base commit as trusted, with children, edges and acceptance', () => {
    const { t, calls } = tracker({ baseSha: () => base });
    expect(t.queryItems({ type: 'local-backlog' }, 50)).toEqual([1, 2]);
    expect(t.queryItems({ type: 'local-backlog', label: 'FACTORY' }, 50)).toEqual([1]);
    expect(t.queryItems({ type: 'local-backlog' }, 1)).toEqual([1]);
    const one = t.viewItem(1);
    expect(one).toEqual({
      id: 1, url: '.copilot/backlog/1-add-remove.md', title: 'Add remove()', body: 'Remove an item.\n\n## Acceptance\n- [ ] `remove(id)` works\n',
      acceptance: '- [ ] `remove(id)` works', open: true, rawState: 'open', authorTrusted: true, comments: [], labels: ['factory'], priority: 2, size: 2,
      dependsOn: [], children: [2], repoUrl: fx.mirror,
    });
    expect(t.viewItem(2)).toMatchObject({ parent: 1, dependsOn: [1], authorTrusted: true });
    expect(t.viewItem(3)).toMatchObject({ open: false, rawState: 'closed' });
    expect(() => t.viewItem(4)).toThrow(/#4 is not in .copilot\/backlog at/);
    // Only git, at the exact base sha, with the trusted-read env; reads are cached per sha.
    expect(calls.every((c) => c.cmd === 'git' && c.env?.GIT_NO_REPLACE_OBJECTS === '1' && c.cwd === fx.root)).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(['ls-tree', 'show', 'show', 'show']);
    expect(calls.every((c) => c.args.join(' ').includes(base))).toBe(true);
  });

  it('ignores uncommitted edits during a run (reads only the base commit)', () => {
    fx.write('.copilot/backlog/1-add-remove.md', ITEM1.replace('Add remove()', 'Tampered'));
    fx.write('.copilot/backlog/9-new.md', '---\ntitle: new\n---\n');
    const { t } = tracker({ baseSha: () => base });
    expect(t.viewItem(1).title).toBe('Add remove()');
    expect(t.queryItems({ type: 'local-backlog' }, 50)).toEqual([1, 2]);
  });

  it('refuses without a base commit, with a bad sha, and with another intake source', () => {
    expect(() => tracker({}).t.viewItem(1)).toThrow(/base commit is not known/);
    expect(() => tracker({ baseSha: () => 'main' }).t.viewItem(1)).toThrow(/40-hex/);
    expect(() => tracker({ baseSha: () => base }).t.queryItems({ type: 'label', label: 'x' }, 5)).toThrow(/local-backlog/);
  });

  it('skips a malformed committed item with a warning naming the file, and refuses duplicate ids', () => {
    fx.write('.copilot/backlog/5-bad.md', '---\ntitle: x\nowner: me\n---\n');
    const bad = fx.commit('bad');
    const { t } = tracker({ baseSha: () => bad });
    expect(t.warnings!()).toEqual([]);
    expect(t.queryItems({ type: 'local-backlog' }, 9)).toEqual([1, 2]);
    expect(t.queryItems({ type: 'local-backlog' }, 9)).toEqual([1, 2]);
    expect(t.warnings!()).toHaveLength(1);
    expect(t.warnings!()[0]).toMatch(/skipped .*\.copilot\/backlog\/5-bad\.md: line 3: unknown key owner/);
    expect(() => t.viewItem(5)).toThrow(/not in/);
    fx.write('.copilot/backlog/5-bad.md', '---\ntitle: x\n---\n');
    fx.write('.copilot/backlog/1-dup.md', '---\ntitle: dup\n---\n');
    const dup = fx.commit('dup');
    expect(() => tracker({ baseSha: () => dup }).t.viewItem(1)).toThrow(/id 1 is also used by/);
  });
});

describe('local tracker: working tree (check, board, enqueue)', () => {
  it('marks new and edited items uncommitted and untrusted; unchanged ones stay trusted', () => {
    fx.write('.copilot/backlog/1-add-remove.md', ITEM1.replace('Remove an item.', 'Edited.'));
    fx.write('.copilot/backlog/9-new.md', '---\ntitle: new\n---\n');
    const { t } = tracker({ baseSha: () => base, workingTree: true });
    expect(t.queryItems({ type: 'local-backlog' }, 50)).toEqual([1, 2, 9]);
    expect(t.viewItem(1)).toMatchObject({ authorTrusted: false, uncommitted: true, body: expect.stringContaining('Edited.') });
    expect(t.viewItem(9)).toMatchObject({ authorTrusted: false, uncommitted: true });
    expect(t.viewItem(2)).toMatchObject({ authorTrusted: true });
    expect(t.viewItem(2)).not.toHaveProperty('uncommitted');
  });

  it('treats a CRLF checkout of a committed file as unchanged', () => {
    fx.write('.copilot/backlog/2-child.md', ITEM2.replace(/\n/g, '\r\n'));
    expect(tracker({ baseSha: () => base, workingTree: true }).t.viewItem(2).authorTrusted).toBe(true);
  });

  it('works before any commit is known (everything untrusted)', () => {
    const { t } = tracker({ workingTree: true });
    expect(t.queryItems({ type: 'local-backlog' }, 50)).toEqual([1, 2]);
    expect(t.viewItem(1)).toMatchObject({ authorTrusted: false, uncommitted: true });
  });

  it('does not follow a symlinked backlog file', () => {
    const outside = join(fx.tmp, 'outside.md');
    writeFileSync(outside, '---\ntitle: outside\n---\n');
    try {
      symlinkSync(outside, join(fx.root, '.copilot', 'backlog', '8-link.md'));
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    expect(tracker({ workingTree: true }).t.queryItems({ type: 'local-backlog' }, 50)).toEqual([1, 2]);
  });

  it('peekItems, findByKey', () => {
    const { t } = tracker({ baseSha: () => base, workingTree: true });
    expect([...t.peekItems!([1, 3, 99]).entries()]).toEqual([
      [1, { title: 'Add remove()', url: '.copilot/backlog/1-add-remove.md', state: 'open', labels: ['factory'] }],
      [3, { title: 'Done', url: '.copilot/backlog/3-done.md', state: 'closed', labels: [] }],
    ]);
    expect(t.findByKey!(3).map((r) => [r.key, r.item.id])).toEqual([['child-key', 2]]);
    expect(t.findByKey!(4)).toEqual([]);
  });
});

describe('local tracker: symbolic links in the working tree', () => {
  const plant = (link: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, 'junction');
  };

  it('refuses comment and setProgress through a linked directory under the runtime root', () => {
    const outside = join(fx.tmp, 'outside');
    mkdirSync(join(fx.root, '.omg', 'factory', 'local', 'items'), { recursive: true });
    plant(join(fx.root, '.omg', 'factory', 'local', 'items', '1'), outside);
    const { t } = tracker({ baseSha: () => base });
    const body = join(fx.tmp, 'c.md');
    writeFileSync(body, 'lane text');
    expect(t.comment(1, body)).toMatchObject({ ok: false, stderr: expect.stringMatching(/symbolic link/) });
    expect(t.setProgress(1, 'building', {})).toMatchObject({ ok: false, detail: expect.stringMatching(/symbolic link/) });
    expect(existsSync(join(outside, 'comments.md'))).toBe(false);
    expect(existsSync(join(outside, 'progress.json'))).toBe(false);
  });

  it('refuses backlog reads and writes through a linked .copilot parent', () => {
    const outside = join(fx.tmp, 'outside-copilot');
    mkdirSync(join(outside, 'backlog'), { recursive: true });
    writeFileSync(join(outside, 'backlog', '1-add-remove.md'), ITEM1);
    rmSync(join(fx.root, '.copilot'), { recursive: true, force: true });
    plant(join(fx.root, '.copilot'), outside);
    const body = join(fx.tmp, 'b.md');
    writeFileSync(body, 'Body.');
    const { t } = tracker({ baseSha: () => base, workingTree: true });
    expect(() => t.queryItems({ type: 'local-backlog' }, 9)).toThrow(/symbolic link/);
    const committedOnly = tracker({ baseSha: () => base }).t;
    expect(() => committedOnly.createItem!({ title: 'New', bodyFile: body, labels: [] })).toThrow(/symbolic link/);
    expect(committedOnly.addMarker(1, 'factory:planned')).toMatchObject({ ok: false, stderr: expect.stringMatching(/symbolic link/) });
    expect(() => committedOnly.updateItem!(1, { title: 'X', bodyFile: body, addLabels: [], removeLabels: [] })).toThrow(/symbolic link/);
    expect(readFileSync(join(outside, 'backlog', '1-add-remove.md'), 'utf8')).toBe(ITEM1);
    expect(existsSync(join(outside, 'backlog', '4-new.md'))).toBe(false);
  });
});

describe('local tracker: writes', () => {
  it('comment and setProgress write under .omg/factory/local/items/<id>/', () => {
    const { t } = tracker({ baseSha: () => base });
    const body = join(fx.tmp, 'c.md');
    writeFileSync(body, 'Plan approved.');
    expect(t.comment(1, body)).toEqual({ ok: true, stderr: '' });
    expect(t.comment(1, body).ok).toBe(true);
    const comments = readFileSync(join(fx.root, '.omg', 'factory', 'local', 'items', '1', 'comments.md'), 'utf8');
    expect(comments.match(/Plan approved\./g)).toHaveLength(2);
    expect(t.comment(1, join(fx.tmp, 'missing.md')).ok).toBe(false);
    expect(t.setProgress(1, 'building', {})).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(fx.root, '.omg', 'factory', 'local', 'items', '1', 'progress.json'), 'utf8'))).toMatchObject({ id: 1, stage: 'building' });
  });

  it('addMarker adds a label to the working-tree file once', () => {
    const { t } = tracker({ baseSha: () => base, workingTree: true });
    expect(t.addMarker(2, 'factory-ready')).toEqual({ ok: true, stderr: '' });
    expect(t.addMarker(2, 'factory-ready')).toEqual({ ok: true, stderr: '' });
    const after = tracker({ baseSha: () => base, workingTree: true }).t.viewItem(2);
    expect(after).toMatchObject({ labels: ['factory-ready'], parent: 1, dependsOn: [1], uncommitted: true });
    expect(t.addMarker(77, 'x').ok).toBe(false);
  });

  it('createItem writes the next id with the body and acceptance; updateItem rewrites it', () => {
    const bodyDir = join(fx.tmp, 'bodies');
    const { t } = tracker({ baseSha: () => base, workingTree: true }, { trackerBodyDir: bodyDir });
    const body = join(bodyDir, 'b.md');
    mkdirSync(bodyDir, { recursive: true });
    writeFileSync(body, 'New work.\n\nshipyard-key: 3/new-key\n');
    const id = t.createItem!({ title: 'New thing', bodyFile: body, labels: ['factory'], acceptance: ['`x` is done'], priority: 1 });
    expect(id).toBe(4);
    const file = join(fx.root, '.copilot', 'backlog', '4-new-thing.md');
    expect(existsSync(file)).toBe(true);
    const created = tracker({ workingTree: true }).t.viewItem(4);
    expect(created).toMatchObject({ title: 'New thing', labels: ['factory'], priority: 1, acceptance: '- [ ] `x` is done', uncommitted: true });
    writeFileSync(body, 'Changed.\n');
    t.updateItem!(4, { title: 'Renamed', bodyFile: body, addLabels: ['b'], removeLabels: ['factory'] });
    expect(tracker({ workingTree: true }).t.viewItem(4)).toMatchObject({ title: 'Renamed', labels: ['b'], body: 'Changed.\n', priority: 1 });
    // A body outside the body directory is refused.
    const stray = join(fx.tmp, 'stray.md');
    writeFileSync(stray, 'x');
    expect(() => t.createItem!({ title: 'x', bodyFile: stray, labels: [] })).toThrow(/is not in/);
  });
});
