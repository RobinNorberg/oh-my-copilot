/**
 * Persisted `omg factory run` state: `.omg/state/factory/run-<key>.json`,
 * where the key is the issue number, or `heal-<sig8>` for a `ci-heal` run
 * (self-healing CI design §5: the plan is the validated diagnosis),
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
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync, withFileLockSync } from '../../lib/file-lock.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { getProcessStartIdentitySync, isProcessAlive } from '../../platform/process-utils.js';
import { stripAnsi } from '../../utils/string-width.js';
import type { CopilotRunSandboxState } from '../../copilot-run/sandbox.js';
import { sameRepo } from '../../ship/config.js';
import type { ShipVerdict } from '../../ship/state.js';
import { PROGRESS_STAGES, type ForgeKind, type ProgressStage } from '../../forge/types.js';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { codingAgentRecordProblem, type CodingAgentRunRecord } from './coding-agent-lane.js';

export const FACTORY_PHASES = [
  'intake', 'plan', 'implement', 'publish', 'review', 'fix', 'prepare', 'conflict-fix', 'gates', 'ci-fix', 'merge', 'merged', 'cancelled', 'failed',
] as const;
export type FactoryPhase = (typeof FACTORY_PHASES)[number];
export const TERMINAL_FACTORY_PHASES: readonly FactoryPhase[] = ['merged', 'cancelled', 'failed'];

/** `issue`: `omg factory run <issue>`; `ci-heal`: a self-heal run of one CI failure signature. */
export type FactoryRunKind = 'issue' | 'ci-heal';
/** An issue number, or `heal-<sig8>` for a ci-heal run (state, owner, ledger and checkout names). */
export type FactoryRunKey = number | `heal-${string}`;
export const HEAL_RUN_KEY = /^heal-[0-9a-f]{8}$/;
/** ci-heal human gates: a valid diagnosis waits for `omg factory heal approve`; an unusable one is human-only. */
export const HEAL_APPROVE_GATE = 'heal-approve';
export const HEAL_DIAGNOSIS_GATE = 'heal-diagnosis';

export function healRunKey(sig8: string): FactoryRunKey {
  const key = `heal-${sig8}` as const;
  if (!HEAL_RUN_KEY.test(key)) throw new FactoryStateError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
  return key;
}

/** Every lane kind except review is a write lane. Each but coding-agent is also the phase that runs it; a coding-agent lane runs in the implement phase. */
export type FactoryLaneKind = 'implement' | 'review' | 'fix' | 'conflict-fix' | 'ci-fix' | 'coding-agent';
export type FactoryLaneStatus = 'running' | 'completed' | 'failed' | 'lost' | 'cancelled';
export type FactoryLaneVerdict = 'approve' | 'changes-requested' | 'invalid';

export interface FactoryLaneRecord {
  id: string;
  kind: FactoryLaneKind;
  /** The ledger tag source (budget records); absent = `kind`. */
  role?: FactoryLaneKind;
  /** A fix lane started from human review feedback: the forge it came from and how many items it carried. */
  feedback?: { source: 'human'; forge: ForgeKind; items: number };
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
  /** The local job's OS sandbox as it ended (mode, host support, attestation; design §5); absent for remote lanes. */
  sandbox?: CopilotRunSandboxState;
  note?: string;
  /**
   * Whether the lane's stop is unconfirmed (its Copilot child may still run in
   * its worktree): true when the engine could not confirm it, false once the
   * engine or a human (`--lane-stopped`) confirmed it. Absent (older states,
   * other paths): run clean / reset read the note.
   */
  stopUnconfirmed?: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface FactoryGate {
  name: string;
  reason: string;
  at: string;
  /**
   * gate-definition-changed only: the sha256 of the parked head's gate
   * definition, the one definition `--allow-gate-change` may accept.
   */
  definition?: string;
}

export interface FactoryFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  /** The review axis of a two-axis review (the base has docs/standards/). */
  axis?: 'spec' | 'standards';
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
  /** The output tail: the failed prepare step's, or the local gate's (F43). */
  detail?: string;
}

export interface FactoryHistoryEntry {
  at: string;
  from: FactoryPhase | null;
  to: FactoryPhase;
  note: string;
}

/**
 * What a ci-heal run is built from, copied once at creation from the heal
 * signature state (whose out-of-repo seal the caller checked) and sealed
 * with the run. The diagnosis is lane output derived from untrusted CI logs:
 * only these validated fields reach a prompt or the PR body, always fenced.
 */
export interface FactoryHealRecord {
  sig8: string;
  /** The deterministic classifier's class. */
  class: string;
  firstRed: { runId: string; sha: string };
  lastGreen?: { runId: string; sha: string };
  /** `file > title` of the failing tests the classifier parsed. */
  failingTests: string[];
  env: Array<{ field: string; green?: string; red?: string }>;
  diagnosis: {
    class: string;
    rootCause: string;
    evidence: string[];
    reproduced: boolean;
    reproCommand?: string;
    fix: { summary: string; files: string[]; acceptance: string[] } | null;
  };
  /** Set by the engine at the plan step: a human ran `omg factory heal approve`, or factory.heal.autoImplement applied. */
  approved?: { at: string; by: 'human' | 'auto-implement' };
}

