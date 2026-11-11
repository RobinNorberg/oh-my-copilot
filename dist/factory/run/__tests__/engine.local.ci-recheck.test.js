/**
 * F58 (dogfood round 3): a rerun after a ci-fix park on an unchanged head
 * re-runs the local gate on that head before it spends another ci-fix lane.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { readLocalCheckRecord } from '../../../forge/local/index.js';
import { runFactoryEngine, EXIT_AWAITING_HUMAN } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, noCommit, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
vi.setConfig({ testTimeout: scaleTiming(300_000) });
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const ciFixLanes = (ids) => ids.filter((id) => id.includes('ci-fix'));
/** The first run: the gate fails, both ci-fix lanes leave no changes, the run parks at ci-fix-failed. */
async function parkedAtCiFixFailed(gateStatus) {
    w = localWorld();
    w.gateStatus = gateStatus;
    const lanes = lanesFor(w, [greet(), review('approve'), noCommit, noCommit]);
    const out = await runFactoryEngine(localOpts(w, lanes));
    expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('ci-fix-failed');
    expect(ciFixLanes(lanes.started.map((s) => s.laneId))).toHaveLength(2);
    const s = readFactoryState(w.root, LOCAL_ISSUE);
    expect(s.ciFixRounds).toBe(1);
    expect(readLocalCheckRecord(w.stateDir, w.root, s.head)).toMatchObject({ state: 'FAILURE' });
    return s;
}
describe('factory run: rerun after a ci-fix park on the same head (F58)', () => {
    it('re-runs the gate first; a pass goes on to the merge park with no ci-fix lane', async () => {
        const parked = await parkedAtCiFixFailed([1, 0]);
        const lanes = lanesFor(w, []);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        expect(lanes.started).toEqual([]);
        expect(w.gateRuns.map((r) => r.head)).toEqual([parked.head, parked.head]);
        const s = readFactoryState(w.root, LOCAL_ISSUE);
        expect(readLocalCheckRecord(w.stateDir, w.root, s.head)).toMatchObject({ state: 'SUCCESS' });
        expect(s.history.some((h) => h.from === 'ci-fix' && h.to === 'gates' && /re-checking .* the head is unchanged/.test(h.note))).toBe(true);
        expect(s.ciFixRounds).toBe(0);
    });
    it('a gate that still fails spends one ci-fix round again, on the same round count', async () => {
        const parked = await parkedAtCiFixFailed([1, 1]);
        const lanes = lanesFor(w, [noCommit, noCommit]);
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('ci-fix-failed');
        expect(w.gateRuns.map((r) => r.head)).toEqual([parked.head, parked.head]);
        // The re-check failed, so the run spent its lanes as before (one fresh retry), and the round count is unchanged.
        expect(ciFixLanes(lanes.started.map((s) => s.laneId))).toHaveLength(2);
        expect(readFactoryState(w.root, LOCAL_ISSUE).ciFixRounds).toBe(1);
    });
    it('a ci-failed park (rounds spent) records the failure, so a rerun on the same head re-runs the gate', async () => {
        w = localWorld();
        w.gateStatus = [1, 0];
        const noRounds = { limits: { ...localOpts(w, lanesFor(w, [])).limits, maxCiFixRounds: 0 } };
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), noRounds));
        expect(first.exitCode, first.message).toBe(EXIT_AWAITING_HUMAN);
        expect(first.gate?.name).toBe('ci-failed');
        const parked = readFactoryState(w.root, LOCAL_ISSUE);
        expect(parked.ciFailure?.startSha).toBe(parked.head);
        const lanes = lanesFor(w, []);
        const out = await runFactoryEngine(localOpts(w, lanes, noRounds));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        expect(lanes.started).toEqual([]);
        expect(w.gateRuns.map((r) => r.head)).toEqual([parked.head, parked.head]);
    });
});
//# sourceMappingURL=engine.local.ci-recheck.test.js.map