/**
 * Stale-gate reminders (night-3 goal 5), one self-contained step of
 * `omg factory poll`. A run parked at a human gate (awaiting-human) for longer
 * than `factory.poll.remindAfterHours` (default 24; 0 = off) is reminded at
 * most once per window, mentioning the routing handles of the paths its plan
 * names. READ-ONLY on git and the forge: the routing file comes from the
 * base commit through the caller's read shape, nothing is fetched, and the
 * result is printed by poll. The step keeps its own record in the host
 * factory ledger, `<ledgerDir>/reminders/<repo key>.json` (the repository key
 * of the ledger's other per-repository files), never in the repository's
 * lane-writable `.omg/`; it never writes a sealed run state. The record of
 * older versions, `<state>/factory/reminders.json`, is ignored (never read,
 * never removed).
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { visibleLine } from '../../forge/review-feedback.js';
import { ledgerRepoId } from '../run/ledger.js';
import { runLabel, TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity, type FactoryRunKey, type FactoryRunState } from '../run/state.js';
import { statusArgv, validRunKey } from '../run/gate-next.js';
import { readRegularFile } from '../attention/collect.js';
import { pathsInText, TEAM_ROUTING_PATH, type ReadAt } from './context.js';
import { parseRouting, routeFor } from './routing.js';

export interface GateReminder {
  run: FactoryRunKey;
  gate: string;
  /** Hours the run has waited at this gate. */
  hours: number;
  /** `@handle`s of the routed owners (validated by parseRouting), each once. */
  handles: string[];
  /** The gate reason as one visible line, cut. */
  reason: string;
}

/** A parked run whose state fails the trust check: the key and the read-only status command, nothing from the state. */
export interface UnverifiedReminder {
  run: FactoryRunKey;
  verified: false;
  next: string;
}

export type Reminder = GateReminder | UnverifiedReminder;

interface Record_ { gateAt: string; remindedAt: string }
/** The record's gateAt for a run reminded as not verified (its own gate time is not trusted). */
const UNVERIFIED_AT = 'unverified';
type RecordFile = Record<string, Record_>;

/** The record of `root` in the host factory ledger (outside the repository), keyed like the ledger's other per-repository files. */
export const remindersPath = (ledgerDir: string, root: string): string => join(ledgerDir, 'reminders', `${ledgerRepoId(root)}.json`);

/** The record's size cap: a few runs' entries; a larger file is read as empty. */
const RECORD_MAX_BYTES = 64 * 1024;

