/**
 * `omg budget [status|reset] [--json]`: the premium-request ledger
 * (src/budget) against the `budget` limits of `.copilot/omg.jsonc`.
 */

import { formatAmount, loadBudgetSettings, summaryLine, usedInUnit } from '../../budget/governor.js';
import { emptyLedger, ledgerPath, ledgerTotals, readLedger, updateLedger } from '../../budget/ledger.js';

export async function budgetCommand(action: string, options: { json?: boolean }, cwd: string = process.cwd()): Promise<number> {
  const path = ledgerPath(cwd);
  const { settings, issues } = loadBudgetSettings(cwd);

  if (action === 'reset') {
    const previous = updateLedger(path, (ledger) => {
      const before = { since: ledger.since, ...ledgerTotals(ledger) };
      delete ledger.pendingNotice;
      Object.assign(ledger, emptyLedger());
      return before;
    });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ledgerPath: path, previous: { since: previous.since, premiumRequests: previous.premiumRequests, credits: previous.credits } }));
    } else {
      console.log(`Budget ledger reset. Previous period since ${previous.since.slice(0, 10)}: ${formatAmount(previous.premiumRequests, 'premiumRequests')}, ${formatAmount(Number(previous.credits.toFixed(3)), 'credits')}.`);
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
    const cap = settings.perTeamLimit !== undefined ? ` (per-team limit ${settings.perTeamLimit} ${settings.unit})` : '';
    console.log(`  team ${team}: ${formatAmount(t.premiumRequests, 'premiumRequests')}, ${formatAmount(Number(t.credits.toFixed(3)), 'credits')} over ${t.records} session(s)${cap}`);
  }
  if (totals.estimatedRecords > 0) {
    console.log(`  ${totals.estimatedRecords} record(s) are estimates (1 premium request per prompt, multiplier unknown); they become measured once the session's totals are written.`);
  }
  if (!settings.enabled) console.log('  Governor disabled (OMC_BUDGET_GOVERNOR=0).');
  for (const issue of issues) console.log(`  config: ${issue}`);
  console.log(`  ledger: ${path}`);
  return code;
}
