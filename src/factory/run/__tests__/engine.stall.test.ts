import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderFactoryRunState } from '../../../cli/commands/factory.js';
import { resolveFactoryRunLimits } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { readFactoryState, type FactoryRunState } from '../state.js';
import { commitFile, FakeLanes, ISSUE, remoteHead, review, type LaneScript } from './fake-lanes.js';
import { h, useEngineHarness, limits, opts } from './engine-harness.js';

useEngineHarness();

const MIN = 60_000;

/**
 * A fake clock that moves one minute per running poll (FakeLanes.onRunningPoll),
 * and lanes whose session events come from `events(remoteId, poll)`.
 */
function stallRig(scripts: LaneScript[], polls: number[], events: (remoteId: string, poll: number) => string | null | undefined) {
  let t = Date.parse('2026-11-12T20:00:00.000Z');
  const lanes = new FakeLanes(h.root, scripts, polls);
  const seen = new Map<string, number>();
  lanes.onRunningPoll = (id) => { seen.set(id, (seen.get(id) ?? 0) + 1); t += MIN; };
  lanes.lastEventAt = (id) => events(id, seen.get(id) ?? 0);
  return { lanes, now: () => t };
}

describe('omg factory run: the lane no-progress timeout (factory.run.laneIdleMinutes)', () => {
  it('a lane that never emits an event is cancelled as stalled after the timeout; nothing is pushed and the lane fails', async () => {
    const { lanes, now } = stallRig([commitFile('a.ts')], [1000], () => null);
    const out = await runFactoryEngine(opts(lanes, { limits: limits({ laneIdleMs: 10 * MIN, maxRetries: 0 }), now }));
    expect(lanes.cancelled).toEqual(['cr-fake1']);
    expect(out.gate?.name).toBe('implement-failed');
    expect(out.gate?.reason).toMatch(/^lane issue-7-implement-1 ended failed: stalled: no session event \(tool call, message or usage\) for 10 min \(last event none since its start at /);
    expect(remoteHead(h)).toBeNull();
    const lane = readFactoryState(h.root, ISSUE)!.lanes[0];
    expect(lane.status).toBe('stalled');
    expect(lane.note).toMatch(/^stalled: /);
  });

  it('a stalled lane gets the normal fresh retry: the next lane runs and the run goes on', async () => {
    const { lanes, now } = stallRig([commitFile('a.ts'), commitFile('a.ts'), review('approve')], [1000], () => null);
    const out = await runFactoryEngine(opts(lanes, { limits: limits({ laneIdleMs: 10 * MIN }), now }));
    expect(lanes.started).toHaveLength(3);
    expect(out.gate?.name).toBe('merge');
    const s = readFactoryState(h.root, ISSUE)!;
    expect(s.lanes.map((l) => l.status)).toEqual(['stalled', 'completed', 'completed']);
    expect(s.history.some((e) => /stalled: .*fresh retry 1\/1/.test(e.note))).toBe(true);
  });

  it('a lane that keeps emitting keeps running past the idle timeout and completes', async () => {
    // 20 running polls, one minute each: twice the 10 min idle timeout, inside the 30 min wall time.
    const { lanes, now } = stallRig([commitFile('a.ts'), review('approve')], [20], (_id, poll) => new Date(Date.parse('2026-11-12T20:00:00.000Z') + poll * MIN).toISOString());
    const progressFile = join(h.dir, 'progress.log');
    const out = await runFactoryEngine(opts(lanes, { limits: limits({ laneIdleMs: 10 * MIN }), now, progressFile }));
    expect(lanes.cancelled).toEqual([]);
    expect(out.gate?.name).toBe('merge');
    const lane = readFactoryState(h.root, ISSUE)!.lanes[0];
    expect(lane.status).toBe('completed');
    // Persisted at most once a minute of event time: the last one seen.
    expect(lane.lastEventAt).toBe('2026-11-12T20:20:00.000Z');
    // The progress log's heartbeat names the lane's last event.
    expect(readFileSync(progressFile, 'utf8')).toMatch(/heartbeat.*lane issue-7-implement-1 running, last event 2026-11-12T20:\d\d:00\.000Z/);
  });

  it('a lane that goes quiet after an event names that event in the park text, and stays alive when its cancel is not confirmed', async () => {
    const last = '2026-11-12T20:02:00.000Z';
    const { lanes, now } = stallRig([commitFile('a.ts')], [1000], (_id, poll) => (poll >= 2 ? last : null));
    lanes.cancelFails = true;
    const out = await runFactoryEngine(opts(lanes, { limits: limits({ laneIdleMs: 5 * MIN }), now }));
    expect(out.gate?.name).toBe('lane-unconfirmed');
    expect(out.gate?.reason).toContain(`lane issue-7-implement-1 (cr-fake1) stalled: no session event (tool call, message or usage) for 5 min (last event ${last})`);
    const lane = readFactoryState(h.root, ISSUE)!.lanes[0];
    expect(lane.status).toBe('running');
    expect(lane.lastEventAt).toBe(last);
    expect(lane.note).toMatch(/its cancel was not confirmed/);
  });

  it('a backend that reports no event time is bounded by the wall time only', async () => {
    const { lanes, now } = stallRig([commitFile('a.ts'), review('approve')], [20], () => undefined);
    const out = await runFactoryEngine(opts(lanes, { limits: limits({ laneIdleMs: 5 * MIN }), now }));
    expect(lanes.cancelled).toEqual([]);
    expect(out.gate?.name).toBe('merge');
  });

  it('a lane that completes between the stall poll and the cancel, with a newer event, is a normal completion', async () => {
    const last = '2026-11-12T20:02:00.000Z';
    const done = '2026-11-12T20:09:30.000Z';
    // Quiet at `last` while polled; the cancel finds it completed, with an event after the one the engine saw.
    const rig = stallRig([commitFile('a.ts'), review('approve')], [1000], (id) => (rig.lanes.cancelled.includes(id) ? done : last));
    rig.lanes.cancelFinds = 'completed';
    const out = await runFactoryEngine(opts(rig.lanes, { limits: limits({ laneIdleMs: 5 * MIN, maxRetries: 0 }), now: rig.now }));
    expect(rig.lanes.cancelled).toEqual(['cr-fake1']);
    expect(rig.lanes.started).toHaveLength(2);
    expect(out.gate?.name).toBe('merge');
    const s = readFactoryState(h.root, ISSUE)!;
    expect(s.lanes.map((l) => l.status)).toEqual(['completed', 'completed']);
    expect(s.lanes[0].note ?? '').not.toMatch(/stalled/);
  });

  it('a completed cancel snapshot without a newer event stays a stall (fail closed)', async () => {
    const last = '2026-11-12T20:02:00.000Z';
    const rig = stallRig([commitFile('a.ts')], [1000], () => last);
    rig.lanes.cancelFinds = 'completed';
    const out = await runFactoryEngine(opts(rig.lanes, { limits: limits({ laneIdleMs: 5 * MIN, maxRetries: 0 }), now: rig.now }));
    expect(out.gate?.name).toBe('implement-failed');
    expect(remoteHead(h)).toBeNull();
    expect(readFactoryState(h.root, ISSUE)!.lanes[0].status).toBe('stalled');
  });
});

describe('factory.run.laneIdleMinutes', () => {
  it('defaults to 15 min, is set from the user config, and the project config can only lower it', () => {
    expect(resolveFactoryRunLimits(undefined, undefined).limits.laneIdleMs).toBe(15 * MIN);
    expect(resolveFactoryRunLimits({ factory: { run: { laneIdleMinutes: 40 } } }, undefined).limits.laneIdleMs).toBe(40 * MIN);
    expect(resolveFactoryRunLimits({ factory: { run: { laneIdleMinutes: 40 } } }, { factory: { run: { laneIdleMinutes: 5 } } }).limits.laneIdleMs).toBe(5 * MIN);
    const raised = resolveFactoryRunLimits(undefined, { factory: { run: { laneIdleMinutes: 60 } } });
    expect(raised.limits.laneIdleMs).toBe(15 * MIN);
    expect(raised.warnings.join('\n')).toMatch(/ignoring factory\.run\.laneIdleMinutes 60/);
  });

  it('refuses 0, a negative value and anything below 1 minute from either layer', () => {
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneIdleMinutes: 0 } } }, undefined)).toThrow(/laneIdleMinutes must be at least 1 \(got 0\)/);
    expect(() => resolveFactoryRunLimits(undefined, { factory: { run: { laneIdleMinutes: 0 } } })).toThrow(/laneIdleMinutes must be at least 1/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneIdleMinutes: -1 } } }, undefined)).toThrow(/non-negative/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneIdleMinutes: 0.5 } } }, undefined)).toThrow(/laneIdleMinutes must be at least 1 \(got 0\.5\)/);
    expect(() => resolveFactoryRunLimits(undefined, { factory: { run: { laneIdleMinutes: 0.01 } } })).toThrow(/laneIdleMinutes must be at least 1 \(got 0\.01\)/);
    expect(resolveFactoryRunLimits({ factory: { run: { laneIdleMinutes: 1 } } }, undefined).limits.laneIdleMs).toBe(MIN);
  });
});

