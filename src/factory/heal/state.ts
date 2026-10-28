/**
 * Heal signature state (design §2): `.omg/state/factory/heal/<sig8>.json`
 * under the state root, one file per failure signature, plus the per-UTC-day
 * counters in `limits.json`. A run already counted for a signature is never
 * counted again, so rescans are idempotent. A signature with an open heal run,
 * or closed by a human as won't-fix within WONT_FIX_DAYS, only increments its
 * count. Lane-eligible signatures over a limit are queued with
 * `blocked: rate-limit` and re-evaluated by the next scan.
 *
 * PR 1 starts no heal run and no lane: `next` records what the next stage
 * would do, and a rerun is recorded as an intent (at most one per signature),
 * never issued.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import type { HealClass, HealClassification, RerunIntent } from './classify.js';
import type { HealConfig } from './config.js';

export const SIG8 = /^[0-9a-f]{8}$/;
export const WONT_FIX_DAYS = 14;
/** Open heal runs at a time (fixed). */
export const MAX_OPEN_HEAL_RUNS = 1;
/** Reruns the classifier records per signature (fixed). */
export const MAX_RERUNS_PER_SIGNATURE = 1;
const MAX_SEEN_RUNS = 50;

export type HealNext = 'debug-lane' | 'rerun-probe' | 'report';

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

/** Today's counters; a file from an earlier UTC day reads as zero. */
export function readDailyCounters(root: string, now: Date): HealDailyCounters {
  const path = join(healStateDir(root), 'limits.json');
  const zero = { day: utcDay(now), healRuns: 0, debugLanes: 0 };
  if (!existsSync(path)) return zero;
  const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<HealDailyCounters>;
  if (c.day !== zero.day) return zero;
  return { day: zero.day, healRuns: Number(c.healRuns) || 0, debugLanes: Number(c.debugLanes) || 0 };
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
    ...(prev?.wontFixAt ? { wontFixAt: prev.wontFixAt } : {}),
    next,
    ...(blocked ? { blocked: 'rate-limit' as const } : {}),
    rerunIntents,
    updatedAt: at,
  };
  return { state, changed: true, suppressed: false };
}

export function writeHealState(root: string, state: HealSignatureState): void {
  ensureDirSync(healStateDir(root));
  atomicWriteFileSync(healStatePath(root, state.sig8), `${JSON.stringify(state, null, 2)}\n`);
}
