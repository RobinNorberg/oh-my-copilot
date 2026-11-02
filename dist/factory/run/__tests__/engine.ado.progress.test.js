import { describe, expect, it } from 'vitest';
import { adoConfig } from '../../../forge/ado/__tests__/world.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { ISSUE } from './fake-lanes.js';
import { h, ado, useAdoHarness, forgeInput, happy, run, expectNoMerge } from './engine-ado-harness.js';
useAdoHarness();
describe('progress sync on Azure DevOps (factory forges design §7)', () => {
    const progressConfig = (progress) => forgeInput({ config: { ...adoConfig(), progress } });
    const STAGES = {
        queued: { column: 'Ready' },
        building: { column: 'Active' },
        reviewing: { column: 'Code Review' },
        verifying: { column: 'Verify' },
        'ready-to-merge': { column: 'Ready to merge' },
        blocked: { column: 'Blocked', state: 'Resolved' },
        cancelled: { column: 'Removed' },
        done: { state: 'Closed' },
    };
    const patches = () => ado.calls.filter((c) => c.route === 'wit.workItems.PATCH').map((c) => c.body);
    const COLUMN = '/fields/WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column';
    it('one guarded JSON-patch per mapped stage: test /rev, then the column; the item already in the column is skipped', async () => {
        const out = await run(happy(), { forge: progressConfig({ enabled: true, stages: STAGES }) });
        expect(out.gate?.name, out.message).toBe('merge');
        // queued maps to Ready, where the item already is: read, nothing patched, recorded.
        expect(patches()).toEqual(['Active', 'Code Review', 'Verify', 'Ready to merge'].map((value) => [{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: COLUMN, value }]));
        expect(readFactoryState(h.root, ISSUE).trackerStage).toBe('ready-to-merge');
        expectNoMerge();
    });
    it('a rev conflict is retried once with a fresh rev, and the run goes on', async () => {
        ado.revConflicts = 1;
        const out = await run(happy(), { forge: progressConfig({ enabled: true, stages: { reviewing: { column: 'Code Review' } } }) });
        expect(out.gate?.name, out.message).toBe('merge');
        expect(patches()).toHaveLength(2);
        const reads = ado.calls.filter((c) => c.route === 'wit.workItems.GET' || c.route === 'wit.workItems.PATCH').map((c) => c.route);
        // intake's read, then read + PATCH (conflict) + re-read + PATCH (the merge park's outcome read follows).
        const first = reads.indexOf('wit.workItems.PATCH');
        expect(reads.slice(first - 1, first + 3)).toEqual(['wit.workItems.GET', 'wit.workItems.PATCH', 'wit.workItems.GET', 'wit.workItems.PATCH']);
        expect(readFactoryState(h.root, ISSUE).trackerStage).toBe('reviewing');
    });
    it('a conflict that persists after the one retry is a warning, never a blocked transition', async () => {
        ado.revConflicts = 10;
        const warnings = [];
        const out = await run(happy(), { warn: (m) => warnings.push(m), forge: progressConfig({ enabled: true, stages: { reviewing: { column: 'Code Review' } } }) });
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        expect(patches()).toHaveLength(2);
        const state = readFactoryState(h.root, ISSUE);
        expect(state.trackerStage).toBeUndefined();
        expect(state.history.some((e) => /^tracker-sync fail: reviewing: .*TF26071/.test(e.note))).toBe(true);
        expect(warnings.some((w) => /tracker stage reviewing/.test(w))).toBe(true);
    });
    it('blocked moves the column only, never the state', async () => {
        ado.headOverride = 'e'.repeat(40);
        const out = await run(happy(), { forge: progressConfig({ enabled: true, stages: STAGES }) });
        expect(out.gate?.name, out.message).toBe('head-moved-externally');
        const last = patches().at(-1);
        expect(last).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: COLUMN, value: 'Blocked' }]);
        expect(JSON.stringify(patches())).not.toContain('System.State');
        expect(readFactoryState(h.root, ISSUE).trackerStage).toBe('blocked');
    });
    it('cancelled changes nothing on Azure DevOps', async () => {
        ado.headOverride = 'e'.repeat(40);
        await run(happy(), { forge: progressConfig({ enabled: true, stages: STAGES }) });
        const before = patches().length;
        requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
        const out = await run([], { forge: progressConfig({ enabled: true, stages: STAGES }) });
        expect(out.phase).toBe('cancelled');
        // The rerun re-evaluated the gate at review (one column write), then cancelled wrote nothing.
        expect(patches().slice(before)).toEqual([[{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: COLUMN, value: 'Code Review' }]]);
        expect(readFactoryState(h.root, ISSUE).trackerStage).toBe('cancelled');
    });
    it('progress.enabled false writes nothing', async () => {
        const out = await run(happy(), { forge: progressConfig({ enabled: false, stages: STAGES }) });
        expect(out.gate?.name, out.message).toBe('merge');
        expect(patches()).toEqual([]);
        expect(readFactoryState(h.root, ISSUE).trackerStage).toBeUndefined();
    });
});
//# sourceMappingURL=engine.ado.progress.test.js.map