/**
 * The ci-heal run of one signature (design §5-§6, PR 3): `omg factory heal
 * approve <sig8>` runs the factory engine (run/engine.ts) with kind
 * `ci-heal`, keyed `heal-<sig8>`, from the heal record's valid diagnosis.
 * The engine parks at `awaiting-human: heal-approve` until a human approves
 * (factory.heal.autoImplement aside, never for regression-or-env), and from
 * implement on it is the issue pipeline: review, fix rounds, prepare, gates,
 * and the human merge.
 *
 * Trust: the heal record lives in `.omg/`, which a lane's shell can reach,
 * so a run starts only from a record whose out-of-repo seal matches. The
 * engine then keeps its own sealed copy and never re-reads the record.
 *
 * Caps: every engine lane keeps `factory.run.laneMaxCredits`; the run's
 * credits are bounded by what `factory.heal.maxRunCredits` leaves after the
 * debugger lanes; and before each lane start `factory.heal.dailyCredits` is
 * checked against the larger of the heal counters and the budget ledger's
 * `factory-lane:heal-*` records. An engine lane is reserved in the counters
 * at its full cap, then settled to its measured spend after its confirmed
 * end (released when it never started).
 *
 * Known-flaky entries are never written: a diagnosis of class `flaky` gets a
 * printed proposal only (knownFlakyProposal). Nothing in src/factory writes
 * `.github/known-flaky-tests.json`.
 */

import { join } from 'path';
import { withFileLockSync } from '../../lib/file-lock.js';
import type { KnownFlakyTest } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { RUNTIME_MIN_MAX_CREDITS, type LoadedFactoryRunLimits } from '../run/budget.js';
import { runFactoryEngine, type FactoryEngineOptions, type FactoryRunOutcome, type HealLaneCapDecision } from '../run/engine.js';
import type { LaneBackend } from '../run/lane.js';
import type { GateConfigLoader } from '../run/prepare.js';
import { healRunKey, readFactoryState, type FactoryHealRecord } from '../run/state.js';
import type { HealConfig } from './config.js';
import { closeHeal, HealRunRefused, healTestId, ledgerHealCredits, readHealCounters, readHealSealSubject, verifyHealSeal, writeHealCounters, type HealSealSubject } from './run.js';
import { healStateDir, readHealState, type HealSignatureState } from './state.js';

export const KNOWN_FLAKY_FILE = '.github/known-flaky-tests.json';

export interface HealEngineDeps {
  exec: Exec;
  lanes: (root: string) => LaneBackend;
  /** `factory.run` limits (trusted user config; the project config can only tighten). */
  limits: (root: string) => LoadedFactoryRunLimits;
  /** The engine ledger directory, outside the repository (also holds the heal counters mirror and seals). */
  ledgerDir: string;
  now: () => Date;
  gateConfig?: GateConfigLoader;
  warn?: (message: string) => void;
  /** Test seams of the engine. */
  engine?: Partial<Pick<FactoryEngineOptions, 'pollMs' | 'owner' | 'processes' | 'sleep' | 'interrupted' | 'progressFile'>>;
}

export interface HealEngineOptions {
  root: string;
  base: string;
  sig8: string;
  config: HealConfig;
  /** `omg factory heal approve`: a human approved the diagnosis. */
  approved: boolean;
  dryRun?: boolean;
}

/**
 * The validated fields a ci-heal run is created from (the record's diagnosis
 * must be valid). The class and the classifier fields come from the sealed
 * snapshot only, never from the record's unsealed class or classification.
 */
export function healRecord(s: HealSignatureState, sealed: HealSealSubject): FactoryHealRecord {
  const d = s.diagnosis?.diagnosis;
  if (s.diagnosis?.outcome !== 'valid' || !d) throw new HealRunRefused(`heal ${s.sig8} has no valid diagnosis`);
  return {
    sig8: s.sig8,
    class: sealed.class,
    firstRed: { ...sealed.firstRed },
    ...(sealed.lastGreen ? { lastGreen: { ...sealed.lastGreen } } : {}),
    failingTests: [...sealed.failingTests],
    env: sealed.env.map((e) => ({ ...e })),
    diagnosis: {
      class: d.class,
      rootCause: d.rootCause,
      evidence: [...d.evidence],
      reproduced: d.reproduced,
      ...(d.reproCommand ? { reproCommand: d.reproCommand } : {}),
      fix: d.fix ? { summary: d.fix.summary, files: [...d.fix.files], acceptance: [...d.fix.acceptance] } : null,
    },
  };
}

/**
 * The daily heal cap on one engine lane: what `factory.heal.dailyCredits`
 * leaves today, reserved in the heal counters at the lane's cap. The engine
 * settles the reservation once: to the measured spend after the lane's
 * confirmed end, or to 0 when the lane never started. A lost or unconfirmed
 * lane is never settled and keeps its cap.
 */
export function healLaneCap(root: string, ledgerDir: string, config: HealConfig, now: () => Date): (cap: number) => HealLaneCapDecision {
  const lock = join(healStateDir(root), 'scan.lock');
  return (cap) => withFileLockSync(lock, () => {
    const counters = readHealCounters(root, ledgerDir, now());
    const left = config.dailyCredits - Math.max(counters.credits, ledgerHealCredits(root, counters.day));
    const capped = Math.min(cap, Math.floor(left));
    if (capped < RUNTIME_MIN_MAX_CREDITS) {
      return { ok: false, reason: `heal lanes have ${Math.max(0, left).toFixed(2)} of factory.heal.dailyCredits ${config.dailyCredits} AI credits left today; a lane needs at least ${RUNTIME_MIN_MAX_CREDITS}` };
    }
    writeHealCounters(root, ledgerDir, { ...counters, credits: counters.credits + capped });
    let settled = false;
    const settle = (credits: number) => {
      if (settled) return;
      settled = true;
      withFileLockSync(lock, () => {
        const c = readHealCounters(root, ledgerDir, now());
        // A reservation of an earlier UTC day went with that day's counters.
        if (c.day !== counters.day) return;
        const spent = Number.isFinite(credits) ? Math.max(0, credits) : capped;
        writeHealCounters(root, ledgerDir, { ...c, credits: Math.max(0, c.credits - capped + spent) });
      }, { timeoutMs: 60_000 });
    };
    return { ok: true, cap: capped, settle };
  }, { timeoutMs: 60_000 });
}

