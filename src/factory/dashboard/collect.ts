/**
 * `omg factory dashboard` data (goal 6): everything comes from LOCAL state,
 * the sealed run states under `.omg/state/factory/` (finished runs stay there)
 * and optional `bench-results/*.json`. No forge or network call.
 *
 * Every string taken from a run (issue title, park reason, finding text) is
 * untrusted, so it goes through plainText here and is HTML-escaped again at
 * render time (render.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { plainText } from '../check/score.js';
import { readRuns } from '../board/collect.js';
import { FACTORY_PHASES, runKeyOf, runLabel, type FactoryLaneKind, type FactoryRunState } from '../run/state.js';

export const DASHBOARD_SCHEMA_VERSION = 1;

const GATE_NOTE = /^awaiting-human: ([^:]+):/;
const MAX_BENCH_FILES = 50;
const MAX_BENCH_BYTES = 1_000_000;
const MAX_BENCH_ISSUES = 100;
const text = (v: unknown, max = 300): string => plainText(String(v)).slice(0, max);

export interface UsageTotals {
  credits: number;
  premiumRequests: number;
  lanes: number;
}

export interface DashboardRun extends UsageTotals {
  key: string;
  kind: 'issue' | 'ci-heal';
  title: string;
  phase: string;
  gate: { name: string; reason: string } | null;
  pr: number | null;
  createdAt: string;
  updatedAt: string;
  /** Engine wall time across invocations. */
  elapsedMs: number;
  /** Time spent in each phase, from the run history (the last phase runs to updatedAt). */
  phaseMs: Record<string, number>;
  /** Credits and requests per lane role. */
  roles: Record<string, UsageTotals>;
  /** Names of every human gate the run parked at (repeats kept). */
  parks: string[];
}

export interface DashboardBench {
  file: string;
  schemaVersion: number;
  createdAt: string | null;
  mode: string | null;
  /** Scalar entries of the file's `totals` object. */
  totals: Record<string, string | number | boolean>;
  /** Up to MAX_BENCH_ISSUES rows with an id and an outcome, when the file has an `issues` array. */
  issues: { id: string; outcome: string; expect: string | null }[];
}

export interface DashboardData {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  generatedAt: string;
  since: string | null;
  runs: DashboardRun[];
  totals: UsageTotals & { runs: number; elapsedMs: number };
  statuses: { phase: string; count: number }[];
  parkReasons: { name: string; count: number }[];
  phaseMs: { phase: string; ms: number }[];
  byRole: ({ role: string } & UsageTotals)[];
  byDay: ({ day: string } & UsageTotals)[];
  bench: DashboardBench[];
  warnings: string[];
}

const emptyUsage = (): UsageTotals => ({ credits: 0, premiumRequests: 0, lanes: 0 });
const round = (n: number): number => Math.round(n * 1000) / 1000;

function add(into: UsageTotals, credits: number, premiumRequests: number): void {
  into.credits = round(into.credits + credits);
  into.premiumRequests += premiumRequests;
  into.lanes += 1;
}

const ms = (iso: string): number => Date.parse(iso);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const laneTime = (lane: { endedAt?: string; startedAt: string }): number => ms(lane.endedAt ?? lane.startedAt);
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Local calendar day (YYYY-MM-DD) of a timestamp. */
const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** A lane's usage as numbers; a value that is not a finite number counts as 0 and adds a warning. */
function laneUsage(lane: FactoryRunState['lanes'][number], warnings: string[]): { credits: number; requests: number } {
  const credits = lane.usage?.credits === undefined ? 0 : num(lane.usage.credits);
  const requests = lane.usage?.premiumRequests === undefined ? 0 : num(lane.usage.premiumRequests);
  if (credits === null || requests === null) warnings.push(`lane ${text(lane.id, 40)}: usage is not numeric, counted as 0`);
  return { credits: credits ?? 0, requests: requests ?? 0 };
}
const isParkNote = (h: { from: string | null; to: string }): boolean => h.from !== null && h.from === h.to;

