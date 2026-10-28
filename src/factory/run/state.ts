/**
 * Persisted `omg factory run` state: `.omg/state/factory/run-<issue>.json`,
 * written with the ship pattern (src/ship/state.ts): read-modify-write under
 * the file lock, atomic write, sha256 `integrity` seal re-checked before every
 * update. A single-runner owner file `run-<issue>.owner` keeps two engines off
 * one issue. The seal is an unkeyed sha256 that anyone can recompute, so it
 * only catches accidental edits; the engine's defence against a lane that
 * rewrites the file is its own record of the bytes it wrote (ledger.ts).
 *
 * Phases (design §3): intake -> plan -> implement -> publish -> review ->
 * (fix -> publish -> review)* -> prepare -> gates -> merge -> merged, with
 * conflict-fix (prepare's base merge conflicts) and ci-fix (a real check
 * failure) going back through publish -> review. `gate` set means
 * awaiting-human: the phase is kept, and the next `omg factory run <issue>`
 * clears the gate and re-evaluates that phase. merged, cancelled and failed
 * are terminal.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { isProcessAlive } from '../../platform/process-utils.js';
import type { ShipVerdict } from '../../ship/state.js';

export const FACTORY_PHASES = [
  'intake', 'plan', 'implement', 'publish', 'review', 'fix', 'prepare', 'conflict-fix', 'gates', 'ci-fix', 'merge', 'merged', 'cancelled', 'failed',
] as const;
export type FactoryPhase = (typeof FACTORY_PHASES)[number];
export const TERMINAL_FACTORY_PHASES: readonly FactoryPhase[] = ['merged', 'cancelled', 'failed'];

/** Every lane kind except review is a write lane, and each is also the phase that runs it. */
export type FactoryLaneKind = 'implement' | 'review' | 'fix' | 'conflict-fix' | 'ci-fix';
export type FactoryLaneStatus = 'running' | 'completed' | 'failed' | 'lost' | 'cancelled';
export type FactoryLaneVerdict = 'approve' | 'changes-requested' | 'invalid';

export interface FactoryLaneRecord {
  id: string;
  kind: FactoryLaneKind;
  jobId?: string;
  /** The job's local Copilot child (pid and start identity), recorded at the first poll that reports it. */
  process?: { pid: number; identity: string | null };
  worktree?: string;
  startSha: string;
  endSha?: string;
  status: FactoryLaneStatus;
  /** The AI-credit cap the lane was started with. */
  maxCredits: number;
  /** AI Credits is the unit; premiumRequests is legacy, kept for older readers. */
  usage?: { credits: number; premiumRequests: number; source: 'measured' | 'estimated' };
  verdict?: FactoryLaneVerdict;
  /**
   * sha256 of the ship verdict the engine recorded from this lane
   * (shipVerdictHash), written before the ship state: a ship verdict is
   * adopted only when a review lane the engine ran carries its hash.
   */
  verdictHash?: string;
  note?: string;
  startedAt: string;
  endedAt?: string;
}

export interface FactoryGate {
  name: string;
  reason: string;
  at: string;
}

export interface FactoryFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file?: string;
  line?: number;
  summary: string;
}

export interface FactoryCiFailure {
  source: 'prepare' | 'ci';
  /** The commit the ci-fix lane starts at (prepare's checkout HEAD, or the PR head). */
  startSha: string;
  /** Failed prepare step or failed check names. */
  checks: string[];
  /** Failing test titles (`file > title`) read from the failed jobs' logs. */
  tests: string[];
  /** The failed prepare step's output tail. */
  detail?: string;
}

export interface FactoryHistoryEntry {
  at: string;
  from: FactoryPhase | null;
  to: FactoryPhase;
  note: string;
}

