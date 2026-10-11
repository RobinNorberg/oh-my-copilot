/**
 * Premium-request budget governor: `budget` settings from `.copilot/omg.jsonc`,
 * the hook side (record usage, SessionStart summary, threshold notices) and
 * the `omg team` fan-out check. Everything here is fail-open: a bug or an
 * unreadable ledger yields no message, never a blocked session.
 *
 * Kill switch: `OMC_BUDGET_GOVERNOR=0` turns every part off.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetConfig } from '../shared/types.js';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import { getConfigDir } from '../utils/paths.js';
import { parseJsonc } from '../utils/jsonc.js';
import {
  copilotEventsPath,
  ledgerPath,
  ledgerTotals,
  readCopilotSessionUsage,
  readLedger,
  recordUsage,
  updateLedger,
  type BudgetLedger,
  type LedgerTotals,
} from './ledger.js';

export type BudgetUnit = 'premiumRequests' | 'credits';

export interface BudgetSettings {
  enabled: boolean;
  mode: 'warn' | 'enforce';
  unit: BudgetUnit;
  softLimit?: number;
  hardLimit?: number;
  perTeamLimit?: number;
}

const LIMIT_KEYS = ['softLimit', 'hardLimit', 'perTeamLimit'] as const;
const KNOWN_KEYS = new Set<string>(['mode', 'unit', ...LIMIT_KEYS]);
/** Estimated sessions re-read per SessionStart to pick up their final totals. */
const REFRESH_MAX = 20;

/** Validate a raw `budget` block; invalid values are dropped and reported, never thrown. */
export function resolveBudgetSettings(raw: unknown, env: NodeJS.ProcessEnv = process.env): { settings: BudgetSettings; issues: string[] } {
  const issues: string[] = [];
  const settings: BudgetSettings = { enabled: env.OMC_BUDGET_GOVERNOR !== '0', mode: 'warn', unit: 'premiumRequests' };
  if (raw === undefined || raw === null) return { settings, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('budget: must be an object');
    return { settings, issues };
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) if (!KNOWN_KEYS.has(key)) issues.push(`budget.${key}: unknown key`);
  if (block.mode !== undefined) {
    if (block.mode === 'warn' || block.mode === 'enforce') settings.mode = block.mode;
    else issues.push(`budget.mode: must be "warn" or "enforce" (got ${JSON.stringify(block.mode)}); using "warn"`);
  }
  if (block.unit !== undefined) {
    if (block.unit === 'premiumRequests' || block.unit === 'credits') settings.unit = block.unit;
    else issues.push(`budget.unit: must be "premiumRequests" or "credits" (got ${JSON.stringify(block.unit)}); using "premiumRequests"`);
  }
  for (const key of LIMIT_KEYS) {
    const value = block[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) settings[key] = value;
    else issues.push(`budget.${key}: must be a positive number (got ${JSON.stringify(value)}); ignored`);
  }
  if (settings.softLimit !== undefined && settings.hardLimit !== undefined && settings.softLimit > settings.hardLimit) {
    issues.push(`budget.softLimit (${settings.softLimit}) is above budget.hardLimit (${settings.hardLimit})`);
  }
  return { settings, issues };
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
  return s.softLimit !== undefined || s.hardLimit !== undefined || s.perTeamLimit !== undefined;
}

export function usedInUnit(totals: { premiumRequests: number; credits: number }, unit: BudgetUnit): number {
  return unit === 'credits' ? totals.credits : totals.premiumRequests;
}

export function formatAmount(value: number, unit: BudgetUnit): string {
  const n = Number.isInteger(value) ? String(value) : value.toFixed(unit === 'credits' ? 3 : 2);
  return `${n} ${unit === 'credits' ? 'AI credits' : 'premium requests'}`;
}

export function summaryLine(ledger: BudgetLedger, settings: BudgetSettings): string {
  const t = ledgerTotals(ledger);
  const limits = [
    settings.softLimit !== undefined ? `soft ${settings.softLimit}` : '',
    settings.hardLimit !== undefined ? `hard ${settings.hardLimit}` : '',
    settings.perTeamLimit !== undefined ? `per team ${settings.perTeamLimit}` : '',
  ].filter(Boolean).join(', ');
  const estimated = t.estimatedRecords > 0 ? `; ${t.estimatedRecords} record(s) estimated` : '';
  return `[BUDGET] Copilot usage since ${ledger.since.slice(0, 10)}: ${formatAmount(t.premiumRequests, 'premiumRequests')}, `
    + `${formatAmount(Number(t.credits.toFixed(3)), 'credits')} (${t.sessions} session(s), ${Object.keys(t.teams).length} team(s)${estimated}). `
    + `Limits in ${settings.unit}: ${limits || 'none'} (${settings.mode} mode). Details: omg budget status.`;
}

/** Mark newly crossed thresholds in `ledger` and return the notice, or null. */
export function checkThresholds(ledger: BudgetLedger, settings: BudgetSettings, now = new Date()): string | null {
  const used = usedInUnit(ledgerTotals(ledger), settings.unit);
  const amount = (limit: number) => `${formatAmount(Number(used.toFixed(3)), settings.unit)} of ${limit} used since ${ledger.since.slice(0, 10)}`;
  if (settings.hardLimit !== undefined && used >= settings.hardLimit && !ledger.notified.hard) {
    ledger.notified.hard = now.toISOString();
    ledger.notified.soft ??= ledger.notified.hard;
    const gate = settings.mode === 'enforce' ? ' New `omg team` fan-out is refused or clamped until `omg budget reset` or a higher budget.hardLimit.' : '';
    return `[BUDGET] Hard limit reached: ${amount(settings.hardLimit)}.${gate} Tell the user before starting more work.`;
  }
  if (settings.softLimit !== undefined && used >= settings.softLimit && !ledger.notified.soft) {
    ledger.notified.soft = now.toISOString();
    return `[BUDGET] Soft limit reached: ${amount(settings.softLimit)}. Mention this to the user.`;
  }
  return null;
}

