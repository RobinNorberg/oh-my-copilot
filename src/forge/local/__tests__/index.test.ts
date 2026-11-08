import { mkdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../index.js';
import { createLocalForge, localForgeLimitations, localPrStorePath, writeLocalCheckRecord } from '../index.js';
import { localMerge } from '../merge.js';
import { git, makeFixture, recordingExec, type Fixture } from './git-fixture.js';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

describe('createForge with a local config', () => {
  it('returns the local forge with no CI, heal, board or webhooks, and its limitations', () => {
    const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], stateDir: fx.stateDir, local: { omgRoot: fx.omgRoot } });
    expect(forge.kind).toBe('local');
    expect(forge.provider).toBe('unknown');
    expect(forge.repo).toEqual(fx.config.repo);
    expect(forge.ci).toBeUndefined();
    expect(forge.reviews.listThreads).toBeUndefined();
    expect(forge.capabilities).toEqual({ heal: false, projectsV2: false, boardColumns: false, webhookIntake: false });
    expect(forge.limitations?.()).toEqual(localForgeLimitations());
  });

  it('refuses a store under an untrusted root', () => {
    expect(() => createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.tmp], local: { omgRoot: fx.omgRoot } })).toThrow(/untrusted root/);
  });

  it('needs the caller to name the runtime root (src/forge cannot resolve it without spawning)', () => {
    expect(() => createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root] })).toThrow(/omgRoot is required/);
  });

  it('refuses a non-local config', () => {
    expect(() => createLocalForge(recordingExec().exec, fx.root, { ...fx.config, kind: 'github' }, { untrustedRoots: [] })).toThrow(/local forge config/);
  });

  it('reads back the engine-written local-gate record for the PR head', () => {
    fx.write('a.txt', 'a');
    const base = fx.commit('base');
    fx.push(base, 'main');
    git(fx.root, 'checkout', '-q', '-b', 'factory/1-x');
    fx.write('b.txt', 'b');
    const head = fx.commit('b');
    fx.push(head, 'factory/1-x');
    const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], local: { omgRoot: fx.omgRoot } });
    const body = join(fx.tmp, 'body.md');
    writeFileSync(body, 'x');
    const pr = forge.reviews.createDraftPr({ base: 'main', head: 'factory/1-x', title: 'x', bodyFile: body });
    expect(forge.checks.checks(pr, head)).toEqual([]);
    writeLocalCheckRecord(fx.stateDir, fx.root, { name: 'local-gate', head, state: 'SUCCESS', argv: ['node', '--test'], runId: 1, startedAt: 'now', completedAt: 'now', exitCode: 0 });
    expect(forge.checks.checks(pr, forge.reviews.prHead(pr).headRefOid)).toMatchObject([{ name: 'local-gate', state: 'SUCCESS' }]);
    expect(forge.merge.humanMergeCommand(pr, head)).toEqual(['git', '-C', fx.root, 'merge', '--no-ff', '--no-edit', head]);
    expect(forge.merge.blockingPolicies(pr, head)).toEqual([]);
  });
});

describe('F31: the PR store behind a merged item', () => {
  const item = (title: string, state: string) => `---\ntitle: ${JSON.stringify(title)}\nstate: ${state}\n---\nDo it.\n`;
  const pr = (number: number, base: string) => ({ number, head: `factory/issue-1-${number}`, base, title: 't', state: 'MERGED', isDraft: false, itemId: 1, createdAt: 'now' });

  it('a malformed store fails only the open items that need it, with one error; once fixed, only a PR into the current base closes the item', () => {
    fx.write('.copilot/backlog/1-open.md', item('open one', 'open'));
    fx.write('.copilot/backlog/2-done.md', item('done one', 'closed'));
    const sha = fx.commit('backlog');
    const store = localPrStorePath(fx.stateDir, fx.root);
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, '{ not json');
    const forge = (base: string) => createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], local: { omgRoot: fx.omgRoot, base, baseSha: () => sha } });
    const main = forge('main');
    expect(main.tracker.viewItem(2).open).toBe(false);
    expect(() => main.tracker.viewItem(1)).toThrow(/the PR store .* is not valid JSON/);
    expect(() => main.tracker.queryItems({ type: 'local-backlog' }, 10)).toThrow(/the PR store .* is not valid JSON/);

    // The store changed (another size): read again, and only the PR into main counts.
    writeFileSync(store, JSON.stringify({ version: 1, next: 3, prs: [pr(1, 'release')] }));
    expect(main.tracker.viewItem(1).open).toBe(true);
    writeFileSync(store, JSON.stringify({ version: 1, next: 3, prs: [pr(1, 'release'), pr(2, 'main')] }));
    const pinned = new Date('2026-01-01T00:00:00Z');
    utimesSync(store, pinned, pinned);
    expect(main.tracker.viewItem(1)).toMatchObject({ open: false, rawState: 'merged (local PR #2)' });
    expect(forge('release').tracker.viewItem(1)).toMatchObject({ open: false, rawState: 'merged (local PR #1)' });
    // A replacement of the same size with the old mtime (a rename over the store) is still read again: the key has the inode and ctime.
    const before = JSON.stringify({ version: 1, next: 3, prs: [pr(1, 'release'), pr(2, 'main')] });
    const after = before.replace('"main"', '"mxin"');
    expect(after.length).toBe(before.length);
    const old = statSync(store);
    writeFileSync(`${store}.new`, after);
    utimesSync(`${store}.new`, pinned, pinned);
    renameSync(`${store}.new`, store);
    expect(statSync(store).size).toBe(old.size);
    expect(statSync(store).mtimeMs).toBe(old.mtimeMs);
    expect(main.tracker.viewItem(1).open).toBe(true);
    // Without the base branch no PR closes an item.
    expect(createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], local: { omgRoot: fx.omgRoot, baseSha: () => sha } }).tracker.viewItem(1).open).toBe(true);
  });
});

describe('localMerge and limitations', () => {
  it('refuses a head that is not a 40-hex sha', () => {
    expect(() => localMerge('/r').humanMergeCommand(1, 'main')).toThrow(/40-hex/);
  });

  it('lists every offline limitation, naming the base', () => {
    const lines = localForgeLimitations('main').join('\n');
    for (const want of ['no CI', 'review threads', '.omg/factory/local/', 'listen', 'heal', 'board', 'git merge you run on main', 'between machines']) expect(lines).toContain(want);
  });
});
