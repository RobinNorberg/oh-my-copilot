/**
 * `omg budget [status|reset] [--json]`: the AI Credits usage ledger
 * (src/budget) against the warn-only `budget.softLimit` of `.copilot/omg.jsonc`.
 * Reporting only: status always exits 0.
 */

import { deprecationNotice, formatAmount, loadBudgetSettings, summaryLine } from '../../budget/governor.js';
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
  if (options.json) {
    console.log(JSON.stringify({ ledgerPath: path, since: ledger.since, settings, issues, used: totals.credits, totals, notified: ledger.notified, sessions: ledger.sessions, teams: ledger.teams }, null, 2));
    return 0;
  }
  // The deprecation notice is part of the summary line; the issue list would repeat it.
  console.log(summaryLine(ledger, settings).replace(/ Details: omg budget status\.$/, ''));
  for (const [team, t] of Object.entries(totals.teams)) {
    console.log(`  team ${team}: ${formatAmount(Number(t.credits.toFixed(3)), 'credits')} over ${t.records} session(s)`);
  }
  if (totals.estimatedRecords > 0) {
    console.log(`  ${totals.estimatedRecords} record(s) are estimates (about ${ESTIMATED_CREDITS_PER_PROMPT} AI credit per prompt; the real cost varies by model); they become measured once the session's totals are written.`);
  }
  if (!settings.enabled) console.log('  Governor disabled (OMC_BUDGET_GOVERNOR=0).');
  const shown = settings.deprecated.length > 0 ? deprecationNotice(settings.deprecated) : undefined;
  for (const issue of issues) if (issue !== shown) console.log(`  config: ${issue}`);
  console.log(`  ledger: ${path}`);
  return 0;
}