/** CLI argv phases; not the hook type names (the registry shadow matches those in args). */
export type BudgetHookPhase = 'start' | 'submit' | 'turn';

export interface BudgetHookInput {
  phase: BudgetHookPhase;
  payload: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
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

  if (input.phase !== 'submit' && sessionId && env.OMC_BUDGET_HOST_LEDGER !== '1') {
    const events = copilotEventsPath(sessionId);
    const usage = events ? readCopilotSessionUsage(events, now) : null;
    if (usage) recordUsage(path, sessionId, usage, worker?.split('/')[0]);
  }
  if (worker) return null;

  if (input.phase === 'start') {
    refreshEstimates(path, now);
    if (!hasLimits(settings)) return null;
    return { continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summaryLine(readLedger(path), settings) } };
  }
  if (input.phase === 'turn') {
    if (!hasLimits(settings)) return null;
    const notice = updateLedger(path, (ledger) => {
      const n = checkThresholds(ledger, settings, now);
      if (n) ledger.pendingNotice = n;
      return n;
    });
    return notice ? { continue: true, systemMessage: notice } : null;
  }
  // submit: deliver a pending notice as model context (Copilot injects top-level additionalContext).
  if (!readLedger(path).pendingNotice) return null;
  const notice = updateLedger(path, (ledger) => {
    const n = ledger.pendingNotice;
    delete ledger.pendingNotice;
    return n;
  });
  return notice ? { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice } } : null;
}

/** Re-read estimated sessions: once a session has ended its events carry measured totals. */
function refreshEstimates(path: string, now: Date): void {
  const ledger = readLedger(path);
  const stale = Object.entries(ledger.sessions).filter(([, r]) => r.source === 'estimated').slice(0, REFRESH_MAX);
  for (const [id] of stale) {
    const events = copilotEventsPath(id);
    const usage = events ? readCopilotSessionUsage(events, now) : null;
    if (usage?.source === 'measured') recordUsage(path, id, usage);
  }
}

export interface FanoutInput {
  settings: BudgetSettings;
  totals: LedgerTotals;
  agentTypes: readonly string[];
  /** `team.sdk.maxCreditsPerWorker`: the per-worker cap an sdk host enforces. */
  maxCreditsPerWorker: number;
  override: boolean;
  /** False when workers own decomposed subtasks: clamping would drop scope, so enforce refuses. */
  clampable: boolean;
}

export interface FanoutDecision {
  workerCount: number;
  /** Warning or clamp message for stderr. */
  notice?: string;
  /** Set when the launch must not start. */
  refusal?: string;
}

/**
 * Projected cost of a launch, ESTIMATED: one premium request per copilot
 * worker (its first prompt at an assumed x1 multiplier), or the per-worker
 * credit cap in `credits`. Non-copilot workers are not billed to Copilot.
 */
export function governTeamFanout(input: FanoutInput): FanoutDecision {
  const { settings, agentTypes } = input;
  const workerCount = agentTypes.length;
  if (!settings.enabled) return { workerCount };
  const copilot = agentTypes.filter((t) => t === 'copilot').length;
  const perWorker = settings.unit === 'credits' ? input.maxCreditsPerWorker : 1;
  const used = usedInUnit(input.totals, settings.unit);
  const bounds: Array<{ budget: number; label: string }> = [];
  if (settings.perTeamLimit !== undefined) bounds.push({ budget: settings.perTeamLimit, label: `budget.perTeamLimit ${settings.perTeamLimit}` });
  if (settings.hardLimit !== undefined) {
    bounds.push({ budget: Math.max(0, settings.hardLimit - used), label: `the ${formatAmount(Number(Math.max(0, settings.hardLimit - used).toFixed(3)), settings.unit)} left of budget.hardLimit ${settings.hardLimit}` });
  }
  if (copilot === 0 || bounds.length === 0) return { workerCount };
  const tightest = bounds.reduce((a, b) => (b.budget < a.budget ? b : a));
  const projected = copilot * perWorker;
  if (projected <= tightest.budget) return { workerCount };
  const basis = settings.unit === 'credits' ? `x ${perWorker} credit cap` : 'x 1 premium request, estimated';
  const over = `[omg budget] projected ${formatAmount(projected, settings.unit)} (${copilot} copilot worker(s) ${basis}) exceeds ${tightest.label}`;
  if (settings.mode !== 'enforce' || input.override) {
    return { workerCount, notice: `${over}; starting anyway (${input.override ? '--budget-override' : 'warn mode'}).` };
  }
  const allowed = Math.floor(tightest.budget / perWorker);
  const fix = 'Pass --budget-override, raise the limit in .copilot/omg.jsonc, or run `omg budget reset`.';
  if (allowed >= 1 && copilot === workerCount && input.clampable) {
    return { workerCount: allowed, notice: `${over}; clamped to ${allowed} worker(s). ${fix}` };
  }
  return { workerCount, refusal: `${over}; team launch refused. ${fix}` };
}
