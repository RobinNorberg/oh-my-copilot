import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localTracker } from '../tracker.js';
import { makeFixture, recordingExec } from './git-fixture.js';
const ITEM = '---\ntitle: Add remove()\n---\nRemove an item.\n';
const FILE = '.copilot/backlog/1-add-remove.md';
let fx;
let merged;
beforeEach(() => {
    fx = makeFixture();
    fx.write(FILE, ITEM);
    merged = fx.commit('item and the PR head that merged');
});
afterEach(() => fx.cleanup());
const open = (baseSha) => {
    const t = localTracker({
        exec: recordingExec().exec, root: fx.root, backlogDir: '.copilot/backlog', repoUrl: fx.mirror, humanDir: join(fx.root, '.omg', 'factory', 'local'),
        options: { baseSha: () => baseSha }, mergedPr: () => ({ number: 5, mergedHead: merged }),
    });
    return t.viewItem(1);
};
describe('the reopen edge of a merged local PR', () => {
    it('a later commit that changes the parsed state reopens the item', () => {
        fx.write(FILE, ITEM.replace('title: Add remove()', 'title: Add remove()\nstate: closed'));
        fx.commit('close');
        fx.write(FILE, ITEM.replace('title: Add remove()', 'title: Add remove()\nstate: open'));
        const reopened = fx.commit('reopen');
        expect(open(reopened)).toMatchObject({ open: true, rawState: 'open' });
    });
    it('a body line that starts with "state:" is not a reopen', () => {
        fx.write(FILE, `${ITEM}\nstate: reviewed by the team\n`);
        const edited = fx.commit('body line');
        expect(open(edited)).toMatchObject({ open: false, rawState: 'merged (local PR #5)' });
    });
    it('an edit that does not touch state keeps the merge', () => {
        fx.write(FILE, `${ITEM}\nMore words.\n`);
        expect(open(fx.commit('body'))).toMatchObject({ open: false });
    });
});
//# sourceMappingURL=tracker.reopen.test.js.map