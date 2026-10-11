/**
 * OMC HUD - Copilot premium-request budget (src/budget).
 *
 * `prq:12/300` (or `cr:4.2/50` with budget.unit "credits") against the hard
 * limit, else the soft limit. A leading `~` means part of the total is an
 * estimate. Yellow from the soft limit, red from the hard limit. Hidden when
 * no budget limit is configured or the governor is off.
 */
import { RESET } from '../colors.js';
import { hasLimits, loadBudgetSettings, usedInUnit } from '../../budget/governor.js';
import { ledgerPath, ledgerTotals, readLedger } from '../../budget/ledger.js';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
export function renderPremiumBudget(cwd) {
    try {
        const { settings } = loadBudgetSettings(cwd);
        if (!settings.enabled || !hasLimits(settings))
            return null;
        const totals = ledgerTotals(readLedger(ledgerPath(cwd)));
        const used = usedInUnit(totals, settings.unit);
        const shown = settings.unit === 'credits' ? Number(used.toFixed(1)) : Math.round(used * 100) / 100;
        const limit = settings.hardLimit ?? settings.softLimit;
        const color = settings.hardLimit !== undefined && used >= settings.hardLimit ? RED
            : settings.softLimit !== undefined && used >= settings.softLimit ? YELLOW
                : GREEN;
        const label = settings.unit === 'credits' ? 'cr' : 'prq';
        const approx = totals.estimatedRecords > 0 ? '~' : '';
        return `${label}:${color}${approx}${shown}${limit !== undefined ? `/${limit}` : ''}${RESET}`;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=premium-budget.js.map