/**
 * AI Credits budget reporting: `budget` settings from `.copilot/omg.jsonc`
 * and the hook side (record usage, SessionStart summary, the warn-only
 * `softLimit` notice). It never blocks, clamps or refuses anything: cost
 * control is Copilot's per-session `maxAiCredits` cap and admin budgets
 * (docs/MIGRATION.md). Everything here is fail-open: a bug or an unreadable
 * ledger yields no message, never a blocked session.
 *
 * Kill switch: `OMC_BUDGET_GOVERNOR=0` turns every part off.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetConfig } from '../shared/types.js';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import { getConfigDir } from '../utils/paths.js';
import { parseJsonc } from '../utils/jsonc.js';
import {
  copilotEventsPath,
  HOOK_LOCK_TIMEOUT_MS,
  ledgerPath,
  ledgerTotals,
  NANO_AIU_PER_CREDIT,
  putRecord,
  readCopilotSessionUsage,
  readLedger,
  readTailTotals,
  scanSince,
  recordUsage,
  updateLedger,
  type BudgetLedger,
  type LedgerLockOptions,
  type UsageRecord,
} from './ledger.js';

/** `credits` (AI Credits, the billed unit) or legacy `premiumRequests`, for display. */
export type BudgetUnit = 'premiumRequests' | 'credits';

export interface BudgetSettings {
  enabled: boolean;
  /** Warn-only threshold in AI Credits: one notice per period, never a block. */
  softLimit?: number;
  /** Retired keys found in the config (`budget.mode`, ...); each one is a no-op. */
  deprecated: string[];
}

/** Retired with budget enforcement; they parse, warn once and do nothing. */
const DEPRECATED_KEYS = ['mode', 'hardLimit', 'perTeamLimit'] as const;
const KNOWN_KEYS = new Set<string>(['softLimit', 'unit', ...DEPRECATED_KEYS]);
/** Estimated records re-read per SessionStart to pick up their final totals. */
const REFRESH_MAX = 20;
/** Time budget of that refresh; the rotation picks up the rest next time. */
const REFRESH_DEADLINE_MS = 300;

/** Validate a raw `budget` block; invalid values are dropped and reported, never thrown. */
export function resolveBudgetSettings(raw: unknown, env: NodeJS.ProcessEnv = process.env): { settings: BudgetSettings; issues: string[] } {
  const issues: string[] = [];
  const settings: BudgetSettings = { enabled: env.OMC_BUDGET_GOVERNOR !== '0', deprecated: [] };
  if (raw === undefined || raw === null) return { settings, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('budget: must be an object');
    return { settings, issues };
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) if (!KNOWN_KEYS.has(key)) issues.push(`budget.${key}: unknown key`);
  for (const key of DEPRECATED_KEYS) if (block[key] !== undefined) settings.deprecated.push(`budget.${key}`);
  if (block.unit === 'premiumRequests') settings.deprecated.push('budget.unit "premiumRequests"');
  else if (block.unit !== undefined && block.unit !== 'credits') {
    issues.push(`budget.unit: must be "credits" (got ${JSON.stringify(block.unit)}); ignored`);
  }
  if (block.softLimit !== undefined) {
    const value = block.softLimit;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) settings.softLimit = value;
    else issues.push(`budget.softLimit: must be a positive number (got ${JSON.stringify(value)}); ignored`);
  }
  if (settings.deprecated.length > 0) issues.push(deprecationNotice(settings.deprecated));
  return { settings, issues };
}

/** The one deprecation warning for every retired key present. */
export function deprecationNotice(keys: readonly string[]): string {
  return `${keys.join(', ')}: deprecated and ignored. Budgets are no longer enforced and limits count AI credits only; `
    + 'budget.softLimit still warns. Cap spend with Copilot\'s per-session maxAiCredits and admin budgets (docs/MIGRATION.md)';
}

function readBudgetBlock(path: string): BudgetConfig | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = parseJsonc(readFileSync(path, 'utf8')) as { budget?: BudgetConfig } | null;
  return parsed?.budget;
}

/** User config, then `.copilot/omg.jsonc` of `cwd` (per-key override). */
export function loadBudgetSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): { settings: BudgetSettings; issues: string[] } {
  let user: unknown;
  let project: unknown;
  const issues: string[] = [];
  try { user = readBudgetBlock(join(getConfigDir(), 'claude-omc', 'config.jsonc')); } catch { issues.push('budget: user config unreadable'); }
  try { project = readBudgetBlock(resolveProjectConfigPath(cwd)); } catch { issues.push('budget: project config unreadable'); }
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  const merged = isObject(user) && isObject(project) ? { ...(user as object), ...(project as object) } : project ?? user;
  const resolved = resolveBudgetSettings(merged, env);
  return { settings: resolved.settings, issues: [...issues, ...resolved.issues] };
}

