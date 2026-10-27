/**
 * OMC HUD - Copilot AI Credits budget (src/budget).
 *
 * `cr:4.2/50`: AI credits used against the warn-only `budget.softLimit`. A
 * leading `~` means part of the total is an estimate. Yellow from the soft
 * limit. Hidden when no soft limit is configured or the governor is off.
 */
import { RESET } from '../colors.js';
import { hasLimits, loadBudgetSettings } from '../../budget/governor.js';
import { ledgerPath, ledgerTotals, readLedger } from '../../budget/ledger.js';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
export function renderPremiumBudget(cwd) {
    try {
        const { settings } = loadBudgetSettings(cwd);
        if (!settings.enabled || !hasLimits(settings))
            return null;
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