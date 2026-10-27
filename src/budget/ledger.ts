/**
 * Usage ledger: the AI Credits Copilot billed (or what we estimate it billed)
 * per session and per team, stored at `<omgRoot>/state/budget-ledger.json`.
 * Copilot bills usage in AI Credits since 2026-06-01; premium requests are a
 * legacy field the CLI still reports and the ledger still carries.
 *
 * Data sources, verified on Copilot CLI 1.0.91 and @github/copilot-sdk 1.0.16:
 * - CLI sessions persist `$COPILOT_HOME/session-state/<id>/events.jsonl`. Its
 *   `session.usage_checkpoint` and `session.shutdown` events carry cumulative
 *   `totalNanoAiu` (1e-9 AI Credits) and the legacy `totalPremiumRequests`.
 *   They are written at the end of a session (the per-call `assistant.usage`
 *   events are ephemeral and not persisted), so a running session has no
 *   total yet: until then the ledger keeps an ESTIMATE of
 *   ESTIMATED_CREDITS_PER_PROMPT AI Credits (and one premium request) per
 *   top-level user prompt (`user.message` without an agent `source`) since
 *   the period start.
 *   The events file is scanned incrementally (byte offset + count kept in the
 *   record), at most MAX_SCAN_BYTES per call.
 * - SDK team workers (`omg team` sdk transport) see live `assistant.usage`
 *   events; `sdk-host.ts` records those (estimated until the shutdown totals).
 *
 * Records are cumulative per session, so an update replaces the previous one,
 * except: measured never downgrades to estimated, an estimate never goes down,
 * and a measured total that drops (a resumed session restarting its counter)
 * keeps the larger value and says so. `omg budget reset` keeps per-record
 * baselines so a session running across the reset counts only what follows.
 * Writes hold a file lock and are atomic; every caller treats a ledger failure
 * as "no data" (fail-open).
 */

import { closeSync, copyFileSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { atomicWriteJsonSync, ensureDirSync } from '../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';

export type UsageSource = 'measured' | 'estimated';

/** Incremental read state of a session's events.jsonl. */
export interface EventsScan {
  /** Period start the prompt count belongs to (`scanSince(ledger)`). */
  since: string;
  /** Bytes consumed (always at a line boundary). */
  offset: number;
  /** Top-level prompts at or after `since` within the consumed bytes. */
  prompts: number;
  /** Last cumulative totals event seen. */
  totals?: { premium: number; nano: number; type: string };
  model?: string;
  /** Size and mtime at the last SessionStart refresh (skip when unchanged). */
  checkedSize?: number;
  checkedMtimeMs?: number;
  /** The events file disappeared; the record is final. */
  gone?: true;
}

export interface UsageRecord {
  /** AI Credits (nano-AIU / 1e9), the billed unit. */
  credits: number;
  /** Legacy: premium requests as the CLI still reports them (multiplier applied). */
  premiumRequests: number;
  source: UsageSource;
  /** Where the numbers came from, e.g. `session.shutdown` or the estimate rule. */
  detail: string;
  model?: string;
  updatedAt: string;
  /** Present on records read from a Copilot CLI events file. */
  scan?: EventsScan;
}

/** Usage a record had accumulated before `omg budget reset` (cumulative sources subtract it). */
export interface UsageBaseline {
  premiumRequests: number;
  credits: number;
  source: UsageSource;
}

export interface BudgetLedger {
  version: 1;
  /** Start of the accounting period (ledger creation or the last `omg budget reset`). */
  since: string;
  sessions: Record<string, UsageRecord>;
  /** team name -> session or worker key -> usage */
  teams: Record<string, Record<string, UsageRecord>>;
  /** When each threshold was first crossed this period, and the limit it was crossed at. */
  notified: { soft?: string; hard?: string; softLimit?: number; hardLimit?: number };
  /** Threshold message not yet shown to the user (delivered on the next prompt). */
  pendingNotice?: string;
  /** Set by `omg budget reset` (equals `since` then); prompts before it are not counted. */
  resetAt?: string;
  /** `s:<session>` / `t:<team>/<key>` -> usage before the last reset. */
  baselines?: Record<string, UsageBaseline>;
  /** Rotation point of the SessionStart refresh. */
  refreshCursor?: number;
}

export interface LedgerTotals {
  premiumRequests: number;
  credits: number;
  sessions: number;
  estimatedRecords: number;
  teams: Record<string, { premiumRequests: number; credits: number; records: number }>;
}

export interface LedgerLockOptions {
  /** Lock wait; 0 tries once (skip on contention). Default 1000 ms. */
  timeoutMs?: number;
}

/**
 * nano-AIU per AI credit. The Copilot SDK documents this division only "as a
 * convenience (SI nano prefix)"; billing defines the real rate, so treat
 * credits derived from `totalNanoAiu` as a measured approximation.
 */
export const NANO_AIU_PER_CREDIT = 1e9;
/**
 * Rough AI Credits per top-level prompt of a running CLI session, used until
 * its measured total is written. Short smoke prompts measured 0.29 to 0.91
 * credits (Copilot CLI 1.0.91, small models); real work varies by model and
 * by the number of model calls, so this is an estimate, not a floor.
 */
export const ESTIMATED_CREDITS_PER_PROMPT = 1;
/** Bytes of events.jsonl parsed per call; the rest is picked up by the next call. */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Tail read for the end-of-session totals. */
export const TAIL_BYTES = 64 * 1024;
/** Lock wait of hook processes: a hook must stay well inside its timeout. */
export const HOOK_LOCK_TIMEOUT_MS = 250;
const SAFE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel));
}

