/**
 * `omg factory board` (ADO parity design §1): a read-only view of intake
 * items, their runs and tracker stages. The command lives in
 * src/factory/board/collect.ts.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { runFactoryBoard } from '../../factory/board/collect.js';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { integerOption } from '../utils/integer-option.js';
export function factoryBoardCommand(deps) {
    return new Command('board')
        .description('Read-only board: intake items by bucket, runs by tracker stage, drift / unsynced / seal / stale flags')
        .option('--source <spec>', 'intake source: label:<name> | milestone:<name> | wiql-query:<guid> | board-column:<team>/<board>/<column> | area-tag:<area path>#<tag>')
        .option('--parent <spec>', 'show the children of this spec item instead of the intake source')
        .option('--limit <n>', 'items read from the source (1..200)', integerOption(1, 200))
        .option('--no-check', 'skip the check rules: one batched tracker read for the live stages')
        .option('--json', 'JSON output (schemaVersion 1)')
        .action(async (o) => {
        try {
            process.exitCode = await runFactoryBoard(o, deps);
        }
        catch (error) {
            const message = plainText(error instanceof Error ? error.message : String(error));
            if (o.json)
                deps.out(JSON.stringify({ ok: false, error: message }, null, 2));
            else
                deps.err(chalk.red(`Error: ${message}`));
            process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
        }
    });
}
//# sourceMappingURL=factory-board.js.map