export interface FactoryRunState {
  version: 1;
  issue: number;
  repoUrl: string;
  base: string;
  branch: string;
  phase: FactoryPhase;
  gate?: FactoryGate;
  /** Issue snapshot taken at intake (title and body feed the lane prompts). */
  issueTitle?: string;
  issueBody?: string;
  /** `omg-plan: <repo path>` from the issue body, else the newest comment carrying one. */
  planLink?: string;
  plan?: { source: 'link' | 'issue-body'; path?: string; blob?: string; text: string };
  /** origin/<base> the implement lane started at. */
  baseSha?: string;
  pr?: number;
  implementer: string;
  /** Last head the engine pushed. */
  head?: string;
  /** A write lane's head waiting for publish. */
  pendingHead?: string;
  /** The last review's findings, fed to the next fix lane. */
  findings?: FactoryFinding[];
  /** Prepare's base merge conflicted outside inventory/: the files, fed to the conflict-fix lane. */
  conflicts?: string[];
  /** What the next ci-fix lane fixes: a prepare check or CI checks on the head. */
  ciFailure?: FactoryCiFailure;
  /** A prepare pushed `head` with these housekeeping commits; ship records them before gates. */
  prepared?: { head: string; housekeeping: string[] };
  /** merge -> gates returns so far; the cap holds across reruns. */
  mergeBounces?: number;
  /** The engine-owned prepare checkout's HEAD when the engine last left it. */
  checkoutHead?: string;
  /** Human-gate comments already posted (`<gate>@<sha12>` per target), so a rerun does not repeat them. */
  gateComments?: string[];
  lanes: FactoryLaneRecord[];
  /** Lane failures retried per phase key (`implement`, `review@<sha12>`, `fix@<round>`). */
  retries: Record<string, number>;
  /** Consecutive lost lanes per kind (a completed lane resets it). */
  lostStreak: Partial<Record<FactoryLaneKind, number>>;
  /** Wall time the engine spent on this run, across invocations. */
  elapsedMs: number;
  ciFixRounds: number;
  cancelRequested?: boolean;
  history: FactoryHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  integrity?: string;
}

export class FactoryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryStateError';
  }
}

export function implementerName(issue: number): string {
  return `factory-impl-${issue}`;
}

export function reviewerName(issue: number, jobId: string): string {
  return `factory-review-${issue}-${jobId}`;
}

export function factoryBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

export function factoryStateDir(root: string): string {
  return join(getOmcRoot(root), 'state', 'factory');
}

export function factoryStatePath(root: string, issue: number): string {
  return join(factoryStateDir(root), `run-${issue}.json`);
}

export function factoryOwnerPath(root: string, issue: number): string {
  return join(factoryStateDir(root), `run-${issue}.owner`);
}

/** `omg factory run cancel` drops this file; the engine alone writes the state file. */
export function factoryCancelPath(root: string, issue: number): string {
  return join(factoryStateDir(root), `run-${issue}.cancel`);
}

export function factoryCancelRequested(root: string, issue: number): boolean {
  return existsSync(factoryCancelPath(root, issue));
}

/** The hash a review lane record keeps of the ship verdict the engine recorded from it. */
export function shipVerdictHash(v: Pick<ShipVerdict, 'reviewer' | 'verdict' | 'sha' | 'at' | 'notes'>): string {
  return createHash('sha256').update(JSON.stringify([v.reviewer, v.verdict, v.sha, v.at, v.notes ?? null])).digest('hex');
}

export function createFactoryState(input: { issue: number; repoUrl: string; base: string }, now: string): FactoryRunState {
  return {
    version: 1,
    issue: input.issue,
    repoUrl: input.repoUrl,
    base: input.base,
    branch: factoryBranch(input.issue),
    phase: 'intake',
    implementer: implementerName(input.issue),
    lanes: [],
    retries: {},
    lostStreak: {},
    elapsedMs: 0,
    ciFixRounds: 0,
    history: [{ at: now, from: null, to: 'intake', note: `issue #${input.issue}` }],
    createdAt: now,
    updatedAt: now,
  };
}