export function ledgerPath(cwd: string): string {
  const path = join(getOmcRoot(cwd), 'state', 'budget-ledger.json');
  // Tests must never touch the real home ledger (a non-git temp cwd anchors state there).
  if (process.env.VITEST && isWithin(path, homedir()) && !isWithin(path, tmpdir())) {
    throw new Error(`budget ledger outside the temp dir under test: ${path} (stub OMC_STATE_DIR)`);
  }
  return path;
}

export function emptyLedger(now = new Date()): BudgetLedger {
  return { version: 1, since: now.toISOString(), sessions: {}, teams: {}, notified: {} };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Drop entries that are not records, so a hand-edited ledger cannot crash a reader. */
function records(raw: unknown): Record<string, UsageRecord> {
  const out: Record<string, UsageRecord> = {};
  if (!isObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) if (isObject(value)) out[key] = value as unknown as UsageRecord;
  return out;
}

function parseLedger(path: string): { ledger: BudgetLedger; invalid: boolean } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ledger: emptyLedger(), invalid: false };
  }
  try {
    const raw = JSON.parse(text) as Partial<BudgetLedger> | null;
    if (!isObject(raw) || raw.version !== 1 || typeof raw.since !== 'string') return { ledger: emptyLedger(), invalid: true };
    const teams: BudgetLedger['teams'] = {};
    if (isObject(raw.teams)) for (const [team, bucket] of Object.entries(raw.teams)) if (isObject(bucket)) teams[team] = records(bucket);
    const notified: BudgetLedger['notified'] = {};
    if (isObject(raw.notified)) {
      for (const k of ['soft', 'hard'] as const) if (typeof raw.notified[k] === 'string') notified[k] = raw.notified[k];
      for (const k of ['softLimit', 'hardLimit'] as const) if (typeof raw.notified[k] === 'number') notified[k] = raw.notified[k];
    }
    const baselines: Record<string, UsageBaseline> = {};
    if (isObject(raw.baselines)) for (const [k, v] of Object.entries(raw.baselines)) if (isObject(v)) baselines[k] = v as unknown as UsageBaseline;
    return {
      ledger: {
        version: 1,
        since: raw.since,
        sessions: records(raw.sessions),
        teams,
        notified,
        ...(typeof raw.pendingNotice === 'string' ? { pendingNotice: raw.pendingNotice } : {}),
        ...(typeof raw.resetAt === 'string' ? { resetAt: raw.resetAt } : {}),
        ...(Object.keys(baselines).length ? { baselines } : {}),
        ...(typeof raw.refreshCursor === 'number' ? { refreshCursor: raw.refreshCursor } : {}),
      },
      invalid: false,
    };
  } catch {
    return { ledger: emptyLedger(), invalid: true };
  }
}

