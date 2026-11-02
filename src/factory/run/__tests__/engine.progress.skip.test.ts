import { describe, expect, it } from 'vitest';

import { defaultProgressStages } from '../../../forge/config.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { ISSUE } from './fake-lanes.js';
import { githubConfig, h, edits, clearEdits, useProgressHarness, opts, happy, added, expectExclusive } from './engine-progress-harness.js';

useProgressHarness();

describe('progress sync on GitHub (fake gh, real git, real guard)', () => {
  it('another gate is blocked; cancelled removes the whole family', async () => {
    h.gh.issue.body = 'please add greet';
    const out = await runFactoryEngine(opts([]));
    expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('needs-plan');
    expect(added()).toEqual(['factory:queued', 'factory:blocked']);
    expectExclusive();

    clearEdits();
    requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
    const cancelled = await runFactoryEngine(opts([]));
    expect(cancelled.phase).toBe('cancelled');
    // The rerun re-evaluates the gate (back to queued at plan), then the cancel takes the family back.
    expect(added()).toEqual(['factory:queued', null]);
    expectExclusive();
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('cancelled');
  });

  it('a closed issue cancelled at intake writes nothing (no stage was ever written)', async () => {
    h.gh.issue.state = 'CLOSED';
    const out = await runFactoryEngine(opts([]));
    expect(out.phase).toBe('cancelled');
    expect(edits).toEqual([]);
  });

  it('progress.enabled false writes nothing', async () => {
    const off = await runFactoryEngine(opts(happy(), { forge: { config: githubConfig({ enabled: false, stages: defaultProgressStages('github') }), options: factoryForgeOptions(h.root) } }));
    expect(off.gate?.name, off.message).toBe('merge');
    expect(edits).toEqual([]);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBeUndefined();
  });

  it('a run without a forge config (tests and callers before forges) writes nothing', async () => {
    const out = await runFactoryEngine(opts(happy(), { forge: undefined }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(edits).toEqual([]);
  });

  it('a stage with no label in the mapping is skipped, the others still write', async () => {
    const stages = defaultProgressStages('github');
    delete stages.reviewing;
    const out = await runFactoryEngine(opts(happy(), { forge: { config: githubConfig({ enabled: true, stages }), options: factoryForgeOptions(h.root) } }));
    expect(out.gate?.name).toBe('merge');
    expect(added()).toEqual(['factory:queued', 'factory:building', 'factory:verifying', 'factory:ready-to-merge']);
  });
});
