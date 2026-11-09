import { mkdirSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../index.js';
import { localPrStorePath } from '../index.js';
import { makeFixture, recordingExec } from './git-fixture.js';
let fx;
beforeEach(() => {
    fx = makeFixture();
});
afterEach(() => fx.cleanup());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
describe('the PR store memo key', () => {
    it('reads again when only the change time differs: same size, same mtime, same inode', async () => {
        const item = (state) => `---\ntitle: "one"\nstate: ${state}\n---\nDo it.\n`;
        fx.write('.copilot/backlog/1-one.md', item('open'));
        const sha = fx.commit('backlog');
        const store = localPrStorePath(fx.stateDir, fx.root);
        mkdirSync(dirname(store), { recursive: true });
        const pr = (base) => ({ number: 1, head: 'factory/issue-1-1', base, title: 't', state: 'MERGED', isDraft: false, itemId: 1, createdAt: 'now' });
        const doc = (base) => JSON.stringify({ version: 1, next: 2, prs: [pr(base)] });
        const merged = doc('main');
        const other = doc('mxin');
        expect(other.length).toBe(merged.length);
        const pinned = new Date('2026-01-01T00:00:00Z');
        writeFileSync(store, other);
        utimesSync(store, pinned, pinned);
        const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], local: { omgRoot: fx.omgRoot, base: 'main', baseSha: () => sha } });
        expect(forge.tracker.viewItem(1).open).toBe(true);
        const before = statSync(store, { bigint: true });
        await sleep(30); // let the change time tick on coarse file systems
        // Rewrite in place (same inode), then put the old mtime back: only the ctime moved.
        writeFileSync(store, merged);
        utimesSync(store, pinned, pinned);
        const after = statSync(store, { bigint: true });
        expect(after.size).toBe(before.size);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        expect(after.ino).toBe(before.ino);
        expect(after.ctimeNs).not.toBe(before.ctimeNs);
        expect(forge.tracker.viewItem(1)).toMatchObject({ open: false, rawState: 'merged (local PR #1)' });
    });
});
//# sourceMappingURL=store-memo.test.js.map