export function readLedger(path: string): BudgetLedger {
  return parseLedger(path).ledger;
}

const EPOCH = new Date(0).toISOString();

/**
 * Start of the prompt count: the last `omg budget reset`. Before any reset
 * every prompt counts, like the cumulative totals the session writes.
 */
export function scanSince(ledger: BudgetLedger): string {
  return ledger.resetAt ?? EPOCH;
}

/**
 * Read-modify-write under the ledger lock. Throws when the lock is not
 * acquired. A corrupt or foreign-version ledger is copied to `<path>.corrupt`
 * before it is overwritten.
 */
export function updateLedger<T>(path: string, fn: (ledger: BudgetLedger) => T, opts: LedgerLockOptions = {}): T {
  ensureDirSync(dirname(path));
  return withFileLockSync(lockPathFor(path), () => {
    const { ledger, invalid } = parseLedger(path);
    if (invalid) {
      try { copyFileSync(path, `${path}.corrupt`); } catch { /* best effort: the ledger is rebuilt either way */ }
    }
    const result = fn(ledger);
    atomicWriteJsonSync(path, ledger);
    return result;
  }, { timeoutMs: opts.timeoutMs ?? 1000 });
}

/**
 * Merge an update into the stored record: measured replaces an estimate, an
 * estimate never replaces a measured record or lowers an estimate, and a
 * measured total that drops keeps the larger value and flags it.
 */
export function mergeRecord(existing: UsageRecord | undefined, next: UsageRecord): UsageRecord {
  if (!existing) return next;
  if (existing.source === 'measured' && next.source === 'estimated') {
    return next.scan ? { ...existing, scan: next.scan } : existing;
  }
  if (existing.source !== next.source) return next;
  const credits = Math.max(num(existing.credits), num(next.credits));
  const premiumRequests = Math.max(num(existing.premiumRequests), num(next.premiumRequests));
  if (credits === num(next.credits) && premiumRequests === num(next.premiumRequests)) return next;
  if (next.source === 'estimated') return { ...next, credits, premiumRequests };
  return {
    ...next,
    credits,
    premiumRequests,
    detail: `${next.detail}; total fell from ${amount(existing)} to ${amount(next)} (resumed session?), kept ${amount({ credits, premiumRequests })}`,
  };
}

/** `0.425 AI credits (1 premium request)` for record details. */
function amount(r: Pick<UsageRecord, 'credits' | 'premiumRequests'>): string {
  return `${Number(num(r.credits).toFixed(3))} AI credits (${num(r.premiumRequests)} premium requests)`;
}

const baselineKey = (key: string, team?: string) => (team ? `t:${team}/${key}` : `s:${key}`);

/** A cumulative (measured) total minus what the record had before the last reset. */
function applyBaseline(usage: UsageRecord, baseline: UsageBaseline | undefined): UsageRecord {
  if (!baseline || usage.source !== 'measured') return usage;
  const net: UsageRecord = {
    ...usage,
    premiumRequests: Math.max(0, num(usage.premiumRequests) - num(baseline.premiumRequests)),
    credits: Math.max(0, num(usage.credits) - num(baseline.credits)),
    detail: `${usage.detail} minus ${amount(baseline)} before the reset`,
  };
  // The pre-reset part was itself an estimate, so the split is too.
  if (baseline.source === 'estimated') return { ...net, source: 'estimated', detail: `${net.detail} (estimated)` };
  return net;
}

/** Store one record in an already locked ledger. False when the key is unsafe or the update is stale. */
export function putRecord(ledger: BudgetLedger, key: string, usage: UsageRecord, team?: string): boolean {
  if (!SAFE_KEY.test(key) || (team !== undefined && !SAFE_KEY.test(team))) return false;
  // A scan from before `omg budget reset` counted the old period.
  if (usage.scan && usage.scan.since !== scanSince(ledger)) return false;
  const net = applyBaseline(usage, ledger.baselines?.[baselineKey(key, team)]);
  if (team) {
    const bucket = (ledger.teams[team] ??= {});
    bucket[key] = mergeRecord(bucket[key], net);
  } else {
    ledger.sessions[key] = mergeRecord(ledger.sessions[key], net);
  }
  return true;
}

