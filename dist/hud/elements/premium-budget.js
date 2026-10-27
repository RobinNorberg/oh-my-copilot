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
/** Credits text: up to 2 decimals from a hundredth to 0.1 (0.099 shows as 0.1), `<0.01` below, else 1 decimal. */
function formatCredits(nanoAiu) {
    const credits = nanoAiu / NANO_AIU_PER_CREDIT;
    if (credits >= 0.1)
        return String(Number(credits.toFixed(1)));
    return credits < 0.01 ? '<0.01' : String(Number(credits.toFixed(2)));
}
/**
 * `cr:0.4` from the Copilot payload when no budget applies: nano-AIU converted
 * to credits, falling back to Copilot's `formatted` text (format unverified)
 * only when the number is missing. Hidden at exactly zero (fresh session).
 */
function renderSessionCredits(aiUsed) {
    if (!aiUsed || aiUsed.nanoAiu === 0)
        return null;
    const value = aiUsed.nanoAiu !== null ? formatCredits(aiUsed.nanoAiu) : aiUsed.formatted;
    return value ? `cr:${GREEN}${value}${RESET}` : null;
}
/**
 * @param sessionAiUsed Copilot host only: the session's `ai_used`, shown when
 *   no budget limit is configured. Claude passes nothing and keeps the old rule.
 */
export function renderPremiumBudget(cwd, sessionAiUsed) {
    try {
        const { settings } = loadBudgetSettings(cwd);
        if (!settings.enabled || !hasLimits(settings)) {
            return sessionAiUsed === undefined ? null : renderSessionCredits(sessionAiUsed);
        }
        const totals = ledgerTotals(readLedger(ledgerPath(cwd)));
        const used = totals.credits;
        const limit = settings.softLimit;
        const color = used >= limit ? YELLOW : GREEN;
        const approx = totals.estimatedRecords > 0 ? '~' : '';
        return `cr:${color}${approx}${Number(used.toFixed(1))}/${limit}${RESET}`;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=premium-budget.js.map