describe('omg factory run status: stalled and running lanes', () => {
  const base = { issue: ISSUE, phase: 'implement', base: 'dev', branch: 'factory/issue-7', lanes: [], history: [], elapsedMs: 0 } as unknown as FactoryRunState;
  const lane = (over: Partial<FactoryRunState['lanes'][number]>) => ({ id: 'issue-7-implement-1', kind: 'implement' as const, startSha: 'a'.repeat(40), status: 'running' as const, maxCredits: 30, startedAt: '2026-11-12T20:00:00.000Z', ...over });

  it('names a running lane\'s last event time', () => {
    const text = renderFactoryRunState({ ...base, lanes: [lane({ lastEventAt: '2026-11-12T20:03:00.000Z' })] });
    expect(text).toContain('issue-7-implement-1 running credits -/30 last event 2026-11-12T20:03:00.000Z');
  });

  it('shows a stalled lane with its last event and why it stalled', () => {
    const note = 'stalled: no session event (tool call, message or usage) for 15 min (last event 2026-11-12T20:03:00.000Z)';
    const text = renderFactoryRunState({ ...base, lanes: [lane({ status: 'stalled', lastEventAt: '2026-11-12T20:03:00.000Z', note })] });
    expect(text).toContain('issue-7-implement-1 stalled credits -/30 last event 2026-11-12T20:03:00.000Z');
    expect(text).toContain(note);
  });

  it('leaves the last event out for an ended lane', () => {
    const text = renderFactoryRunState({ ...base, lanes: [lane({ status: 'completed', lastEventAt: '2026-11-12T20:03:00.000Z' })] });
    expect(text).not.toContain('last event');
  });
});
