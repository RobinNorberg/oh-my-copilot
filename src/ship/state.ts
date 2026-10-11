/**
 * Persisted `omg ship` run state: `.omg/state/ship/<pr>.json`, written
 * atomically under the repo's file lock so a run survives restarts and two
 * processes never interleave updates.
 *
 * Phases: review (awaiting the first independent verdict) -> fix (changes
 * requested; a fresh agent fixes, then the reviewer re-verifies) -> prepare
 * (approved; mechanical housekeeping) -> gates (CI watch) -> ready -> merged.
 * blocked is entered when the fix-round budget is spent or prepare hits a
 * conflict it may not resolve.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJsonSync, ensureDirSync } from '../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot } from '../lib/worktree-paths.js';

export type ShipPhase = 'review' | 'fix' | 'prepare' | 'gates' | 'ready' | 'merged' | 'blocked';

export type VerdictKind = 'approve' | 'changes-requested';

export interface ShipVerdict {
  reviewer: string;
  verdict: VerdictKind;
  /** Full sha of the commit the reviewer was given. */
  sha: string;
  at: string;
  notes?: string;
}

export interface ShipHistoryEntry {
  at: string;
  from: ShipPhase | null;
  to: ShipPhase;
  note: string;
}

export interface ShipState {
  version: 1;
  pr: number;
  base: string;
  branch?: string;
  /** Lane that wrote the change; its verdicts are refused (no self-approval). */
  implementer: string;
  phase: ShipPhase;
  fixRounds: number;
  maxFixRounds: number;
  verdicts: ShipVerdict[];
  /** Commits `omg ship prepare` created (base merges, inventory regeneration). */
  housekeepingCommits: string[];
  /** Run id -> automatic reruns spent. */
  reruns: Record<string, number>;
  lastGates?: { verdict: string; at: string; failed: string[]; pending: string[] };
  blockedReason?: string;
  history: ShipHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<ShipPhase, readonly ShipPhase[]> = {
  review: ['fix', 'prepare', 'blocked'],
  fix: ['fix', 'prepare', 'blocked'],
  prepare: ['prepare', 'gates', 'fix', 'blocked'],
  gates: ['gates', 'ready', 'prepare', 'fix', 'blocked'],
  ready: ['ready', 'gates', 'prepare', 'fix', 'merged', 'blocked'],
  merged: [],
  blocked: [],
};

export class ShipStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShipStateError';
  }
}

export function canTransition(from: ShipPhase, to: ShipPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Move to `to`, appending history; throws ShipStateError on an illegal transition. */
export function transition(state: ShipState, to: ShipPhase, note: string, now: string): ShipState {
  if (!canTransition(state.phase, to)) {
    throw new ShipStateError(`illegal ship transition ${state.phase} -> ${to} for PR #${state.pr}`);
  }
  return { ...state, phase: to, updatedAt: now, history: [...state.history, { at: now, from: state.phase, to, note }] };
}

export function createShipState(input: { pr: number; base: string; branch?: string; implementer: string; maxFixRounds: number }, now: string): ShipState {
  return {
    version: 1,
    pr: input.pr,
    base: input.base,
    branch: input.branch,
    implementer: input.implementer,
    phase: 'review',
    fixRounds: 0,
    maxFixRounds: input.maxFixRounds,
    verdicts: [],
    housekeepingCommits: [],
    reruns: {},
    history: [{ at: now, from: null, to: 'review', note: `implementer ${input.implementer}` }],
    createdAt: now,
    updatedAt: now,
  };
}

function sameIdentity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Record an independent verdict. approve -> prepare; changes-requested ->
 * fix, or blocked once fixRounds would exceed maxFixRounds.
 */
export function recordVerdict(state: ShipState, verdict: ShipVerdict): ShipState {
  if (sameIdentity(verdict.reviewer, state.implementer)) {
    throw new ShipStateError(`reviewer ${verdict.reviewer} is the implementer; self-approval is refused`);
  }
  if (!/^[0-9a-f]{40}$/.test(verdict.sha)) throw new ShipStateError(`verdict sha must be a full 40-hex commit id, got ${verdict.sha}`);
  const withVerdict: ShipState = { ...state, verdicts: [...state.verdicts, verdict] };
  if (verdict.verdict === 'approve') {
    return transition(withVerdict, 'prepare', `approved by ${verdict.reviewer} at ${verdict.sha.slice(0, 12)}`, verdict.at);
  }
  const fixRounds = state.fixRounds + 1;
  if (fixRounds > state.maxFixRounds) {
    const blocked = transition({ ...withVerdict, fixRounds }, 'blocked', `fix round ${fixRounds} exceeds max ${state.maxFixRounds}`, verdict.at);
    return { ...blocked, blockedReason: `fix-round budget spent (${state.maxFixRounds}); escalate to a human` };
  }
  return transition({ ...withVerdict, fixRounds }, 'fix', `changes requested by ${verdict.reviewer} (round ${fixRounds}/${state.maxFixRounds})`, verdict.at);
}

export function latestVerdict(state: ShipState): ShipVerdict | undefined {
  return state.verdicts[state.verdicts.length - 1];
}

export function shipStatePath(repoRoot: string, pr: number): string {
  return join(getOmcRoot(repoRoot), 'state', 'ship', `${pr}.json`);
}

export function readShipState(repoRoot: string, pr: number): ShipState | null {
  const path = shipStatePath(repoRoot, pr);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ShipState;
  if (parsed?.version !== 1 || parsed.pr !== pr) throw new ShipStateError(`${path} is not a ship state for PR #${pr}`);
  return parsed;
}

/**
 * Read-modify-write under the state file's lock. `mutate` receives the
 * current state (null when none) and returns the next one.
 */
export function updateShipState(repoRoot: string, pr: number, mutate: (current: ShipState | null) => ShipState): ShipState {
  const path = shipStatePath(repoRoot, pr);
  ensureDirSync(join(path, '..'));
  return withFileLockSync(lockPathFor(path), () => {
    const next = mutate(readShipState(repoRoot, pr));
    atomicWriteJsonSync(path, next);
    return next;
  }, { timeoutMs: 5_000 });
}
