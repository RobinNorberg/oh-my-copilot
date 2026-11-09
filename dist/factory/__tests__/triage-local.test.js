/**
 * `omg factory triage --apply` on the local forge: the backlog file in the
 * working tree is rewritten (labels and the priority field); nothing is
 * committed, and the committed item is untouched.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localTracker } from '../../forge/local/tracker.js';
import { git, makeFixture, recordingExec } from '../../forge/local/__tests__/git-fixture.js';
import { resolveTriageConfig, planItem } from '../triage/rules.js';
const ITEM = '---\ntitle: Add remove()\nlabels: [factory, priority:p3, needs-plan]\npriority: 4\n---\nRemove an item.\n';
let fx;
let base;
beforeEach(() => {
    fx = makeFixture();
    fx.write('.copilot/backlog/1-add-remove.md', ITEM);
    base = fx.commit('backlog');
});
afterEach(() => fx.cleanup());
const tracker = () => localTracker({ exec: recordingExec().exec, root: fx.root, backlogDir: '.copilot/backlog', repoUrl: fx.mirror, humanDir: join(fx.root, '.omg', 'factory', 'local'), options: { baseSha: () => base, workingTree: true } });
const file = () => readFileSync(join(fx.root, '.copilot', 'backlog', '1-add-remove.md'), 'utf8');
describe('local setTriage', () => {
    it('edits labels and the priority field in the working tree only', () => {
        const t = tracker();
        const res = t.setTriage(1, { add: ['priority:p1'], remove: ['PRIORITY:P3', 'needs-plan'], priority: 2 });
        expect(res).toMatchObject({ ok: true });
        expect(res.detail).toMatch(/commit it on the base branch/);
        expect(file()).toBe('---\ntitle: "Add remove()"\nstate: open\nlabels: [factory, priority:p1]\npriority: 2\n---\nRemove an item.\n');
        // The committed item at the base is still the original.
        expect(git(fx.root, 'show', `${base}:.copilot/backlog/1-add-remove.md`).trim()).toBe(ITEM.trim());
    });
    it('is a no-op when nothing changes, and fails for an unknown item or an assignee', () => {
        const t = tracker();
        expect(t.setTriage(1, { add: ['factory'], remove: [] })).toEqual({ ok: true, detail: 'nothing to change' });
        expect(file()).toBe(ITEM);
        expect(t.setTriage(77, { add: ['x'], remove: [] }).ok).toBe(false);
        expect(t.setTriage(1, { add: [], remove: [], assignee: 'a' }).ok).toBe(false);
    });
    it('derives the tag from the priority frontmatter and never writes the number (kind local)', () => {
        const item = tracker().viewItem(1);
        const result = { id: 1, title: item.title, url: item.url, bucket: 'needs-plan', reasons: ['no-plan'], detail: '', priority: 4, planSource: null };
        const row = planItem(item, result, 'local', resolveTriageConfig([]));
        // priority:p3 is number 4, which the field already says; needs-plan is already present.
        expect(row).toMatchObject({ action: 'unchanged', add: [], remove: [], priority: null });
        const drift = planItem({ ...item, priority: 1 }, result, 'local', resolveTriageConfig([]));
        // The frontmatter (1 = p0) is authoritative: the stale tag changes, the number does not.
        expect(drift).toMatchObject({ action: 'change', add: ['priority:p0'], remove: ['priority:p3'], priority: null });
    });
});
//# sourceMappingURL=triage-local.test.js.map