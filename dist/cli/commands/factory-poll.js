/**
 * `omg factory poll` (ADO parity design §2): the foreground polling loop
 * over heal, intake, PRs and the board. The command lives in
 * src/factory/poll.ts.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { runFactoryPoll } from '../../factory/poll.js';
export function factoryPollCommand(deps) {
    return new Command('poll')
        .description('Poll heal, intake, PRs and the board each interval (GitHub and Azure DevOps); never writes to the tracker or forge, and starts no lane unless factory.intake.autoStart (trusted config) starts omg factory run --next on an idle tick')
        .option('--interval <duration>', 'wait between ticks: <n>s, <n>m or <n>h, 2 min to 60 min (default 5m; doubles while rate-limited)')
        .option('--once', 'run one tick and exit')
        .option('--no-heal', 'skip the heal scan')
        .option('--no-intake', 'skip the intake query (the board shows runs only)')
        .option('--no-prs', 'skip the PR reads')
        .option('--json', 'one JSON object per tick (schemaVersion 1)')
        .action(async (o) => {
        try {
            process.exitCode = await runFactoryPoll(o, deps);
        }
        catch (error) {
            const message = plainText(error instanceof Error ? error.message : String(error));
            if (o.json)
                deps.out(JSON.stringify({ ok: false, error: message }));
            else
                deps.err(chalk.red(`Error: ${message}`));
            process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
        }
    });
}
//# sourceMappingURL=factory-poll.js.map