/** Milliseconds per phase: each transition runs until the next one; the last runs to updatedAt (nothing once terminal). Park notes are not transitions. */
export function phaseDurations(s: Pick<FactoryRunState, 'history' | 'updatedAt'>): Record<string, number> {
  const out: Record<string, number> = {};
  const moves = s.history.filter((h) => !isParkNote(h));
  for (let i = 0; i < moves.length; i++) {
    const last = i === moves.length - 1;
    if (last && (moves[i].to === 'merged' || moves[i].to === 'cancelled' || moves[i].to === 'failed')) continue;
    const start = ms(moves[i].at);
    const end = last ? ms(s.updatedAt) : ms(moves[i + 1].at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out[moves[i].to] = (out[moves[i].to] ?? 0) + (end - start);
  }
  return out;
}

export function summarizeRun(s: FactoryRunState, o: { sinceMs?: number | null; warnings?: string[] } = {}): DashboardRun {
  const roles = Object.create(null) as Record<string, UsageTotals>;
  const total = emptyUsage();
  const warnings = o.warnings ?? [];
  for (const lane of s.lanes) {
    if (o.sinceMs != null) {
      const t = laneTime(lane);
      if (!Number.isFinite(t) || t < o.sinceMs) continue;
    }
    const role: FactoryLaneKind = lane.role ?? lane.kind;
    const { credits, requests } = laneUsage(lane, warnings);
    add((roles[text(role, 40)] ??= emptyUsage()), credits, requests);
    add(total, credits, requests);
  }
  const parks = s.history.flatMap((h) => GATE_NOTE.exec(h.note)?.[1] ?? []).map((n) => text(n, 60));
  return {
    key: runLabel(runKeyOf(s)),
    kind: s.kind ?? 'issue',
    title: text(s.issueTitle ?? (s.heal ? 'ci-heal' : ''), 160),
    phase: s.phase,
    gate: s.gate ? { name: text(s.gate.name, 60), reason: text(s.gate.reason) } : null,
    pr: typeof s.pr === 'number' ? s.pr : null,
    createdAt: text(s.createdAt, 40),
    updatedAt: text(s.updatedAt, 40),
    elapsedMs: Number.isFinite(s.elapsedMs) ? s.elapsedMs : 0,
    phaseMs: phaseDurations(s),
    roles: { ...roles },
    parks,
    ...total,
  };
}

function scalarEntries(v: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, 40)) {
    if (typeof val === 'number' || typeof val === 'boolean') out[text(k, 60)] = val;
    else if (typeof val === 'string') out[text(k, 60)] = text(val, 120);
  }
  return out;
}

/** Read `bench-results/*.json`: a file counts when it parses and carries a numeric `schemaVersion`; anything else is skipped with a warning. */
export function readBenchResults(root: string, warnings: string[]): DashboardBench[] {
  const dir = join(root, 'bench-results');
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().slice(-MAX_BENCH_FILES);
  } catch {
    return [];
  }
  const out: DashboardBench[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (statSync(path).size > MAX_BENCH_BYTES) throw new Error('larger than 1 MB');
      const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
      if (typeof j !== 'object' || j === null || typeof j.schemaVersion !== 'number') throw new Error('no numeric schemaVersion');
      const rows = Array.isArray(j.issues) ? j.issues.slice(0, MAX_BENCH_ISSUES) : [];
      const issues = rows.flatMap((r) => {
        const o = r as Record<string, unknown> | null;
        if (typeof o !== 'object' || o === null) return [];
        const id = o.id ?? o.issue ?? o.key;
        const outcome = o.outcome ?? o.result ?? o.status;
        if ((typeof id !== 'string' && typeof id !== 'number') || (typeof outcome !== 'string' && typeof outcome !== 'boolean')) return [];
        return [{ id: text(id, 60), outcome: text(outcome, 60), expect: typeof o.expect === 'string' ? text(o.expect, 60) : null }];
      });
      const stamp = j.createdAt ?? j.timestamp ?? j.startedAt;
      out.push({
        file: text(name, 120),
        schemaVersion: j.schemaVersion,
        createdAt: typeof stamp === 'string' ? text(stamp, 40) : null,
        mode: typeof j.mode === 'string' ? text(j.mode, 30) : null,
        totals: scalarEntries(j.totals),
        issues,
      });
    } catch (error) {
      warnings.push(`bench-results/${text(name, 120)}: skipped (${text(error instanceof Error ? error.message : error, 120)})`);
    }
  }
  return out;
}