/** Move to `to` (clearing any gate), appending history. Terminal phases never move. */
export function moveTo(state: FactoryRunState, to: FactoryPhase, note: string, now: string): FactoryRunState {
  if (TERMINAL_FACTORY_PHASES.includes(state.phase)) {
    throw new FactoryStateError(`factory run for issue #${state.issue} is ${state.phase}; it does not move to ${to}`);
  }
  const { gate: _gate, ...rest } = state;
  return { ...rest, phase: to, updatedAt: now, history: [...state.history, { at: now, from: state.phase, to, note }] };
}

/** Park at a named human gate; the phase stays so a rerun re-evaluates it. */
export function setGate(state: FactoryRunState, name: string, reason: string, now: string): FactoryRunState {
  return {
    ...state,
    gate: { name, reason, at: now },
    updatedAt: now,
    history: [...state.history, { at: now, from: state.phase, to: state.phase, note: `awaiting-human: ${name}: ${reason}` }],
  };
}

export function computeFactoryIntegrity(state: FactoryRunState): string {
  return createHash('sha256').update(JSON.stringify({ ...state, integrity: undefined })).digest('hex');
}

export function verifyFactoryIntegrity(state: FactoryRunState): boolean {
  return typeof state.integrity === 'string' && state.integrity === computeFactoryIntegrity(state);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function shapeProblem(s: Record<string, unknown>): string | null {
  if (!isStr(s.repoUrl) || !isStr(s.base) || !s.base || !isStr(s.branch) || !s.branch) return 'repoUrl/base/branch';
  if (!FACTORY_PHASES.includes(s.phase as FactoryPhase)) return 'phase';
  if (!isStr(s.implementer) || !s.implementer) return 'implementer';
  if (!Array.isArray(s.lanes) || !s.lanes.every((l) => {
    const x = l as Record<string, unknown>;
    return isStr(x?.id) && isStr(x.kind) && isStr(x.status) && isStr(x.startSha) && typeof x.maxCredits === 'number';
  })) return 'lanes';
  if (typeof s.retries !== 'object' || s.retries === null || !Object.values(s.retries).every(isCount)) return 'retries';
  if (typeof s.lostStreak !== 'object' || s.lostStreak === null) return 'lostStreak';
  if (typeof s.elapsedMs !== 'number' || !isCount(s.ciFixRounds)) return 'elapsedMs/ciFixRounds';
  if (!Array.isArray(s.history)) return 'history';
  if (!isStr(s.createdAt) || !isStr(s.updatedAt)) return 'createdAt/updatedAt';
  return null;
}

/** Read and shape-check the state file; throws FactoryStateError on malformed content. */
export function readFactoryState(root: string, issue: number): FactoryRunState | null {
  const path = factoryStatePath(root, issue);
  if (!existsSync(path)) return null;
  return parseFactoryState(path, issue, readFileSync(path, 'utf8'));
}

/** Parse and shape-check the bytes of a state file (read once by the caller). */
export function parseFactoryState(path: string, issue: number, raw: string): FactoryRunState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FactoryStateError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const s = parsed as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null || s.version !== 1 || s.issue !== issue) throw new FactoryStateError(`${path} is not a factory run state for issue #${issue}`);
  const problem = shapeProblem(s);
  if (problem) throw new FactoryStateError(`${path} is malformed (field ${problem})`);
  return parsed as FactoryRunState;
}

/**
 * Read-modify-write under the state file's lock; the result is sealed. A
 * stored state failing its integrity check is refused (the run is `failed`
 * for the engine; a human replaces the file).
 */
export function updateFactoryState(
  root: string,
  issue: number,
  mutate: (current: FactoryRunState | null) => FactoryRunState,
  options: {
    onWrite?: (path: string, content: string) => void;
    /**
     * Called under the lock with the exact bytes read (null: no file); throw
     * to refuse. `mutate` gets the state parsed from these same bytes, never
     * from a second read (the engine compares them with its ledger).
     */
    verify?: (bytes: Buffer | null) => void;
  } = {},
): FactoryRunState {
  if (!existsSync(join(root, '.git'))) throw new FactoryStateError(`${root} is not a git work tree; factory run state lives in the repo`);
  const path = factoryStatePath(root, issue);
  ensureDirSync(factoryStateDir(root));
  return withFileLockSync(lockPathFor(path), () => {
    const bytes = existsSync(path) ? readFileSync(path) : null;
    options.verify?.(bytes);
    const current = bytes === null ? null : parseFactoryState(path, issue, bytes.toString('utf8'));
    if (current && !verifyFactoryIntegrity(current)) {
      throw new FactoryStateError(`${path} fails its integrity check (edited outside omg factory run); the run is failed until a human replaces the file`);
    }
    const { sealed, content } = writeSealed(path, mutate(current));
    options.onWrite?.(path, content);
    return sealed;
  }, { timeoutMs: 5_000 });
}

