/**
 * isolation "container" (review-517 L2): a git view that cannot be built
 * runs nothing; the check gets no verdict (gate-no-verdict), never a run
 * without git. buildGitView is made to fail; the base calibration (not
 * reached here) keeps its warning.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-view.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-view.js')>()),
  buildGitView: () => { throw new Error('pack too big for the test'); },
}));

import { resolveShipConfig } from '../../../ship/config.js';
import { GATE_NO_VERDICT_GATE, runFactoryEngine } from '../engine.js';
import type { GateConfigLoader } from '../prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { lanesFor, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { commitFile, review } from './fake-lanes.js';

const T = 300_000;
let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const gateConfig: GateConfigLoader = () => ({
  config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [['node', 'check.js']] } as ReturnType<GateConfigLoader>['config'],
  known: [],
});

describe('container git view failure', () => {
  it('a prepare check whose view cannot be built never reaches the runner and parks gate-no-verdict', async () => {
    w = localWorld();
    const seen: SandboxRunRequest[] = [];
    const run: SandboxRunner = async (req): Promise<SandboxRunResult> => {
      seen.push(req);
      return { ran: true, status: 0, output: '', timedOut: false };
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]), { gateSandbox: run, gateConfig, gateSandboxUserConfig: { factory: { run: { sandbox: { isolation: 'container' } } } } }));
    expect(out.gate?.name, out.message).toBe(GATE_NO_VERDICT_GATE);
    expect(out.gate?.reason).toMatch(/the git view of .* could not be built \(pack too big for the test\); nothing ran/);
    expect(seen.filter((r) => r.purpose === 'prepare' || r.purpose === 'gate')).toEqual([]);
  }, T);
});
