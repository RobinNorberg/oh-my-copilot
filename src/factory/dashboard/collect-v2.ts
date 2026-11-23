/**
 * `omg factory dashboard` data, schemaVersion 2: a pure `collect -> JSON`
 * step (render.ts turns the JSON into the page; a later `--serve` reuses
 * both). LOCAL reads only: run states, owner and slot files, progress-log
 * modification times, the engine ledger, bench result files. No forge or
 * network call and no write of any kind; the tracker columns come in only
 * as an already-read board (`--forge`, the CLI does that read).
 *
 * Trust: each run state is read once and checked like `omg factory
 * attention` checks it (readRun: the seal, then the engine ledger on the
 * same bytes). A run that fails is listed with its trust marker and no free
 * text from its state (no title, no reason), and its numbers are never
 * summed into a total: `cost.excluded` counts them apart. The Attention
 * section IS the attention collector's output (collectAttention), so its
 * rows and their trust rules are the same as the CLI's.
 *
 * Every string from a state, the tracker or a bench file is untrusted: it
 * goes through plainText here and is HTML-escaped again in render.ts.
 */

import { readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import type { ForgeKind } from '../../forge/types.js';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { plainText } from '../check/score.js';
import { attentionJson, collectAttention, readRegularFile, readRun, runKeyOfName, type AttentionData, type AttentionItem, type AttentionTrust } from '../attention/collect.js';
import { ledgerFilePath } from '../run/ledger.js';
import type { BoardJson, BoardRow } from '../board/collect.js';
import type { FactoryRunLimits } from '../run/budget.js';
import { factoryProgressFile } from '../run/progress.js';
import {
  defaultOwnerDeps, FACTORY_PHASES, factoryStateDir, heldSlots, runLabel, TERMINAL_FACTORY_PHASES,
  type FactoryLaneRecord, type FactoryRunKey, type FactoryRunState, type OwnerDeps,
} from '../run/state.js';
import { localDay, parseSince } from './collect.js';

export const DASHBOARD_SCHEMA_VERSION_2 = 2;

const GATE_NOTE = /^awaiting-human: ([^:]+):/;
/** resumed()'s note: the rerun that drops the gate. */
const RERUN_NOTE = /^rerun after awaiting-human: /;
/** A timestamp this far past now is reported as later than now (engine and reader clocks); every time is still clamped to now. */
const FUTURE_SLACK_MS = 60_000;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_BENCH_FILES = 200;
const MAX_BENCH_BYTES = 4_000_000;
const text = (v: unknown, max = 300): string => plainText(String(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
const msOf = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface Usage { credits: number; premiumRequests: number; lanes: number }
const emptyUsage = (): Usage => ({ credits: 0, premiumRequests: 0, lanes: 0 });
function addUsage(into: Usage, u: Usage): void {
  into.credits = round(into.credits + u.credits);
  into.premiumRequests += u.premiumRequests;
  into.lanes += u.lanes;
}

/** One visit to a phase: engine time and time parked at a human gate, apart. */
export interface TimelineStep {
  phase: string;
  engineMs: number;
  waitingMs: number;
  /** The human gates the run parked at during this visit, in order. */
  gates: string[];
}

export interface RunTimeline {
  steps: TimelineStep[];
  engineMs: number;
  waitingMs: number;
  /** Parked now: since when (ISO), else null. */
  waitingSince: string | null;
  /** The first park at the merge gate (ISO), else null. */
  mergeReadyAt: string | null;
  /** Engine time before that first merge park (waiting excluded), else null. */
  engineToMergeReadyMs: number | null;
  /** Time parked at the merge gate in total (to now while still parked there). */
  mergeWaitMs: number;
  /** Why some timestamps were clamped (out of order, or later than now), else null: the spans are bounded, but the run is no sample for medians. */
  clamped: string | null;
}

/**
 * What a history entry does to a park. The engine's writers (src/factory/run/):
 * - `park`: setGate's `awaiting-human: <gate>: <reason>` note (from === to);
 *   a park after a park changes the gate, the wait goes on.
 * - `end`: an entry that clears the gate: a phase move (moveTo, from !== to,
 *   incl. a cancel and markMergedByHuman's merged record) and the resume's
 *   `rerun after awaiting-human: <gate>` note (resumed(), which drops the gate).
 * - `note`: every other from === to note (tracker-sync failures, clean's
 *   --lane-stopped, lane, gate, sandbox and model notes). None of them clears
 *   the gate, so inside a park they are waiting time like the park itself.
 */
function parkEffect(h: { from: string | null; to: string; note?: string }): { kind: 'park'; gate: string } | { kind: 'end' | 'note' } {
  if (h.from === null || h.from !== h.to) return { kind: 'end' };
  const note = String(h.note ?? '');
  const park = GATE_NOTE.exec(note);
  if (park) return { kind: 'park', gate: text(park[1], 60) };
  return RERUN_NOTE.test(note) ? { kind: 'end' } : { kind: 'note' };
}

/**
 * The run's timeline from its history. Each history entry starts a segment
 * that lasts to the next entry. A park note (`awaiting-human: <gate>: ...`,
 * written by setGate) starts WAITING time, which lasts until an entry ends the
 * park (parkEffect: a phase move, a rerun, a human-merge record, a cancel):
 * notes written while parked are waiting time too. While the run is still
 * parked the wait runs to `now`, from `waitingSince` (the later of the last
 * park note and `gate.at`). Every other segment is engine time of the phase
 * the last move entered; a terminal phase ends the run (no segment after it),
 * and the last segment of a run that is neither parked nor finished runs to
 * `updatedAt`. A state whose gate is newer than its last history entry (no
 * park note) waits from `gate.at`.
 *
 * Every time is clamped to `now`, and an entry older than the one before it
 * starts where that one ended: no span is negative or later than now.
 * `clamped` says why when an entry is out of order or later than now (beyond
 * a minute of clock skew).
 *
 * What it cannot tell: an engine that died without a park (the gap to the
 * next invocation counts as engine time), and when a human really merged a
 * PR (the wait ends when a read surface or a rerun recorded it).
 */
export function runTimeline(s: Pick<FactoryRunState, 'history' | 'updatedAt' | 'gate' | 'phase'>, now: number): RunTimeline {
  const entries = (Array.isArray(s.history) ? s.history : []).filter((h) => h && Number.isFinite(msOf(h.at)));
  const steps: TimelineStep[] = [];
  let engineMs = 0;
  let waitingMs = 0;
  let mergeWaitMs = 0;
  let mergeReadyAt: string | null = null;
  let engineToMergeReadyMs: number | null = null;
  let waitingSince: string | null = null;
  const problems = new Set<string>();
  /** A time no later than now (NaN stays NaN). */
  const clamp = (t: number): number => {
    if (t > now + FUTURE_SLACK_MS) problems.add('later than now');
    return Math.min(t, now);
  };
  const stepFor = (phase: string): TimelineStep => {
    const last = steps.at(-1);
    if (last && last.phase === phase) return last;
    const step: TimelineStep = { phase, engineMs: 0, waitingMs: 0, gates: [] };
    steps.push(step);
    return step;
  };
  let phase: string | null = null;
  const parked = s.gate !== undefined && !TERMINAL_FACTORY_PHASES.includes(s.phase);
  const gateAt = clamp(msOf(s.gate?.at));
  /** The gate of the park the run is in at this entry, else null. */
  let waiting: string | null = null;
  let parkStart = Number.NaN;
  let cursor = Number.NEGATIVE_INFINITY;
  let lastStart = Number.NaN;
  for (let i = 0; i < entries.length; i++) {
    const h = entries[i];
    const effect = parkEffect(h);
    if (effect.kind !== 'park' || phase === null) phase = text(h.to, 40);
    if (TERMINAL_FACTORY_PHASES.includes(h.to)) {
      stepFor(phase);
      break;
    }
    let start = clamp(msOf(h.at));
    if (start < cursor) {
      problems.add('out of order');
      start = cursor;
    }
    lastStart = start;
    if (effect.kind === 'park') waiting = effect.gate;
    else if (effect.kind === 'end') waiting = null;
    const lastEntry = i === entries.length - 1;
    let end: number;
    if (!lastEntry) end = clamp(msOf(entries[i + 1].at));
    else if (waiting !== null && parked) end = now;
    else if (parked && Number.isFinite(gateAt) && gateAt > start) end = gateAt;
    else end = clamp(msOf(s.updatedAt));
    const span = Number.isFinite(end) && end > start ? end - start : 0;
    cursor = start + span;
    const step = stepFor(phase);
    if (effect.kind === 'park') {
      step.gates.push(effect.gate);
      parkStart = start;
      if (effect.gate === 'merge' && mergeReadyAt === null) {
        mergeReadyAt = new Date(start).toISOString();
        engineToMergeReadyMs = engineMs;
      }
    }
    if (waiting !== null) {
      step.waitingMs += span;
      waitingMs += span;
      if (waiting === 'merge') mergeWaitMs += span;
    } else {
      step.engineMs += span;
      engineMs += span;
    }
  }
  if (parked && waiting !== null) {
    waitingSince = new Date(Number.isFinite(gateAt) && gateAt > parkStart ? gateAt : parkStart).toISOString();
  } else if (parked && Number.isFinite(gateAt) && !(gateAt <= lastStart)) {
    // A gate with no park note after the last entry (older writers): waiting from gate.at.
    const gate = text(s.gate!.name, 60);
    const step = stepFor(phase ?? text(s.phase, 40));
    const span = Math.max(0, now - gateAt);
    step.gates.push(gate);
    step.waitingMs += span;
    waitingMs += span;
    waitingSince = new Date(gateAt).toISOString();
    if (gate === 'merge') {
      mergeWaitMs += span;
      if (mergeReadyAt === null) { mergeReadyAt = waitingSince; engineToMergeReadyMs = engineMs; }
    }
  }
  return { steps, engineMs, waitingMs, waitingSince, mergeReadyAt, engineToMergeReadyMs, mergeWaitMs, clamped: problems.size ? [...problems].join(', ') : null };
}

export interface DashboardRunV2 {
  key: string;
  kind: 'issue' | 'ci-heal';
  trust: AttentionTrust;
  /** False: the state is not the engine's last write (or cannot be checked); no free text and no numbers from it below. */
  verified: boolean;
  title: string;
  phase: string | null;
  gate: { name: string; reason: string; at: string } | null;
  outcome: 'merged' | 'cancelled' | 'failed' | 'parked' | 'in-progress' | 'unknown';
  pr: number | null;
  head: string | null;
  forge: ForgeKind | null;
  credits: number | null;
  premiumRequests: number | null;
  lanes: number | null;
  roles: Record<string, Usage>;
  startedAt: string | null;
  updatedAt: string | null;
  /** The engine's own wall-time counter across invocations. */
  elapsedMs: number | null;
  /** From the history (runTimeline): engine time and waiting-on-human time, apart. */
  engineMs: number | null;
  waitingMs: number | null;
  waitingSince: string | null;
  timeline: TimelineStep[];
  mergeReadyAt: string | null;
  engineToMergeReadyMs: number | null;
  mergeWaitMs: number | null;
}

export interface DashboardTask {
  key: string;
  verified: boolean;
  title: string;
  phase: string | null;
  gate: string | null;
  outcome: DashboardRunV2['outcome'] | 'no run';
  pr: number | null;
  credits: number | null;
  /** First history entry to the last one (or to now while parked). */
  wallMs: number | null;
  /** `--forge` only (from the board): the check bucket and the tracker's live stage. */
  tracker: { bucket: string | null; stage: string | null; liveText: string | null } | null;
}

export interface DashboardBenchV2 {
  /** `bench-results` (the repository's) or `bench-dir` (--bench-dir). */
  source: 'bench-results' | 'bench-dir';
  file: string;
  schemaVersion: number | null;
  mode: string | null;
  omgVersion: string | null;
  model: string | null;
  startedAt: string | null;
  issues: number | null;
  passed: number | null;
  premiumRequests: number | null;
  credits: number | null;
  wallMs: number | null;
  /** The numeric fields the file holds as something other than a finite number >= 0 (shown as "invalid"); absent when none. */
  invalid?: string[];
}

/**
 * Bench result files are UNSEALED and live in the repository (or a
 * --bench-dir): anyone who can write the repository can edit them. Their
 * text fields are shown only when they are plain words of BENCH_TEXT (else
 * BENCH_NOT_SHOWN), their numbers only when finite and >= 0.
 */
export const BENCH_TEXT = /^[A-Za-z0-9._ -]+$/;
export const BENCH_NOT_SHOWN = '(not shown)';
export const BENCH_UNSEALED_NOTE = 'Unsealed files in the repository (anyone who can write the repository can edit them).';
const benchText = (v: string, max: number): string => (v.length <= max && BENCH_TEXT.test(v) ? v : BENCH_NOT_SHOWN);

export interface DashboardDataV2 {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION_2;
  generatedAt: string;
  since: string | null;
  /** Whether tracker data was read (`--forge`), and when. */
  forge: { read: boolean; at: string | null };
  /** `omg factory attention --json`'s object (attentionJson). */
  attention: { schemaVersion: number; repo: string; forge: string | null; generatedAt: string; summary: AttentionData['summary']; items: Omit<AttentionItem, 'at'>[]; warnings: string[] };
  live: {
    engines: number;
    slots: number;
    runs: { key: string; verified: boolean; phase: string | null; lane: { id: string; kind: string; startedAt: string; maxCredits: number } | null; heartbeatAgeMs: number | null; credits: number | null; inFlightCredits: number }[];
    /** The credit caps of the lanes running now (what they may still spend at most). */
    inFlightCredits: number;
  };
  runs: DashboardRunV2[];
  tasks: DashboardTask[];
  cost: {
    caps: { laneMaxCredits: number | null; maxRunCredits: number | null; source: 'config' | 'unresolved'; note: string };
    totals: Usage;
    byRole: ({ role: string } & Usage)[];
    byDay: ({ day: string } & Usage)[];
    byRun: { key: string; credits: number; premiumRequests: number; cap: number | null }[];
    /**
     * Runs whose state is not verified, never in the totals above. Their own
     * numbers are not shown at all (an unverified state's claims are not data).
     * `missing`: of those, runs the engine ledger records whose state file is gone.
     */
    excluded: { runs: number; missing: number };
  };
  throughput: {
    byDay: { day: string; started: number; mergeReady: number }[];
    engineToMergeReady: { runs: number; medianMs: number | null; p90Ms: number | null };
    waitingAtMerge: { runs: number; medianMs: number | null };
    /** The --since both the medians and the per-day counts apply: a run is in the medians when it reached the merge park on or after it. */
    since: string | null;
    /** Runs left out of the medians because their history timestamps were clamped (runTimeline `clamped`). */
    excludedRuns: number;
  };
  bench: DashboardBenchV2[];
  warnings: string[];
}

export interface CollectDashboardV2Options {
  ledgerDir: string;
  since?: string;
  now?: () => number;
  /** The run limits as the engine would resolve them from config (null: could not be resolved). */
  limits?: FactoryRunLimits | null;
  owner?: OwnerDeps;
  /** Extra bench result directories (--bench-dir). */
  benchDirs?: readonly string[];
  /** `--forge` only: the board, already read by the CLI, and when. */
  board?: { json: BoardJson; at: string } | null;
}

const forgeOf = (s: FactoryRunState): ForgeKind => (s.remote === LOCAL_REMOTE ? 'local' : s.forgeKind ?? 'github');
const laneAt = (l: FactoryLaneRecord): number => msOf(l.endedAt ?? l.startedAt);

function laneUsage(l: FactoryLaneRecord): Usage {
  return { credits: num(l.usage?.credits) ?? 0, premiumRequests: num(l.usage?.premiumRequests) ?? 0, lanes: 1 };
}

function outcomeOf(s: FactoryRunState): DashboardRunV2['outcome'] {
  if (s.phase === 'merged' || s.phase === 'cancelled' || s.phase === 'failed') return s.phase;
  return s.gate ? 'parked' : 'in-progress';
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

function unverifiedRun(key: FactoryRunKey, trust: AttentionTrust, s: FactoryRunState | undefined): DashboardRunV2 {
  // Only enum-shaped values of an untrusted state: no title, no reason, no numbers.
  const phase = s && (FACTORY_PHASES as readonly string[]).includes(s.phase) ? s.phase : null;
  const gateName = s?.gate && typeof s.gate.name === 'string' && SAFE_NAME.test(s.gate.name) ? s.gate.name : null;
  return {
    key: runLabel(key), kind: typeof key === 'string' ? 'ci-heal' : 'issue', trust, verified: false, title: '', phase,
    gate: gateName ? { name: gateName, reason: '', at: '' } : null, outcome: 'unknown', pr: null, head: null, forge: null,
    credits: null, premiumRequests: null, lanes: null, roles: {}, startedAt: null, updatedAt: null, elapsedMs: null,
    engineMs: null, waitingMs: null, waitingSince: null, timeline: [], mergeReadyAt: null, engineToMergeReadyMs: null, mergeWaitMs: null,
  };
}

function verifiedRun(key: FactoryRunKey, s: FactoryRunState, now: number, sinceMs: number | null): { run: DashboardRunV2; clamped: string | null } {
  const roles = Object.create(null) as Record<string, Usage>;
  const total = emptyUsage();
  for (const lane of s.lanes) {
    if (sinceMs !== null && !(laneAt(lane) >= sinceMs)) continue;
    const u = laneUsage(lane);
    addUsage((roles[text(lane.role ?? lane.kind, 40)] ??= emptyUsage()), u);
    addUsage(total, u);
  }
  const tl = runTimeline(s, now);
  const run: DashboardRunV2 = {
    key: runLabel(key),
    kind: s.kind ?? 'issue',
    trust: 'ok',
    verified: true,
    title: text(s.issueTitle ?? (s.kind === 'ci-heal' ? 'ci-heal' : ''), 160),
    phase: text(s.phase, 40),
    gate: s.gate ? { name: text(s.gate.name, 60), reason: text(s.gate.reason, 600), at: text(s.gate.at, 40) } : null,
    outcome: outcomeOf(s),
    pr: typeof s.pr === 'number' && Number.isSafeInteger(s.pr) && s.pr > 0 ? s.pr : null,
    head: typeof s.head === 'string' && HEX40.test(s.head) ? s.head : null,
    forge: forgeOf(s),
    credits: total.credits,
    premiumRequests: total.premiumRequests,
    lanes: total.lanes,
    roles: { ...roles },
    startedAt: text(s.createdAt, 40),
    updatedAt: text(s.updatedAt, 40),
    elapsedMs: num(s.elapsedMs) ?? 0,
    engineMs: tl.engineMs,
    waitingMs: tl.waitingMs,
    waitingSince: tl.waitingSince,
    timeline: tl.steps,
    mergeReadyAt: tl.mergeReadyAt,
    engineToMergeReadyMs: tl.engineToMergeReadyMs,
    mergeWaitMs: tl.mergeWaitMs,
  };
  return { run, clamped: tl.clamped };
}

/** One bench result file as a row; null when it is not one (a run-state copy, notes). Throws on a file that cannot be read. */
function benchRow(path: string, file: string, source: DashboardBenchV2['source']): DashboardBenchV2 | null {
  // lstat first, regular files only, bounded: a link, directory, FIFO or device named *.json is never opened.
  const r = readRegularFile(path, MAX_BENCH_BYTES);
  if ('missing' in r) return null;
  if ('error' in r) throw new Error(r.error);
  const j = JSON.parse(r.bytes.toString('utf8')) as Record<string, unknown> | null;
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const totals = (typeof j.totals === 'object' && j.totals !== null && !Array.isArray(j.totals) ? j.totals : null) as Record<string, unknown> | null;
  // A bench result names its kind, or (older writers) carries totals; anything else in the directory is not one.
  if (j.kind !== 'omg-factory-bench' && !totals) return null;
  const t = totals ?? {};
  const invalid: string[] = [];
  const count = (field: string, v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    invalid.push(field);
    return null;
  };
  const runs = Array.isArray(j.runs) ? j.runs : Array.isArray(j.issues) ? j.issues : null;
  const started = j.startedAt ?? j.createdAt ?? j.timestamp;
  // A negative wall time (finishedAt before startedAt) is no wall time: null.
  const w = count('wallMs', t.wallMs) ?? msOf(j.finishedAt) - msOf(started);
  const wall = Number.isFinite(w) && w >= 0 ? w : null;
  const model = typeof j.model === 'string' ? j.model : typeof (j.model as { id?: unknown } | null)?.id === 'string' ? (j.model as { id: string }).id : null;
  return {
    source,
    file: benchText(file, 120),
    schemaVersion: count('schemaVersion', j.schemaVersion),
    mode: typeof j.mode === 'string' ? benchText(j.mode, 30) : null,
    omgVersion: typeof j.omgVersion === 'string' ? benchText(j.omgVersion, 30) : null,
    model: model === null ? null : benchText(model, 60),
    startedAt: typeof started === 'string' && Number.isFinite(msOf(started)) ? new Date(msOf(started)).toISOString() : null,
    issues: count('issues', t.issues) ?? (runs ? runs.length : null),
    passed: count('passed', t.passed),
    premiumRequests: count('premiumRequests', t.premiumRequests),
    credits: count('credits', t.credits),
    wallMs: wall,
    ...(invalid.length ? { invalid } : {}),
  };
}

/** Bench results from `<root>/bench-results/` and every --bench-dir; one row per result file, oldest first. */
export function readBenchV2(root: string, dirs: readonly string[], warnings: string[]): DashboardBenchV2[] {
  const out: DashboardBenchV2[] = [];
  const sources: [string, DashboardBenchV2['source']][] = [[join(root, 'bench-results'), 'bench-results'], ...dirs.map((d): [string, DashboardBenchV2['source']] => [d, 'bench-dir'])];
  for (const [dir, source] of sources) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().slice(-MAX_BENCH_FILES);
    } catch {
      if (source === 'bench-dir') warnings.push(`--bench-dir ${text(dir, 200)}: not a readable directory`);
      continue;
    }
    let skipped = 0;
    for (const name of names) {
      try {
        const row = benchRow(join(dir, name), name, source);
        if (row) out.push(row);
        else skipped++;
      } catch (error) {
        warnings.push(`${source}/${text(name, 120)}: skipped (${text(error instanceof Error ? error.message : error, 120)})`);
      }
    }
    if (skipped > 0 && source === 'bench-results') warnings.push(`bench-results: ${skipped} JSON file(s) are not bench results and were skipped`);
  }
  return out.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.file.localeCompare(b.file));
}

function boardRows(b: BoardJson): BoardRow[] {
  return [...b.columns.flatMap((c) => c.items), ...b.outside];
}

export function collectDashboardV2(root: string, o: CollectDashboardV2Options): DashboardDataV2 {
  const now = (o.now ?? Date.now)();
  const sinceMs = o.since === undefined ? null : parseSince(o.since);
  const owner = o.owner ?? defaultOwnerDeps();
  const warnings: string[] = [];
  const attention = collectAttention(root, { ledgerDir: o.ledgerDir, now: () => now, limits: o.limits ?? null, owner, verbose: true });

  // Every canonical run state, checked as attention checks it.
  let names: string[] = [];
  try {
    names = readdirSync(factoryStateDir(root));
  } catch {
    // No state dir: no runs yet.
  }
  /** Every verified state, --since or not (Live now always shows the present). */
  const allStates = new Map<string, FactoryRunState>();
  const states = new Map<string, FactoryRunState>();
  const runs: DashboardRunV2[] = [];
  /** Runs whose timeline was clamped: kept out of the throughput medians. */
  const clampedRuns = new Set<string>();
  const excluded = { runs: 0, missing: 0 };
  for (const name of names) {
    const key = runKeyOfName(name);
    if (key === null) continue;
    const r = readRun(root, key, o.ledgerDir);
    if (r.trust !== 'ok' || !r.state) {
      // An unreadable state is already one of attention's warnings. Nothing it claims (credits, requests) is counted or shown.
      runs.push(unverifiedRun(key, r.trust, r.state));
      excluded.runs++;
      continue;
    }
    const s = r.state;
    allStates.set(runLabel(key), s);
    if (sinceMs !== null && msOf(s.updatedAt) < sinceMs) continue;
    try {
      const v = verifiedRun(key, s, now, sinceMs);
      runs.push(v.run);
      states.set(runLabel(key), s);
      if (v.clamped) {
        clampedRuns.add(v.run.key);
        warnings.push(`run ${v.run.key}: history timestamps ${v.clamped}; its times are clamped to now and to the entry before, and the run is left out of the throughput medians`);
      }
    } catch (error) {
      warnings.push(`run ${runLabel(key)}: skipped (${text(error instanceof Error ? error.message : error, 160)})`);
    }
  }
  // Runs the engine ledger records whose state file is gone: attention lists them (trust missing); a row here, never in a total.
  const stateKeys = new Set(names.map(runKeyOfName).filter((k) => k !== null).map((k) => runLabel(k)));
  const missingLabels = new Set(attention.items.filter((i) => i.trust === 'missing').map((i) => i.key));
  let ledgerNames: string[] = [];
  try {
    ledgerNames = readdirSync(dirname(ledgerFilePath(o.ledgerDir, root, 1)));
  } catch {
    // No ledger dir: nothing is missing.
  }
  for (const name of ledgerNames) {
    const key = runKeyOfName(name);
    if (key === null || stateKeys.has(runLabel(key)) || !missingLabels.has(runLabel(key))) continue;
    runs.push(unverifiedRun(key, 'missing', undefined));
    excluded.runs++;
    excluded.missing++;
  }
  const startedMs = (r: DashboardRunV2): number => msOf(r.startedAt);
  runs.sort((a, b) => (Number(b.verified) - Number(a.verified)) || (startedMs(b) || 0) - (startedMs(a) || 0) || b.key.localeCompare(a.key, 'en', { numeric: true }));
  const verified = runs.filter((r) => r.verified);

  // Live now: the engines attention counted, and the running lane of each run they hold.
  const liveRuns = attention.summary.engines.runs.map((label) => {
    const s = allStates.get(label);
    if (!s) return { key: label, verified: false, phase: null, lane: null, heartbeatAgeMs: null, credits: null, inFlightCredits: 0 };
    const running = s.lanes.filter((l) => l.status === 'running').at(-1);
    let heartbeatAgeMs: number | null = null;
    try {
      heartbeatAgeMs = Math.max(0, now - statSync(factoryProgressFile(root, label.startsWith('#') ? Number(label.slice(1)) : (label as FactoryRunKey))).mtimeMs);
    } catch {
      // No progress log: no heartbeat.
    }
    const inFlight = running ? num(running.maxCredits) ?? 0 : 0;
    return {
      key: label, verified: true, phase: text(s.phase, 40),
      lane: running ? { id: text(running.id, 80), kind: text(running.role ?? running.kind, 40), startedAt: text(running.startedAt, 40), maxCredits: inFlight } : null,
      heartbeatAgeMs, credits: round(s.lanes.reduce((a, l) => a + laneUsage(l).credits, 0)), inFlightCredits: inFlight,
    };
  });
  let slots = 0;
  try {
    slots = heldSlots(root, owner).length;
  } catch {
    // Unreadable slots dir: none counted.
  }

  // Cost, from verified runs only.
  const totals = emptyUsage();
  const roles = new Map<string, Usage>();
  const days = new Map<string, Usage>();
  const cap = o.limits?.maxRunCredits ?? null;
  for (const r of verified) {
    addUsage(totals, { credits: r.credits ?? 0, premiumRequests: r.premiumRequests ?? 0, lanes: r.lanes ?? 0 });
    for (const [role, u] of Object.entries(r.roles)) {
      const into = roles.get(role) ?? emptyUsage();
      addUsage(into, u);
      roles.set(role, into);
    }
  }
  for (const s of states.values()) {
    for (const lane of s.lanes) {
      const t = laneAt(lane);
      if (!Number.isFinite(t) || (sinceMs !== null && t < sinceMs)) continue;
      const day = localDay(t);
      const into = days.get(day) ?? emptyUsage();
      addUsage(into, laneUsage(lane));
      days.set(day, into);
    }
  }

  // Throughput: runs started and runs reaching the merge park, per local day.
  const through = new Map<string, { started: number; mergeReady: number }>();
  const bump = (iso: string | null, field: 'started' | 'mergeReady'): void => {
    const t = msOf(iso);
    if (!Number.isFinite(t) || (sinceMs !== null && t < sinceMs)) return;
    const day = localDay(t);
    const into = through.get(day) ?? { started: 0, mergeReady: 0 };
    into[field]++;
    through.set(day, into);
  };
  for (const r of verified) {
    bump(r.startedAt, 'started');
    bump(r.mergeReadyAt, 'mergeReady');
  }
  // The medians: runs that reached the merge park on or after --since (as the per-day counts), timelines not clamped.
  const samples = verified.filter((r) => r.mergeReadyAt !== null && (sinceMs === null || msOf(r.mergeReadyAt) >= sinceMs));
  const sampled = samples.filter((r) => !clampedRuns.has(r.key));
  const toMerge = sampled.flatMap((r) => (r.engineToMergeReadyMs === null ? [] : [r.engineToMergeReadyMs]));
  const mergeWaits = sampled.map((r) => r.mergeWaitMs ?? 0);

  // Tasks: one row per run, the tracker columns only from an already-read board (--forge).
  const board = o.board ? new Map(boardRows(o.board.json).map((b) => [runLabel(b.id), b])) : null;
  const tasks: DashboardTask[] = runs.map((r) => {
    const b = board?.get(r.key);
    const lastAt = r.waitingSince ? now : Math.min(now, msOf(r.updatedAt));
    return {
      key: r.key, verified: r.verified, title: r.title, phase: r.phase, gate: r.gate?.name ?? null, outcome: r.outcome, pr: r.pr, credits: r.credits,
      wallMs: r.verified && Number.isFinite(lastAt - startedMs(r)) ? Math.max(0, lastAt - startedMs(r)) : null,
      tracker: board ? { bucket: b?.check ? text(b.check.bucket, 30) : null, stage: b?.stage.live ? text(b.stage.live, 30) : null, liveText: b?.liveText ? text(b.liveText, 80) : null } : null,
    };
  });
  if (o.board) {
    for (const b of o.board.json.columns.find((c) => c.stage === 'backlog')?.items ?? []) {
      if (board && runs.some((r) => r.key === runLabel(b.id))) continue;
      tasks.push({
        key: runLabel(b.id), verified: false, title: text(b.title, 160), phase: null, gate: null, outcome: 'no run', pr: null, credits: null, wallMs: null,
        tracker: { bucket: b.check ? text(b.check.bucket, 30) : null, stage: b.stage.live ? text(b.stage.live, 30) : null, liveText: b.liveText ? text(b.liveText, 80) : null },
      });
    }
    warnings.push(...o.board.json.warnings.map((w) => text(w, 500)));
  }

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION_2,
    generatedAt: new Date(now).toISOString(),
    since: o.since === undefined ? null : text(o.since, 40),
    forge: { read: Boolean(o.board), at: o.board ? text(o.board.at, 40) : null },
    attention: attentionJson(attention) as DashboardDataV2['attention'],
    live: { engines: attention.summary.engines.live, slots, runs: liveRuns, inFlightCredits: round(liveRuns.reduce((a, r) => a + r.inFlightCredits, 0)) },
    runs,
    tasks,
    cost: {
      caps: o.limits
        ? { laneMaxCredits: o.limits.laneMaxCredits, maxRunCredits: cap, source: 'config', note: 'defaults < trusted user config < project config, as the engine resolves them; at run time the base branch\'s committed config (the trusted-base layer) and --max-requests may lower them' }
        : { laneMaxCredits: null, maxRunCredits: null, source: 'unresolved', note: 'the run limits could not be resolved; no cap is shown' },
      totals,
      byRole: [...roles].map(([role, u]) => ({ role, ...u })).sort((a, b) => b.credits - a.credits || a.role.localeCompare(b.role)),
      byDay: [...days].map(([day, u]) => ({ day, ...u })).sort((a, b) => a.day.localeCompare(b.day)),
      byRun: verified.map((r) => ({ key: r.key, credits: r.credits ?? 0, premiumRequests: r.premiumRequests ?? 0, cap: r.kind === 'issue' ? cap : null })),
      excluded,
    },
    throughput: {
      byDay: [...through].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
      engineToMergeReady: { runs: toMerge.length, medianMs: median(toMerge), p90Ms: quantile(toMerge, 0.9) },
      waitingAtMerge: { runs: mergeWaits.length, medianMs: median(mergeWaits) },
      since: o.since === undefined ? null : text(o.since, 40),
      excludedRuns: samples.length - sampled.length,
    },
    bench: readBenchV2(root, o.benchDirs ?? [], warnings).filter((b) => sinceMs === null || b.startedAt === null || msOf(b.startedAt) >= sinceMs),
    warnings: [...attention.warnings, ...warnings].map((w) => text(w, 500)),
  };
}
