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
});