/** Parse `--since`: a date (`2026-11-01`, local midnight) or an ISO timestamp. */
export function parseSince(value: string): number {
  const v = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const t = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime() : Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || !Number.isFinite(t)) throw new Error(`--since must be a date like 2026-11-01, got ${JSON.stringify(value)}`);
  return t;
}

export function collectDashboard(root: string, o: { since?: string; now?: () => Date } = {}): DashboardData {
  const warnings: string[] = [];
  const sinceMs = o.since === undefined ? null : parseSince(o.since);
  const { runs: states } = readRuns(root, warnings);
  const inRange = [...states.values()].filter((s) => sinceMs === null || !(ms(s.updatedAt) < sinceMs));
  const summarized: { s: FactoryRunState; r: DashboardRun }[] = [];
  for (const s of inRange) {
    try {
      summarized.push({ s, r: summarizeRun(s, { sinceMs, warnings }) });
    } catch (error) {
      warnings.push(`run ${text(s.issue, 40)}: skipped (${text(error instanceof Error ? error.message : error, 120)})`);
    }
  }
  const runs = summarized
    .map((x) => x.r)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.key.localeCompare(b.key)));

  const totals = { ...emptyUsage(), runs: runs.length, elapsedMs: 0 };
  const statuses = new Map<string, number>();
  const parks = new Map<string, number>();
  const phases = new Map<string, number>();
  const roles = new Map<string, UsageTotals>();
  const days = new Map<string, UsageTotals>();
  for (const r of runs) {
    totals.credits = round(totals.credits + r.credits);
    totals.premiumRequests += r.premiumRequests;
    totals.lanes += r.lanes;
    totals.elapsedMs += r.elapsedMs;
    const status = r.gate ? `awaiting-human: ${r.gate.name}` : r.phase;
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    for (const p of r.parks) parks.set(p, (parks.get(p) ?? 0) + 1);
    for (const [p, v] of Object.entries(r.phaseMs)) phases.set(p, (phases.get(p) ?? 0) + v);
    for (const [role, u] of Object.entries(r.roles)) {
      const into = roles.get(role) ?? emptyUsage();
      into.credits = round(into.credits + u.credits);
      into.premiumRequests += u.premiumRequests;
      into.lanes += u.lanes;
      roles.set(role, into);
    }
  }
  // Per day: by the lane's end (else start) time.
  for (const { s } of summarized) {
    for (const lane of s.lanes) {
      const t = laneTime(lane);
      if (!Number.isFinite(t) || (sinceMs !== null && t < sinceMs)) continue;
      const day = localDay(t);
      const into = days.get(day) ?? emptyUsage();
      const u = laneUsage(lane, []);
      add(into, u.credits, u.requests);
      days.set(day, into);
    }
  }
  const order = (p: string): number => { const i = (FACTORY_PHASES as readonly string[]).indexOf(p); return i < 0 ? 99 : i; };
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    generatedAt: (o.now?.() ?? new Date()).toISOString(),
    since: o.since === undefined ? null : text(o.since, 40),
    runs,
    totals,
    statuses: [...statuses].map(([phase, count]) => ({ phase, count })).sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase)),
    parkReasons: [...parks].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    phaseMs: [...phases].map(([phase, v]) => ({ phase, ms: v })).sort((a, b) => order(a.phase) - order(b.phase)),
    byRole: [...roles].map(([role, u]) => ({ role, ...u })).sort((a, b) => b.credits - a.credits || a.role.localeCompare(b.role)),
    byDay: [...days].map(([day, u]) => ({ day, ...u })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    bench: readBenchResults(root, warnings),
    warnings,
  };
}
