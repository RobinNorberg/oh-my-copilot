import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ledgerPath, readLedger } from '../../../budget/ledger.js';
import { CopilotRunManager, STOP_CONTINUATION_SKIP_TOKEN } from '../../../copilot-run/job.js';
import { fakeDeps, gitIn, newCalls, scratchRepo, type FakeBehavior, type FakeCalls } from '../../../copilot-run/__tests__/fake-sdk.js';
import { CopilotLaneBackend, LaneLostError, isTerminalLaneState, type LaneJobManager, type LaneRunner, type LaneStartInput } from '../lane.js';

let root: string;
let repo: string;
let calls: FakeCalls;

/** No OMG_COPILOT_RUN_ALLOW in the env: the backend's allowLive is the only opt-in. */
const managerFor = (behavior: FakeBehavior) => new CopilotRunManager(fakeDeps(root, behavior, calls, {}));
const input = (over: Partial<LaneStartInput> = {}): LaneStartInput => ({
  laneId: 'implement-1',
  cwd: repo,
  baseRef: 'main',
  prompt: 'implement the issue; commit, do not push',
  timeoutMs: 60_000,
  maxCredits: 30,
  ...over,
});

beforeEach(() => {
  calls = newCalls();
  ({ root, repo } = scratchRepo('omg-factory-lane-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CopilotLaneBackend', () => {
  it('runs a write lane at baseRef and reports branch, base, head, changes and measured usage', async () => {
    const base = gitIn(repo, 'rev-parse', 'HEAD');
    const lanes: LaneRunner = new CopilotLaneBackend(managerFor('commit'), { allowLive: true });
    expect(lanes.kind).toBe('local-sdk');
    const { remoteId } = await lanes.start(input());
    const result = await lanes.wait(remoteId, 10_000);

    expect(result.state).toBe('completed');
    expect(result.remoteId).toBe(remoteId);
    expect(result.branch).toBe(`omc-team/copilot-run/${remoteId}`);
    expect(result.baseSha).toBe(base);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.headSha).not.toBe(base);
    expect(gitIn(result.worktree!, 'log', '-1', '--format=%s')).toBe('lane commit');
    expect(result.changes?.changedFiles).toEqual(['lane.txt']);
    expect(result.changes?.protectedChanges).toEqual([]);
    expect(result.finalText).toBe('Done.');
    expect(result.usage).toMatchObject({ premiumRequests: 1, credits: 2, source: 'measured' });
    expect(result.logsUrl).toMatch(/events\.jsonl$/);
    expect(result.pr).toBeNull();
    expect(result.error).toBeNull();

    // A lane session never gets the env opt-in and never runs the blocking Stop hooks.
    const env = calls.connections[0].env!;
    expect(env.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
    expect(env.OMC_SKIP_HOOKS).toBe(STOP_CONTINUATION_SKIP_TOKEN);

    // The spend is attributed to the lane, not to the job id.
    const { sessions } = readLedger(ledgerPath(repo));
    expect(Object.keys(sessions)).toEqual(['factory-lane:implement-1']);
    expect(sessions['factory-lane:implement-1']).toMatchObject({ premiumRequests: 1, credits: 2, source: 'measured' });
    expect(result.process).toBeNull();
  });

  it('reports the Copilot child (pid and start identity) once the runtime started', async () => {
    const deps = fakeDeps(root, 'commit', calls, {});
    const sdk = (await deps.loadSdk())!;
    const Base = sdk.module.CopilotClient as unknown as new (o: unknown) => { cliProcess: unknown };
    class WithChild extends Base {
      constructor(o: unknown) { super(o); this.cliProcess = { pid: 4321 }; }
    }
    const identified: number[] = [];
    const manager = new CopilotRunManager({
      ...deps,
      loadSdk: async () => ({ ...sdk, module: { ...sdk.module, CopilotClient: WithChild as never } }),
      processIdentity: async (pid) => { identified.push(pid); return `ticks:${pid}`; },
    });
    const lanes = new CopilotLaneBackend(manager, { allowLive: true });
    const { remoteId } = await lanes.start(input());
    const result = await lanes.wait(remoteId, 10_000);
    expect(result.state).toBe('completed');
    expect(result.process).toEqual({ pid: 4321, identity: 'ticks:4321' });
    expect(identified).toEqual([4321]);
  });

  it('passes the review profile and baseRef through to the job', async () => {
    const started: Array<Parameters<LaneJobManager['start']>> = [];
    const real = managerFor('idle');
    const spy: LaneJobManager = {
      start: (...args) => { started.push(args); return real.start(...args); },
      status: (id) => real.status(id),
      wait: (id, ms) => real.wait(id, ms),
      cancel: (id) => real.cancel(id),
    };
    const lanes = new CopilotLaneBackend(spy, { allowLive: true });
    const { remoteId } = await lanes.start(input({ profile: 'review', model: 'gpt-test' }));
    const result = await lanes.wait(remoteId, 10_000);
    expect(started[0][0]).toMatchObject({ isolation: 'worktree', startRef: 'main', profile: 'review', model: 'gpt-test', timeoutMs: 60_000, maxCredits: 30 });
    expect(started[0][1]).toEqual({ allowLive: true, disableStopContinuations: true, ledgerKey: 'factory-lane:implement-1', sandboxScope: 'factory' });
    expect(result.sandbox?.mode).toBe('enforced');
    // The model the session ran on (copilot_run snapshot.model) reaches the lane result.
    expect(result.model).toBe('gpt-test');
    // A review lane that changed nothing ends on its base commit.
    expect(result.headSha).toBe(result.baseSha);
    expect(result.changes?.changedFiles).toEqual([]);
  });

  it('passes engineCommits through as the job\'s hostCommits', async () => {
    const started: Array<Parameters<LaneJobManager['start']>> = [];
    const real = managerFor('idle');
    const spy: LaneJobManager = {
      start: (...args) => { started.push(args); return real.start(...args); },
      status: (id) => real.status(id),
      wait: (id, ms) => real.wait(id, ms),
      cancel: (id) => real.cancel(id),
    };
    const lanes = new CopilotLaneBackend(spy, { allowLive: true });
    await lanes.wait((await lanes.start(input({ engineCommits: true }))).remoteId, 10_000);
    expect(started[0][1]).toMatchObject({ sandboxScope: 'factory', hostCommits: true });
  });

  it('without allowLive falls back to the env opt-in and refuses', async () => {
    const lanes = new CopilotLaneBackend(managerFor('idle'), { allowLive: false });
    await expect(lanes.start(input())).rejects.toThrow('OMG_COPILOT_RUN_ALLOW=1');
    expect(calls.connections).toHaveLength(0);
  });

  it('poll reports a running lane without a head; cancel ends it', async () => {
    const lanes = new CopilotLaneBackend(managerFor('hang'), { allowLive: true });
    const { remoteId } = await lanes.start(input());
    const running = await lanes.poll(remoteId);
    expect(isTerminalLaneState(running.state)).toBe(false);
    expect(running.headSha).toBeNull();
    const { supported, result } = await lanes.cancel(remoteId);
    expect(supported).toBe(true);
    expect(result.state).toBe('cancelled');
    expect(isTerminalLaneState(result.state)).toBe(true);
  });

  it('a handle the process no longer knows is lost', async () => {
    // A fresh manager stands in for the engine after a restart.
    const first = new CopilotLaneBackend(managerFor('idle'), { allowLive: true });
    const { remoteId } = await first.start(input());
    await first.wait(remoteId, 10_000);
    const restarted = new CopilotLaneBackend(managerFor('idle'), { allowLive: true });
    await expect(restarted.poll(remoteId)).rejects.toBeInstanceOf(LaneLostError);
    await expect(restarted.wait(remoteId, 10)).rejects.toBeInstanceOf(LaneLostError);
    await expect(restarted.cancel(remoteId)).rejects.toBeInstanceOf(LaneLostError);
  });

  it('a laneId that is not a ledger key refuses the start before a session', async () => {
    const lanes = new CopilotLaneBackend(managerFor('idle'), { allowLive: true });
    await expect(lanes.start(input({ laneId: 'team/worker 1' }))).rejects.toThrow('ledgerKey');
    expect(calls.connections).toHaveLength(0);
  });

  it('a bad baseRef refuses the start', async () => {
    const lanes = new CopilotLaneBackend(managerFor('idle'), { allowLive: true });
    await expect(lanes.start(input({ baseRef: '--upload-pack=x' }))).rejects.toThrow('not a valid ref');
  });
});
