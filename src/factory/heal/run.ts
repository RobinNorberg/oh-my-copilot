/**
 * `omg factory heal run <sig8>` (design §5, §7): run the debugger lane for a
 * queued, lane-eligible signature, record its diagnosis, and park. A valid
 * diagnosis parks at `awaiting-human: heal-approve`; anything else parks at
 * `awaiting-human: heal-diagnosis`. Implementing the fix is a later change;
 * nothing here writes a tracked file, pushes, or calls a GitHub write.
 *
 * Limits, checked under the scan lock before the lane starts and recorded
 * write-ahead (a crash counts the lane at its full cap):
 * - one open heal run (MAX_OPEN_HEAL_RUNS), `factory.heal.dailyRuns` heal
 *   runs and `factory.heal.dailyDebugLanes` lanes per UTC day;
 * - the lane's cap `factory.heal.debugLaneMaxCredits` (mandatory, at least
 *   the CLI floor), `factory.heal.maxRunCredits` per heal run and
 *   `factory.heal.dailyCredits` per UTC day. The daily spend is the larger of
 *   the heal counters and the `factory-lane:heal-*` records of the budget
 *   ledger.
 *
 * The counters and a seal of the recorded heal run are mirrored outside the
 * repository (the factory ledger directory), because a lane's shell can reach
 * `.omg/`: the larger counter wins, and `heal status` reports a seal mismatch.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { withFileLockSync } from '../../lib/file-lock.js';
import { ledgerPath, readLedger } from '../../budget/ledger.js';
import type { Exec } from '../../ship/exec.js';
import { RUNTIME_MIN_MAX_CREDITS } from '../run/budget.js';
import { factoryGuardExec, hardenedGitExec } from '../run/exec.js';
import type { LaneBackend } from '../run/lane.js';
import { emptyHooksDir } from '../run/ledger.js';
import { LANE_CLASSES } from './classify.js';
import type { HealConfig } from './config.js';
import { debugPrompt, NO_CONFINEMENT, runDebugLane, type DebugLaneOutcome, type LaneConfinement } from './debug-lane.js';
import { parseDiagnosisOutput } from './diagnosis-output.js';
import { buildEvidence, changedEvidence, collectEvidence, writeEvidence, type EvidenceBundle } from './evidence.js';
import { healGuardExec } from './history.js';
import { newDelimiter } from './sanitize.js';
import {
  dailyCountersPath,
  healStateDir,
  listHealStates,
  MAX_OPEN_HEAL_RUNS,
  readDailyCountersAt,
  readHealState,
  writeDailyCountersAt,
  writeHealState,
  type HealDailyCounters,
  type HealDiagnosisRecord,
  type HealLaneRecord,
  type HealNext,
  type HealSignatureState,
} from './state.js';

/** Wall time of one debugger lane. */
export const DEBUG_LANE_TIMEOUT_MS = 30 * 60_000;
export const EXIT_HEAL_PARKED = 4;
export const EXIT_HEAL_REFUSED = 3;
/** Ledger keys of heal lanes (`factory-lane:<laneId>`, lane ids start `heal-`). */
export const HEAL_LEDGER_PREFIX = 'factory-lane:heal-';

export class HealRunRefused extends Error {}

export interface HealRunDeps {
  exec: Exec;
  lanes: (root: string) => LaneBackend;
  /** Out-of-repository directory for the mirrored counters, the seals and the engine's empty hooks dir. */
  ledgerDir: string;
  now: () => Date;
  clock?: () => number;
  pollMs?: number;
  confinement?: LaneConfinement;
  /** Test seam: the per-run fence delimiter. */
  delimiter?: () => string;
}

export interface HealRunOptions {
  root: string;
  base: string;
  sig8: string;
  config: HealConfig;
  dryRun: boolean;
  lockTimeoutMs?: number;
}

