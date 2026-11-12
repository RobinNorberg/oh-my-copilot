/**
 * isolation "container" (review-517 L2): a git view that cannot be built
 * runs nothing; the check gets no verdict (gate-no-verdict) with its own
 * park sentence (nothing ran), never a run without git. buildGitView is
 * made to fail from a chosen call on; the base calibration (not reached
 * here) keeps its warning.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
const view = vi.hoisted(() => ({ calls: 0, failFrom: 1 }));
vi.mock('../git-view.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        buildGitView: (...args) => {
            view.calls += 1;
            if (view.calls >= view.failFrom)
                throw new Error('pack too big for the test');
            return real.buildGitView(...args);
        },
    };
});
import { resolveShipConfig } from '../../../ship/config.js';
import { GATE_NO_VERDICT_GATE, runFactoryEngine } from '../engine.js';
import { lanesFor, localOpts, localWorld } from './engine-local-harness.js';
import { commitFile, review } from './fake-lanes.js';
const T = 300_000;
let w;
afterEach(() => { view.calls = 0; view.failFrom = 1; rmSync(w.dir, { recursive: true, force: true }); });
const gateConfig = () => ({
    config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [['node', 'check.js']] },
    known: [],
});
const userContainer = { factory: { run: { sandbox: { isolation: 'container' } } } };
function runner() {
    const seen = [];
    const run = async (req) => {
        seen.push(req);
        return { ran: true, status: 0, output: '', timedOut: false };
    };
    return { seen, run };
}
/** The view-failure park: its own sentence, never the "ran in the sandbox ... can hide its own exit code" text. */
function expectViewPark(reason, what) {
    expect(reason).toMatch(what);
    expect(reason).toMatch(/did not run: the git view of .* could not be built \(pack too big for the test\); nothing ran\. The head is not judged/);
    expect(reason).toMatch(/never runs without git/);
    expect(reason).not.toMatch(/ran in the OS sandbox|hide its own exit code/);
}
describe('container git view failure', () => {
    it('a prepare check whose view cannot be built never reaches the runner and parks gate-no-verdict', async () => {
        w = localWorld();
        const s = runner();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]), { gateSandbox: s.run, gateConfig, gateSandboxUserConfig: userContainer }));
        expect(out.gate?.name, out.message).toBe(GATE_NO_VERDICT_GATE);
        expectViewPark(out.gate?.reason, /^the prepare check `node check\.js` on [0-9a-f]{12} did not run/);
        expect(s.seen.filter((r) => r.purpose === 'prepare' || r.purpose === 'gate')).toEqual([]);
    }, T);
    it('the local gate whose view cannot be built never reaches the runner and parks gate-no-verdict', async () => {
        w = localWorld();
        // The prepare check's view builds (call 1); the local gate's does not (call 2).
        view.failFrom = 2;
        const s = runner();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]), { gateSandbox: s.run, gateConfig, gateSandboxUserConfig: userContainer }));
        expect(out.gate?.name, out.message).toBe(GATE_NO_VERDICT_GATE);
        expectViewPark(out.gate?.reason, /^the local gate `[^`]+` on [0-9a-f]{12} did not run/);
        expect(s.seen.map((r) => r.purpose)).toEqual(['prepare']);
        expect(w.gateRuns).toEqual([]);
    }, T);
});
//# sourceMappingURL=engine.gates-git-view-fail.test.js.map