export interface FactoryRunState {
  version: 1;
  /** Absent in states written before ci-heal runs existed: `issue`. */
  kind?: FactoryRunKind;
  /** The issue number; 0 for a ci-heal run, which has no issue. */
  issue: number;
  heal?: FactoryHealRecord;
  /**
   * The forge the run started on (critic amendments §A.9). Absent in states
   * written before forges existed, which ran on GitHub; optional, so their
   * integrity seal still verifies.
   */
  forgeKind?: ForgeKind;
  /**
   * The git remote the run fetches from and pushes to. Absent = `origin`
   * (every GitHub and Azure DevOps run, and states written before the local
   * forge, whose seal still verifies); `omg-local` = the local forge's
   * engine-owned bare mirror. Sealed at creation, never changed.
   */
  remote?: typeof LOCAL_REMOTE;
  /**
   * The local forge only: the factory.forge.local.gate argv this run first
   * ran its gate with. Every later gate run must find the same argv in the
   * trusted config (local-gate.ts assertLocalGateCommand); absent until then.
   */
  localGate?: string[];
  /**
   * The local forge only: the sha256 of the gate definition (local-gate.ts
   * gateDefinition) a human accepted with `omg factory run
   * --allow-gate-change` after the run parked at gate-definition-changed on
   * it. A head whose definition hashes to it is not parked again; any other
   * change is.
   */
  gateChangeApproved?: string;
  /**
   * The trusted ship.prepare.checks this run first prepared with (`auto` =
   * unset, the built-ins the base has). Every later prepare must resolve the
   * same value; a change mid-run parks at prepare-checks. Absent until then.
   */
  prepareChecks?: string[][] | 'auto';
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
  plan?: { source: 'link' | 'issue-body' | 'heal-diagnosis'; path?: string; blob?: string; text: string };
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
  /** The checkout head a prepare left after the PR's code ran in the OS sandbox there (a local gate start failure on it parks at gate-no-verdict). */
  sandboxedPrepareHead?: string;
  /** The head the local gate last ran on in the OS sandbox (the command was handed over): a later gate start failure on it parks at gate-no-verdict. Optional: older state files lack it. */
  sandboxedGateHead?: string;
  /**
   * The name of the prepare checkout's admin dir under `<common>/worktrees/`,
   * as `worktree add` made it: a later invocation reads the checkout only
   * through that admin dir, never another one its `.git` file names.
   */
  checkoutAdmin?: string;
  /**
   * The last human feedback round consumed (sealed with the rest of the
   * state): when, at which head, the digest of what the fix lane got, and
   * the ids of the threads handed to it (at most MAX_HUMAN_THREAD_IDS).
   */
  humanReview?: { seenAt: string; head: string; digest: string; threadIds: string[] };
  /**
   * The head at which the human accepted, with `omg factory run
   * --allow-unsandboxed-lanes`, that write lanes ran without the enforced
   * sandbox (460-7); a new head parks again.
   */
  unsandboxedAck?: string;
  /**
   * The head whose prepare checks and local gate the human accepted to run
   * WITHOUT the OS sandbox (`omg factory run --allow-unsandboxed-gates` after
   * an awaiting-human: gates-unsandboxed park; factory.run.sandbox.gates
   * "ack", or "enforced" where the sandbox is unavailable). A prepare that
   * ran under it carries it to the head it prepared; any other head parks again.
   */
  unsandboxedGatesAck?: string;
  /**
   * A write lane's work the engine has not committed yet because its commit
   * parked (audit H3/L3): secret-shaped content (`secretFindings`), or a lane
   * process that survived the kill. The rerun after that park retries the
   * commit of the same worktree (no new lane is billed). `secretAck`: the
   * (path, kind) pairs the human accepted with `--allow-secret-shapes` for
   * THIS lane commit only; a new pair parks again.
   */
  pendingCommit?: FactoryPendingCommit;
  /**
   * Base calibrations of a check in the sandbox (sandbox-exec.ts), keyed by
   * the sha256 of the base sha and the check's argv: whether the command
   * passes in the sandbox on the trusted base itself, and its output tail.
   */
  gateCalibration?: Record<string, { ok: boolean; tail?: string }>;
  /** The Copilot coding agent session of an issue run whose implementer is the agent (coding-agent-lane.ts); sealed, shape-checked on load. */
  codingAgent?: CodingAgentRunRecord;
  /** Human-gate comments already posted (`<gate>@<sha12>` per target), so a rerun does not repeat them. */
  gateComments?: string[];
  /**
   * factory.run.layout "private" (item 2, private-run.ts): set once, when the
   * implement step sealed the base and created the run's private repository;
   * absent = the shared layout (layout 1, every run before it). A run keeps
   * the layout it started with: a resume never switches it.
   */
  layout?: 2;
  /** A private-layout run's dir `<work>/<repo8>/<slug>` (private-store.ts privateRunLayout). */
  privateDir?: string;
  /**
   * The engine's record of the private repository (sealed): the user
   * repository's common git dir resolved at run start, the config hash after
   * the engine's last own config write, the longest tracked path at the base,
   * and the number of the next import (refs/omg-import/<slug>/<n>).
   */
  privateStore?: { userGitDir: string; configHash: string; longestPath: number; nextImport: number };
  /**
   * The parents of `pendingHead` as the engine committed it (private layout:
   * the import's expectedParents, never read from the commit). Set and
   * cleared with pendingHead.
   */
  pendingParents?: string[];
  /**
   * The progress stage last written to the tracker (factory forges design §7);
   * absent until the first write succeeds, and in states written before
   * progress sync existed (optional, so their seal still verifies).
   */
  trackerStage?: ProgressStage;
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

/** Exit code of a run that did not start: another engine holds this checkout, the item's run or its claim (FactoryBusyError). */
export const EXIT_BUSY = 6;

/**
 * A live owner holds what the caller tried to claim: another engine in this
 * checkout, the item's own run, or the item's claim from another clone.
 * `omg factory run` exits EXIT_BUSY for it; nothing was touched.
 */
export interface FactoryPendingCommit {
  laneId: string;
  /** The phase retry key of the lane (implement, fix@<n>, ...). */
  key: string;
  start: string;
  parents: string[];
  worktree: string;
  branch: string | null;
  message: string;
  secretFindings?: { path: string; kind: string }[];
  secretAck?: { path: string; kind: string }[];
}

export class FactoryBusyError extends FactoryStateError {
  /** The holder's run key when a live owner file refused (`scan`: the poller's heal scan or base sync, or a read command's fetch). */
  readonly holderRun?: string;
  constructor(message: string, holderRun?: string) {
    super(message);
    this.name = 'FactoryBusyError';
    if (holderRun !== undefined) this.holderRun = holderRun;
  }
}

/** A tamper hold is set on the checkout (tamper-quarantine.ts): busy (exit 6) until `omg factory run release --tamper`. */
export class FactoryTamperHoldError extends FactoryBusyError {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryTamperHoldError';
  }
}

/** The run's key: its issue number, or `heal-<sig8>` for a ci-heal run. */
export function runKeyOf(s: Pick<FactoryRunState, 'kind' | 'issue' | 'heal'>): FactoryRunKey {
  return s.kind === 'ci-heal' ? `heal-${s.heal?.sig8 ?? ''}` : s.issue;
}

/** `issue-7` or `heal-0123abcd`: the prefix of lane ids and the prepare checkout's worker name. */
export const runSlug = (key: FactoryRunKey): string => (typeof key === 'number' ? `issue-${key}` : key);

/** `#7` or `heal-0123abcd`, for messages. */
export const runLabel = (key: FactoryRunKey): string => (typeof key === 'number' ? `#${key}` : key);

export function implementerName(key: FactoryRunKey): string {
  return `factory-impl-${key}`;
}

export function reviewerName(key: FactoryRunKey, jobId: string): string {
  return `factory-review-${key}-${jobId}`;
}

export function factoryBranch(key: FactoryRunKey): string {
  return typeof key === 'number' ? `factory/issue-${key}` : `factory/${key}`;
}

export function factoryStateDir(root: string): string {
  return join(getOmcRoot(root), 'state', 'factory');
}

export function factoryStatePath(root: string, key: FactoryRunKey): string {
  return join(factoryStateDir(root), `run-${key}.json`);
}

export function factoryOwnerPath(root: string, key: FactoryRunKey): string {
  return join(factoryStateDir(root), `run-${key}.owner`);
}

/** One engine (issue or ci-heal run) at a time per repository: its lanes and checkouts share the repo's git state. */
export function factoryRepoOwnerPath(root: string): string {
  return join(factoryStateDir(root), 'engine.owner');
}

/** `omg factory run cancel` and `omg factory heal cancel` drop this file; the engine alone writes the state file. */
export function factoryCancelPath(root: string, key: FactoryRunKey): string {
  return join(factoryStateDir(root), `run-${key}.cancel`);
}

export function factoryCancelRequested(root: string, key: FactoryRunKey): boolean {
  return existsSync(factoryCancelPath(root, key));
}

/** The hash a review lane record keeps of the ship verdict the engine recorded from it. */
export function shipVerdictHash(v: Pick<ShipVerdict, 'reviewer' | 'verdict' | 'sha' | 'at' | 'notes'>): string {
  return createHash('sha256').update(JSON.stringify([v.reviewer, v.verdict, v.sha, v.at, v.notes ?? null])).digest('hex');
}

