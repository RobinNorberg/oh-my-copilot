/**
 * Premium-request ledger: what Copilot billed (or what we estimate it billed)
 * per session and per team, stored at `<omgRoot>/state/budget-ledger.json`.
 *
 * Data sources, verified on Copilot CLI 1.0.91 and @github/copilot-sdk 1.0.16:
 * - CLI sessions persist `$COPILOT_HOME/session-state/<id>/events.jsonl`. Its
 *   `session.usage_checkpoint` and `session.shutdown` events carry cumulative
 *   `totalPremiumRequests` (multiplier applied) and `totalNanoAiu`
 *   (1e-9 AI credits). They are written at the end of a session, so a running
 *   session has no total yet: until then the ledger keeps an ESTIMATE of one
 *   premium request per top-level user prompt (`user.message` without an
 *   agent `source`), multiplier and credits unknown.
 * - SDK team workers (`omg team` sdk transport) see live `assistant.usage`
 *   events; `sdk-host.ts` records those as measured.
 *
 * Records are cumulative per session, so an update replaces the previous one
 * (measured never downgrades to estimated). Writes hold a file lock and are
 * atomic; every caller treats a ledger failure as "no data" (fail-open).
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJsonSync, ensureDirSync } from '../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';

export type UsageSource = 'measured' | 'estimated';

export interface UsageRecord {
  premiumRequests: number;
  /** AI credits (nano-AIU / 1e9); 0 when unknown. */
  credits: number;
  source: UsageSource;
  /** Where the numbers came from, e.g. `session.shutdown` or the estimate rule. */
  detail: string;
  model?: string;
  updatedAt: string;
}

export interface BudgetLedger {
  version: 1;
  /** Start of the accounting period (ledger creation or the last `omg budget reset`). */
  since: string;
  sessions: Record<string, UsageRecord>;
  /** team name -> session or worker key -> usage */
  teams: Record<string, Record<string, UsageRecord>>;
  /** When each threshold was first crossed this period. */
  notified: { soft?: string; hard?: string };
  /** Threshold message not yet shown to the user (delivered on the next prompt). */
  pendingNotice?: string;
}

export interface LedgerTotals {
  premiumRequests: number;
  credits: number;
  sessions: number;
  estimatedRecords: number;
  teams: Record<string, { premiumRequests: number; credits: number; records: number }>;
}

const NANO = 1e9;
const FULL_READ_MAX_BYTES = 32 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;
const SAFE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export function ledgerPath(cwd: string): string {
  return join(getOmcRoot(cwd), 'state', 'budget-ledger.json');
}

export function emptyLedger(now = new Date()): BudgetLedger {
  return { version: 1, since: now.toISOString(), sessions: {}, teams: {}, notified: {} };
}

export function readLedger(path: string): BudgetLedger {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BudgetLedger>;
    if (raw?.version !== 1 || typeof raw.since !== 'string') return emptyLedger();
    return {
      version: 1,
      since: raw.since,
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      teams: raw.teams && typeof raw.teams === 'object' ? raw.teams : {},
      notified: raw.notified && typeof raw.notified === 'object' ? raw.notified : {},
      ...(typeof raw.pendingNotice === 'string' ? { pendingNotice: raw.pendingNotice } : {}),
    };
  } catch {
    return emptyLedger();
  }
}

/** Read-modify-write under the ledger lock. Throws when the lock is not acquired. */
export function updateLedger<T>(path: string, fn: (ledger: BudgetLedger) => T): T {
  ensureDirSync(dirname(path));
  return withFileLockSync(lockPathFor(path), () => {
    const ledger = readLedger(path);
    const result = fn(ledger);
    atomicWriteJsonSync(path, ledger);
    return result;
  }, { timeoutMs: 1000 });
}

/** Measured replaces anything; an estimate never replaces a measured record. */
export function mergeRecord(existing: UsageRecord | undefined, next: UsageRecord): UsageRecord {
  if (existing?.source === 'measured' && next.source === 'estimated') return existing;
  return next;
}

