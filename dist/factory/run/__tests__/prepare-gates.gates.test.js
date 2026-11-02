import { describe, expect, it, vi } from 'vitest';
import { readShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, failedGates, greenGates, ISSUE, PR, pendingGates, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, usePrepareGatesHarness, run, events } from './prepare-gates-harness.js';
// Every engine run here drives a few hundred real git processes (the lane
// tamper snapshots, prepare merges, the bare remote). No assertion measures
// time, so the timeout only bounds a hang and must leave a loaded host's
// process spawns room.
vi.setConfig({ testTimeout: scaleTiming(90_000) });
usePrepareGatesHarness();
describe('gates loop', () => {
    it('pending -> green across watch windows: a window that ends pending is a heartbeat, not a stop', async () => {
        // 30 s polls: 25 pending reads cross the 9-minute ship window once.
        h.gh.gates = [...Array(25).fill(pendingGates()), greenGates()];
        const { done } = run([commitFile('a.ts'), review('approve')]);
        const out = await done;
        expect(out.gate?.name, out.message).toBe('merge');
        expect(h.calls.filter((c) => c.startsWith(`gh pr checks ${PR}`)).length).toBeGreaterThanOrEqual(26);
        const ship = readShipState(h.root, PR);
        expect(ship.phase).toBe('ready');
        expect(ship.lastGates?.verdict).toBe('green');
        expect(events().some((e) => e.phase === 'gates' && e.status === 'heartbeat' && /watch window elapsed/.test(e.note ?? ''))).toBe(true);
    });
    it('pending -> red -> one ci-fix lane -> a new review on the new head -> green', async () => {
        h.gh.gates = [pendingGates(100), failedGates(100), greenGates(101)];
        h.gh.logs['200'] = 'Test\tRun tests\t2026-10-27T10:00:00.0000000Z  FAIL  src/greet.test.ts > greet > returns hi\n';
        const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve'), commitFile('src/greet.ts', 'hi\n'), review('approve')]);
        const out = await done;
        expect(out.gate?.name, out.message).toBe('merge');
        const state = readFactoryState(h.root, ISSUE);
        expect(lanes.started.map((s) => s.laneId)).toEqual([
            `issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-ci-fix-1`, `issue-${ISSUE}-review-2`,
        ]);
        const redHead = state.lanes[0].endSha;
        expect(lanes.started[2].baseRef).toBe(redHead);
        expect(lanes.started[2].prompt).toContain('- Test');
        expect(lanes.started[2].prompt).toContain('src/greet.test.ts > greet > returns hi');
        expect(lanes.started[3].baseRef).toBe(state.head);
        expect(state.head).not.toBe(redHead);
        expect(state.ciFixRounds).toBe(1);
        expect(readShipState(h.root, PR).verdicts.map((v) => v.sha)).toEqual([redHead, state.head]);
    });
    it('a second real failure after the one ci-fix round parks at ci-failed', async () => {
        h.gh.gates = [failedGates(100)];
        const { lanes, done } = run([commitFile('a.ts'), review('approve'), commitFile('b.ts'), review('approve')]);
        const out = await done;
        expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('ci-failed');
        expect(lanes.started.filter((s) => s.laneId.includes('ci-fix'))).toHaveLength(1);
    });
});
//# sourceMappingURL=prepare-gates.gates.test.js.map