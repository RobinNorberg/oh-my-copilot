import { describe, expect, it } from 'vitest';
import { DEFAULT_TRIAGE_CONFIG, planItem, resolveTriageConfig, TriageConfigError } from '../rules.js';
const item = (o = {}) => ({
    id: 1, url: 'u', title: 't', body: '', open: true, rawState: 'OPEN', authorTrusted: true, comments: [], labels: [], dependsOn: [], children: [], repoUrl: 'r', ...o,
});
const res = (bucket, reason = '', priority = null) => ({ id: 1, title: 't', url: 'u', bucket, reasons: reason ? [reason] : [], detail: '', priority, planSource: null });
const plan = (i, r, kind = 'github') => planItem(item(i), r, kind, DEFAULT_TRIAGE_CONFIG);
describe('triage rules', () => {
    it('gives an item with no priority the default, and none when defaultPriority is false', () => {
        expect(plan({}, res('runnable'))).toMatchObject({ action: 'change', add: ['priority:p2'], priority: null });
        expect(planItem(item(), res('runnable'), 'github', { ...DEFAULT_TRIAGE_CONFIG, defaultPriority: null }).action).toBe('unchanged');
    });
    it('leaves an ADO or local item with a numeric priority alone, and sets the number with the default label otherwise', () => {
        expect(plan({ priority: 2 }, res('runnable', '', 2), 'azure-devops').action).toBe('unchanged');
        expect(plan({}, res('runnable'), 'azure-devops')).toMatchObject({ add: ['priority:p2'], priority: 3 });
    });
    it('keeps the highest of several priority labels and aligns the number', () => {
        const row = plan({ labels: ['priority:p3', 'priority:P1'], priority: 3 }, res('runnable', '', 3), 'azure-devops');
        expect(row).toMatchObject({ remove: ['priority:p3'], priority: 2, add: [] });
    });
    it('needs-plan follows the check bucket; a blocked item keeps its labels', () => {
        expect(plan({ labels: ['priority:p1'] }, res('needs-plan', 'no-plan'))).toMatchObject({ add: ['needs-plan'] });
        expect(plan({ labels: ['priority:p1', 'needs-plan'] }, res('runnable'))).toMatchObject({ remove: ['needs-plan'] });
        expect(plan({ labels: ['priority:p1', 'needs-plan'] }, res('blocked', 'depends-on:#9')).action).toBe('unchanged');
    });
    it('needs-split: epics, too-big and size above the threshold, only without children', () => {
        const p1 = { labels: ['priority:p1'] };
        expect(plan(p1, res('blocked', 'needs-split'))).toMatchObject({ add: ['needs-split'] });
        expect(plan({ ...p1, size: 6 }, res('runnable'))).toMatchObject({ add: ['needs-split'] });
        expect(plan({ ...p1, size: 5 }, res('runnable')).action).toBe('unchanged');
        expect(plan({ ...p1, size: 8, children: [2] }, res('blocked', 'needs-split')).add).toEqual([]);
        expect(plan({ labels: ['priority:p1', 'needs-split'], children: [2] }, res('blocked', 'needs-split'))).toMatchObject({ remove: ['needs-split'] });
    });
    it('skips closed items, live runs, open PRs and read failures, with the check reason', () => {
        for (const reason of ['closed', 'run-active:implement', 'pr-exists', 'branch-exists', 'run-finished:merged', 'read-failed', 'merged']) {
            expect(plan({}, res('blocked', reason))).toMatchObject({ action: 'skip', skipReason: reason, add: [], remove: [] });
        }
    });
    it('config: defaults, overrides from later layers, and strict validation', () => {
        expect(resolveTriageConfig([undefined, {}])).toEqual(DEFAULT_TRIAGE_CONFIG);
        expect(resolveTriageConfig([{ factory: { triage: { sizeSplitAt: 3, labels: { needsSplit: 'split' } } } }, { factory: { triage: { sizeSplitAt: 8, defaultPriority: 1 } } }]))
            .toEqual({ ...DEFAULT_TRIAGE_CONFIG, needsSplit: 'split', sizeSplitAt: 8, defaultPriority: 1 });
        for (const bad of [{ x: 1 }, { sizeSplitAt: 1.5 }, { defaultPriority: 4 }, { labels: { owner: 'x' } }, { labels: { needsPlan: 'a b' } }, { labels: { needsPlan: 'needs-split' } }, 5]) {
            expect(() => resolveTriageConfig([{ factory: { triage: bad } }])).toThrow(TriageConfigError);
        }
    });
});
//# sourceMappingURL=rules.test.js.map