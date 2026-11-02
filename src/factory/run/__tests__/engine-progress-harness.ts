/**
 * The shared harness of the engine.progress*.test.ts files: progress sync on
 * GitHub through the real factory guard, with fake gh and real git.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, expect } from 'vitest';

import { defaultProgressStages } from '../../../forge/config.js';
import { PROGRESS_STAGES, type ResolvedForgeConfig } from '../../../forge/types.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import type { FactoryEngineOptions } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { updateFactoryState, type FactoryRunState } from '../state.js';
import { EngineLedger } from '../ledger.js';
import { commitFile, FakeLanes, FakeProcesses, harness, ISSUE, REPO_URL, review, testGateConfig, type Harness, type LaneScript } from './fake-lanes.js';

export const FAMILY = PROGRESS_STAGES.filter((s) => s !== 'cancelled').map((s) => `factory:${s}`);

export function githubConfig(progress: ResolvedForgeConfig['progress'] = { enabled: true, stages: defaultProgressStages('github') }): ResolvedForgeConfig {
  return {
    kind: 'github',
    repo: { kind: 'github', host: 'github.com', owner: 'o', name: 'r', url: REPO_URL },
    intake: { itemTypes: [], limit: 50, marker: 'factory-ready' },
    check: { maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20_000 },
    progress,
  };
}

export let h: Harness;
/** The `gh issue edit` argv the engine ran (after the guard), one per tracker write. */
export let edits: string[][];
/** Answer for each `gh issue edit`. */
export let editResult: () => ExecResult;

/** Answer every later `gh issue edit` with `result`. */
export function setEditResult(result: () => ExecResult): void {
  editResult = result;
}

/** Forget the edits recorded so far. */
export function clearEdits(): void {
  edits = [];
}

/** A fresh harness per test; call once at the top of each test file that uses it. */
export function useProgressHarness(): void {
  beforeEach(() => {
    h = harness('omg-factory-progress-');
    edits = [];
    editResult = () => ({ status: 0, stdout: '', stderr: '' });
  });

  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
  });
}

export const exec: Exec = (cmd, args, opts) => {
  if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
    edits.push(args.slice(2));
    return editResult();
  }
  return h.exec(cmd, args, opts);
};

export function opts(scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}): FactoryEngineOptions {
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

export const happy = (): LaneScript[] => [commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')];

/** The label each write adds (null: a removal only). */
export const added = () => edits.map((e) => (e[1] === '--add-label' ? e[2] : null));

/** Every write: issue ISSUE, the one stage label added and every other family label removed (mutually exclusive). */
export function expectExclusive(): void {
  for (const e of edits) {
    expect(e[0]).toBe(String(ISSUE));
    const add = e[1] === '--add-label' ? e[2] : undefined;
    const removed = e.slice(add ? 3 : 1).filter((_, i) => i % 2 === 1);
    expect([...(add ? [add] : []), ...removed].sort()).toEqual([...FAMILY].sort());
  }
}

/** A state write the engine made (a crash simulated in the state). */
export function asEngine(mutate: (s: FactoryRunState) => FactoryRunState): void {
  const l = EngineLedger.open(h.ledgerDir, h.root, ISSUE);
  updateFactoryState(h.root, ISSUE, (s) => mutate(s!), { onWrite: (p, c) => l.record(p, c) });
}
