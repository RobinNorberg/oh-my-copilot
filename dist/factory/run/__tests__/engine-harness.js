/**
 * The shared harness of the core engine tests (engine.test.ts, engine.intake,
 * engine.state, engine.lanes, engine.resume): fake lanes, real git with a local
 * bare remote, scripted gh behind the exec seam.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach } from 'vitest';
import { updateShipState } from '../../../ship/state.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { defaultExec } from '../../../ship/exec.js';
import { factoryGuardExec } from '../exec.js';
import { EngineLedger } from '../ledger.js';
import { snapshotRepo } from '../review-guard.js';
import { updateFactoryState } from '../state.js';
import { FakeLanes, FakeProcesses, harness, ISSUE, PR, testGateConfig } from './fake-lanes.js';
export let h;
export let procs;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export function useEngineHarness() {
    beforeEach(() => {
        h = harness();
        procs = new FakeProcesses();
    });
    afterEach(() => {
        rmSync(h.dir, { recursive: true, force: true });
    });
}
export const limits = (over = {}) => ({ ...DEFAULT_FACTORY_RUN_LIMITS, ...over });
export function opts(lanes, over = {}) {
    return {
        root: h.root,
        issue: ISSUE,
        exec: h.exec,
        lanes,
        limits: limits(),
        base: 'dev',
        pollMs: 5,
        owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
        ledgerDir: h.ledgerDir,
        processes: procs,
        gateConfig: testGateConfig,
        ...over,
    };
}
export const ledger = () => EngineLedger.open(h.ledgerDir, h.root, ISSUE);
/** The Copilot child the crashed lane recorded (crashDuringLane). */
export const DEAD_CHILD = { pid: 4_999_999, identity: 'ticks:cr-dead' };
/**
 * The engine crashed while an implement lane (job cr-dead) ran; it had
 * recorded the lane's baseline first and, by default, the lane's child.
 */
export function crashDuringLane(withBaseline = true, child = DEAD_CHILD) {
    const id = `issue-${ISSUE}-implement-1`;
    if (withBaseline)
        ledger().setBaseline(id, snapshotRepo(factoryGuardExec(defaultExec), h.root));
    asEngine((s) => ({
        ...s, phase: 'implement', gate: undefined, plan: { source: 'issue-body', text: 'do it' },
        lanes: [{ id, kind: 'implement', jobId: 'cr-dead', ...(child ? { process: child } : {}), startSha: 'a'.repeat(40), status: 'running', maxCredits: 30, startedAt: s.createdAt }],
    }));
}
/** A state write the engine made (a crash simulated in the state): recorded in the engine ledger like the engine's own. */
export function asEngine(mutate) {
    const l = ledger();
    updateFactoryState(h.root, ISSUE, (s) => mutate(s), { onWrite: (p, c) => l.record(p, c) });
}
/** A ship write the engine made. */
export function shipAsEngine(mutate) {
    const l = ledger();
    updateShipState(h.root, PR, (s) => mutate(s), { onWrite: (p, c) => l.record(p, c) });
}
export const run = (scripts, over = {}, polls = []) => {
    const lanes = new FakeLanes(h.root, scripts, polls);
    return { lanes, done: runFactoryEngine(opts(lanes, over)) };
};
//# sourceMappingURL=engine-harness.js.map