export function recordUsage(path: string, key: string, usage: UsageRecord, team?: string, opts: LedgerLockOptions = {}): void {
  if (!SAFE_KEY.test(key) || (team !== undefined && !SAFE_KEY.test(team))) return;
  updateLedger(path, (ledger) => { putRecord(ledger, key, usage, team); }, opts);
}

/**
 * Start a new period: totals so far become per-record baselines (subtracted
 * from later cumulative totals), records and notices are cleared. Returns the
 * previous period's totals.
 */
export function resetLedger(ledger: BudgetLedger, now = new Date()): { since: string } & LedgerTotals {
  const before = { since: ledger.since, ...ledgerTotals(ledger) };
  const baselines: Record<string, UsageBaseline> = { ...(ledger.baselines ?? {}) };
  const carry = (bkey: string, r: UsageRecord) => {
    const prev = baselines[bkey];
    baselines[bkey] = {
      premiumRequests: num(prev?.premiumRequests) + num(r.premiumRequests),
      credits: num(prev?.credits) + num(r.credits),
      source: r.source === 'estimated' || prev?.source === 'estimated' ? 'estimated' : 'measured',
    };
  };
  for (const [key, r] of Object.entries(ledger.sessions)) carry(baselineKey(key), r);
  for (const [team, bucket] of Object.entries(ledger.teams)) for (const [key, r] of Object.entries(bucket)) carry(baselineKey(key, team), r);
  delete ledger.pendingNotice;
  delete ledger.refreshCursor;
  delete ledger.baselines;
  Object.assign(ledger, emptyLedger(now), { resetAt: now.toISOString() }, Object.keys(baselines).length ? { baselines } : {});
  return before;
}

