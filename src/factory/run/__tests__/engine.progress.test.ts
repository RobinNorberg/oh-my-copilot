/**
 * Progress sync on GitHub (factory forges design §7, §9 PR 7): the engine
 * writes the run's stage as one `factory:<stage>` label through the real
 * factory guard, at most once per stage, and a tracker failure never changes
 * or blocks a transition.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseProgressLog } from '../../../lib/agent-progress.js';
import { runFactoryEngine } from '../engine.js';
import { assertFactoryCommand } from '../exec.js';
import { factoryProgressFile } from '../progress.js';
import {
  computeFactoryIntegrity, FACTORY_PHASES, parseFactoryState, readFactoryState, trackerStageOf, type FactoryPhase, type FactoryRunState,
} from '../state.js';
import { ISSUE } from './fake-lanes.js';
import { h, edits, clearEdits, useProgressHarness, opts, happy, added, expectExclusive, asEngine } from './engine-progress-harness.js';

useProgressHarness();

describe('trackerStageOf: the §7 phase / gate -> stage table', () => {
  const table: Record<FactoryPhase, string> = {
    intake: 'queued', plan: 'queued',
    implement: 'building', publish: 'building', fix: 'building', 'conflict-fix': 'building', 'ci-fix': 'building',
    review: 'reviewing',
    prepare: 'verifying', gates: 'verifying',
    merge: 'ready-to-merge',
    merged: 'done',
    failed: 'blocked',
    cancelled: 'cancelled',
  };

  it('maps every phase', () => {
    expect(Object.keys(table).sort()).toEqual([...FACTORY_PHASES].sort());
    for (const phase of FACTORY_PHASES) expect(trackerStageOf({ phase }), phase).toBe(table[phase]);
  });

  it('awaiting-human: merge is ready-to-merge; any other gate is blocked', () => {
    const gate = (name: string) => ({ name, reason: 'r', at: 'now' });
    expect(trackerStageOf({ phase: 'merge', gate: gate('merge') })).toBe('ready-to-merge');
    for (const phase of ['plan', 'review', 'gates', 'merge'] as const) {
      expect(trackerStageOf({ phase, gate: gate('needs-plan') })).toBe('blocked');
      expect(trackerStageOf({ phase, gate: gate('budget') })).toBe('blocked');
    }
  });
});

describe('trackerStage in the run state', () => {
  it('old states without the field still validate; an unknown stage is refused', async () => {
    await runFactoryEngine(opts(happy(), { forge: undefined }));
    const s = readFactoryState(h.root, ISSUE)!;
    expect(s.trackerStage).toBeUndefined();
    const seal = (x: FactoryRunState) => JSON.stringify({ ...x, integrity: computeFactoryIntegrity({ ...x, integrity: undefined }) });
    expect(() => parseFactoryState('state.json', ISSUE, seal({ ...s, trackerStage: 'shipping' } as unknown as FactoryRunState))).toThrow(/trackerStage/);
    expect(parseFactoryState('state.json', ISSUE, seal({ ...s, trackerStage: 'reviewing' })).trackerStage).toBe('reviewing');
  });
});

describe('the factory guard: gh issue edit with factory labels only', () => {
  const ok = (...r: string[]) => expect(() => assertFactoryCommand('gh', ['issue', 'edit', ...r])).not.toThrow();
  const refused = (...r: string[]) => expect(() => assertFactoryCommand('gh', ['issue', 'edit', ...r])).toThrow(/refuses/);

  it('allows the progress shapes', () => {
    ok('7', '--add-label', 'factory:building', '--remove-label', 'factory:queued', '--remove-label', 'factory:reviewing');
    ok('7', '--add-label', 'factory:queued');
    ok('7', '--remove-label', 'factory:queued', '--remove-label', 'factory:done');
  });

  it('refuses every other edit', () => {
    refused('7');
    refused('7', '--add-label', 'bug');
    refused('7', '--remove-label', 'factory-ready');
    refused('7', '--add-label', 'factory:a', '--add-label', 'factory:b');
    refused('7', '--remove-label', 'factory:a', '--add-label', 'factory:b');
    refused('7', '--add-label', 'factory:a', '--remove-label', 'factory:a');
    refused('7', '--add-label', 'factory:a,bug');
    refused('7', '--add-label', 'factory:A');
    refused('7', '--add-label');
    refused('7', '--title', 'x');
    refused('7', '--body-file', 'b.md');
    refused('7', '--add-assignee', 'me');
    refused('7', '--milestone', 'v1');
    refused('7', '--add-label', 'factory:a', '--repo', 'o/other');
    refused('x7', '--add-label', 'factory:a');
    refused('-R', 'o/r', '7', '--add-label', 'factory:a');
  });
});

describe('progress sync on GitHub (fake gh, real git, real guard)', () => {
  it('one exclusive label write per stage up to the merge gate, then done once merged', async () => {
    const out = await runFactoryEngine(opts(happy()));
    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    expect(added()).toEqual(['factory:queued', 'factory:building', 'factory:reviewing', 'factory:verifying', 'factory:ready-to-merge']);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('ready-to-merge');
    expectExclusive();

    h.gh.merged = true;
    const merged = await runFactoryEngine(opts([]));
    expect(merged.phase, merged.message).toBe('merged');
    expect(added().slice(5)).toEqual(['factory:done']);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('done');
    expectExclusive();

    const events = parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
    expect(events.filter((e) => e.phase === 'tracker-sync' && e.status === 'ok')).toHaveLength(6);
  });

  it('a crash after the label write and before trackerStage was recorded re-applies the stage once at resume', async () => {
    await runFactoryEngine(opts(happy()));
    expect(edits).toHaveLength(5);
    // The engine wrote factory:verifying, then died before recording it (and before the merge gate).
    asEngine(({ trackerStage: _t, gate: _g, ...s }) => ({ ...s, phase: 'gates', trackerStage: 'reviewing' }));
    clearEdits();

    const out = await runFactoryEngine(opts([]));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(added()).toEqual(['factory:verifying', 'factory:ready-to-merge']);

    // A resume whose recorded stage matches writes nothing.
    clearEdits();
    const again = await runFactoryEngine(opts([]));
    expect(again.gate?.name).toBe('merge');
    expect(edits).toEqual([]);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('ready-to-merge');
  });
});
