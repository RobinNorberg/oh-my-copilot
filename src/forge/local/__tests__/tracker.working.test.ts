import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../index.js';
import { makeFixture, recordingExec, type Fixture } from './git-fixture.js';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

describe('the working-tree backlog read', () => {
  it('skips a malformed file with a warning instead of failing every item', () => {
    fx.write('.copilot/backlog/1-good.md', '---\ntitle: "good"\nstate: open\n---\nDo it.\n');
    const sha = fx.commit('backlog');
    fx.write('.copilot/backlog/2-bad.md', '---\ntitle: [unclosed\nstate: open\n---\nBroken.\n');
    fx.write('.copilot/backlog/3-new.md', '---\ntitle: "new"\nstate: open\n---\nUncommitted.\n');
    const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], local: { omgRoot: fx.omgRoot, workingTree: true, baseSha: () => sha } });
    expect(forge.tracker.queryItems({ type: 'local-backlog' }, 10)).toEqual([1, 3]);
    expect(forge.tracker.viewItem(3)).toMatchObject({ uncommitted: true, authorTrusted: false });
    const warnings = forge.tracker.warnings?.() ?? [];
    expect(warnings.filter((w) => /2-bad\.md/.test(w))).toHaveLength(1);
  });

  it('never overwrites a skipped malformed working copy and never reuses its id', () => {
    fx.write('.copilot/backlog/1-good.md', '---\ntitle: "good"\nstate: open\n---\nDo it.\n');
    const sha = fx.commit('backlog');
    const broken = '---\ntitle: [unclosed\nstate: open\n---\nMy uncommitted edit.\n';
    fx.write('.copilot/backlog/1-good.md', broken);
    fx.write('.copilot/backlog/7-bad.md', broken);
    const bodyDir = join(fx.tmp, 'bodies');
    mkdirSync(bodyDir, { recursive: true });
    const bodyFile = join(bodyDir, 'b.md');
    writeFileSync(bodyFile, 'Body.\n');
    const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], trackerBodyDir: bodyDir, local: { omgRoot: fx.omgRoot, workingTree: true, baseSha: () => sha } });
    const file1 = join(fx.root, '.copilot', 'backlog', '1-good.md');
    expect(() => forge.tracker.updateItem!(1, { title: 'X', bodyFile, addLabels: [], removeLabels: [] })).toThrow(/1-good.md.*malformed/);
    expect(forge.tracker.addMarker(1, 'factory-ready')).toMatchObject({ ok: false, stderr: expect.stringMatching(/malformed/) });
    expect(readFileSync(file1, 'utf8')).toBe(broken);
    expect(forge.tracker.createItem!({ title: 'Fresh', bodyFile, labels: [] })).toBe(8);
  });
});
