import { describe, expect, it } from 'vitest';
import { readShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../engine.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { commitFile, FakeLanes, gitIn, ISSUE, PR, review } from './fake-lanes.js';
import { asEngine, h, ledger, opts, run, useEngineHarness } from './engine-harness.js';
useEngineHarness();
/** A run parked at the merge gate (it has a PR and a ship state), then moved to `phase`/`gate` as the engine would have. */
async function stoppedRun(mutate) {
    const first = await run([commitFile('a.ts'), review('approve')]).done;
    expect(first.gate?.name, first.message).toBe('merge');
    asEngine(mutate);
}
const cancelled = (s) => {
    const { gate: _g, ...rest } = s;
    return { ...rest, phase: 'cancelled', history: [...s.history, { at: s.updatedAt, from: s.phase, to: 'cancelled', note: 'cancel requested' }] };
};
const fixFailed = (s) => ({ ...s, phase: 'fix', gate: { name: 'fix-failed', reason: 'lane issue-7-fix-2: the lane left no changes in its worktree', at: s.updatedAt } });
/** h.exec with `gh pr view <PR>` answered by `answer` (a failed read or another PR state). */
function prView(answer) {
    const inner = h.exec;
    return (cmd, args, o) => {
        const res = inner(cmd, args, o);
        return cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args[2] === String(PR) ? answer(res) : res;
    };
}
describe('omg factory run: a stopped run whose PR a human merged', () => {
    it('cancelled + merged PR: recorded merged, no lane starts, ship follows', async () => {
        await stoppedRun(cancelled);
        h.gh.merged = true;
        const { lanes, done } = run([]);
        const out = await done;
        expect(out.exitCode, out.message).toBe(0);
        expect(out.phase).toBe('merged');
        expect(lanes.started).toHaveLength(0);
        const s = readFactoryState(h.root, ISSUE);
        expect(s.phase).toBe('merged');
        expect(s.history.at(-1)?.note).toBe(`PR #${PR} merged by a human after cancelled`);
        expect(readShipState(h.root, PR).phase).toBe('merged');
        // The engine's own record: the next run reads the state as its own (no tamper park).
        expect(ledger().mismatches()).toEqual([]);
        const again = await run([]).done;
        expect(again.phase).toBe('merged');
    });
    it('parked at fix-failed + merged PR: recorded merged before any lane resumes', async () => {
        await stoppedRun(fixFailed);
        h.gh.merged = true;
        const { lanes, done } = run([commitFile('b.ts')]);
        const out = await done;
        expect(out.phase, out.message).toBe('merged');
        expect(lanes.started).toHaveLength(0);
        const s = readFactoryState(h.root, ISSUE);
        expect(s.gate).toBeUndefined();
        expect(s.history.at(-1)?.note).toBe(`PR #${PR} merged by a human after awaiting-human: fix-failed`);
    });
    it('a failed PR read never marks merged: a cancelled run stays cancelled', async () => {
        await stoppedRun(cancelled);
        h.gh.merged = true;
        const warnings = [];
        const out = await run([], { exec: prView(() => ({ status: 1, stdout: '', stderr: 'HTTP 502' })), warn: (m) => warnings.push(m) }).done;
        expect(out.phase).toBe('cancelled');
        expect(readFactoryState(h.root, ISSUE).phase).toBe('cancelled');
        expect(warnings.join('\n')).toMatch(/PR #42 could not be read to check for a human merge/);
    });
    it('a failed PR read on a parked run resumes as before (never merged)', async () => {
        await stoppedRun(fixFailed);
        let reads = 0;
        // Only the first read (the human-merge check) fails; the PR stays open.
        const { lanes, done } = run([commitFile('b.ts')], { exec: prView((res) => (++reads === 1 ? { status: 1, stdout: '', stderr: 'HTTP 502' } : res)) });
        await done;
        expect(reads).toBeGreaterThan(1);
        expect(lanes.started[0]?.laneId).toBe(`issue-${ISSUE}-fix-1`);
        expect(readFactoryState(h.root, ISSUE).phase).not.toBe('merged');
    });
    it('parked + closed (unmerged) PR: stops with a message, no lane starts, the park stays', async () => {
        await stoppedRun(fixFailed);
        const closed = prView((res) => ({ ...res, stdout: res.stdout.replace('"state":"OPEN"', '"state":"CLOSED"') }));
        const { lanes, done } = run([commitFile('b.ts')], { exec: closed });
        const out = await done;
        expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
        expect(out.message).toMatch(/PR #42 of the factory run for issue #7 was closed without merging, so the run \(parked at awaiting-human: fix-failed\) was not resumed and no lane started/);
        expect(lanes.started).toHaveLength(0);
        const s = readFactoryState(h.root, ISSUE);
        expect(s.phase).toBe('fix');
        expect(s.gate?.name).toBe('fix-failed');
    });
    it('parked at the merge gate + merged PR: the merge step reads the PR itself (no human-merge record first)', async () => {
        await stoppedRun((s) => s);
        h.gh.merged = true;
        const out = await run([]).done;
        expect(out.phase, out.message).toBe('merged');
        const notes = readFactoryState(h.root, ISSUE).history.map((e) => e.note ?? '');
        expect(notes.some((n) => n.includes('merged by a human after'))).toBe(false);
    });
    it.each(['prepare', 'gates'])('parked in %s + merged PR: that step reads the PR itself (no human-merge record first)', async (phase) => {
        await stoppedRun((s) => ({ ...s, phase, gate: { name: `${phase}-timeout`, reason: 'test', at: s.updatedAt } }));
        h.gh.merged = true;
        await run([]).done;
        const notes = readFactoryState(h.root, ISSUE).history.map((e) => e.note ?? '');
        expect(notes.some((n) => n.includes('merged by a human after'))).toBe(false);
    });
    it('parked at a tamper park + merged PR: never recorded as a human merge', async () => {
        await stoppedRun((s) => ({ ...s, phase: 'fix', gate: { name: 'lane-tampered', reason: 'test', at: s.updatedAt } }));
        h.gh.merged = true;
        await run([]).done;
        const notes = readFactoryState(h.root, ISSUE).history.map((e) => e.note ?? '');
        expect(notes.some((n) => n.includes('merged by a human after'))).toBe(false);
    });
    it('cancelled + open PR: unchanged, nothing resumes', async () => {
        await stoppedRun(cancelled);
        const { lanes, done } = run([commitFile('b.ts')]);
        const out = await done;
        expect(out.phase).toBe('cancelled');
        expect(lanes.started).toHaveLength(0);
    });
});
describe('review 533b NEW-1: a lane cancelled without a clean tamper check is never laundered into a human merge', () => {
    /** Cancel the run while its review lane runs; `during` runs at that poll (a lane's write). */
    async function cancelDuringReview(during, over = {}) {
        const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')], [0, 50]);
        if (over.cancelFails)
            lanes.cancelFails = true;
        let asked = false;
        lanes.onRunningPoll = () => {
            if (asked)
                return;
            asked = true;
            during();
            requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
        };
        const out = await runFactoryEngine(opts(lanes));
        expect(out.phase, out.message).toBe('cancelled');
    }
    /** Rerun after a human merged the PR: the outcome and the warnings. */
    async function rerunMerged() {
        h.gh.merged = true;
        const warnings = [];
        const { lanes, done } = run([], { warn: (m) => warnings.push(m) });
        const out = await done;
        expect(lanes.started).toHaveLength(0);
        return { phase: out.phase ?? '', warnings: warnings.join('\n') };
    }
    it('a cancel whose tamper check found a change + merged PR: stays cancelled, a warning says why', async () => {
        await cancelDuringReview(() => gitIn(h.root, 'branch', 'evil', 'HEAD'));
        const lane = readFactoryState(h.root, ISSUE).lanes[1];
        expect(lane).toMatchObject({ status: 'cancelled', tamperCheck: 'problems' });
        const r = await rerunMerged();
        expect(r.phase).toBe('cancelled');
        expect(r.warnings).toContain(`not checked for a human merge: lane ${lane.id} was cancelled without a clean tamper check; inspect dev`);
        expect(readFactoryState(h.root, ISSUE).history.some((e) => (e.note ?? '').includes('merged by a human'))).toBe(false);
    });
    it('a cancel that could not stop the lane (no compare) + merged PR: stays cancelled', async () => {
        await cancelDuringReview(() => undefined, { cancelFails: true });
        expect(readFactoryState(h.root, ISSUE).lanes[1]).toMatchObject({ status: 'cancelled', tamperCheck: 'skipped' });
        expect((await rerunMerged()).phase).toBe('cancelled');
    });
    it('a clean cancel + merged PR: recorded merged', async () => {
        await cancelDuringReview(() => undefined);
        expect(readFactoryState(h.root, ISSUE).lanes[1]).toMatchObject({ status: 'cancelled', tamperCheck: 'clean' });
        expect((await rerunMerged()).phase).toBe('merged');
    });
    it('an older state (a cancelled lane without tamperCheck, note says clean) + merged PR: stays cancelled', async () => {
        await cancelDuringReview(() => undefined);
        asEngine((s) => ({ ...s, lanes: s.lanes.map(({ tamperCheck: _t, ...l }) => l) }));
        expect(readFactoryState(h.root, ISSUE).lanes[1].note).toBe('cancelled; tamper check clean');
        const r = await rerunMerged();
        expect(r.phase).toBe('cancelled');
        expect(r.warnings).toMatch(/was cancelled without a clean tamper check/);
    });
});
//# sourceMappingURL=engine.human-merged.test.js.map