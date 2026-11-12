import { describe, expect, it, vi } from 'vitest';

import { readShipState } from '../../../ship/state.js';
import { cancelCommand, resumeCommand } from '../engine.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import type { Exec } from '../../../ship/exec.js';
import { commitFile, failedGates, gitIn, greenGates, ISSUE, PR, pendingGates, review, type LaneScript } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, t, usePrepareGatesHarness, limits, run, PREPARE_VIEW, pushes } from './prepare-gates-harness.js';

// Every engine run here drives a few hundred real git processes (the lane
// tamper snapshots, prepare merges, the bare remote). No assertion measures
// time, so the timeout only bounds a hang and must leave a loaded host's
// process spawns room.
vi.setConfig({ testTimeout: scaleTiming(90_000) });

usePrepareGatesHarness();

describe('gates loop', () => {
  it('a stale head and a failed read from another commit\'s runs are ignored, never acted on', async () => {
    // In the gates phase (its PR view is the second full one, after prepare's), GitHub first still reports the base,
    // an ancestor of the pushed head; then a failure from a run of another commit.
    let views = 0;
    let armed = false;
    h.onCall = (call) => {
      if (call.startsWith(PREPARE_VIEW) && ++views === 2) armed = true;
      else if (armed && call === `gh pr view ${PR} --json headRefOid,state`) {
        armed = false;
        h.gh.headSequence.push(gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev'));
      }
    };
    h.gh.gates = [{ checks: failedGates(99).checks, runs: greenGates(100).runs }, greenGates(100)];
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started).toHaveLength(2);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.ciFixRounds).toBe(0);
    expect(state.ciFailure).toBeUndefined();
    expect(h.calls.filter((c) => c === `gh pr view ${PR} --json headRefOid,state`).length).toBeGreaterThanOrEqual(3);
  });

  it('a head GitHub reports that the engine never pushed parks at head-moved-externally', async () => {
    let views = 0;
    let armed = false;
    h.onCall = (call) => {
      // After the gates phase's own PR view (the second full one), the driver's head read sees a foreign head.
      if (call.startsWith(PREPARE_VIEW) && ++views === 2) armed = true;
      else if (armed && call === `gh pr view ${PR} --json headRefOid,state`) {
        armed = false;
        h.gh.headSequence.push('f'.repeat(40));
      }
    };
    const { done } = run([commitFile('a.ts'), review('approve')]);
    const out = await done;
    expect(out.gate?.name).toBe('head-moved-externally');
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('gates');
  });

  it('gates that never settle park at gates-timeout after factory.run.gatesTimeoutMinutes', async () => {
    h.gh.gates = [pendingGates()];
    const { done } = run([commitFile('a.ts'), review('approve')], { limits: limits({ gatesTimeoutMs: 20 * 60_000 }) });
    const out = await done;
    expect(out.gate?.name).toBe('gates-timeout');
    expect(out.gate?.reason?.endsWith(`; rerun ${resumeCommand(ISSUE)} to wait again, or ${cancelCommand(ISSUE)}`)).toBe(true);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('gates');
  });

  it('review-528 M2: the gates-timeout reason sanitises forge check names (newline, @mention, backticks, ANSI)', async () => {
    const pending = pendingGates();
    const evil = 'Build`\n@team \u001b[31mred';
    h.gh.gates = [{ ...pending, checks: [...pending.checks, { ...pending.checks[0]!, name: evil }] }];
    const { done } = run([commitFile('a.ts'), review('approve')], { limits: limits({ gatesTimeoutMs: 20 * 60_000 }) });
    const out = await done;
    expect(out.gate?.name).toBe('gates-timeout');
    const reason = out.gate?.reason ?? '';
    expect(reason).toContain('(pending: `Test`, `Build\' ＠team [31mred`, ');
    expect(reason).not.toMatch(/[\n\u001b@]/);
  });
});

describe('gates: ci-fix tampering, cancel and resume', () => {
  it('a ci-fix lane that changes shared git state parks at lane-tampered and nothing is pushed', async () => {
    h.gh.gates = [failedGates(100)];
    const tampering: LaneScript = (ctx) => { const r = commitFile('src/fix.ts')(ctx); gitIn(h.root, 'branch', 'evil', ctx.baseSha); return r ?? undefined; };
    const out = await run([commitFile('a.ts'), review('approve'), tampering]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(/ci-fix lane .*refs\/heads\/evil was created/);
    expect(pushes()).toHaveLength(1);
  });

  it('cancel while the gates loop polls stops the run as cancelled', async () => {
    h.gh.gates = [pendingGates()];
    let checks = 0;
    h.onCall = (c) => { if (c.startsWith(`gh pr checks ${PR}`) && ++checks === 3) requestFactoryCancel(h.root, ISSUE, new Date(t).toISOString()); };
    const out = await run([commitFile('a.ts'), review('approve')]).done;
    expect(out.phase, out.message).toBe('cancelled');
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('cancelled');
    // It lands at ship's next poll, not at the end of the 9-minute watch window.
    expect(h.calls.filter((c) => c.startsWith(`gh pr checks ${PR}`))).toHaveLength(3);
  });

  it('a crash mid-gates resumes the gates loop on the same head and reaches the merge park', async () => {
    h.gh.gates = [pendingGates()];
    let checks = 0;
    const crashing: Exec = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'checks' && ++checks === 3) throw new Error('simulated crash mid-gates');
      return h.exec(cmd, args, opts);
    };
    const first = await run([commitFile('a.ts'), review('approve')], { exec: crashing }).done;
    expect(first.exitCode, first.message).toBe(1);
    const head = readFactoryState(h.root, ISSUE)!.head;
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('gates');
    h.gh.gates = [greenGates()];
    const out = await run([]).done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(readFactoryState(h.root, ISSUE)!.head).toBe(head);
    expect(readShipState(h.root, PR)!.phase).toBe('ready');
    expect(pushes()).toHaveLength(1);
  });

  it('a merge-rule gate read that keeps disagreeing with the gates loop parks at gates-disagree instead of cycling', async () => {
    h.gh.gates = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? greenGates() : failedGates()));
    const out = await run([commitFile('a.ts'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('gates-disagree');
    // Persisted in the state, so a rerun does not get a fresh allowance.
    expect(readFactoryState(h.root, ISSUE)!.mergeBounces).toBe(3);
    expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });
});
