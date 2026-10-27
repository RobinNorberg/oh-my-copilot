/**
 * Heal signature state (design §2): `.omg/state/factory/heal/<sig8>.json`
 * under the state root, one file per failure signature, plus the per-UTC-day
 * counters in `limits.json`. A run already counted for a signature is never
 * counted again, so rescans are idempotent. A signature with an open heal run,
 * or closed by a human as won't-fix within WONT_FIX_DAYS, only increments its
 * count. Lane-eligible signatures over a limit are queued with
 * `blocked: rate-limit` and re-evaluated by the next scan.
 *
 * The scan starts no heal run and no lane: `next` records what the next stage
 * would do, and a rerun is recorded as an intent (at most one per signature),
 * never issued. `omg factory heal run` (run.ts) starts the heal run and its
 * debugger lane and records them here.
 *
 * `webhook-queue.json` holds the run ids the listener's `workflow_run`
 * handler enqueued. It is a hint only: the scan (the poller) stays the
 * source of truth, re-reads every queued run through `gh`, and clears the
 * entries it has seen.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import type { HealClass, HealClassification, RerunIntent } from './classify.js';
import type { HealConfig } from './config.js';
import type { Diagnosis } from './diagnosis-output.js';

export const SIG8 = /^[0-9a-f]{8}$/;
export const WONT_FIX_DAYS = 14;
/** Open heal runs at a time (fixed). */
export const MAX_OPEN_HEAL_RUNS = 1;
/** Reruns the classifier records per signature (fixed). */
export const MAX_RERUNS_PER_SIGNATURE = 1;
const MAX_SEEN_RUNS = 50;

/**
 * `heal-approve`: a valid diagnosis is recorded and the heal run waits for a
 * human (implementing the fix is PR 3). `heal-diagnosis`: the debugger lane
 * produced no usable diagnosis; a human reads the record, and
 * `omg factory heal run` may try again within the limits.
 */
export type HealNext = 'debug-lane' | 'rerun-probe' | 'report' | 'heal-approve' | 'heal-diagnosis';

export interface HealLaneRecord {
  id: string;
  kind: 'debug';
  jobId?: string;
  startSha: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'lost' | 'start-failed' | 'unconfirmed';
  maxCredits: number;
  startedAt: string;
  endedAt?: string;
  /** The process that started the lane (a stale `running` record of a dead process is settled as lost). */
  pid: number;
  confinement: string;
  usage?: { credits: number; premiumRequests: number; source: 'measured' | 'estimated' };
  note?: string;
}

export interface HealDiagnosisRecord {
  at: string;
  laneId: string;
  outcome: 'valid' | 'rejected' | 'invalid' | 'tampered' | 'lane-failed';
  reason?: string;
  /** The validated lane output (valid or rejected outcomes only). */
  diagnosis?: Diagnosis;
  /** Bundle file -> sha256 at the time the lane read it. */
  evidence: Record<string, string>;
}

export interface HealSignatureState {
  version: 1;
  sig8: string;
  signature: string;
  class: HealClass;
  classification: HealClassification;
  /** `push`: a red dev push run; `pr`: seen on PR runs of two or more head branches. */
  source: 'push' | 'pr';
  firstSeen: { runId: string; at: string };
  lastSeen: { runId: string; at: string };
  count: number;
  seenRuns: string[];
  prBranches?: string[];
  healRun?: { id: string; open: boolean; startedAt: string };
  /** Debugger lanes of the heal run, oldest first. */
  lanes?: HealLaneRecord[];
  diagnosis?: HealDiagnosisRecord;
  wontFixAt?: string;
  next: HealNext;
  blocked?: 'rate-limit';
  rerunIntents: RerunIntent[];
  updatedAt: string;
}

export interface HealDailyCounters {
  day: string;
  healRuns: number;
  debugLanes: number;
  /** AI credits of heal lanes today: a lane's cap is reserved at its start, then replaced by its measured spend. */
  credits: number;
}

export function healStateDir(root: string): string {
  return join(getOmcRoot(root), 'state', 'factory', 'heal');
}

