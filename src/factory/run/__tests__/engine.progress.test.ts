/**
 * Progress sync on GitHub (factory forges design §7, §9 PR 7): the engine
 * writes the run's stage as one `factory:<stage>` label through the real
 * factory guard, at most once per stage, and a tracker failure never changes
 * or blocks a transition.
 */
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultProgressStages } from '../../../forge/config.js';
import { PROGRESS_STAGES, type ResolvedForgeConfig } from '../../../forge/types.js';
import { parseProgressLog } from '../../../lib/agent-progress.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import { assertFactoryCommand } from '../exec.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { factoryProgressFile } from '../progress.js';
import {
  computeFactoryIntegrity,
  FACTORY_PHASES,
  parseFactoryState,
  readFactoryState,
  requestFactoryCancel,
  trackerStageOf,
  updateFactoryState,
  type FactoryPhase,
  type FactoryRunState,
} from '../state.js';
import { EngineLedger } from '../ledger.js';
import { commitFile, FakeLanes, FakeProcesses, harness, ISSUE, REPO_URL, review, testGateConfig, type Harness, type LaneScript } from './fake-lanes.js';

const FAMILY = PROGRESS_STAGES.filter((s) => s !== 'cancelled').map((s) => `factory:${s}`);

function githubConfig(progress: ResolvedForgeConfig['progress'] = { enabled: true, stages: defaultProgressStages('github') }): ResolvedForgeConfig {
  return {
    kind: 'github',
    repo: { kind: 'github', host: 'github.com', owner: 'o', name: 'r', url: REPO_URL },
    intake: { itemTypes: [], limit: 50, marker: 'factory-ready' },
    check: { maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20_000 },
    progress,
  };
}

let h: Harness;
/** The `gh issue edit` argv the engine ran (after the guard), one per tracker write. */
let edits: string[][];
/** Answer for each `gh issue edit`. */
let editResult: () => ExecResult;

beforeEach(() => {
  h = harness('omg-factory-progress-');
  edits = [];
  editResult = () => ({ status: 0, stdout: '', stderr: '' });
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

const exec: Exec = (cmd, args, opts) => {
  if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
    edits.push(args.slice(2));
    return editResult();
  }
  return h.exec(cmd, args, opts);
};

function opts(scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}): FactoryEngineOptions {
  return {
    root: h.root,
    issue: ISSUE,
    exec,
    lanes: new FakeLanes(h.root, scripts),
    limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
    base: 'dev',
    pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
    ledgerDir: h.ledgerDir,
    processes: new FakeProcesses(),
    gateConfig: testGateConfig,
    forge: { config: githubConfig(), options: factoryForgeOptions(h.root) },
    ...over,
  };
}

const happy = (): LaneScript[] => [commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')];

/** The label each write adds (null: a removal only). */
const added = () => edits.map((e) => (e[1] === '--add-label' ? e[2] : null));

/** Every write: issue ISSUE, the one stage label added and every other family label removed (mutually exclusive). */
function expectExclusive(): void {
  for (const e of edits) {
    expect(e[0]).toBe(String(ISSUE));
    const add = e[1] === '--add-label' ? e[2] : undefined;
    const removed = e.slice(add ? 3 : 1).filter((_, i) => i % 2 === 1);
    expect([...(add ? [add] : []), ...removed].sort()).toEqual([...FAMILY].sort());
  }
}

/** A state write the engine made (a crash simulated in the state). */
function asEngine(mutate: (s: FactoryRunState) => FactoryRunState): void {
  const l = EngineLedger.open(h.ledgerDir, h.root, ISSUE);
  updateFactoryState(h.root, ISSUE, (s) => mutate(s!), { onWrite: (p, c) => l.record(p, c) });
}

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
    edits = [];

    const out = await runFactoryEngine(opts([]));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(added()).toEqual(['factory:verifying', 'factory:ready-to-merge']);

    // A resume whose recorded stage matches writes nothing.
    edits = [];
    const again = await runFactoryEngine(opts([]));
    expect(again.gate?.name).toBe('merge');
    expect(edits).toEqual([]);
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('ready-to-merge');
  });

  it('a tracker write failure is warned and noted but never blocks or changes a transition', async () => {
    editResult = () => ({ status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' });
    const warnings: string[] = [];
    const out = await runFactoryEngine(opts(happy(), { warn: (m) => warnings.push(m) }));

    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.phase).toBe('merge');
    expect(state.trackerStage).toBeUndefined();
    // Each stage was tried once, no retries within the run.
    expect(added()).toEqual(['factory:queued', 'factory:building', 'factory:reviewing', 'factory:verifying', 'factory:ready-to-merge']);
    expect(state.history.filter((e) => e.note.startsWith('tracker-sync fail: '))).toHaveLength(5);
    expect(warnings.filter((w) => /could not set the tracker stage .* HTTP 403/.test(w))).toHaveLength(5);
    const events = parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
    expect(events.filter((e) => e.phase === 'tracker-sync' && e.status === 'fail')).toHaveLength(5);

    // A throwing tracker is the same failure.
    editResult = () => { throw new Error('spawn gh ENOENT'); };
    edits = [];
    const again = await runFactoryEngine(opts([]));
    expect(again.gate?.name).toBe('merge');
    expect(added()).toEqual(['factory:ready-to-merge']);
  });

  it('a missing label names omg factory setup, warned once per invocation, one history note per stage', async () => {
    editResult = () => ({ status: 1, stdout: '', stderr: "failed to update https://github.com/o/r/issues/7: 'factory:queued' not found\n" });
    const warnings: string[] = [];
    const out = await runFactoryEngine(opts(happy(), { warn: (m) => warnings.push(m) }));

    expect(out.gate?.name, out.message).toBe('merge');
    const hints = warnings.filter((w) => w.includes('omg factory setup'));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/progress label is missing in the repository \(failed to update .*'factory:queued' not found\); run omg factory setup/);
    const notes = readFactoryState(h.root, ISSUE)!.history.filter((e) => e.note.startsWith('tracker-sync fail: '));
    expect(notes.map((e) => e.note.split(':')[1].trim())).toEqual(['queued', 'building', 'reviewing', 'verifying', 'ready-to-merge']);
    expect(notes.every((e) => e.note.includes('run omg factory setup'))).toBe(true);
  });

  it('a crash after the merged save and before the done write: the resume writes done once', async () => {
    await runFactoryEngine(opts(happy()));
    // The engine saved merged, then died before the tracker write (trackerStage still ready-to-merge).
    asEngine(({ gate: _g, ...s }) => ({ ...s, phase: 'merged' }));
    edits = [];

    const out = await runFactoryEngine(opts([]));
    expect(out.phase, out.message).toBe('merged');
    expect(out.exitCode).toBe(0);
    expect(added()).toEqual(['factory:done']);
    expectExclusive();
    expect(readFactoryState(h.root, ISSUE)!.trackerStage).toBe('done');

    edits = [];
    expect((await runFactoryEngine(opts([]))).phase).toBe('merged');
    expect(edits).toEqual([]);
  });

  it('another gate is blocked; cancelled removes the whole family', async () => {
    h.gh.issue.body = 'please add greet';
    const out = await runFactoryEngine(opts([]));
    expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
    expect(out.gate?.name).toBe('needs-plan');
    expect(added()).toEqual(['factory:queued', 'factory:blocked']);
    expectExclusive();

    edits = [];
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
