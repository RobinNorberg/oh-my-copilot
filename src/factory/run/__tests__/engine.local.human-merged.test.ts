/**
 * The local forge: a stopped run whose PR a human merged on the base is recorded merged before any lane resumes,
 * and only when the base contains the head the engine pushed (the PR store alone is not trusted).
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runFactoryEngine } from '../engine.js';
import { EngineLedger } from '../ledger.js';
import { readFactoryState, updateFactoryState, type FactoryRunState } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');

/** A state write the engine made (recorded in its ledger). */
function asEngine(mutate: (s: FactoryRunState) => FactoryRunState): void {
  const l = EngineLedger.open(w.ledgerDir, w.root, LOCAL_ISSUE);
  updateFactoryState(w.root, LOCAL_ISSUE, (s) => mutate(s!), { onWrite: (p, c) => l.record(p, c) });
}

describe('factory run on the local forge: a human merge after the run stopped', () => {
  it('parked at fix-failed, then merged on the base: recorded merged, no lane starts; unmerged: the run resumes', async () => {
    w = localWorld();
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(first.gate?.name, first.message).toBe('merge');
    asEngine((s) => ({ ...s, phase: 'fix', gate: { name: 'fix-failed', reason: 'the lane left no changes', at: s.updatedAt } }));
    const head = readFactoryState(w.root, LOCAL_ISSUE)!.head!;

    gitIn(w.root, 'merge', '--no-ff', '--no-edit', head);
    const lanes = lanesFor(w, [greet()]);
    const out = await runFactoryEngine(localOpts(w, lanes));
    expect(out.phase, out.message).toBe('merged');
    expect(lanes.started).toHaveLength(0);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.history.at(-1)?.note).toBe('PR #1 merged by a human after awaiting-human: fix-failed');
  });

  it('cancelled and not merged on the base: stays cancelled', async () => {
    w = localWorld();
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(first.gate?.name, first.message).toBe('merge');
    asEngine((s) => {
      const { gate: _g, ...rest } = s;
      return { ...rest, phase: 'cancelled' };
    });
    const lanes = lanesFor(w, []);
    const out = await runFactoryEngine(localOpts(w, lanes));
    expect(out.phase, out.message).toBe('cancelled');
    expect(lanes.started).toHaveLength(0);
  });
});
