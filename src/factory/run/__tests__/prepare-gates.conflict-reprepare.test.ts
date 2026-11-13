/**
 * Gates -> prepare for a PR that conflicts with its moved base (n5-gatesconflict):
 * GitHub runs no CI on a CONFLICTING PR, so the gates would park at
 * missing-checks (or no-workflows) forever. The engine reads the forge's
 * mergeability at the gates entry and before those parks, and on a definite
 * conflict for the pushed head goes back to prepare (bounded per run).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { resolveShipConfig } from '../../../ship/config.js';
import { TRUSTED_READ_ENV } from '../../../ship/exec.js';
import { readShipState } from '../../../ship/state.js';
import { mergeTreeArgs } from '../../../forge/local/mirror.js';
import { assertFactoryCommand } from '../exec.js';
import { MAX_CONFLICT_REPREPARES, MERGEABILITY_READS } from '../engine.js';
import { factoryStatePath, readFactoryState } from '../state.js';
import { commitFile, gitIn, greenGates, ISSUE, PR, review, type LaneScript } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, moveBase, pushes, run, usePrepareGatesHarness } from './prepare-gates-harness.js';

vi.setConfig({ testTimeout: scaleTiming(90_000) });

usePrepareGatesHarness();

const MERGEABILITY_READ = `gh pr view ${PR} --json headRefOid,mergeable,mergeStateStatus`;
const reads = () => h.calls.filter((c) => c === MERGEABILITY_READ).length;

/** Required checks `Test` and `Lint` (Lint never reports: missing-checks) until `fixed()`, then just `Test`. */
function requiredUntil(fixed: () => boolean) {
  return () => ({ config: { ...resolveShipConfig(undefined), requiredChecks: fixed() ? ['Test'] : ['Test', 'Lint'], advisoryChecks: [] }, known: [] });
}

/** Run `fn` right before the `n`th mergeability read. */
function atRead(n: number, fn: () => void): void {
  let seen = 0;
  h.onCall = (call) => { if (call === MERGEABILITY_READ && ++seen === n) fn(); };
}

const conflictNotes = () => readFactoryState(h.root, ISSUE)!.history.filter((e) => e.from === 'gates' && e.to === 'prepare' && /conflicts with dev after it moved; preparing again/.test(e.note));