export function recordUsage(path: string, key: string, usage: UsageRecord, team?: string): void {
  if (!SAFE_KEY.test(key) || (team !== undefined && !SAFE_KEY.test(team))) return;
  updateLedger(path, (ledger) => {
    if (team) {
      const bucket = (ledger.teams[team] ??= {});
      bucket[key] = mergeRecord(bucket[key], usage);
    } else {
      ledger.sessions[key] = mergeRecord(ledger.sessions[key], usage);
    }
  });
}

export function ledgerTotals(ledger: BudgetLedger): LedgerTotals {
  const totals: LedgerTotals = { premiumRequests: 0, credits: 0, sessions: 0, estimatedRecords: 0, teams: {} };
  const add = (r: UsageRecord) => {
    totals.premiumRequests += num(r.premiumRequests);
    totals.credits += num(r.credits);
    if (r.source !== 'measured') totals.estimatedRecords += 1;
  };
  for (const r of Object.values(ledger.sessions)) { add(r); totals.sessions += 1; }
  for (const [team, records] of Object.entries(ledger.teams)) {
    const t = { premiumRequests: 0, credits: 0, records: 0 };
    for (const r of Object.values(records)) {
      add(r);
      t.premiumRequests += num(r.premiumRequests);
      t.credits += num(r.credits);
      t.records += 1;
    }
    totals.teams[team] = t;
  }
  return totals;
}

/** `$COPILOT_HOME/session-state/<id>/events.jsonl`, or null for an unsafe id. */
export function copilotEventsPath(sessionId: string): string | null {
  if (!SAFE_KEY.test(sessionId) || sessionId.includes('..')) return null;
  return join(getCopilotConfigDir(), 'session-state', sessionId, 'events.jsonl');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readEventsText(path: string): { text: string; tail: boolean } | null {
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = size > FULL_READ_MAX_BYTES ? size - TAIL_BYTES : 0;
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
    return { text: buffer.subarray(0, offset).toString('utf8'), tail: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read already done */ }
  }
}

/**
 * Usage of one Copilot CLI session from its persisted events: the last
 * `session.shutdown` or `session.usage_checkpoint` totals (measured), else
 * one premium request per top-level user prompt (estimated). Null when the
 * file is missing or holds no prompt.
 */
export function readCopilotSessionUsage(eventsPath: string, now = new Date()): UsageRecord | null {
  const read = readEventsText(eventsPath);
  if (!read) return null;
  let totals: { premium: number; nano: number; type: string } | null = null;
  let prompts = 0;
  let model: string | undefined;
  for (const line of read.text.split('\n')) {
    if (!line.includes('"type"')) continue;
    let event: { type?: string; agentId?: string; data?: Record<string, unknown> };
    try { event = JSON.parse(line); } catch { continue; }
    const data = event.data ?? {};
    if (event.type === 'session.shutdown' || event.type === 'session.usage_checkpoint') {
      if (typeof data.totalPremiumRequests === 'number' || typeof data.totalNanoAiu === 'number') {
        totals = { premium: num(data.totalPremiumRequests), nano: num(data.totalNanoAiu), type: event.type };
      }
      if (typeof data.currentModel === 'string') model = data.currentModel;
    } else if (event.type === 'user.message') {
      const source = typeof data.source === 'string' ? data.source : '';
      if (!event.agentId && !source.startsWith('agent-')) prompts += 1;
    } else if (event.type === 'session.auto_mode_resolved' && typeof data.chosenModel === 'string') {
      model = data.chosenModel;
    } else if (event.type === 'session.model_change' && typeof data.newModel === 'string' && data.newModel !== 'auto') {
      model = data.newModel;
    }
  }
  const base = { updatedAt: now.toISOString(), ...(model ? { model } : {}) };
  if (totals) {
    return { ...base, premiumRequests: totals.premium, credits: totals.nano / NANO, source: 'measured', detail: totals.type };
  }
  if (prompts === 0) return null;
  return {
    ...base,
    premiumRequests: prompts,
    credits: 0,
    source: 'estimated',
    detail: `estimate: ${prompts} user prompt(s) x1; multiplier and credits unknown until the session ends${read.tail ? ' (events tail only)' : ''}`,
  };
}