export function createFactoryState(input: { issue: number; repoUrl: string; base: string; heal?: FactoryHealRecord; remote?: typeof LOCAL_REMOTE; itemNoun?: string }, now: string): FactoryRunState {
  const key = input.heal ? healRunKey(input.heal.sig8) : input.issue;
  return {
    version: 1,
    kind: input.heal ? 'ci-heal' : 'issue',
    issue: input.heal ? 0 : input.issue,
    ...(input.heal ? { heal: input.heal } : {}),
    ...(input.remote ? { remote: input.remote } : {}),
    repoUrl: input.repoUrl,
    base: input.base,
    branch: factoryBranch(key),
    phase: 'intake',
    implementer: implementerName(key),
    lanes: [],
    retries: {},
    lostStreak: {},
    elapsedMs: 0,
    ciFixRounds: 0,
    history: [{ at: now, from: null, to: 'intake', note: input.heal ? `ci-heal for CI signature ${input.heal.sig8}` : `${input.itemNoun ?? 'issue'} #${input.issue}` }],
    createdAt: now,
    updatedAt: now,
  };
}

/** Move to `to` (clearing any gate), appending history. Terminal phases never move. */
export function moveTo(state: FactoryRunState, to: FactoryPhase, note: string, now: string): FactoryRunState {
  if (TERMINAL_FACTORY_PHASES.includes(state.phase)) {
    throw new FactoryStateError(`factory run ${runLabel(runKeyOf(state))} is ${state.phase}; it does not move to ${to}`);
  }
  const { gate: _gate, ...rest } = state;
  return { ...rest, phase: to, updatedAt: now, history: [...state.history, { at: now, from: state.phase, to, note }] };
}

/** Park at a named human gate; the phase stays so a rerun re-evaluates it. */
export function setGate(state: FactoryRunState, name: string, reason: string, now: string, extra: Pick<FactoryGate, 'definition'> = {}): FactoryRunState {
  return {
    ...state,
    gate: { name, reason, at: now, ...extra },
    updatedAt: now,
    history: [...state.history, { at: now, from: state.phase, to: state.phase, note: `awaiting-human: ${name}: ${reason}` }],
  };
}

/**
 * The tracker progress stage of a run (factory forges design §7): a merge
 * gate or the merge phase is ready-to-merge, any other gate and failed are
 * blocked.
 */
export function trackerStageOf(s: Pick<FactoryRunState, 'phase' | 'gate'>): ProgressStage {
  if (s.gate) return s.gate.name === 'merge' ? 'ready-to-merge' : 'blocked';
  switch (s.phase) {
    case 'intake': case 'plan': return 'queued';
    case 'implement': case 'publish': case 'fix': case 'conflict-fix': case 'ci-fix': return 'building';
    case 'review': return 'reviewing';
    case 'prepare': case 'gates': return 'verifying';
    case 'merge': return 'ready-to-merge';
    case 'merged': return 'done';
    case 'cancelled': return 'cancelled';
    case 'failed': return 'blocked';
  }
}

export function computeFactoryIntegrity(state: FactoryRunState): string {
  return createHash('sha256').update(JSON.stringify({ ...state, integrity: undefined })).digest('hex');
}

export function verifyFactoryIntegrity(state: FactoryRunState): boolean {
  return typeof state.integrity === 'string' && state.integrity === computeFactoryIntegrity(state);
}

/**
 * Why a resume must refuse, or null (critic amendments §A.9): a config change
 * cannot swap adapters mid-run. A state without forgeKind ran on GitHub.
 * With `resolvedRepoUrl` (the forge config's repository), a run whose
 * recorded repoUrl names another repository (repoIdentity) refuses too.
 */
export function forgeResumeProblem(state: Pick<FactoryRunState, 'forgeKind' | 'issue' | 'kind' | 'heal' | 'repoUrl'>, resolved: ForgeKind, resolvedRepoUrl?: string): string | null {
  const recorded = state.forgeKind ?? 'github';
  const label = runLabel(runKeyOf(state));
  if (recorded !== resolved) return `factory run ${label} started on ${recorded}, but the forge now resolves to ${resolved}; finish or cancel the run before changing factory.forge`;
  if (resolvedRepoUrl !== undefined && state.repoUrl && !sameRepo(state.repoUrl, resolvedRepoUrl)) {
    return `factory run ${label} started in ${state.repoUrl}, but the forge now resolves to ${resolvedRepoUrl}; finish or cancel the run before changing the origin remote or factory.forge`;
  }
  return null;
}