describe('gates: a PR that conflicts with its moved base goes back to prepare', () => {
  it('missing-checks with a CONFLICTING PR re-prepares; the base conflict goes to the conflict-fix lane, then gates green', async () => {
    h.gh.gates = [greenGates()];
    // Read 1: the gates entry (clean). Read 2: before the missing-checks park, the base just moved and conflicts.
    h.gh.mergeable = ['MERGEABLE', 'CONFLICTING', 'MERGEABLE'];
    let baseSha = '';
    atRead(2, () => { baseSha = moveBase('README.md', 'base side\n'); });
    const resolve: LaneScript = ({ worktree }) => {
      writeFileSync(join(worktree, 'README.md'), 'both sides\n');
      return { finalText: 'Merged.' };
    };
    const { lanes, done } = run([commitFile('README.md', 'lane side\n'), review('approve'), resolve, review('approve')], { gateConfig: requiredUntil(() => baseSha !== '') });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-conflict-fix-1`, `issue-${ISSUE}-review-2`]);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.conflictReprepares).toBe(1);
    expect(conflictNotes()).toHaveLength(1);
    expect(conflictNotes()[0].note).toContain(`(1 of ${MAX_CONFLICT_REPREPARES})`);
    expect(gitIn(h.root, 'merge-base', '--is-ancestor', baseSha, state.head!)).toBe('');
    expect(gitIn(h.root, 'show', `${state.head}:README.md`)).toBe('both sides');
    expect(readShipState(h.root, PR)!.history.some((e) => e.from === 'gates' && e.to === 'prepare')).toBe(true);
  });

  it('UNKNOWN is read again (GitHub computes it lazily) until CONFLICTING; a clean base merge needs no lane', async () => {
    h.gh.gates = [greenGates()];
    h.gh.mergeable = ['MERGEABLE', 'UNKNOWN', 'UNKNOWN', 'CONFLICTING', 'MERGEABLE'];
    let baseSha = '';
    atRead(2, () => { baseSha = moveBase('b.ts', 'base\n'); });
    const { lanes, done } = run([commitFile('a.ts'), review('approve')], { gateConfig: requiredUntil(() => baseSha !== '') });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started).toHaveLength(2);
    expect(reads()).toBe(5);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.conflictReprepares).toBe(1);
    expect(gitIn(h.root, 'merge-base', '--is-ancestor', baseSha, state.head!)).toBe('');
  });

  it('UNKNOWN that never settles keeps today\'s park (fail closed: no re-prepare on a guess)', async () => {
    h.gh.gates = [greenGates()];
    h.gh.mergeable = ['MERGEABLE', 'UNKNOWN'];
    const out = await run([commitFile('a.ts'), review('approve')], { gateConfig: requiredUntil(() => false) }).done;
    expect(out.gate?.name, out.message).toBe('missing-checks');
    expect(reads()).toBe(1 + MERGEABILITY_READS);
    expect(readFactoryState(h.root, ISSUE)!.conflictReprepares).toBeUndefined();
    expect(readShipState(h.root, PR)!.phase).toBe('gates');
  });

  it('a failed mergeability read keeps today\'s behaviour', async () => {
    h.gh.gates = [greenGates()];
    const inner = h.exec;
    const exec: typeof inner = (cmd, args, opts) => (cmd === 'gh' && args.join(' ') === MERGEABILITY_READ.slice(3) ? { status: 1, stdout: '', stderr: 'HTTP 502' } : inner(cmd, args, opts));
    const out = await run([commitFile('a.ts'), review('approve')], { exec, gateConfig: requiredUntil(() => false) }).done;
    expect(out.gate?.name, out.message).toBe('missing-checks');
    expect(readFactoryState(h.root, ISSUE)!.conflictReprepares).toBeUndefined();
  });

  it(`a PR that stays CONFLICTING re-prepares ${MAX_CONFLICT_REPREPARES} times, then parks at merge-conflicts; a rerun parks again without preparing`, async () => {
    h.gh.gates = [greenGates()];
    h.gh.mergeable = ['CONFLICTING'];
    const out = await run([commitFile('a.ts'), review('approve')]).done;
    expect(out.gate?.name, out.message).toBe('merge-conflicts');
    expect(out.gate?.reason).toContain(`again after ${MAX_CONFLICT_REPREPARES} re-prepares in this run`);
    expect(out.gate?.reason).toContain('merge dev into factory/issue-7 by hand and push, then rerun omg factory run 7');
    expect(readFactoryState(h.root, ISSUE)!.conflictReprepares).toBe(MAX_CONFLICT_REPREPARES);
    expect(conflictNotes()).toHaveLength(MAX_CONFLICT_REPREPARES);

    const pushesBefore = pushes().length;
    const again = await run([]).done;
    expect(again.gate?.name, again.message).toBe('merge-conflicts');
    expect(pushes()).toHaveLength(pushesBefore);
    expect(readFactoryState(h.root, ISSUE)!.conflictReprepares).toBe(MAX_CONFLICT_REPREPARES);
  });

  it('resume: a run parked at missing-checks re-enters gates, finds the PR CONFLICTING and prepares again', async () => {
    h.gh.gates = [greenGates()];
    h.gh.mergeable = ['MERGEABLE'];
    let fixed = false;
    const gateConfig = requiredUntil(() => fixed);
    const first = await run([commitFile('a.ts'), review('approve')], { gateConfig }).done;
    expect(first.gate?.name, first.message).toBe('missing-checks');
    const headBefore = readFactoryState(h.root, ISSUE)!.head!;

    const baseSha = moveBase('b.ts', 'base\n');
    h.gh.mergeable = ['CONFLICTING', 'MERGEABLE'];
    fixed = true;
    const again = await run([], { gateConfig }).done;
    expect(again.gate?.name, again.message).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.conflictReprepares).toBe(1);
    expect(state.head).not.toBe(headBefore);
    expect(gitIn(h.root, 'merge-base', '--is-ancestor', baseSha, state.head!)).toBe('');
  });

  it('the factory guard allows the mergeability reads (gh view fields; the local forge\'s merge-tree with the trusted-read env)', () => {
    expect(() => assertFactoryCommand('gh', ['pr', 'view', '545', '--json', 'headRefOid,mergeable,mergeStateStatus'])).not.toThrow();
    expect(() => assertFactoryCommand('git', mergeTreeArgs('a'.repeat(40), 'b'.repeat(40)), [], TRUSTED_READ_ENV)).not.toThrow();
  });

  it('a malformed conflictReprepares in the state file is refused on load', async () => {
    h.gh.gates = [greenGates()];
    h.gh.mergeable = ['MERGEABLE'];
    await run([commitFile('a.ts'), review('approve')], { gateConfig: requiredUntil(() => false) }).done;
    const file = factoryStatePath(h.root, ISSUE);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...raw, conflictReprepares: -1 }));
    expect(() => readFactoryState(h.root, ISSUE)).toThrow(/conflictReprepares/);
  });
});