export interface HealRunOutcome {
  sig8: string;
  exitCode: number;
  next: HealNext;
  message: string;
  bundleDir: string;
  /** Dry run only. */
  prompt?: string;
  lane?: HealLaneRecord;
  diagnosis?: HealDiagnosisRecord;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const healLedgerDir = (ledgerDir: string, root: string) => join(ledgerDir, 'heal', sha256(resolve(root).toLowerCase()).slice(0, 16));
const mirrorCountersPath = (ledgerDir: string, root: string) => join(healLedgerDir(ledgerDir, root), 'limits.json');
const sealPath = (ledgerDir: string, root: string, sig8: string) => join(healLedgerDir(ledgerDir, root), `${sig8}.seal.json`);

/** What the seal covers: the heal run, its lanes and its diagnosis. */
const sealOf = (s: Pick<HealSignatureState, 'healRun' | 'lanes' | 'diagnosis'>) => sha256(JSON.stringify({ healRun: s.healRun ?? null, lanes: s.lanes ?? [], diagnosis: s.diagnosis ?? null }));

export function writeHealSeal(ledgerDir: string, root: string, state: HealSignatureState): void {
  const path = sealPath(ledgerDir, root, state.sig8);
  ensureDirSync(healLedgerDir(ledgerDir, root));
  atomicWriteFileSync(path, `${JSON.stringify({ sig8: state.sig8, seal: sealOf(state) }, null, 2)}\n`);
}

/** `ok` when the recorded heal run matches its out-of-repo seal; `none` without a heal run. */
export function verifyHealSeal(ledgerDir: string, root: string, state: HealSignatureState): 'ok' | 'none' | 'missing' | 'mismatch' {
  if (!state.healRun && !state.diagnosis && !state.lanes?.length) return 'none';
  const path = sealPath(ledgerDir, root, state.sig8);
  if (!existsSync(path)) return 'missing';
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { seal?: unknown }).seal === sealOf(state) ? 'ok' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

/** Field-wise larger of the in-repo and the mirrored counters. */
export function readHealCounters(root: string, ledgerDir: string, now: Date): HealDailyCounters {
  const a = readDailyCountersAt(dailyCountersPath(root), now);
  const b = readDailyCountersAt(mirrorCountersPath(ledgerDir, root), now);
  return { day: a.day, healRuns: Math.max(a.healRuns, b.healRuns), debugLanes: Math.max(a.debugLanes, b.debugLanes), credits: Math.max(a.credits, b.credits) };
}

function writeHealCounters(root: string, ledgerDir: string, counters: HealDailyCounters): void {
  writeDailyCountersAt(dailyCountersPath(root), counters);
  writeDailyCountersAt(mirrorCountersPath(ledgerDir, root), counters);
}

/** AI credits the budget ledger holds for heal lanes updated on `day` (UTC). */
export function ledgerHealCredits(root: string, day: string): number {
  try {
    const ledger = readLedger(ledgerPath(root));
    return Object.entries(ledger.sessions)
      .filter(([key, r]) => key.startsWith(HEAL_LEDGER_PREFIX) && r.updatedAt.slice(0, 10) === day)
      .reduce((sum, [, r]) => sum + (Number(r.credits) || 0), 0);
  } catch {
    return 0;
  }
}

const runSpent = (s: HealSignatureState) => (s.lanes ?? []).reduce((sum, l) => sum + (l.usage?.credits ?? (l.status === 'running' ? l.maxCredits : 0)), 0);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Why the signature cannot take a debugger lane now, or null. */
function eligibility(s: HealSignatureState): string | null {
  if (!s.classification.laneEligible || !LANE_CLASSES.includes(s.class)) return `class ${s.class} never goes to a debugger lane`;
  if (s.next === 'heal-approve') return 'a valid diagnosis is already recorded; the heal run waits at awaiting-human: heal-approve';
  if (s.next === 'report') return 'the signature is report-only';
  if (s.wontFixAt) return "the signature was closed as won't-fix";
  return null;
}

/**
 * The lane cap after the limits, or why the lane may not start. `others` are
 * the other signatures' states; `fresh` is true when this starts a new heal run.
 */
export function laneBudget(state: HealSignatureState, others: readonly HealSignatureState[], counters: HealDailyCounters, ledgerCredits: number, config: HealConfig, fresh: boolean): { ok: true; cap: number } | { ok: false; reason: string } {
  const open = others.filter((s) => s.healRun?.open).length;
  if (open >= MAX_OPEN_HEAL_RUNS) return { ok: false, reason: `${open} other heal run(s) open (max ${MAX_OPEN_HEAL_RUNS})` };
  if (fresh && counters.healRuns >= config.dailyRuns) return { ok: false, reason: `${counters.healRuns} heal run(s) started today (factory.heal.dailyRuns ${config.dailyRuns})` };
  if (counters.debugLanes >= config.dailyDebugLanes) return { ok: false, reason: `${counters.debugLanes} debugger lane(s) today (factory.heal.dailyDebugLanes ${config.dailyDebugLanes})` };
  const runLeft = config.maxRunCredits - (fresh ? 0 : runSpent(state));
  const dayLeft = config.dailyCredits - Math.max(counters.credits, ledgerCredits);
  const cap = Math.min(config.debugLaneMaxCredits, Math.floor(runLeft), Math.floor(dayLeft));
  if (cap < RUNTIME_MIN_MAX_CREDITS) {
    const which = runLeft < dayLeft ? `the heal run has ${Math.max(0, runLeft).toFixed(2)} of factory.heal.maxRunCredits ${config.maxRunCredits} AI credits left` : `heal lanes have ${Math.max(0, dayLeft).toFixed(2)} of factory.heal.dailyCredits ${config.dailyCredits} AI credits left today`;
    return { ok: false, reason: `${which}; a lane needs at least ${RUNTIME_MIN_MAX_CREDITS}` };
  }
  return { ok: true, cap };
}

export async function runHeal(o: HealRunOptions, deps: HealRunDeps): Promise<HealRunOutcome> {
  const now = () => deps.now().toISOString();
  const lockPath = join(healStateDir(o.root), 'scan.lock');
  const locked = <T>(fn: () => T): T => withFileLockSync(lockPath, fn, { timeoutMs: o.lockTimeoutMs ?? 60_000 });
  const healExec = healGuardExec(deps.exec);
  const bundleDir = join(healStateDir(o.root), o.sig8, 'evidence');

  const initial = readHealState(o.root, o.sig8);
  if (!initial) throw new HealRunRefused(`no heal signature ${o.sig8} (run omg factory heal scan first)`);
  const why = eligibility(initial);
  if (why) throw new HealRunRefused(`heal ${o.sig8}: ${why}`);
  const c = initial.classification;
  if (healExec('git', ['cat-file', '-e', `${c.firstRed.sha}^{commit}`], { cwd: o.root }).status !== 0) {
    throw new HealRunRefused(`the first red commit ${c.firstRed.sha.slice(0, 12)} is not in the local repository; fetch origin first`);
  }

  const bundle: EvidenceBundle = buildEvidence(collectEvidence(healExec, o.root, c, o.config.ignoreJobs));
  const delimiter = (deps.delimiter ?? newDelimiter)();
  const prompt = debugPrompt(c, bundle, delimiter);
  if (o.dryRun) {
    writeEvidence(o.root, bundle);
    return { sig8: o.sig8, exitCode: 0, next: initial.next, message: `dry run: wrote the evidence bundle; a debugger lane would start capped at ${o.config.debugLaneMaxCredits} AI credits`, bundleDir, prompt };
  }

  // Reserve: limits checked and the lane recorded before it exists.
  const reserved = locked(() => {
    let s = readHealState(o.root, o.sig8);
    if (!s) throw new HealRunRefused(`heal signature ${o.sig8} disappeared`);
    const stale = s.lanes?.at(-1);
    if (stale?.status === 'running') {
      if (stale.pid !== process.pid && pidAlive(stale.pid)) throw new HealRunRefused(`debugger lane ${stale.id} is still running in process ${stale.pid}`);
      s = {
        ...s,
        lanes: s.lanes!.map((l) => (l.id === stale.id ? { ...l, status: 'lost' as const, endedAt: now(), usage: { credits: l.maxCredits, premiumRequests: 0, source: 'estimated' as const }, note: 'its process ended before the lane was recorded; counted at its cap' } : l)),
        next: 'heal-diagnosis',
      };
    }
    const again = eligibility(s);
    if (again) throw new HealRunRefused(`heal ${o.sig8}: ${again}`);
    const counters = readHealCounters(o.root, deps.ledgerDir, deps.now());
    const others = listHealStates(o.root).filter((x) => x.sig8 !== o.sig8);
    const fresh = !s.healRun?.open;
    const budget = laneBudget(s, others, counters, ledgerHealCredits(o.root, counters.day), o.config, fresh);
    if (!budget.ok) {
      writeHealState(o.root, { ...s, blocked: 'rate-limit', updatedAt: now() });
      throw new HealRunRefused(`heal ${o.sig8} queued as blocked: rate-limit: ${budget.reason}`);
    }
    const lane: HealLaneRecord = {
      id: `heal-${o.sig8}-debug-${(s.lanes?.length ?? 0) + 1}`,
      kind: 'debug',
      startSha: c.firstRed.sha,
      status: 'running',
      maxCredits: budget.cap,
      startedAt: now(),
      pid: process.pid,
      confinement: (deps.confinement ?? NO_CONFINEMENT).name,
    };
    const { blocked: _blocked, ...rest } = s;
    const next: HealSignatureState = {
      ...rest,
      healRun: fresh ? { id: `heal-${o.sig8}`, open: true, startedAt: now() } : s.healRun!,
      lanes: [...(s.lanes ?? []), lane],
      updatedAt: now(),
    };
    writeHealCounters(o.root, deps.ledgerDir, { ...counters, healRuns: counters.healRuns + (fresh ? 1 : 0), debugLanes: counters.debugLanes + 1, credits: counters.credits + budget.cap });
    writeHealState(o.root, next);
    writeHealSeal(deps.ledgerDir, o.root, next);
    return { state: next, lane };
  });

  const { hashes } = writeEvidence(o.root, bundle);
  const hooksDir = emptyHooksDir(join(deps.ledgerDir, 'heal'));
  const laneExec = factoryGuardExec(hardenedGitExec(deps.exec, hooksDir), () => [o.base]);
  let jobId: string | undefined;
  const outcome: DebugLaneOutcome = await runDebugLane({
    backend: deps.lanes(o.root),
    exec: laneExec,
    root: o.root,
    laneId: reserved.lane.id,
    startSha: c.firstRed.sha,
    prompt,
    maxCredits: reserved.lane.maxCredits,
    timeoutMs: DEBUG_LANE_TIMEOUT_MS,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.confinement ? { confinement: deps.confinement } : {}),
    onStarted: (id) => { jobId = id; },
  }).catch((error: unknown): DebugLaneOutcome => ({
    // A started lane's spend is unknown: counted at its cap. Its end is unconfirmed, so its output is never used.
    status: jobId ? 'unconfirmed' : 'start-failed',
    result: null,
    usage: jobId ? { credits: reserved.lane.maxCredits, premiumRequests: 0, source: 'estimated' } : { credits: 0, premiumRequests: 0, source: 'measured' },
    problems: [],
    confinement: reserved.lane.confinement,
    error: error instanceof Error ? error.message : String(error),
  }));