function writeSealed(path: string, next: FactoryRunState): { sealed: FactoryRunState; content: string } {
  const sealed = { ...next, integrity: computeFactoryIntegrity(next) };
  // The exact bytes written, so the engine ledger can record them (ledger.ts).
  const content = JSON.stringify(sealed, null, 2);
  atomicWriteFileSync(path, content);
  return { sealed, content };
}

/**
 * Seal and write `state` without the lock and without reading the file: the
 * engine's park at state-tampered, which must not depend on the current
 * bytes (or a lock file) that an unconfirmed lane may still be rewriting.
 */
export function overwriteFactoryState(root: string, issue: number, state: FactoryRunState): { sealed: FactoryRunState; content: string } {
  ensureDirSync(factoryStateDir(root));
  return writeSealed(factoryStatePath(root, issue), state);
}

/**
 * `omg factory run cancel`: drop the cancel request file next to the state.
 * The state file stays engine-only (the engine ledger flags any other
 * writer); the returned state shows the request.
 */
export function requestFactoryCancel(root: string, issue: number, now: string): FactoryRunState {
  const current = readFactoryState(root, issue);
  if (!current) throw new FactoryStateError(`no factory run for issue #${issue}`);
  writeFileSync(factoryCancelPath(root, issue), `${JSON.stringify({ at: now })}\n`, 'utf8');
  return { ...current, cancelRequested: true };
}

export interface FactoryOwner {
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface OwnerDeps {
  pid: number;
  hostname: string;
  isAlive: (pid: number) => boolean;
}

export const defaultOwnerDeps = (): OwnerDeps => ({ pid: process.pid, hostname: hostname(), isAlive: isProcessAlive });

/**
 * Claim the single-runner owner file. A live owner (or one on another host,
 * whose pid cannot be checked) refuses; a dead pid on this host is taken
 * over, and `tookOver` names it for the history.
 */
export function acquireFactoryOwner(root: string, issue: number, now: string, deps: OwnerDeps = defaultOwnerDeps()): { release: () => void; tookOver?: FactoryOwner } {
  const path = factoryOwnerPath(root, issue);
  ensureDirSync(factoryStateDir(root));
  const tookOver = withFileLockSync(lockPathFor(path), () => {
    let prior: FactoryOwner | undefined;
    if (existsSync(path)) {
      try {
        prior = JSON.parse(readFileSync(path, 'utf8')) as FactoryOwner;
      } catch {
        prior = undefined;
      }
      if (prior && (prior.hostname !== deps.hostname || (prior.pid !== deps.pid && deps.isAlive(prior.pid)))) {
        throw new FactoryStateError(`omg factory run ${issue} is already running (pid ${prior.pid} on ${prior.hostname} since ${prior.startedAt})`);
      }
    }
    writeFileSync(path, `${JSON.stringify({ pid: deps.pid, hostname: deps.hostname, startedAt: now } satisfies FactoryOwner)}\n`, 'utf8');
    return prior;
  }, { timeoutMs: 5_000 });
  const release = () => {
    try {
      withFileLockSync(lockPathFor(path), () => {
        const owner = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FactoryOwner) : null;
        if (owner && owner.pid === deps.pid && owner.hostname === deps.hostname) unlinkSync(path);
      }, { timeoutMs: 5_000 });
    } catch { /* a stale owner file is taken over by the next run */ }
  };
  return { release, ...(tookOver ? { tookOver } : {}) };
}
