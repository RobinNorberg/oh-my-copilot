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
        // F55: the title line is the file's own (not re-quoted).
        expect(file()).toBe('---\ntitle: Add remove()\nstate: open\nlabels: [factory, priority:p1]\npriority: 2\n---\nRemove an item.\n');
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
    it('the priority frontmatter wins (kind local): no priority label is added, a disagreeing one goes, the number is never written', () => {
        const item = tracker().viewItem(1);
        const result = { id: 1, title: item.title, url: item.url, bucket: 'needs-plan', reasons: ['no-plan'], detail: '', priority: 4, planSource: null };
        const row = planItem(item, result, 'local', resolveTriageConfig([]));
        // priority:p3 is number 4, which the field already says; needs-plan is already present.
        expect(row).toMatchObject({ action: 'unchanged', add: [], remove: [], priority: null });
        expect(row.why).toEqual(['priority: the frontmatter priority 4 wins; triage adds no priority label on the local forge']);
        const drift = planItem({ ...item, priority: 1 }, result, 'local', resolveTriageConfig([]));
        // F55: the frontmatter is authoritative: the stale tag goes and no priority:p0 is added next to "priority: 1".
        expect(drift).toMatchObject({ action: 'change', add: [], remove: ['priority:p3'], priority: null });
        expect(drift.why.join('\n')).toContain('the frontmatter priority 1 wins, drop priority:p3');
        // No frontmatter priority: the label stays the item's priority (unchanged).
        const { priority: _p, ...noField } = item;
        expect(planItem({ ...noField, labels: ['factory'] }, { ...result, bucket: 'runnable', reasons: [], priority: null }, 'local', resolveTriageConfig([]))).toMatchObject({ action: 'unchanged', add: [] });
    });
    it('F55: --apply keeps a plain title line and writes no priority label next to the frontmatter priority', () => {
        fx.write('.copilot/backlog/2-help.md', '---\ntitle: Add --help to the calc CLI\nlabels: [factory]\npriority: 1\n---\nHelp.\n\n## Acceptance\n- [ ] prints usage\n');
        base = fx.commit('item 2');
        const t = tracker();
        const item = t.viewItem(2);
        const result = { id: 2, title: item.title, url: item.url, bucket: 'runnable', reasons: [], detail: '', priority: 1, planSource: 'issue-body' };
        const row = planItem(item, result, 'local', resolveTriageConfig([]));
        expect(row).toMatchObject({ action: 'unchanged', add: [], remove: [] });
        // A label write (here needs-split by hand) leaves the title line as the file had it.
        expect(t.setTriage(2, { add: ['needs-split'], remove: [] })).toMatchObject({ ok: true });
        expect(readFileSync(join(fx.root, '.copilot', 'backlog', '2-help.md'), 'utf8')).toBe('---\ntitle: Add --help to the calc CLI\nstate: open\nlabels: [factory, needs-split]\npriority: 1\n---\nHelp.\n\n## Acceptance\n- [ ] prints usage\n');
    });
});
//# sourceMappingURL=triage-local.test.js.map