  return locked(() => {
    const cur = readHealState(o.root, o.sig8);
    const problems = [...outcome.problems];
    const changed = changedEvidence(o.root, o.sig8, hashes);
    if (changed.length > 0) problems.push(`the evidence bundle changed while the lane ran: ${changed.slice(0, 5).join(', ')}`);
    const expected = { healRun: reserved.state.healRun, lanes: reserved.state.lanes };
    if (!cur || JSON.stringify({ healRun: cur.healRun, lanes: cur.lanes }) !== JSON.stringify(expected)) problems.push('the heal state file changed while the lane ran');
    const base = cur ?? reserved.state;

    let diagnosis: HealDiagnosisRecord;
    const record = { at: now(), laneId: reserved.lane.id, evidence: hashes };
    if (problems.length > 0) diagnosis = { ...record, outcome: 'tampered', reason: problems.slice(0, 5).join('; ') };
    else if (outcome.status !== 'completed') diagnosis = { ...record, outcome: 'lane-failed', reason: `lane ended ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}` };
    else {
      const parsed = parseDiagnosisOutput(outcome.result?.finalText, bundle);
      diagnosis = parsed.kind === 'invalid'
        ? { ...record, outcome: 'invalid', reason: parsed.reason }
        : parsed.kind === 'rejected'
          ? { ...record, outcome: 'rejected', reason: parsed.reason, diagnosis: parsed.diagnosis }
          : { ...record, outcome: 'valid', diagnosis: parsed.diagnosis };
    }
    const lane: HealLaneRecord = {
      ...reserved.lane,
      ...(jobId ? { jobId } : {}),
      status: outcome.status,
      endedAt: now(),
      usage: outcome.usage,
      confinement: outcome.confinement,
      ...(diagnosis.outcome !== 'valid' && diagnosis.reason ? { note: diagnosis.reason.slice(0, 500) } : {}),
    };
    const next: HealNext = diagnosis.outcome === 'valid' ? 'heal-approve' : 'heal-diagnosis';
    const state: HealSignatureState = {
      ...base,
      healRun: reserved.state.healRun,
      lanes: [...(reserved.state.lanes ?? []).slice(0, -1), lane],
      diagnosis,
      next,
      updatedAt: now(),
    };
    writeHealState(o.root, state);
    writeHealSeal(deps.ledgerDir, o.root, state);
    // The reserved cap becomes the measured spend (a lost or unconfirmed lane keeps its cap).
    const counters = readHealCounters(o.root, deps.ledgerDir, deps.now());
    if (counters.day === reserved.lane.startedAt.slice(0, 10)) {
      writeHealCounters(o.root, deps.ledgerDir, { ...counters, credits: Math.max(0, counters.credits - reserved.lane.maxCredits + outcome.usage.credits) });
    }
    const message = next === 'heal-approve'
      ? `awaiting-human: heal-approve (diagnosis ${diagnosis.diagnosis!.class}: ${diagnosis.diagnosis!.fix!.summary.slice(0, 200)})`
      : `awaiting-human: heal-diagnosis (${diagnosis.outcome}: ${diagnosis.reason ?? ''})`;
    return { sig8: o.sig8, exitCode: EXIT_HEAL_PARKED, next, message, bundleDir, lane, diagnosis };
  });
}