export function ledgerTotals(ledger: BudgetLedger): LedgerTotals {
  const totals: LedgerTotals = { premiumRequests: 0, credits: 0, sessions: 0, estimatedRecords: 0, teams: {} };
  const add = (r: UsageRecord) => {
    totals.premiumRequests += num(r?.premiumRequests);
    totals.credits += num(r?.credits);
    if (r?.source !== 'measured') totals.estimatedRecords += 1;
  };
  for (const r of Object.values(ledger.sessions)) {
    if (!isObject(r)) continue;
    add(r);
    totals.sessions += 1;
  }
  for (const [team, bucket] of Object.entries(ledger.teams)) {
    if (!isObject(bucket)) continue;
    const t = { premiumRequests: 0, credits: 0, records: 0 };
    for (const r of Object.values(bucket)) {
      if (!isObject(r)) continue;
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

function readRange(path: string, start: number, length: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.max(0, Math.min(length, size - start));
    const buffer = Buffer.alloc(len);
    let offset = 0;
    while (offset < len) {
      const n = readSync(fd, buffer, offset, len - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read already done */ }
  }
}

interface ParsedEvent { type?: string; agentId?: string; timestamp?: string; data?: Record<string, unknown> }

/** Apply the relevant events of complete lines to `scan`. Lines without a known type are not parsed. */
function scanLines(text: string, scan: EventsScan): void {
  const sinceMs = Date.parse(scan.since);
  for (const line of text.split('\n')) {
    if (!line.includes('"user.message"') && !line.includes('"session.')) continue;
    let event: ParsedEvent;
    try { event = JSON.parse(line); } catch { continue; }
    const data = event.data ?? {};
    if (event.type === 'session.shutdown' || event.type === 'session.usage_checkpoint') {
      if (typeof data.totalPremiumRequests === 'number' || typeof data.totalNanoAiu === 'number') {
        scan.totals = { premium: num(data.totalPremiumRequests), nano: num(data.totalNanoAiu), type: event.type };
      }
      if (typeof data.currentModel === 'string') scan.model = data.currentModel;
    } else if (event.type === 'user.message') {
      const source = typeof data.source === 'string' ? data.source : '';
      // Prompts without a timestamp count (older fixtures); timestamped ones only from the period start.
      const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
      if (!event.agentId && !source.startsWith('agent-') && !(at < sinceMs)) scan.prompts += 1;
    } else if (event.type === 'session.auto_mode_resolved' && typeof data.chosenModel === 'string') {
      scan.model = data.chosenModel;
    } else if (event.type === 'session.model_change' && typeof data.newModel === 'string' && data.newModel !== 'auto') {
      scan.model = data.newModel;
    }
  }
}

/** The last totals event in the final TAIL_BYTES of the file. */
export function readTailTotals(path: string, size: number): Totals | null {
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = readRange(path, start, size - start);
  if (!buffer) return null;
  let text = buffer.toString('utf8');
  if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
  const scan: EventsScan = { since: new Date(0).toISOString(), offset: 0, prompts: 0 };
  scanLines(text, scan);
  return scan.totals ? { ...scan.totals, ...(scan.model ? { model: scan.model } : {}) } : null;
}

type Totals = { premium: number; nano: number; type: string; model?: string };

function toRecord(scan: EventsScan, partial: boolean, now: Date, tail: Totals | null = null): UsageRecord | null {
  const model = tail?.model ?? scan.model;
  const base = { updatedAt: now.toISOString(), ...(model ? { model } : {}), scan };
  const totals = tail ?? scan.totals;
  if (totals) {
    return { ...base, premiumRequests: totals.premium, credits: totals.nano / NANO_AIU_PER_CREDIT, source: 'measured', detail: `${totals.type}${tail ? ' (events tail)' : ''}` };
  }
  if (scan.prompts === 0 && !partial) return null;
  return {
    ...base,
    premiumRequests: scan.prompts,
    credits: scan.prompts * ESTIMATED_CREDITS_PER_PROMPT,
    source: 'estimated',
    detail: `estimate: ${scan.prompts} user prompt(s) x ${ESTIMATED_CREDITS_PER_PROMPT} AI credit; measured once the session writes its totals${partial ? ` (read ${scan.offset} bytes so far)` : ''}`,
  };
}

export interface SessionUsageOptions {
  /** Period start; prompts before it are not counted. Default: count all. */
  since?: string;
  /** Scan state of the stored record: continue from its offset. */
  prev?: EventsScan;
  /** Per-call parse budget (tests). */
  maxScanBytes?: number;
}

/**
 * Usage of one Copilot CLI session from its persisted events: the last
 * `session.shutdown` or `session.usage_checkpoint` totals (measured), else
 * one premium request per top-level user prompt (estimated). Reads only the
 * bytes after `prev.offset`, at most `maxScanBytes`; when the file is larger
 * the count is partial (it only grows) and the tail is checked for totals.
 * Null when the file is missing, nothing was appended since `prev`, or it
 * holds no prompt.
 */
export function readCopilotSessionUsage(eventsPath: string, now = new Date(), opts: SessionUsageOptions = {}): UsageRecord | null {
  let size: number;
  try { size = statSync(eventsPath).size; } catch { return null; }
  const since = opts.since ?? new Date(0).toISOString();
  const prev = opts.prev && opts.prev.since === since && opts.prev.offset <= size ? opts.prev : undefined;
  if (prev && prev.offset === size) return null;
  const scan: EventsScan = prev
    ? { since, offset: prev.offset, prompts: prev.prompts, ...(prev.totals ? { totals: prev.totals } : {}), ...(prev.model ? { model: prev.model } : {}) }
    : { since, offset: 0, prompts: 0 };
  const budget = opts.maxScanBytes ?? MAX_SCAN_BYTES;
  const chunk = readRange(eventsPath, scan.offset, Math.min(budget, size - scan.offset));
  if (!chunk) return null;
  const end = scan.offset + chunk.length;
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline >= 0) {
    scanLines(chunk.subarray(0, lastNewline + 1).toString('utf8'), scan);
    scan.offset += lastNewline + 1;
  } else if (end < size) {
    scan.offset = end; // one line longer than the budget: skip it, it cannot be an event we count
  }
  const partial = end < size;
  // Not stored in the scan: older checkpoints further up must not look like a falling total later.
  const tail = partial ? readTailTotals(eventsPath, size) : null;
  return toRecord(scan, partial, now, tail);
}
