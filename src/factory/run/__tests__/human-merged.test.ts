import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Forge } from '../../../forge/types.js';
import type { Exec } from '../../../ship/exec.js';
import { createShipState, readShipState, transition, updateShipState } from '../../../ship/state.js';
import { forgePrStateReader, humanMergeCandidate, humanMergeLines, markMergedByHuman, recordHumanMerge, recordHumanMerges, type PrStateRead } from '../human-merged.js';
import { currentBytes, EngineLedger } from '../ledger.js';
import { acquireFactoryOwner, createFactoryState, factoryStatePath, readFactoryState, updateFactoryState, type FactoryRunState, type OwnerDeps } from '../state.js';

const ISSUE = 505;
const PR = 515;
const HEAD = 'a'.repeat(40);
const NOW = '2026-11-12T20:00:00.000Z';
const OWNER: OwnerDeps = { pid: 4242, hostname: 'test-host', isAlive: () => false };

let dir: string;
let root: string;
let ledgerDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-human-merged-'));
  root = join(dir, 'repo');
  ledgerDir = join(dir, 'ledger');
  mkdirSync(join(root, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ledger = () => EngineLedger.open(ledgerDir, root, ISSUE);

/** A run state written as the engine would (recorded in its ledger). */
function engineState(mutate: (s: FactoryRunState) => FactoryRunState): void {
  const l = ledger();
  updateFactoryState(root, ISSUE, () => mutate({ ...createFactoryState({ issue: ISSUE, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW), pr: PR, head: HEAD }), { onWrite: (p, c) => l.record(p, c) });
}

const cancelled = (s: FactoryRunState): FactoryRunState => ({ ...s, phase: 'cancelled' });
const fixFailed = (s: FactoryRunState): FactoryRunState => ({ ...s, phase: 'fix', gate: { name: 'fix-failed', reason: 'the lane left no changes', at: NOW } });

const reader = (state: 'OPEN' | 'MERGED' | 'CLOSED'): PrStateRead & { calls: number } => {
  const f = Object.assign(() => { f.calls += 1; return state; }, { calls: 0 });
  f.calls = 0;
  return f;
};
const opts = (readPrState: PrStateRead) => ({ readPrState, ledgerDir, now: () => NOW, owner: OWNER });

describe('humanMergeCandidate', () => {
  const base = { pr: PR } as const;
  it.each<[string, Pick<FactoryRunState, 'phase' | 'pr' | 'gate'>, boolean]>([
    ['cancelled with a PR', { ...base, phase: 'cancelled' }, true],
    ['failed with a PR', { ...base, phase: 'failed' }, true],
    ['parked with a PR', { ...base, phase: 'fix', gate: { name: 'fix-failed', reason: 'x', at: NOW } }, true],
    ['parked at a tamper park', { ...base, phase: 'fix', gate: { name: 'state-tampered', reason: 'x', at: NOW } }, false],
    ['running (no gate)', { ...base, phase: 'fix' }, false],
    ['already merged', { ...base, phase: 'merged' }, false],
    ['cancelled without a PR', { pr: undefined, phase: 'cancelled' }, false],
  ])('%s', (_name, s, want) => {
    expect(humanMergeCandidate(s)).toBe(want);
  });

  it('markMergedByHuman clears the gate and the cancel request and notes the previous state', () => {
    const s = markMergedByHuman({ ...fixFailed(createFactoryState({ issue: ISSUE, repoUrl: '', base: 'dev' }, NOW)), pr: PR, cancelRequested: true }, NOW);
    expect(s.phase).toBe('merged');
    expect(s.gate).toBeUndefined();
    expect(s.cancelRequested).toBeUndefined();
    expect(s.history.at(-1)).toEqual({ at: NOW, from: 'fix', to: 'merged', note: `PR #${PR} merged by a human after awaiting-human: fix-failed` });
  });
});

describe('recordHumanMerge (status, board, dashboard)', () => {
  it('cancelled + merged PR: recorded merged in the state and the engine ledger', () => {
    engineState(cancelled);
    const r = recordHumanMerge(root, ISSUE, opts(reader('MERGED')));
    expect(r.kind).toBe('merged');
    const s = readFactoryState(root, ISSUE)!;
    expect(s.phase).toBe('merged');
    expect(s.history.at(-1)?.note).toBe(`PR #${PR} merged by a human after cancelled`);
    const path = factoryStatePath(root, ISSUE);
    expect(ledger().matches(path, currentBytes(path))).toBe(true);
    expect(ledger().mismatches()).toEqual([]);
    expect(humanMergeLines([r])).toEqual([`run #${ISSUE}: PR #${PR} was merged by a human after cancelled; recorded the run as merged`]);
  });

  it('parked at fix-failed + merged PR: merged, gate cleared; ship follows when it is the engine\'s own', () => {
    engineState(fixFailed);
    const l = ledger();
    const ready = ['prepare', 'gates', 'ready'] as const;
    updateShipState(root, PR, () => ready.reduce((s, to) => transition(s, to, 'x', NOW), createShipState({ pr: PR, base: 'dev', implementer: 'factory-505', maxFixRounds: 3 }, NOW)), { onWrite: (p, c) => l.record(p, c) });
    const r = recordHumanMerge(root, ISSUE, opts(reader('MERGED')));
    expect(r.kind).toBe('merged');
    const s = readFactoryState(root, ISSUE)!;
    expect(s.phase).toBe('merged');
    expect(s.gate).toBeUndefined();
    expect(readShipState(root, PR)!.phase).toBe('merged');
    expect(ledger().mismatches()).toEqual([]);
  });

  it('a failed PR read changes nothing and says so', () => {
    engineState(cancelled);
    const r = recordHumanMerge(root, ISSUE, opts(() => { throw new Error('HTTP 502'); }));
    expect(r).toMatchObject({ kind: 'unchanged', readFailed: true });
    expect(readFactoryState(root, ISSUE)!.phase).toBe('cancelled');
    expect(humanMergeLines([r])).toEqual([`run #${ISSUE}: not checked for a human merge: PR #${PR} could not be read: HTTP 502`]);
  });

  it('a closed PR changes nothing and says so', () => {
    engineState(fixFailed);
    const r = recordHumanMerge(root, ISSUE, opts(reader('CLOSED')));
    expect(r.kind).toBe('closed');
    expect(readFactoryState(root, ISSUE)!.gate?.name).toBe('fix-failed');
    expect(humanMergeLines([r])[0]).toMatch(/was closed without merging; the run stays as it is/);
  });

  it('an open PR changes nothing and prints nothing', () => {
    engineState(cancelled);
    const r = recordHumanMerge(root, ISSUE, opts(reader('OPEN')));
    expect(r.kind).toBe('unchanged');
    expect(humanMergeLines([r])).toEqual([]);
  });

  it('a state that is not the engine\'s last write is not read on the forge or written', () => {
    engineState(cancelled);
    updateFactoryState(root, ISSUE, (s) => ({ ...s!, updatedAt: '2026-11-12T21:00:00.000Z' }));
    const read = reader('MERGED');
    const r = recordHumanMerge(root, ISSUE, opts(read));
    expect(r).toMatchObject({ kind: 'unchanged', reason: expect.stringMatching(/not the engine's last write/) });
    expect(read.calls).toBe(0);
    expect(readFactoryState(root, ISSUE)!.phase).toBe('cancelled');
  });

  it('a live engine on the run: nothing is written', () => {
    engineState(cancelled);
    const live: OwnerDeps = { pid: 4343, hostname: 'test-host', isAlive: () => true };
    const held = acquireFactoryOwner(root, ISSUE, NOW, live);
    try {
      const r = recordHumanMerge(root, ISSUE, { ...opts(reader('MERGED')), owner: { ...OWNER, isAlive: () => true } });
      expect(r).toMatchObject({ kind: 'unchanged', reason: expect.stringMatching(/an engine is running the run/) });
      expect(readFactoryState(root, ISSUE)!.phase).toBe('cancelled');
    } finally {
      held.release();
    }
  });

  it('recordHumanMerges reads only candidates', () => {
    engineState((s) => ({ ...s, phase: 'fix' }));
    const read = reader('MERGED');
    expect(recordHumanMerges(root, [[ISSUE, readFactoryState(root, ISSUE)!]], opts(read))).toEqual([]);
    expect(read.calls).toBe(0);
  });
});

describe('forgePrStateReader', () => {
  const run = (over: Partial<FactoryRunState>): FactoryRunState => ({ ...createFactoryState({ issue: ISSUE, repoUrl: '', base: 'dev' }, NOW), pr: PR, head: HEAD, ...over });
  const forge = (kind: Forge['kind'], state: string): Forge => ({ kind, reviews: { prHead: () => ({ headRefOid: HEAD, state }) } }) as unknown as Forge;
  const noGit: Exec = () => { throw new Error('no git expected'); };

  it('GitHub and Azure DevOps: the adapter\'s PR state', () => {
    expect(forgePrStateReader(forge('github', 'MERGED'), noGit, root)(run({}))).toBe('MERGED');
    expect(forgePrStateReader(forge('azure-devops', 'CLOSED'), noGit, root)(run({ forgeKind: 'azure-devops' }))).toBe('CLOSED');
    expect(() => forgePrStateReader(forge('github', 'WEIRD'), noGit, root)(run({}))).toThrow(/unknown state/);
  });

  it('the local forge: merged only when your base contains the pushed head (the store\'s MERGED alone is not trusted)', () => {
    const local = run({ remote: 'omg-local' as FactoryRunState['remote'] });
    const calls: string[][] = [];
    const git = (status: number): Exec => (cmd, args) => { calls.push([cmd, ...args]); return { status, stdout: '', stderr: '' }; };
    expect(forgePrStateReader(forge('local', 'OPEN'), git(0), root)(local)).toBe('MERGED');
    expect(calls[0]).toEqual(['git', 'merge-base', '--is-ancestor', HEAD, 'refs/heads/dev']);
    expect(forgePrStateReader(forge('local', 'MERGED'), git(1), root)(local)).toBe('OPEN');
    expect(forgePrStateReader(forge('local', 'CLOSED'), git(1), root)(local)).toBe('CLOSED');
    expect(() => forgePrStateReader(forge('local', 'OPEN'), git(128), root)(local)).toThrow(/merge-base/);
  });

  it('a run and a forge that disagree on the local forge: a read error', () => {
    expect(() => forgePrStateReader(forge('local', 'MERGED'), noGit, root)(run({}))).toThrow(/forge resolves to local/);
  });
});