export function healStatePath(root: string, sig8: string): string {
  if (!SIG8.test(sig8)) throw new Error(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
  return join(healStateDir(root), `${sig8}.json`);
}

function parseState(raw: string, path: string): HealSignatureState {
  const s = JSON.parse(raw) as HealSignatureState;
  if (s?.version !== 1 || typeof s.sig8 !== 'string' || !SIG8.test(s.sig8) || typeof s.count !== 'number' || !Array.isArray(s.seenRuns)) {
    throw new Error(`${path}: not a heal signature state`);
  }
  return s;
}

export function readHealState(root: string, sig8: string): HealSignatureState | null {
  const path = healStatePath(root, sig8);
  return existsSync(path) ? parseState(readFileSync(path, 'utf8'), path) : null;
}

export function listHealStates(root: string): HealSignatureState[] {
  const dir = healStateDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
    .flatMap((f) => {
      const path = join(dir, f);
      try {
        return [parseState(readFileSync(path, 'utf8'), path)];
      } catch (error) {
        console.warn(`omg factory heal: skipping corrupt signature file ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    })
    .sort((a, b) => b.lastSeen.at.localeCompare(a.lastSeen.at));
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Today's counters in one counters file; a file from an earlier UTC day reads as zero. */
export function readDailyCountersAt(path: string, now: Date): HealDailyCounters {
  const zero = { day: utcDay(now), healRuns: 0, debugLanes: 0, credits: 0 };
  if (!existsSync(path)) return zero;
  const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<HealDailyCounters>;
  if (c.day !== zero.day) return zero;
  return { day: zero.day, healRuns: Number(c.healRuns) || 0, debugLanes: Number(c.debugLanes) || 0, credits: Number(c.credits) || 0 };
}

export const dailyCountersPath = (root: string): string => join(healStateDir(root), 'limits.json');

/** Today's counters; a file from an earlier UTC day reads as zero. */
export function readDailyCounters(root: string, now: Date): HealDailyCounters {
  return readDailyCountersAt(dailyCountersPath(root), now);
}

export function writeDailyCountersAt(path: string, counters: HealDailyCounters): void {
  ensureDirSync(dirname(path));
  atomicWriteFileSync(path, `${JSON.stringify(counters, null, 2)}\n`);
}

/** Why a lane-eligible signature may not start a heal run now, or null. */
export function healLimitReason(states: readonly HealSignatureState[], counters: HealDailyCounters, config: Pick<HealConfig, 'dailyRuns' | 'dailyDebugLanes'>): string | null {
  const open = states.filter((s) => s.healRun?.open).length;
  if (open >= MAX_OPEN_HEAL_RUNS) return `${open} heal run(s) open (max ${MAX_OPEN_HEAL_RUNS})`;
  if (counters.healRuns >= config.dailyRuns) return `${counters.healRuns} heal run(s) started today (factory.heal.dailyRuns ${config.dailyRuns})`;
  if (counters.debugLanes >= config.dailyDebugLanes) return `${counters.debugLanes} debugger lane(s) today (factory.heal.dailyDebugLanes ${config.dailyDebugLanes})`;
  return null;
}

export interface RecordInput {
  classification: HealClassification;
  runId: string;
  source: 'push' | 'pr';
  prBranches?: string[];
}

export interface RecordResult {
  state: HealSignatureState;
  /** False when the run was already counted for this signature. */
  changed: boolean;
  /** Only the count moved: an open heal run or a recent won't-fix. */
  suppressed: boolean;
}

/**
 * Fold one classified run into its signature state (pure: the caller writes
 * it). `others` are the other signatures' states, for the open-run limit.
 */
export function foldSignature(prev: HealSignatureState | null, input: RecordInput, others: readonly HealSignatureState[], counters: HealDailyCounters, config: HealConfig, now: Date): RecordResult {
  const at = now.toISOString();
  const c = input.classification;
  if (prev?.seenRuns.includes(input.runId)) return { state: prev, changed: false, suppressed: false };
  const wontFix = prev?.wontFixAt !== undefined && now.getTime() - Date.parse(prev.wontFixAt) < WONT_FIX_DAYS * 86_400_000;
  if (prev && (prev.healRun?.open || wontFix)) {
    const state = { ...prev, count: prev.count + 1, lastSeen: { runId: input.runId, at }, seenRuns: [...prev.seenRuns, input.runId].slice(-MAX_SEEN_RUNS), updatedAt: at };
    return { state, changed: true, suppressed: true };
  }
  const rerunIntents = [...(prev?.rerunIntents ?? [])];
  if (c.rerun && rerunIntents.length < MAX_RERUNS_PER_SIGNATURE) rerunIntents.push(c.rerun);
  // A rerun class (env-change included) waits for its probe's outcome, which PR 1 never records.
  const next: HealNext = c.rerun ? 'rerun-probe' : c.laneEligible ? 'debug-lane' : 'report';
  const blocked = next === 'debug-lane' && healLimitReason(others.filter((s) => s.sig8 !== c.sig8), counters, config) !== null;
  const state: HealSignatureState = {
    version: 1,
    sig8: c.sig8,
    signature: c.signature,
    class: c.class,
    classification: c,
    source: prev?.source === 'push' ? 'push' : input.source,
    firstSeen: prev?.firstSeen ?? { runId: input.runId, at },
    lastSeen: { runId: input.runId, at },
    count: (prev?.count ?? 0) + 1,
    seenRuns: [...(prev?.seenRuns ?? []), input.runId].slice(-MAX_SEEN_RUNS),
    ...(input.prBranches ? { prBranches: input.prBranches } : prev?.prBranches ? { prBranches: prev.prBranches } : {}),
    ...(prev?.healRun ? { healRun: prev.healRun } : {}),
    ...(prev?.lanes ? { lanes: prev.lanes } : {}),
    ...(prev?.diagnosis ? { diagnosis: prev.diagnosis } : {}),
    ...(prev?.wontFixAt ? { wontFixAt: prev.wontFixAt } : {}),
    next,
    ...(blocked ? { blocked: 'rate-limit' as const } : {}),
    rerunIntents,
    updatedAt: at,
  };
  return { state, changed: true, suppressed: false };
}

export interface QueuedRun {
  runId: string;
  receivedAt: string;
}

/** Entries kept in the webhook queue (oldest dropped first). */
export const MAX_QUEUED_RUNS = 50;
/** A queued run the scan has not seen after this long is dropped. */
export const QUEUE_TTL_MS = 7 * 86_400_000;

export const webhookQueuePath = (root: string): string => join(healStateDir(root), 'webhook-queue.json');

export function readWebhookQueue(root: string): QueuedRun[] {
  const path = webhookQueuePath(root);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { runs?: unknown };
    return Array.isArray(raw.runs)
      ? raw.runs.filter((r): r is QueuedRun => typeof r?.runId === 'string' && /^\d{1,20}$/.test(r.runId) && typeof r.receivedAt === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeWebhookQueue(root: string, runs: readonly QueuedRun[]): void {
  ensureDirSync(healStateDir(root));
  atomicWriteFileSync(webhookQueuePath(root), `${JSON.stringify({ runs }, null, 2)}\n`);
}

/** Add one run id (idempotent); false when it was already queued. The caller holds the scan lock. */
export function enqueueWebhookRun(root: string, runId: string, now: Date): boolean {
  if (!/^\d{1,20}$/.test(runId)) throw new Error(`run id must be numeric, got ${JSON.stringify(runId)}`);
  const runs = readWebhookQueue(root);
  if (runs.some((r) => r.runId === runId)) return false;
  writeWebhookQueue(root, [...runs, { runId, receivedAt: now.toISOString() }].slice(-MAX_QUEUED_RUNS));
  return true;
}

/** Drop queued runs the scan saw and expired ones; returns what is left. The caller holds the scan lock. */
export function pruneWebhookQueue(root: string, seen: ReadonlySet<string>, now: Date): QueuedRun[] {
  const runs = readWebhookQueue(root);
  const left = runs.filter((r) => !seen.has(r.runId) && now.getTime() - Date.parse(r.receivedAt) < QUEUE_TTL_MS);
  if (left.length !== runs.length) writeWebhookQueue(root, left);
  return left;
}

export function writeHealState(root: string, state: HealSignatureState): void {
  ensureDirSync(healStateDir(root));
  atomicWriteFileSync(healStatePath(root, state.sig8), `${JSON.stringify(state, null, 2)}\n`);
}