/** The record through the bounded regular-file read: a link, FIFO, directory or oversize file reads as empty (never opened or followed). */
function readRecord(path: string): RecordFile {
  const file = readRegularFile(path, RECORD_MAX_BYTES);
  if (!('bytes' in file)) return {};
  try {
    const raw = JSON.parse(file.bytes.toString('utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: RecordFile = {};
    for (const [k, v] of Object.entries(raw)) {
      const r = v as Partial<Record_> | null;
      if (r && typeof r.gateAt === 'string' && typeof r.remindedAt === 'string') out[k] = { gateAt: r.gateAt, remindedAt: r.remindedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export interface ReminderInput {
  root: string;
  /** The host factory ledger dir (ledger.ts defaultLedgerDir) that holds the record. */
  ledgerDir: string;
  runs: ReadonlyMap<FactoryRunKey, FactoryRunState>;
  nowMs: number;
  /** 0 or undefined = off. */
  afterHours: number | undefined;
  /** The base commit's files; undefined when the base sha is unknown. */
  readBase?: ReadAt;
  warn?: (message: string) => void;
  /**
   * Runs whose state fails the trust check (board readRuns with a ledger dir).
   * Such a parked run is reminded once per window, counted from when it was
   * first seen unverified, as "not verified" with the status command; no
   * field of its state is shown.
   */
  untrusted?: ReadonlySet<FactoryRunKey>;
}

/** The reminders due now; records them so the same run is reminded once per window. */
export function staleGateReminders(o: ReminderInput & { untrusted?: undefined }): GateReminder[];
export function staleGateReminders(o: ReminderInput): Reminder[];
export function staleGateReminders(o: ReminderInput): Reminder[] {
  if (!o.afterHours || o.afterHours <= 0) return [];
  const windowMs = o.afterHours * 3_600_000;
  const path = remindersPath(o.ledgerDir, o.root);
  // No run parked at a gate and no record to prune: nothing to remind or record, so no directory and no lock.
  const parkedAny = [...o.runs.values()].some((s) => s.gate && !TERMINAL_FACTORY_PHASES.includes(s.phase));
  if (!parkedAny && !existsSync(path)) return [];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(lockPathFor(path), () => {
    const before = readRecord(path);
    const next: RecordFile = {};
    const due: Reminder[] = [];
    let routes: ReturnType<typeof parseRouting>['routes'] | undefined;
    for (const [key, s] of o.runs) {
      if (!s.gate || TERMINAL_FACTORY_PHASES.includes(s.phase)) continue;
      const label = runLabel(key);
      if (o.untrusted?.has(key)) {
        const rec = before[label];
        if (!rec || rec.gateAt !== UNVERIFIED_AT) { next[label] = { gateAt: UNVERIFIED_AT, remindedAt: new Date(o.nowMs).toISOString() }; continue; }
        const last = Date.parse(rec.remindedAt);
        if (Number.isFinite(last) && o.nowMs - last < windowMs) { next[label] = rec; continue; }
        if (validRunKey(key)) due.push({ run: key, verified: false, next: statusArgv(key).join(' ') });
        next[label] = { gateAt: UNVERIFIED_AT, remindedAt: new Date(o.nowMs).toISOString() };
        continue;
      }
      if (!verifyFactoryIntegrity(s)) { o.warn?.(`reminder: ${label} is unsound (its state fails the integrity seal), skipped`); continue; }
      const parkedAt = Date.parse(s.gate.at);
      if (!Number.isFinite(parkedAt)) continue;
      // The record lives outside the repository; as defence in depth it may still only postpone or repeat a reminder, never
      // bring one forward (a lane whose shell reaches the home directory can write it). Due only once the sealed
      // park time is a window old; its remindedAt counts clamped to [gate.at, now] (kept clamped, so a future time
      // postpones by one window at most from when it was first read).
      if (o.nowMs - parkedAt < windowMs) continue;
      const rec = before[label];
      const recorded = rec && rec.gateAt === s.gate.at ? Date.parse(rec.remindedAt) : Number.NaN;
      const last = Number.isFinite(recorded) ? Math.min(o.nowMs, Math.max(parkedAt, recorded)) : parkedAt;
      if (o.nowMs - last < windowMs) {
        next[label] = { gateAt: s.gate.at, remindedAt: new Date(last).toISOString() };
        continue;
      }
      if (routes === undefined) {
        routes = [];
        try {
          const text = o.readBase?.(TEAM_ROUTING_PATH);
          if (text !== undefined) {
            const parsed = parseRouting(text);
            routes = parsed.routes;
            for (const w of parsed.warnings) o.warn?.(w);
          }
        } catch (error) {
          o.warn?.(visibleLine(`routing.md unreadable at the base commit: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      const handles = [...new Set(routeFor(routes, pathsInText(s.plan?.text ?? '')).flatMap((r) => (r.handle ? [r.handle] : [])))];
      due.push({ run: key, gate: visibleLine(s.gate.name), hours: Math.floor((o.nowMs - parkedAt) / 3_600_000), handles, reason: visibleLine(s.gate.reason).slice(0, 300) });
      next[label] = { gateAt: s.gate.at, remindedAt: new Date(o.nowMs).toISOString() };
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return due;
  }, { timeoutMs: 5_000 });
}
