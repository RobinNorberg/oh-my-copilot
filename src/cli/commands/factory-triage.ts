/**
 * `omg factory triage` (night-3 goal 4): propose priority, needs-split and
 * needs-plan labels for intake items; `--apply` writes the printed plan.
 * The command lives in src/factory/triage/cli.ts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE, factoryErrorLine, type FactoryCheckDeps } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { runFactoryTriage } from '../../factory/triage/cli.js';
import { integerOption } from '../utils/integer-option.js';

export function factoryTriageCommand(deps: FactoryCheckDeps): Command {
  return new Command('triage')
    .description('Propose priority and needs-split / needs-plan labels for intake items (dry run; --apply writes the printed plan)')
    .argument('[ids...]', 'item ids; default: the intake source')
    .option('--parent <spec>', 'triage the children of this spec item')
    .option('--source <spec>', 'intake source (as omg factory check --source)')
    .option('--limit <n>', 'items read from the source (1..200)', integerOption(1, 200))
    .option('--apply', 'write the plan (labels, and the priority field on Azure DevOps and the local backlog); without it nothing is written')
    .option('--json', 'JSON output (schemaVersion 1)')
    .addHelpText('after', [
      '',
      'Taxonomy: priority:p0..p3 (one per item), needs-split, needs-plan (names: factory.triage.labels).',
      'Items with a live run or an open factory PR are skipped. On GitHub a label the repository lacks is',
      'never created: its items are skipped. On the local forge --apply edits the backlog files in the',
      'working tree; commit them on the base branch.',
    ].join('\n'))
    .action(async (ids: string[], o: { parent?: string; source?: string; limit?: number; apply?: boolean; json?: boolean }) => {
      try {
        process.exitCode = await runFactoryTriage({ ids, ...o }, deps);
      } catch (error) {
        const message = plainText(error instanceof Error ? error.message : String(error));
        if (o.json) deps.out(JSON.stringify({ ok: false, error: message }, null, 2));
        else deps.err(chalk.red(factoryErrorLine(message)));
        process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
      }
    });
}