/** The git remote of a run: `origin` unless the state seals the local forge's `omg-local`. */
export function runRemote(state: Pick<FactoryRunState, 'remote'>): string {
  return state.remote ?? 'origin';
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const HEX64 = /^[0-9a-f]{64}$/;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function shapeProblem(s: Record<string, unknown>): string | null {
  if (!isStr(s.repoUrl) || !isStr(s.base) || !s.base || !isStr(s.branch) || !s.branch) return 'repoUrl/base/branch';
  if (!FACTORY_PHASES.includes(s.phase as FactoryPhase)) return 'phase';
  if (!isStr(s.implementer) || !s.implementer) return 'implementer';
  if (s.kind !== undefined && s.kind !== 'issue' && s.kind !== 'ci-heal') return 'kind';
  if (s.forgeKind !== undefined && s.forgeKind !== 'github' && s.forgeKind !== 'azure-devops' && s.forgeKind !== 'local') return 'forgeKind';
  // The remote follows the forge: omg-local exactly on a local run, absent (origin) on every other.
  if (s.remote !== undefined ? s.remote !== LOCAL_REMOTE || s.forgeKind !== 'local' : s.forgeKind === 'local') return 'remote';
  if (s.localGate !== undefined && (s.forgeKind !== 'local' || !Array.isArray(s.localGate) || s.localGate.length === 0 || !s.localGate.every(isStr))) return 'localGate';
  if (s.gateChangeApproved !== undefined && (s.forgeKind !== 'local' || !isStr(s.gateChangeApproved) || !HEX64.test(s.gateChangeApproved))) return 'gateChangeApproved';
  const gateDef = (s.gate as { definition?: unknown } | undefined)?.definition;
  if (gateDef !== undefined && (s.forgeKind !== 'local' || !isStr(gateDef) || !HEX64.test(gateDef))) return 'gate.definition';
  if (s.prepareChecks !== undefined && s.prepareChecks !== 'auto' && !(Array.isArray(s.prepareChecks) && s.prepareChecks.every((a) => Array.isArray(a) && a.length > 0 && a.every(isStr)))) return 'prepareChecks';
  if (s.trackerStage !== undefined && !(PROGRESS_STAGES as readonly unknown[]).includes(s.trackerStage)) return 'trackerStage';
  if (s.codingAgent !== undefined && (s.kind === 'ci-heal' || codingAgentRecordProblem(s.codingAgent) !== null)) return 'codingAgent';
  // The private layout comes whole: layout 2, its run dir and the engine's record, or none of them.
  if (s.layout !== undefined || s.privateDir !== undefined || s.privateStore !== undefined) {
    const ps = s.privateStore as Record<string, unknown> | undefined;
    if (s.layout !== 2 || !isStr(s.privateDir) || !isAbsolute(s.privateDir) || typeof ps !== 'object' || ps === null
      || !isStr(ps.userGitDir) || !isAbsolute(ps.userGitDir) || !isStr(ps.configHash) || !HEX64.test(ps.configHash) || !isCount(ps.longestPath) || !isCount(ps.nextImport)) return 'layout';
  }
  if (s.pendingParents !== undefined && (!Array.isArray(s.pendingParents) || s.pendingParents.length === 0 || !s.pendingParents.every((x) => isStr(x) && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(x)))) return 'pendingParents';
  if (s.kind === 'ci-heal') {
    const h = s.heal as Record<string, unknown> | undefined;
    const d = h?.diagnosis as Record<string, unknown> | undefined;
    if (!isStr(h?.sig8) || !Array.isArray(h.failingTests) || !Array.isArray(h.env) || typeof d !== 'object' || d === null || !isStr(d.rootCause)) return 'heal';
  }
  if (!Array.isArray(s.lanes) || !s.lanes.every((l) => {
    const x = l as Record<string, unknown>;
    const sbx = x?.sandbox as Record<string, unknown> | undefined;
    return isStr(x?.id) && isStr(x.kind) && isStr(x.status) && isStr(x.startSha) && typeof x.maxCredits === 'number'
      && (x.stopUnconfirmed === undefined || typeof x.stopUnconfirmed === 'boolean')
      && (sbx === undefined || (typeof sbx === 'object' && sbx !== null && isStr(sbx.mode) && isCount(sbx.unsandboxedCalls)
        && (sbx.writeNetwork === undefined || sbx.writeNetwork === 'none' || sbx.writeNetwork === 'registry')));
  })) return 'lanes';
  if (typeof s.retries !== 'object' || s.retries === null || !Object.values(s.retries).every(isCount)) return 'retries';
  if (typeof s.lostStreak !== 'object' || s.lostStreak === null) return 'lostStreak';
  if (typeof s.elapsedMs !== 'number' || !isCount(s.ciFixRounds)) return 'elapsedMs/ciFixRounds';
  if (!Array.isArray(s.history)) return 'history';
  if (!isStr(s.createdAt) || !isStr(s.updatedAt)) return 'createdAt/updatedAt';
  return humanReviewShapeProblem(s);
}

// --- Human review fields (night 3 L2b): checked here, before the engine reads them -------------

const HEX40 = /^[0-9a-f]{40}$/;
/** Thread ids one human round may record: 100 review threads and 50 review bodies fit. */
export const MAX_HUMAN_THREAD_IDS = 200;
const THREAD_ID = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && v.length <= 200;
const FEEDBACK_FORGES: readonly unknown[] = ['github', 'azure-devops', 'local'];

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const findingsOk = (v: unknown): boolean => Array.isArray(v) && v.length <= 1000 && v.every((f) => {
  const r = f as Record<string, unknown> | null;
  return typeof r === 'object' && r !== null && isStr(r.path) && r.path.length <= 4096 && isStr(r.kind) && /^[a-z-]{1,40}$/.test(r.kind)
    && Object.keys(r).every((k) => k === 'path' || k === 'kind');
});

function pendingCommitShapeOk(v: unknown): boolean {
  const p = v as Record<string, unknown> | null;
  return typeof p === 'object' && p !== null && !Array.isArray(p)
    && isStr(p.laneId) && isStr(p.key) && isStr(p.start) && FULL_SHA.test(p.start)
    && Array.isArray(p.parents) && p.parents.length > 0 && p.parents.length <= 2 && p.parents.every((x) => isStr(x) && FULL_SHA.test(x))
    && isStr(p.worktree) && (p.branch === null || isStr(p.branch)) && isStr(p.message) && p.message.length <= 8000
    && (p.secretFindings === undefined || findingsOk(p.secretFindings)) && (p.secretAck === undefined || findingsOk(p.secretAck))
    && Object.keys(p).every((k) => ['laneId', 'key', 'start', 'parents', 'worktree', 'branch', 'message', 'secretFindings', 'secretAck'].includes(k));
}

/** `humanReview`, `unsandboxedAck` and every lane's `feedback`: absent, or exactly their shape. */
function humanReviewShapeProblem(s: Record<string, unknown>): string | null {
  const h = s.humanReview as Record<string, unknown> | undefined;
  if (h !== undefined && (typeof h !== 'object' || h === null || Array.isArray(h) || !isStr(h.seenAt) || !isStr(h.head) || !HEX40.test(h.head)
    || !isStr(h.digest) || !HEX64.test(h.digest) || (h.threadIds !== undefined && (!Array.isArray(h.threadIds) || h.threadIds.length > MAX_HUMAN_THREAD_IDS || !h.threadIds.every(THREAD_ID)))
    || Object.keys(h).some((k) => k !== 'seenAt' && k !== 'head' && k !== 'digest' && k !== 'threadIds'))) return 'humanReview';
  if (s.unsandboxedAck !== undefined && (!isStr(s.unsandboxedAck) || !HEX40.test(s.unsandboxedAck))) return 'unsandboxedAck';
  if (s.unsandboxedGatesAck !== undefined && (!isStr(s.unsandboxedGatesAck) || !HEX40.test(s.unsandboxedGatesAck))) return 'unsandboxedGatesAck';
  if (s.pendingCommit !== undefined && !pendingCommitShapeOk(s.pendingCommit)) return 'pendingCommit';
  if (s.sandboxedPrepareHead !== undefined && (!isStr(s.sandboxedPrepareHead) || !HEX40.test(s.sandboxedPrepareHead))) return 'sandboxedPrepareHead';
  if (s.sandboxedGateHead !== undefined && (!isStr(s.sandboxedGateHead) || !HEX40.test(s.sandboxedGateHead))) return 'sandboxedGateHead';
  // One admin dir name under <common>/worktrees (git makes it from the checkout's base name): no separator, nothing else.
  if (s.checkoutAdmin !== undefined && (!isStr(s.checkoutAdmin) || !/^[A-Za-z0-9._-]+$/.test(s.checkoutAdmin) || s.checkoutAdmin === '.' || s.checkoutAdmin === '..')) return 'checkoutAdmin';
  const cal = s.gateCalibration as Record<string, unknown> | undefined;
  if (cal !== undefined && (typeof cal !== 'object' || cal === null || Array.isArray(cal) || !Object.entries(cal).every(([k, v]) => {
    const e = v as Record<string, unknown> | null;
    return HEX64.test(k) && typeof e === 'object' && e !== null && typeof e.ok === 'boolean' && (e.tail === undefined || isStr(e.tail))
      && Object.keys(e).every((x) => x === 'ok' || x === 'tail');
  }))) return 'gateCalibration';
  const lanes = s.lanes as Array<Record<string, unknown>>;
  if (!lanes.every((l) => {
    const f = l.feedback as Record<string, unknown> | undefined;
    return f === undefined || (typeof f === 'object' && f !== null && !Array.isArray(f) && f.source === 'human' && FEEDBACK_FORGES.includes(f.forge)
      && isCount(f.items) && Object.keys(f).every((k) => k === 'source' || k === 'forge' || k === 'items') && l.kind === 'fix');
  })) return 'lanes.feedback';
  return null;
}

/** Read and shape-check the state file; throws FactoryStateError on malformed content. */
export function readFactoryState(root: string, key: FactoryRunKey): FactoryRunState | null {
  const path = factoryStatePath(root, key);
  if (!existsSync(path)) return null;
  return parseFactoryState(path, key, readFileSync(path, 'utf8'));
}

/** Parse and shape-check the bytes of a state file (read once by the caller). */
export function parseFactoryState(path: string, key: FactoryRunKey, raw: string): FactoryRunState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FactoryStateError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const s = parsed as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null || s.version !== 1 || typeof s.issue !== 'number') throw new FactoryStateError(`${path} is not a factory run state for ${runLabel(key)}`);
  const problem = shapeProblem(s);
  if (problem) throw new FactoryStateError(`${path} is malformed (field ${problem})`);
  if (runKeyOf(parsed as FactoryRunState) !== key) throw new FactoryStateError(`${path} is not a factory run state for ${runLabel(key)}`);
  // A humanReview sealed before thread ids were recorded handed none.
  const h = s.humanReview as Record<string, unknown> | undefined;
  if (h && h.threadIds === undefined) h.threadIds = [];
  return parsed as FactoryRunState;
}

