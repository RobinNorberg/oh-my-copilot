/**
 * `omg budget [status|reset] [--json]`: the AI Credits usage ledger
 * (src/budget) against the `budget` limits of `.copilot/omg.jsonc`.
 */

import { formatAmount, formatUnit, loadBudgetSettings, summaryLine, usedInUnit } from '../../budget/governor.js';
import { ESTIMATED_CREDITS_PER_PROMPT, ledgerPath, ledgerTotals, readLedger, resetLedger, updateLedger } from '../../budget/ledger.js';

export async function budgetCommand(action: string, options: { json?: boolean }, cwd: string = process.cwd()): Promise<number> {
  const path = ledgerPath(cwd);
  const { settings, issues } = loadBudgetSettings(cwd);

  if (action === 'reset') {
    let previous: ReturnType<typeof resetLedger>;
    try {
      previous = updateLedger(path, (ledger) => resetLedger(ledger));
    } catch (error) {
      const busy = error instanceof Error && error.message.startsWith('Failed to acquire file lock');
      console.error(busy
        ? `omg budget reset: the ledger is locked by another process (${path}.lock); try again in a moment.`
        : `omg budget reset: could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ledgerPath: path, previous: { since: previous.since, credits: previous.credits, premiumRequests: previous.premiumRequests } }));
    } else {
      console.log(`Budget ledger reset. Previous period since ${previous.since.slice(0, 10)}: ${formatAmount(Number(previous.credits.toFixed(3)), 'credits')} (legacy ${formatAmount(previous.premiumRequests, 'premiumRequests')}).`);
    }
    return 0;
  }
  if (action !== 'status') {
    console.error(`Unknown budget action "${action}". Usage: omg budget [status|reset] [--json]`);
    return 2;
  }

  const ledger = readLedger(path);
  const totals = ledgerTotals(ledger);
  const used = usedInUnit(totals, settings.unit);
  /** Exit 1 once the hard limit is reached, so scripts can gate on it. */
  const code = settings.hardLimit !== undefined && used >= settings.hardLimit ? 1 : 0;
  if (options.json) {
    console.log(JSON.stringify({ ledgerPath: path, since: ledger.since, settings, issues, used, totals, notified: ledger.notified, sessions: ledger.sessions, teams: ledger.teams }, null, 2));
    return code;
  }
  console.log(summaryLine(ledger, settings).replace(/ Details: omg budget status\.$/, ''));
  for (const [team, t] of Object.entries(totals.teams)) {
    const cap = settings.perTeamLimit !== undefined ? ` (per-team limit ${settings.perTeamLimit} ${formatUnit(settings.unit)})` : '';
    const legacy = settings.unit === 'premiumRequests' ? ` (legacy ${formatAmount(t.premiumRequests, 'premiumRequests')})` : '';
    console.log(`  team ${team}: ${formatAmount(Number(t.credits.toFixed(3)), 'credits')}${legacy} over ${t.records} session(s)${cap}`);
  }
  if (totals.estimatedRecords > 0) {
    console.log(`  ${totals.estimatedRecords} record(s) are estimates (about ${ESTIMATED_CREDITS_PER_PROMPT} AI credit per prompt; the real cost varies by model); they become measured once the session's totals are written.`);
  }
  if (!settings.enabled) console.log('  Governor disabled (OMC_BUDGET_GOVERNOR=0).');
  for (const issue of issues) console.log(`  config: ${issue}`);
  console.log(`  ledger: ${path}`);
  return code;
}
