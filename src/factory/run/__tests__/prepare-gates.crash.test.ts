import { describe, expect, it, vi } from 'vitest';

import { readShipState } from '../../../ship/state.js';
import { checkoutPath } from '../prepare.js';
import { readFactoryState } from '../state.js';
import type { Exec } from '../../../ship/exec.js';
import { commitFile, gitIn, ISSUE, PR, remoteHead, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, usePrepareGatesHarness, run, moveBase, PREPARE_VIEW, before, okRun, isTsc, pushes } from './prepare-gates-harness.js';

// Every engine run here drives a few hundred real git processes (the lane
// tamper snapshots, prepare merges, the bare remote). No assertion measures
// time, so the timeout only bounds a hang and must leave a loaded host's
// process spawns room.
vi.setConfig({ testTimeout: scaleTiming(90_000) });

usePrepareGatesHarness();

describe('prepare: crash window, PR code and failing checks', () => {
  it('a crash right after the prepare push resumes from the recorded prepare instead of parking at head-moved-externally', async () => {
    before(PREPARE_VIEW, () => moveBase('inventory/graph.json', '{"base":true}\n'));
    let n = 0;
    const crashing: Exec = (cmd, args, opts) => {
      const res = h.exec(cmd, args, opts);
      if (cmd === 'git' && args.includes('push') && ++n === 2) throw new Error('simulated crash after the prepare push');
      return res;
    };
    const first = await run([commitFile('inventory/graph.json', '{"lane":true}\n'), review('approve')], { exec: crashing }).done;
    expect(first.exitCode, first.message).toBe(1);
    const crashed = readFactoryState(h.root, ISSUE)!;
    expect(crashed.phase).toBe('prepare');
    expect(crashed.prepared?.head).toBe(remoteHead(h));
    expect(crashed.head).not.toBe(remoteHead(h));

    const out = await run([]).done;
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.head).toBe(remoteHead(h));
    expect(state.prepared).toBeUndefined();
    expect(readShipState(h.root, PR)!.housekeepingCommits).toEqual([state.head]);
    // Nothing was prepared or pushed again.
    expect(pushes()).toHaveLength(2);
  });

  it.each<[string, () => void, RegExp]>([
    ['sets a pushurl', () => gitIn(h.root, 'config', 'remote.origin.pushurl', 'https://github.com/evil/r.git'), /common git config changed/],
    ['creates a ref', () => gitIn(h.root, 'branch', 'evil', 'HEAD'), /ref refs\/heads\/evil was created/],
  ])('PR code run by prepare\'s checks that %s parks at lane-tampered and nothing is pushed', async (_label, tamper, problem) => {
    h.node = (args) => { if (isTsc(args)) tamper(); return okRun; };
    const out = await run([commitFile('src/greet.ts', 'x\n'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(problem);
    expect(out.message).toMatch(/prepare's checks/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('prepare');
    expect(pushes()).toHaveLength(1);
    expect(readShipState(h.root, PR)!.phase).toBe('prepare');
  });

  it('origin/dev moved by prepare\'s checks to a sha that is not GitHub\'s base parks at lane-tampered', async () => {
    h.node = (args) => {
      if (isTsc(args)) gitIn(h.root, 'update-ref', 'refs/remotes/origin/dev', readFactoryState(h.root, ISSUE)!.head!);
      return okRun;
    };
    const out = await run([commitFile('src/greet.ts', 'x\n'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(/refs\/remotes\/origin\/dev is at .*, not GitHub's base/);
    expect(pushes()).toHaveLength(1);
  });

  it('a commit PR code adds in the checkout is not one of the engine\'s housekeeping commits: lane-tampered and nothing is pushed', async () => {
    h.node = (args) => {
      if (isTsc(args)) gitIn(checkoutPath(h.root, ISSUE), 'commit', '-q', '--allow-empty', '-m', 'unreviewed');
      return okRun;
    };
    const out = await run([commitFile('src/greet.ts', 'x\n'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.message).toMatch(/added commit\(s\) the engine did not make/);
    expect(pushes()).toHaveLength(1);
    expect(readShipState(h.root, PR)!.phase).toBe('prepare');
  });

  it('resuming a recorded prepare re-checks the shared git state first', async () => {
    before(PREPARE_VIEW, () => moveBase('inventory/graph.json', '{"base":true}\n'));
    let n = 0;
    const crashing: Exec = (cmd, args, opts) => {
      const res = h.exec(cmd, args, opts);
      if (cmd === 'git' && args.includes('push') && ++n === 2) throw new Error('simulated crash after the prepare push');
      return res;
    };
    await run([commitFile('inventory/graph.json', '{"lane":true}\n'), review('approve')], { exec: crashing }).done;
    gitIn(h.root, 'branch', 'evil', 'HEAD');
    const out = await run([]).done;
    expect(out.gate?.name, out.message).toBe('review-tampered');
    expect(out.message).toMatch(/tampered|shared git state changed/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('review');
  });

  it('a restarted prepare drops the recorded push, so a stale tracking-ref move is no longer tolerated', async () => {
    before(PREPARE_VIEW, () => moveBase('inventory/graph.json', '{"base":true}\n'));
    let n = 0;
    const crashing: Exec = (cmd, args, opts) => {
      const res = h.exec(cmd, args, opts);
      if (cmd === 'git' && args.includes('push') && ++n === 2) throw new Error('simulated crash after the prepare push');
      return res;
    };
    await run([commitFile('inventory/graph.json', '{"lane":true}\n'), review('approve')], { exec: crashing }).done;
    // The PR head is back at the reviewed head, so the recorded prepare is not what is on GitHub: prepare restarts.
    h.gh.headOverride = readFactoryState(h.root, ISSUE)!.head!;
    const out = await run([]).done;
    expect(out.gate?.name, out.message).toBe('review-tampered');
    expect(out.message).toMatch(/before prepare/);
    expect(readFactoryState(h.root, ISSUE)!.prepared).toBeUndefined();
  });

  it('a failing prepare check starts one ci-fix lane at the checkout head, then a new review and a clean prepare', async () => {
    let tsc = 0;
    h.node = (args) => (isTsc(args) && ++tsc === 1 ? { status: 1, stdout: 'src/greet.ts(1,1): error TS1005: expected', stderr: '' } : okRun);
    const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve'), commitFile('src/greet.ts', 'fixed\n'), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started.map((s) => s.laneId)).toEqual([
      `issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-ci-fix-1`, `issue-${ISSUE}-review-2`,
    ]);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(lanes.started[2].baseRef).toBe(state.lanes[0].endSha);
    expect(lanes.started[2].prompt).toContain('- prepare tsc');
    expect(lanes.started[2].prompt).toContain('engine\'s local checks');
    expect(state.ciFixRounds).toBe(1);
    expect(tsc).toBe(2);
  });
});