/**
 * Read-modify-write under the state file's lock; the result is sealed. A
 * stored state failing its integrity check is refused (the run is `failed`
 * for the engine; a human replaces the file).
 */
export function updateFactoryState(
  root: string,
  key: FactoryRunKey,
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
  const path = factoryStatePath(root, key);
  ensureDirSync(factoryStateDir(root));
  return withFileLockSync(lockPathFor(path), () => {
    const bytes = existsSync(path) ? readFileSync(path) : null;
    options.verify?.(bytes);
    const current = bytes === null ? null : parseFactoryState(path, key, bytes.toString('utf8'));
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
export function overwriteFactoryState(root: string, key: FactoryRunKey, state: FactoryRunState): { sealed: FactoryRunState; content: string } {
  ensureDirSync(factoryStateDir(root));
  return writeSealed(factoryStatePath(root, key), state);
}

/**
 * `omg factory run cancel`: drop the cancel request file next to the state.
 * The state file stays engine-only (the engine ledger flags any other
 * writer); the returned state shows the request.
 */
export function requestFactoryCancel(root: string, key: FactoryRunKey, now: string): FactoryRunState {
  const current = readFactoryState(root, key);
  if (!current) throw new FactoryStateError(typeof key === 'number' ? `no factory run for issue #${key}` : `no factory run ${key}`);
  writeFileSync(factoryCancelPath(root, key), `${JSON.stringify({ at: now })}\n`, 'utf8');
  return { ...current, cancelRequested: true };
}

export interface FactoryOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  /** The run key (the repository owner file and a claim). */
  run?: string;
  /** The checkout the engine runs in (a claim only: it may be another clone). */
  root?: string;
  /** The owner process's start identity (getProcessStartIdentitySync) when it could be read: a reused pid does not hold the file. */
  identity?: string;
}

export interface OwnerDeps {
  pid: number;
  hostname: string;
  isAlive: (pid: number) => boolean;
  /** The start identity of a pid on this host (null: unknown). Absent: identities are neither written nor compared. */
  identityOf?: (pid: number) => string | null;
}

let ownIdentity: string | null | undefined;
/** getProcessStartIdentitySync (the reader the team runtime and the gate cleanup use); this process's own identity is read once. */
const startIdentity = (pid: number): string | null => {
  if (pid !== process.pid) return getProcessStartIdentitySync(pid);
  if (ownIdentity === undefined) ownIdentity = getProcessStartIdentitySync(pid);
  return ownIdentity;
};

export const defaultOwnerDeps = (): OwnerDeps => ({ pid: process.pid, hostname: hostname(), isAlive: isProcessAlive, identityOf: startIdentity });

/** Owner and claim file text is data: no terminal escape or control character reaches the terminal. */
export const ownerText = (v: unknown): string => stripAnsi(String(v)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');

/** `<run>, pid <pid> on <host> since <time>[ in <root>]`, every field through ownerText. */
export function describeOwner(o: Partial<FactoryOwner>): string {
  const pid = o.pid === undefined ? 'no live process' : `pid ${ownerText(o.pid)}`;
  return `${o.run === undefined ? 'run unknown' : ownerText(o.run)}, ${pid} on ${ownerText(o.hostname ?? 'unknown host')} since ${ownerText(o.startedAt ?? 'unknown')}${o.root ? ` in ${ownerText(o.root)}` : ''}`;
}

/**
 * A held owner file: release() removes it while it is still this process's
 * (false: the release failed, a warning naming the lock was printed, and the
 * file stays until a retry or until this process exits); relabel() rewrites
 * its run field (`run --next` once it picked an item).
 */
export interface HeldOwner {
  release: () => boolean;
  relabel: (run: string) => void;
  tookOver?: FactoryOwner;
}

/** tryScanLock's hold: `importLock` when it also took the import lock (a slot was held); pass it to withRepoImportLock's `held`. */
export interface ScanHold extends HeldOwner {
  importLock?: HeldOwner;
}

/**
 * Claim the single-runner owner file. A live owner (or one on another host,
 * whose pid cannot be checked) refuses; a dead pid on this host is taken
 * over, and `tookOver` names it for the history.
 */
export function acquireFactoryOwner(root: string, key: FactoryRunKey, now: string, deps: OwnerDeps = defaultOwnerDeps()): HeldOwner {
  return claimOwner(factoryOwnerPath(root, key), now, deps, (prior) => `omg factory run ${key} is already running (pid ${ownerText(prior.pid)} on ${ownerText(prior.hostname)} since ${ownerText(prior.startedAt)})`);
}

/**
 * Claim the repository's engine owner file (factoryRepoOwnerPath) for `key`
 * like acquireFactoryOwner: a second engine on the same repository refuses
 * instead of tripping the first one's shared git state checks. `next`:
 * `omg factory run --next` before it picked an item (then relabel()).
 * `scan`: a step that fetches or moves refs without starting a run (the
 * poller's heal tick and local base sync, `omg factory heal scan`).
 */
export function acquireFactoryRepoOwner(root: string, key: FactoryRunKey | 'next' | 'scan', now: string, deps: OwnerDeps = defaultOwnerDeps()): HeldOwner {
  const held = claimOwner(factoryRepoOwnerPath(root), now, deps, (prior) => engineBusyMessage(prior, root, String(key)), { run: String(key), root: resolve(root) });
  if (key === 'scan') return held;
  // B2: a shared-layout engine (or any start that takes this lock) never runs next to private parallel runs. The lock
  // is taken first, then the slots are read; a parallel run takes its slot first, then reads this lock: two racing
  // starts may both refuse, never both run.
  const live = heldSlots(root, deps);
  if (live.length === 0) return held;
  held.release();
  throw new FactoryBusyError(`${live.length} private-layout parallel run(s) are active in this checkout (${live.map(slotText).join('; ')}); a run that takes this checkout's engine lock (the shared layout, factory.run.maxConcurrent 1, reset, clean of a shared run, heal) starts after they end (omg factory run status lists them)`);
}

// --- B2: parallel private-layout runs (design i23 5/8) -----------------------------------------------------------
//
// LOCK ORDER (every holder takes them in this order and never waits for an earlier one while holding a later one):
//   1. engine.owner (a shared-layout engine, or `scan`: the poller's heal scan / base sync, a read command's fetch,
//      clean of a private run) or a slot (slots/slot-<i>.owner: a private-layout parallel engine); never both;
//   2. the run's owner file run-<key>.owner, then <run dir>/run.lock (private layout);
//   3. import.lock (repository import lock: fetches into your repository, the seed fetch, import + push);
//   4. the per-repository seed lock under the work root (<work>/<repo8>/import.lock; shared by every checkout of it);
//   5. short file locks (owner-file locks, the credit reservation file, the local forge's store).
// A slot holder only READS engine.owner (waiting out a `scan` holder before it holds anything else), and a `scan`
// holder takes import.lock only while a slot is held; so a scan waits for an import, never the other way round.
// Claims of run-<key>.owner (2) never wait: a held one is busy at once (claimOwner behind a short file lock),
// so no holder of a later lock ever waits on one. `--next`'s pick takes the item's owner file after its import-lock
// section (the base fetch) ended, never inside it (review-487 M-4). The import-lock waits are awaited where the
// caller can await (acquireImportLockAsync: signals run while waiting); a synchronous wait remains only in sync
// paths (clean, the poller's scan, a section reached from sync code), bounded as below.

/** The slot owner files of private-layout parallel runs (factory.run.maxConcurrent). */
export function factorySlotsDir(root: string): string {
  return join(factoryStateDir(root), 'slots');
}

export function factorySlotPath(root: string, slot: number): string {
  return join(factorySlotsDir(root), `slot-${slot}.owner`);
}

/** The repository import lock (an owner record): held only around git transport into or out of your repository. */
export function factoryImportLockPath(root: string): string {
  return join(factoryStateDir(root), 'import.lock');
}

const SLOT_FILE = /^slot-(\d+)\.owner$/;

/** One slot file a live (or unreadable) holder has: unreadable counts as held. */
export interface HeldSlotView {
  slot: number;
  path: string;
  owner: FactoryOwner | 'unreadable';
}

const slotText = (s: HeldSlotView): string => `slot ${s.slot}: ${s.owner === 'unreadable' ? `unreadable (${s.path}; omg factory run release)` : describeOwner(s.owner)}`;

/** Every slot file a live holder holds or nobody can read, whatever maxConcurrent is now (a lowered value never hides a live run). */
export function heldSlots(root: string, deps: OwnerDeps = defaultOwnerDeps()): HeldSlotView[] {
  let names: string[];
  try {
    names = readdirSync(factorySlotsDir(root));
  } catch {
    return [];
  }
  const out: HeldSlotView[] = [];
  for (const name of names) {
    const m = SLOT_FILE.exec(name);
    if (!m) continue;
    const path = join(factorySlotsDir(root), name);
    const owner = ownerHolding(path, deps);
    if (owner !== null) out.push({ slot: Number(m[1]), path, owner });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** A held slot: the owner file of slot `slot`. */
export interface HeldSlot extends HeldOwner {
  slot: number;
}

/**
 * Take one of `max` slots for `key` (claimOwner records: identity, takeover
 * of a dead holder, unreadable = held), then make sure no shared-layout
 * engine holds this checkout's engine lock: a `scan` holder is waited out
 * for at most `scanWaitMs`; any other live holder (or an unreadable file)
 * gives the slot back and is busy. No free slot: FactoryBusyError (exit 6)
 * "N runs active (maxConcurrent N)" with the holders.
 */
export function acquireRunSlot(root: string, key: FactoryRunKey | 'next', max: number, now: () => string, deps: OwnerDeps = defaultOwnerDeps(), scanWaitMs: number = SCAN_WAIT_MS): HeldSlot {
  if (!Number.isInteger(max) || max < 1) throw new FactoryStateError(`factory.run.maxConcurrent must be a positive integer (got ${String(max)})`);
  let held: HeldOwner | undefined;
  let slot = -1;
  const busy: string[] = [];
  for (let i = 0; i < max && !held; i++) {
    try {
      held = claimOwner(factorySlotPath(root, i), now(), deps, (prior) => `slot ${i}: ${describeOwner(prior)}`, { run: String(key), root: resolve(root) });
      slot = i;
    } catch (error) {
      if (!(error instanceof FactoryBusyError)) throw error;
      busy.push(error.message.startsWith('slot ') ? error.message : `slot ${i}: ${error.message}`);
    }
  }
  if (!held) throw new FactoryBusyError(`${max} runs active (factory.run.maxConcurrent ${max}): ${busy.join('; ')}; start this one after one of them ends (omg factory run status)`);
  const start = scanWait.clock();
  for (;;) {
    const path = factoryRepoOwnerPath(root);
    const h = ownerHolding(path, deps);
    if (h === null) return { ...held, slot };
    const waited = scanWait.clock() - start;
    if (h !== 'unreadable' && h.run === 'scan' && waited < scanWaitMs) {
      scanWait.sleep(Math.min(SCAN_POLL_MS, scanWaitMs - waited));
      continue;
    }
    held.release();
    if (h === 'unreadable') throw new FactoryBusyError(unreadableOwnerMessage(path));
    throw new FactoryBusyError(h.run === 'scan'
      ? `${engineBusyText(h)} (waited ${Math.round(waited / 1000)} s)`
      : `a shared-layout run holds this checkout's engine lock (${describeOwner(h)}); private parallel runs start after it ends (a run started in the shared layout keeps it: there is no migration)`, h.run === 'scan' ? 'scan' : undefined);
  }
}

/** How long an engine waits for another engine's import, fetch or push (sized for a first seed fetch or a slow push of a big repository). */
export const IMPORT_LOCK_WAIT_MS = 15 * 60_000;
/** How long a scan holder (poll, read commands, clean of a private run) waits for an import in flight. */
export const IMPORT_LOCK_SCAN_WAIT_MS = 60_000;

/** The busy error of the import lock: the holder and how long it waited; FactoryBusyError.holderRun is `import`. */
export class ImportLockBusyError extends FactoryBusyError {
  constructor(message: string) {
    super(message, 'import');
    this.name = 'ImportLockBusyError';
  }
}

/**
 * Take the repository import lock (factoryImportLockPath) for `label`
 * (`import:<key>`, `scan`): a claimOwner record, so a holder whose process
 * is gone (pid dead, or reused: start identity) is taken over at once and a
 * live holder is never taken over, however long it holds (no age rule: a
 * slow push or a first seed fetch of a big repository keeps it). A live
 * holder is waited for at most `waitMs`, then ImportLockBusyError; an
 * unreadable file is busy at once (a human removes it: omg factory run release).
 */
export function acquireImportLock(root: string, label: string, now: () => string, deps: OwnerDeps = defaultOwnerDeps(), waitMs: number = IMPORT_LOCK_WAIT_MS): HeldOwner {
  const start = scanWait.clock();
  for (;;) {
    const r = tryImportLock(root, label, now, deps, scanWait.clock() - start, waitMs);
    if ('held' in r) return r.held;
    scanWait.sleep(r.sleepMs);
  }
}

/** One attempt: the held lock, or how long to sleep before the next (ImportLockBusyError past `waitMs` or for an unreadable file). */
function tryImportLock(root: string, label: string, now: () => string, deps: OwnerDeps, waited: number, waitMs: number): { held: HeldOwner } | { busy: string; sleepMs: number } {
  const path = factoryImportLockPath(root);
  const key = `${resolve(path)}\0${deps.pid}`;
  // Review-487 L-4: this process holding it already (a hold not passed in explicitly) is never taken over (claimOwner
  // takes a record of its own pid over): the nested section would run unlocked. It refuses instead.
  if (importHeld.has(key)) throw new FactoryStateError(`this process already holds the repository import lock ${path}; a nested section must be given that hold (withRepoImportLock's held option)`);
  try {
    const held = claimOwner(path, now(), deps, (prior) => `the repository import lock ${path} is held by ${describeOwner(prior)} (another run fetches, imports or pushes)`, { run: label, root: resolve(root) });
    importHeld.add(key);
    let released = false;
    return { held: { ...held, release: () => { if (!released) { released = true; importHeld.delete(key); } return held.release(); } } };
  } catch (error) {
    if (!(error instanceof FactoryBusyError)) throw error;
    if (error.message.startsWith('the owner file ') || waited >= waitMs) {
      throw new ImportLockBusyError(`${error.message}; waited ${Math.round(waited / 1000)} s: rerun when it is done (omg factory run status names the holder)`);
    }
    return { busy: error.message, sleepMs: Math.min(SCAN_POLL_MS, waitMs - waited) };
  }
}

/** The import locks this process holds (path and owner pid; acquired, not released): a second acquisition by the same pid refuses. */
const importHeld = new Set<string>();
/** The import lock paths a synchronous section of this process runs inside right now (set only for that call, never across an await). */
const importInside = new Set<string>();

/**
 * Run `fn` (synchronous: it is never held across an await, so never across
 * a lane or a gate) under the repository import lock (acquireImportLock).
 * Re-entrant inside the synchronous call of an outer withRepoImportLock of
 * this process only. `held`: the caller already holds the lock (a scan
 * hold, an awaited acquireImportLockAsync); `fn` runs inside it and the
 * caller releases it (review-487 L-4: no process-wide flag across awaits).
 */
export function withRepoImportLock<T>(root: string, label: string, fn: () => T, o: { deps?: OwnerDeps; waitMs?: number; now?: () => string; held?: HeldOwner } = {}): T {
  const path = resolve(factoryImportLockPath(root));
  if (importInside.has(path)) return fn();
  const held = o.held ?? acquireImportLock(root, label, o.now ?? (() => new Date().toISOString()), o.deps ?? defaultOwnerDeps(), o.waitMs ?? IMPORT_LOCK_WAIT_MS);
  importInside.add(path);
  try {
    return fn();
  } finally {
    importInside.delete(path);
    if (!o.held) held.release();
  }
}

/**
 * withRepoImportLock whose wait never blocks the event loop (review-487
 * M-3): while another process holds the lock, the holder is re-read every
 * SCAN_POLL_MS between awaited sleeps, so SIGINT, SIGTERM and a supervisor's
 * forwarded stop run meanwhile. The successful claim, the synchronous `fn`
 * and the release run in one synchronous turn: the lock is never held across
 * an await. `stopped`: read between polls; true ends the wait with
 * ImportLockBusyError (nothing ran under the lock; a rerun continues).
 */
export async function withRepoImportLockAsync<T>(root: string, label: string, fn: () => T, o: { deps?: OwnerDeps; waitMs?: number; now?: () => string; stopped?: () => boolean; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const now = o.now ?? (() => new Date().toISOString());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const start = scanWait.clock();
  for (;;) {
    const r = tryImportLock(root, label, now, o.deps ?? defaultOwnerDeps(), scanWait.clock() - start, o.waitMs ?? IMPORT_LOCK_WAIT_MS);
    if ('held' in r) {
      try {
        return withRepoImportLock(root, label, fn, { held: r.held });
      } finally {
        r.held.release();
      }
    }
    if (o.stopped?.()) throw new ImportLockBusyError(`${r.busy}; stopped by a signal while waiting for it (nothing was done under the lock): rerun to continue`);
    await sleep(r.sleepMs);
  }
}

/** How long an engine-side start (run, heal run/approve/cancel, run reset, run clean, the poller's auto-start) waits for a `scan` holder before it is busy. */
export const SCAN_WAIT_MS = 60_000; // must exceed FETCH_TIMEOUT_MS (factory/check/cli.ts)
/** The poller's auto-start blocks the event loop while it waits, so it waits only this long for a `scan` holder. */
export const AUTO_START_SCAN_WAIT_MS = 5_000;
/** How long a read command waits for another `scan` holder before it reads without fetching. */
export const READ_SCAN_WAIT_MS = 10_000;
/** The holder is re-read this often while it is `scan`. */
export const SCAN_POLL_MS = 500;

/** The scan wait's sleep and clock; tests replace them (vi.spyOn). */
export const scanWait = {
  sleep: (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  clock: (): number => Date.now(),
};

/**
 * acquireFactoryRepoOwner that waits out a `scan` holder (the poller's heal
 * scan or base sync, or a read command's fetch): the holder is re-read every
 * SCAN_POLL_MS for at most `boundMs`, then the scan busy error (exit 6). Any
 * other holder is busy at once.
 */
export function acquireFactoryRepoOwnerForRun(root: string, key: FactoryRunKey | 'next' | 'scan', now: () => string, deps: OwnerDeps = defaultOwnerDeps(), boundMs: number = SCAN_WAIT_MS): HeldOwner {
  const start = scanWait.clock();
  for (;;) {
    try {
      return acquireFactoryRepoOwner(root, key, now(), deps);
    } catch (error) {
      if (!(error instanceof FactoryBusyError) || error.holderRun !== 'scan') throw error;
      const waited = scanWait.clock() - start;
      if (waited >= boundMs) throw new FactoryBusyError(`${error.message} (waited ${Math.round(waited / 1000)} s)`, 'scan');
      scanWait.sleep(Math.min(SCAN_POLL_MS, boundMs - waited));
    }
  }
}

/**
 * The checkout's engine lock under key `scan`, for a step that fetches or
 * moves refs without starting a run (the poller's heal tick and base sync,
 * the read commands' base fetch, heal dry runs): the held lock, or the
 * FactoryBusyError when an engine holds the checkout (`waitMs`: a `scan`
 * holder is waited out that long first). Any other error (EACCES on the
 * state dir, ...) throws: it is not "busy".
 */
export function tryScanLock(root: string, now: string, deps: OwnerDeps = defaultOwnerDeps(), waitMs = 0): ScanHold | FactoryBusyError {
  let held: HeldOwner;
  try {
    held = waitMs > 0 ? acquireFactoryRepoOwnerForRun(root, 'scan', () => now, deps, waitMs) : acquireFactoryRepoOwner(root, 'scan', now, deps);
  } catch (error) {
    if (error instanceof FactoryBusyError) return error;
    throw error;
  }
  // B2 (lock order: engine.owner, then import.lock): with no private parallel run live, as before. A parallel run that
  // takes its slot after this read waits out this `scan` holder at its start (acquireRunSlot), so it cannot slip in.
  if (heldSlots(root, deps).length === 0) return held;
  let imp: HeldOwner;
  try {
    imp = acquireImportLock(root, 'scan', () => now, deps, Math.max(waitMs, IMPORT_LOCK_SCAN_WAIT_MS));
  } catch (error) {
    held.release();
    if (error instanceof FactoryBusyError) return error;
    throw error;
  }
  return { release: () => { const a = imp.release(); return held.release() && a; }, relabel: held.relabel, importLock: imp };
}

/**
 * True when the engine lock of `root` was taken from another folder (its
 * recorded `root`): that folder resolves to this checkout's state root (a
 * linked worktree, or with OMC_STATE_DIR set a clone with the same folder
 * name and origin), so the two cannot run in parallel.
 */
export function ownerFromOtherCheckout(prior: Pick<FactoryOwner, 'root'>, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof prior.root !== 'string') return false;
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p));
  return fold(prior.root) !== fold(root);
}

const engineBusyMessage = (prior: Partial<FactoryOwner>, root: string, key?: string): string =>
  engineBusyText(prior, key) + (ownerFromOtherCheckout(prior, root)
    ? '; WARNING: that engine runs in another folder that shares this checkout\'s state root (a linked worktree, or with OMC_STATE_DIR set a clone with the same folder name: parallel clones need distinct folder names)'
    : '');

const engineBusyText = (prior: Partial<FactoryOwner>, key?: string): string => prior.run === 'scan'
  ? `the poller's heal scan or base sync, or a factory read command's fetch, holds this checkout for a moment (${describeOwner(prior)}); retry`
  : `another omg factory engine runs in this repository (${describeOwner(prior)}); one engine runs per checkout at a time${key === 'next' ? ', so run --next after it ends' : key === 'scan' ? ', so retry after it ends' : key ? `, so start ${ownerText(key)} after it ends` : ''} (parallel runs need separate clones)`;

/** The one rule for an owner or claim file that does not parse: it is held (never taken over, never "not busy") until a human removes it. */
export const unreadableOwnerMessage = (path: string, release = 'omg factory run release'): string =>
  `the owner file ${path} is unreadable, so it counts as held; check that no engine uses it, then remove it (${release})`;

/**
 * Throws FactoryBusyError while the checkout's engine lock is held: a live
 * engine, or an unreadable lock file. Read-only; acquireFactoryRepoOwner
 * stays the binding check.
 */
export function refuseWhileEngineRuns(root: string, deps: OwnerDeps = defaultOwnerDeps()): void {
  const path = factoryRepoOwnerPath(root);
  const h = ownerHolding(path, deps);
  if (h === 'unreadable') throw new FactoryBusyError(unreadableOwnerMessage(path));
  if (h) throw new FactoryBusyError(engineBusyMessage(h, root));
}

/**
 * Whether `owner` holds its file against `deps`, as claimOwner decides:
 * another host, or another live pid here whose start identity (when both
 * sides know it) is still the recorded one, so a reused pid does not hold it.
 */
export function ownerHolds(owner: Pick<FactoryOwner, 'pid' | 'hostname' | 'identity'>, deps: OwnerDeps): boolean {
  if (owner.hostname !== deps.hostname) return true;
  if (owner.pid === deps.pid || !deps.isAlive(owner.pid)) return false;
  if (typeof owner.identity !== 'string' || !deps.identityOf) return true;
  const current = deps.identityOf(owner.pid);
  return current === null || current === owner.identity;
}

/** A parsed owner file with the fields every holder check reads. */
export const isOwnerRecord = (v: unknown): v is FactoryOwner =>
  typeof v === 'object' && v !== null && Number.isInteger((v as FactoryOwner).pid) && typeof (v as FactoryOwner).hostname === 'string';

/** This process's owner record, with its start identity when deps can read it. */
export function ownerRecord(now: string, deps: OwnerDeps, fields: Pick<FactoryOwner, 'run' | 'root'> = {}): FactoryOwner {
  const identity = deps.identityOf?.(deps.pid) ?? null;
  return { pid: deps.pid, hostname: deps.hostname, startedAt: now, ...(fields.run ? { run: fields.run } : {}), ...(fields.root ? { root: fields.root } : {}), ...(identity ? { identity } : {}) };
}

/**
 * The owner holding the file at `path` (read-only; claimOwner stays the
 * binding check): null when there is none or it is taken over by the next
 * claim, `unreadable` when the file cannot be parsed, which every caller
 * treats as held (unreadableOwnerMessage).
 */
export function ownerHolding(path: string, deps: OwnerDeps = defaultOwnerDeps()): FactoryOwner | 'unreadable' | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const owner: unknown = JSON.parse(raw);
    if (!isOwnerRecord(owner)) return 'unreadable';
    return ownerHolds(owner, deps) ? owner : null;
  } catch {
    return 'unreadable';
  }
}

/**
 * Run `fn` under the file lock of an owner or claim file. A contender that
 * cannot take that lock in time (another engine holds it, maybe while it
 * reads a start identity) is busy (FactoryBusyError, exit 6), not an error.
 */
export function withOwnerFileLock<T>(path: string, fn: () => T): T {
  const lock = lockPathFor(path);
  const handle = acquireFileLockSync(lock, { timeoutMs: 5_000 });
  if (!handle) throw new FactoryBusyError(lockBusyMessage(lock));
  try {
    return fn();
  } finally {
    releaseFileLockSync(handle);
  }
}

/** file-lock's stale age: a lock file older than this whose pid is alive never goes stale. */
const LOCK_STALE_MS = 30_000;

/**
 * Why an owner or claim file's lock could not be taken. An omg factory
 * process holds it for milliseconds, so a directory at the lock path, or a
 * lock file older than file-lock's stale age (its pid alive: maybe reused by
 * an unrelated program), is stuck: it never goes stale, and the message
 * names the path to remove. A younger one is transient.
 */
export function lockBusyMessage(lock: string, nowMs: number = Date.now()): string {
  const remove = `if no omg factory process is running, remove ${lock}`;
  let stat;
  try {
    stat = lstatSync(lock);
  } catch {
    return `another omg factory process held the lock file ${lock}; retry in a moment`;
  }
  if (stat.isDirectory()) return `the lock path ${lock} is a directory, so the lock can never be taken and never goes stale; ${remove}`;
  if (nowMs - stat.mtimeMs >= LOCK_STALE_MS) return `the lock file ${lock} has been held for more than ${LOCK_STALE_MS / 1000} s by a live pid (maybe an unrelated program reusing it), so it does not go stale; ${remove}`;
  return `another omg factory process holds the lock file ${lock}; retry in a moment (${remove})`;
}

/**
 * Claim an owner file: a live owner (or one on another host, whose pid
 * cannot be checked) refuses with a FactoryBusyError, and so does a file
 * that does not parse (unreadableOwnerMessage); a dead pid on this host is
 * taken over, and `tookOver` names it.
 */
export function claimOwner(path: string, now: string, deps: OwnerDeps, busy: (prior: FactoryOwner) => string, fields: Pick<FactoryOwner, 'run' | 'root'> = {}): HeldOwner {
  ensureDirSync(dirname(path));
  // This process's own start identity is read (once, cached) before the file lock: no spawn of ours while holding it.
  const record = `${JSON.stringify(ownerRecord(now, deps, fields))}\n`;
  const tookOver = withOwnerFileLock(path, () => {
    let prior: FactoryOwner | undefined;
    if (existsSync(path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        parsed = undefined;
      }
      if (!isOwnerRecord(parsed)) throw new FactoryBusyError(unreadableOwnerMessage(path));
      prior = parsed;
      if (ownerHolds(prior, deps)) throw new FactoryBusyError(busy(prior), typeof prior.run === 'string' ? prior.run : undefined);
    }
    atomicWriteFileSync(path, record);
    return prior;
  });
  const whileMine = (fn: (owner: FactoryOwner) => void): boolean => {
    try {
      withOwnerFileLock(path, () => {
        const owner: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
        if (isOwnerRecord(owner) && owner.pid === deps.pid && owner.hostname === deps.hostname) fn(owner);
      });
      return true;
    } catch (error) {
      // L7: the file stays this process's until a retry, or until it exits (then the next taker finds the pid gone).
      console.error(`omg factory: could not update the lock ${path} (${error instanceof Error ? error.message : String(error)}); it stays held by this process`);
      return false;
    }
  };
  const release = () => whileMine(() => unlinkSync(path));
  const relabel = (run: string): void => { whileMine((owner) => atomicWriteFileSync(path, `${JSON.stringify({ ...owner, run })}\n`)); };
  return { release, relabel, ...(tookOver ? { tookOver } : {}) };
}
