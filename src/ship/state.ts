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

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../lib/atomic-write.js';
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
  /** Earlier runs for this PR replaced by `init --force`, oldest first. */
  previousRuns?: Array<Omit<ShipState, 'previousRuns'>>;
  /**
   * sha256 over the rest of the state, written by the engine on every update
   * and re-checked before every update and by `merge`. Detects hand edits; it
   * is not a signature (anyone can recompute it), so it is not tamper-proof.
   */
  integrity?: string;
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

/** sha256 of the state without its `integrity` field (key order as stored). */
export function computeIntegrity(state: ShipState): string {
  return createHash('sha256').update(JSON.stringify({ ...state, integrity: undefined })).digest('hex');
}

export function sealShipState(state: ShipState): ShipState {
  return { ...state, integrity: computeIntegrity(state) };
}

/** True when the stored integrity matches the content (false for a hand-edited or unsealed state). */
export function verifyShipIntegrity(state: ShipState): boolean {
  return typeof state.integrity === 'string' && state.integrity === computeIntegrity(state);
}

const PHASES: readonly ShipPhase[] = ['review', 'fix', 'prepare', 'gates', 'ready', 'merged', 'blocked'];
const isStr = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Structural check of a parsed state file; returns the first problem or null. */
function shapeProblem(s: Record<string, unknown>): string | null {
  if (!isStr(s.base) || !s.base) return 'base';
  if (s.branch !== undefined && !isStr(s.branch)) return 'branch';
  if (!isStr(s.implementer) || !s.implementer) return 'implementer';
  if (!PHASES.includes(s.phase as ShipPhase)) return 'phase';
  if (!isCount(s.fixRounds) || !isCount(s.maxFixRounds)) return 'fixRounds/maxFixRounds';
  if (!Array.isArray(s.verdicts) || !s.verdicts.every((v) => {
    const x = v as Record<string, unknown>;
    return isStr(x?.reviewer) && (x.verdict === 'approve' || x.verdict === 'changes-requested') && isStr(x.sha) && /^[0-9a-f]{40}$/.test(x.sha) && isStr(x.at);
  })) return 'verdicts';
  if (!Array.isArray(s.housekeepingCommits) || !s.housekeepingCommits.every((c) => isStr(c) && /^[0-9a-f]{40}$/.test(c))) return 'housekeepingCommits';
  if (typeof s.reruns !== 'object' || s.reruns === null || Array.isArray(s.reruns) || !Object.values(s.reruns).every(isCount)) return 'reruns';
  if (!Array.isArray(s.history) || !s.history.every((h) => {
    const x = h as Record<string, unknown>;
    return isStr(x?.at) && (x.from === null || PHASES.includes(x.from as ShipPhase)) && PHASES.includes(x.to as ShipPhase) && isStr(x.note);
  })) return 'history';
  if (!isStr(s.createdAt) || !isStr(s.updatedAt)) return 'createdAt/updatedAt';
  if (s.previousRuns !== undefined && (!Array.isArray(s.previousRuns) || !s.previousRuns.every((p) => {
    const x = p as Record<string, unknown>;
    return typeof p === 'object' && p !== null && !Array.isArray(p) && x.version === 1 && x.pr === s.pr
      && x.previousRuns === undefined && shapeProblem(x) === null;
  }))) return 'previousRuns';
  if (s.integrity !== undefined && !isStr(s.integrity)) return 'integrity';
  return null;
}

/** Read and shape-check the state file; throws ShipStateError on malformed content. */
export function readShipState(repoRoot: string, pr: number): ShipState | null {
  const path = shipStatePath(repoRoot, pr);
  if (!existsSync(path)) return null;
  return parseShipState(path, pr, readFileSync(path, 'utf8'));
}

/** Parse and shape-check the bytes of a ship state file (read once by the caller). */
export function parseShipState(path: string, pr: number, raw: string): ShipState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ShipStateError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const s = parsed as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null || s.version !== 1 || s.pr !== pr) throw new ShipStateError(`${path} is not a ship state for PR #${pr}`);
  const problem = shapeProblem(s);
  if (problem) throw new ShipStateError(`${path} is malformed (field ${problem})`);
  return parsed as ShipState;
}

export interface UpdateShipStateOptions {
  /** Hand the mutator a state whose integrity check fails (owner-only `init --force`). */
  allowUnverified?: boolean;
  /** Called with the exact bytes written (omg factory run records them in its engine ledger). */
  onWrite?: (path: string, content: string) => void;
  /**
   * Called under the lock with the exact bytes read (null: no file); throw to
   * refuse. `mutate` gets the state parsed from these same bytes, never from a
   * second read (omg factory run compares them with its engine ledger).
   */
  verify?: (bytes: Buffer | null) => void;
}

/**
 * Read-modify-write under the state file's lock. `mutate` receives the
 * current state (null when none) and returns the next one, which is sealed
 * with a fresh integrity hash. A stored state that fails its integrity check
 * (hand-edited) is refused unless `allowUnverified`. `repoRoot` must be a git
 * work tree: elsewhere the state root would resolve under the home directory.
 */
export function updateShipState(
  repoRoot: string,
  pr: number,
  mutate: (current: ShipState | null) => ShipState,
  options: UpdateShipStateOptions = {},
): ShipState {
  if (!existsSync(join(repoRoot, '.git'))) throw new ShipStateError(`${repoRoot} is not a git work tree; ship state lives in the repo`);
  const path = shipStatePath(repoRoot, pr);
  ensureDirSync(join(path, '..'));
  return withFileLockSync(lockPathFor(path), () => {
    const bytes = existsSync(path) ? readFileSync(path) : null;
    options.verify?.(bytes);
    const current = bytes === null ? null : parseShipState(path, pr, bytes.toString('utf8'));
    if (current && !options.allowUnverified && !verifyShipIntegrity(current)) {
      throw new ShipStateError(`${path} fails its integrity check (edited outside omg ship); an owner can replace it with OMG_SHIP_HUMAN=1 omg ship init ${pr} --force`);
    }
    const next = sealShipState(mutate(current));
    const content = JSON.stringify(next, null, 2);
    atomicWriteFileSync(path, content);
    options.onWrite?.(path, content);
    return next;
  }, { timeoutMs: 5_000 });
}
