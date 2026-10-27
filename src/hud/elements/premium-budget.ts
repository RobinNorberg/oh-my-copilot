/**
 * OMC HUD - Copilot AI Credits budget (src/budget).
 *
 * `cr:4.2/50`: AI credits used against the warn-only `budget.softLimit`. A
 * leading `~` means part of the total is an estimate. Yellow from the soft
 * limit. Hidden when no soft limit is configured or the governor is off,
 * except on the Copilot host, which then shows the session's credits (`cr:0.4`).
 */

import { RESET } from '../colors.js';
import { hasLimits, loadBudgetSettings } from '../../budget/governor.js';
import { ledgerPath, ledgerTotals, NANO_AIU_PER_CREDIT, readLedger } from '../../budget/ledger.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

/** Session AI Credits from the Copilot statusline payload (`ai_used`). */
export interface SessionAiUsed {
  nanoAiu: number | null;
  formatted: string | null;
}

/**
 * `cr:0.4` from the Copilot payload when no budget applies: Copilot's own
 * `formatted` text, else nano-AIU in credits. Hidden at zero (fresh session).
 */
function renderSessionCredits(aiUsed: SessionAiUsed | null | undefined): string | null {
  if (!aiUsed || aiUsed.nanoAiu === 0) return null;
  const value = aiUsed.formatted
    ?? (aiUsed.nanoAiu !== null ? String(Number((aiUsed.nanoAiu / NANO_AIU_PER_CREDIT).toFixed(1))) : null);
  return value ? `cr:${GREEN}${value}${RESET}` : null;
}

/**
 * @param sessionAiUsed Copilot host only: the session's `ai_used`, shown when
 *   no budget limit is configured. Claude passes nothing and keeps the old rule.
 */
export function renderPremiumBudget(cwd: string, sessionAiUsed?: SessionAiUsed | null): string | null {
  try {
    const { settings } = loadBudgetSettings(cwd);
    if (!settings.enabled || !hasLimits(settings)) {
      return sessionAiUsed === undefined ? null : renderSessionCredits(sessionAiUsed);
    }
    const totals = ledgerTotals(readLedger(ledgerPath(cwd)));
    const used = totals.credits;
    const limit = settings.softLimit!;
    const color = used >= limit ? YELLOW : GREEN;
    const approx = totals.estimatedRecords > 0 ? '~' : '';
    return `cr:${color}${approx}${Number(used.toFixed(1))}/${limit}${RESET}`;
  } catch {
    return null;
  }
}