export function hasLimits(s: BudgetSettings): boolean {
  return s.softLimit !== undefined;
}

export function formatAmount(value: number, unit: BudgetUnit): string {
  const n = Number.isInteger(value) ? String(value) : value.toFixed(unit === 'credits' ? 3 : 2);
  return `${n} ${unit === 'credits' ? 'AI credits' : 'premium requests'}`;
}

export function summaryLine(ledger: BudgetLedger, settings: BudgetSettings): string {
  const t = ledgerTotals(ledger);
  const estimated = t.estimatedRecords > 0 ? `; ${t.estimatedRecords} record(s) estimated` : '';
  const threshold = settings.softLimit !== undefined ? `soft limit ${formatAmount(settings.softLimit, 'credits')}` : 'no soft limit';
  const deprecated = settings.deprecated.length > 0 ? ` ${deprecationNotice(settings.deprecated)}.` : '';
  return `[BUDGET] Copilot usage since ${ledger.since.slice(0, 10)}: ${formatAmount(Number(t.credits.toFixed(3)), 'credits')} `
    + `(${t.sessions} session(s), ${Object.keys(t.teams).length} team(s)${estimated}). `
    + `Reporting only, ${threshold}.${deprecated} Details: omg budget status.`;
}

/** Mark a newly crossed soft limit in `ledger` and return the notice, or null. */
export function checkThresholds(ledger: BudgetLedger, settings: BudgetSettings, now = new Date()): string | null {
  const totals = ledgerTotals(ledger);
  const used = totals.credits;
  const n = ledger.notified;
  // A raised limit re-arms its notice.
  if (n.soft && n.softLimit !== undefined && settings.softLimit !== undefined && settings.softLimit > n.softLimit) {
    delete n.soft;
    delete n.softLimit;
  }
  if (settings.softLimit === undefined || used < settings.softLimit || n.soft) return null;
  n.soft = now.toISOString();
  n.softLimit = settings.softLimit;
  const estimated = totals.estimatedRecords > 0 ? ` (${totals.estimatedRecords} record(s) estimated)` : '';
  return `[BUDGET] Soft limit reached: ${formatAmount(Number(used.toFixed(3)), 'credits')} of ${settings.softLimit} used since ${ledger.since.slice(0, 10)}${estimated}. Mention this to the user.`;
}

/** CLI argv phases; not the hook type names (the registry shadow matches those in args). */
export type BudgetHookPhase = 'start' | 'submit' | 'turn';

export interface BudgetHookInput {
  phase: BudgetHookPhase;
  payload: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** SessionStart refresh time budget (tests). */
  refreshDeadlineMs?: number;
}

function payloadString(payload: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = payload?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * One hook invocation. Returns the hook stdout object, or null for no output.
 * Team worker sessions record under their team and never get notices; sdk
 * workers (`OMC_BUDGET_HOST_LEDGER=1`) are recorded by their host instead.
 */
export function runBudgetHook(input: BudgetHookInput): Record<string, unknown> | null {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const cwd = payloadString(input.payload, 'cwd') ?? process.cwd();
  const sessionId = payloadString(input.payload, 'session_id', 'sessionId');
  const worker = typeof env.OMC_TEAM_WORKER === 'string' && env.OMC_TEAM_WORKER.includes('/') ? env.OMC_TEAM_WORKER : undefined;
  const ledgerCwd = worker ? env.OMC_TEAM_LEADER_CWD || cwd : cwd;
  const { settings } = loadBudgetSettings(ledgerCwd, env);
  if (!settings.enabled) return null;
  const path = ledgerPath(ledgerCwd);

  const lock = { timeoutMs: HOOK_LOCK_TIMEOUT_MS };
  const team = worker?.split('/')[0];

  if (input.phase !== 'submit' && sessionId && env.OMC_BUDGET_HOST_LEDGER !== '1') {
    const events = copilotEventsPath(sessionId);
    if (events) {
      const ledger = readLedger(path);
      const stored = team ? ledger.teams[team]?.[sessionId] : ledger.sessions[sessionId];
      const usage = readCopilotSessionUsage(events, now, { since: scanSince(ledger), ...(stored?.scan ? { prev: stored.scan } : {}) });
      if (usage) recordUsage(path, sessionId, usage, team, lock);
    }
  }
  if (worker) return null;

  if (input.phase === 'start') {
    refreshEstimates(path, now, lock, input.refreshDeadlineMs);
    if (!hasLimits(settings) && settings.deprecated.length === 0) return null;
    return { continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summaryLine(readLedger(path), settings) } };
  }
  if (input.phase === 'turn') {
    if (!hasLimits(settings)) return null;
    const notice = updateLedger(path, (ledger) => {
      const n = checkThresholds(ledger, settings, now);
      if (n) ledger.pendingNotice = n;
      return n;
    }, lock);
    return notice ? { continue: true, systemMessage: notice } : null;
  }
  // submit: deliver a pending notice as model context (Copilot injects top-level additionalContext).
  if (!readLedger(path).pendingNotice) return null;
  const notice = updateLedger(path, (ledger) => {
    const n = ledger.pendingNotice;
    delete ledger.pendingNotice;
    return n;
  }, lock);
  return notice ? { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice } } : null;
}