/** AI credits the heal record's debugger lanes spent (a running one at its cap). */
const debugSpent = (s: HealSignatureState) => (s.lanes ?? []).reduce((sum, l) => sum + (l.usage?.credits ?? (l.status === 'running' ? l.maxCredits : 0)), 0);

/**
 * Start or resume the ci-heal run of `sig8` (`heal approve`, `heal cancel`,
 * and `heal run` under factory.heal.autoImplement). A new run needs an open
 * heal run with a valid diagnosis at heal-approve and a matching seal.
 */
export async function runHealEngine(o: HealEngineOptions, deps: HealEngineDeps): Promise<FactoryRunOutcome> {
  const key = healRunKey(o.sig8);
  const s = readHealState(o.root, o.sig8);
  if (!s) throw new HealRunRefused(`no heal signature ${o.sig8}`);
  const seal = verifyHealSeal(deps.ledgerDir, o.root, s);
  if (seal !== 'ok') throw new HealRunRefused(`the heal record of ${o.sig8} does not match the one the heal run wrote (seal: ${seal}); do not act on it`);
  const existing = readFactoryState(o.root, key);
  let record: FactoryHealRecord | undefined;
  if (!existing) {
    if (!s.healRun?.open) throw new HealRunRefused(`heal ${o.sig8} has no open heal run (run omg factory heal run ${o.sig8} first)`);
    if (s.next !== 'heal-approve') throw new HealRunRefused(`heal ${o.sig8} is at ${s.next}; only a valid diagnosis parked at heal-approve starts a ci-heal run`);
    const sealed = readHealSealSubject(deps.ledgerDir, o.root, o.sig8);
    if (!sealed) throw new HealRunRefused(`the heal seal of ${o.sig8} holds no valid classification snapshot; rerun omg factory heal run ${o.sig8}`);
    record = healRecord(s, sealed);
  }
  const { limits, warnings } = deps.limits(o.root);
  for (const w of warnings) deps.warn?.(w);
  const left = Math.floor(o.config.maxRunCredits - debugSpent(s));
  const maxRunCredits = Math.min(limits.maxRunCredits ?? Number.POSITIVE_INFINITY, left);
  if (maxRunCredits < limits.laneMaxCredits) {
    throw new HealRunRefused(`heal ${o.sig8}: the heal run has ${Math.max(0, left)} of factory.heal.maxRunCredits ${o.config.maxRunCredits} AI credits left after its debugger lanes; one lane needs factory.run.laneMaxCredits ${limits.laneMaxCredits}`);
  }
  const outcome = await runFactoryEngine({
    root: o.root,
    exec: deps.exec,
    lanes: deps.lanes(o.root),
    limits: { ...limits, maxRunCredits },
    base: o.base,
    heal: { sig8: o.sig8, ...(record ? { record } : {}), autoImplement: o.config.autoImplement, approved: o.approved, laneCap: healLaneCap(o.root, deps.ledgerDir, o.config, deps.now) },
    ledgerDir: deps.ledgerDir,
    ...(o.dryRun ? { dryRun: true } : {}),
    ...(deps.gateConfig ? { gateConfig: deps.gateConfig } : {}),
    ...(deps.warn ? { warn: deps.warn } : {}),
    ...deps.engine,
  });
  // A merged or cancelled ci-heal run frees the open heal-run slot.
  if (!o.dryRun && (outcome.phase === 'merged' || outcome.phase === 'cancelled')) {
    try { closeHeal(o.root, o.sig8, { ledgerDir: deps.ledgerDir, now: deps.now }); } catch { /* already closed, or a human closes it */ }
  }
  return outcome;
}

export interface KnownFlakyProposal {
  /** The list a human edits by hand, on a reviewed PR (`omg ship merge` refuses an unattended change to it). */
  file: typeof KNOWN_FLAKY_FILE;
  tests: KnownFlakyTest[];
  runs: string[];
}

/** A diagnosis of class `flaky` becomes a printed proposal, never a write and never a heal PR (design §6). */
export function knownFlakyProposal(s: HealSignatureState): KnownFlakyProposal | null {
  if (s.diagnosis?.diagnosis?.class !== 'flaky') return null;
  const seen = new Set<string>();
  const tests: KnownFlakyTest[] = [];
  for (const t of s.classification.jobs.flatMap((j) => j.failingTests)) {
    if (!t.title || seen.has(healTestId(t))) continue;
    seen.add(healTestId(t));
    tests.push({ file: t.file, title: t.title, note: `CI signature ${s.sig8}: a debugger lane called it flaky (runs ${s.seenRuns.slice(-3).join(', ')})` });
  }
  return tests.length > 0 ? { file: KNOWN_FLAKY_FILE, tests, runs: s.seenRuns.slice(-5) } : null;
}

/** The proposal as printed text (the caller makes it terminal-safe). */
export function renderKnownFlakyProposal(p: KnownFlakyProposal): string {
  return [
    `known-flaky proposal (printed only: nothing writes ${p.file}; review it, then add the entries by hand on a PR):`,
    JSON.stringify({ tests: p.tests }, null, 2),
  ].join('\n');
}