/**
 * Upgrade estimated records (sessions and pane team workers) whose session
 * has since written its totals. Bounded: at most REFRESH_MAX records per call,
 * rotating through the candidates, a tail read each, skipped when the events
 * file is unchanged since the last check, and a REFRESH_DEADLINE_MS budget.
 * A record whose events file is gone is marked final. Records without scan
 * state (sdk host records) are their host's business.
 */
export function refreshEstimates(path: string, now: Date, lock: LedgerLockOptions = {}, deadlineMs = REFRESH_DEADLINE_MS): void {
  const ledger = readLedger(path);
  const candidates: Array<{ key: string; team?: string; record: UsageRecord }> = [];
  for (const key of Object.keys(ledger.sessions).sort()) candidates.push({ key, record: ledger.sessions[key]! });
  for (const team of Object.keys(ledger.teams).sort()) {
    for (const key of Object.keys(ledger.teams[team]!).sort()) candidates.push({ key, team, record: ledger.teams[team]![key]! });
  }
  const stale = candidates.filter((c) => c.record.source === 'estimated' && c.record.scan && !c.record.scan.gone);
  if (stale.length === 0) return;
  const start = (ledger.refreshCursor ?? 0) % stale.length;
  const deadline = Date.now() + deadlineMs;
  const updates: Array<{ key: string; team?: string; usage: UsageRecord }> = [];
  let visited = 0;
  // At least one record per call, so the rotation always moves on.
  for (; visited < Math.min(REFRESH_MAX, stale.length) && (visited === 0 || Date.now() < deadline); visited++) {
    const { key, team, record } = stale[(start + visited) % stale.length]!;
    const scan = record.scan!;
    const events = copilotEventsPath(key);
    let stat: { size: number; mtimeMs: number } | null = null;
    try { stat = events ? statSync(events) : null; } catch { stat = null; }
    if (!stat) {
      updates.push({ key, team, usage: { ...record, detail: `${record.detail}; events file gone, final`, scan: { ...scan, gone: true }, updatedAt: now.toISOString() } });
      continue;
    }
    const mtimeMs = Math.floor(stat.mtimeMs); // whole ms: survives JSON and filesystems with coarser stamps
    if (scan.checkedSize === stat.size && scan.checkedMtimeMs === mtimeMs) continue;
    const checked = { ...scan, checkedSize: stat.size, checkedMtimeMs: mtimeMs };
    const tail = readTailTotals(events!, stat.size);
    const usage: UsageRecord = tail
      ? { premiumRequests: tail.premium, credits: tail.nano / NANO_AIU_PER_CREDIT, source: 'measured', detail: `${tail.type} (events tail)`, ...(tail.model ? { model: tail.model } : {}), updatedAt: now.toISOString(), scan: checked }
      : { ...record, scan: checked };
    updates.push({ key, team, usage });
  }
  const cursor = (start + visited) % stale.length;
  if (updates.length === 0 && cursor === (ledger.refreshCursor ?? 0)) return;
  updateLedger(path, (fresh) => {
    if (fresh.since !== ledger.since) return; // reset in between: these records are gone
    for (const { key, team, usage } of updates) {
      const current = team ? fresh.teams[team]?.[key] : fresh.sessions[key];
      if (!current) continue;
      if (usage.source === 'estimated') {
        // Bookkeeping only (checked size/mtime, gone): never lower what a concurrent hook stored.
        const merged = { ...current, scan: { ...(current.scan ?? usage.scan!), checkedSize: usage.scan!.checkedSize, checkedMtimeMs: usage.scan!.checkedMtimeMs, ...(usage.scan!.gone ? { gone: true as const } : {}) } };
        if (usage.scan!.gone && current.source === 'estimated') merged.detail = usage.detail;
        if (team) fresh.teams[team]![key] = merged; else fresh.sessions[key] = merged;
      } else {
        putRecord(fresh, key, usage, team);
      }
    }
    fresh.refreshCursor = cursor;
  }, lock);
}
