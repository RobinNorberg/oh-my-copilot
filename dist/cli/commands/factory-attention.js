/**
 * `omg factory attention [--json] [--verbose] [--exit-zero]`: what needs the
 * human, grouped by the action it needs, from local state only (no network,
 * no forge read, no write). Logic in src/factory/attention/.
 *
 * Exit codes: 0 nothing needs you; 4 something does (EXIT_AWAITING_HUMAN;
 * 0 with --exit-zero); 1 a run state could not be read; 2 usage.
 */
import { execFileSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { attentionJson, collectAttention } from '../../factory/attention/collect.js';
import { renderAttention } from '../../factory/attention/render.js';
import { EXIT_CHECK_FAILED, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { EXIT_AWAITING_HUMAN } from '../../factory/run/engine.js';
import { defaultLedgerDir } from '../../factory/run/ledger.js';
const defaultRoot = () => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
export const defaultAttentionDeps = { root: defaultRoot, out: (l) => console.log(l), err: (l) => console.error(l) };
export function factoryAttentionCommand(deps = defaultAttentionDeps) {
    const cmd = new Command('attention')
        .description('What needs you: parked, broken and tampered factory runs grouped by the human action, with the next commands (local state only: no network, no forge read, no write)')
        .option('--json', 'JSON output (schemaVersion 1)')
        .option('--verbose', 'also print each park\'s full reason, for runs whose state is the engine\'s own (never its local detail)')
        .option('--exit-zero', 'exit 0 when something needs you (default: 4)');
    cmd.exitOverride((e) => {
        e.exitCode = e.code === 'commander.helpDisplayed' || e.code === 'commander.help' || e.code === 'commander.version' ? 0 : EXIT_CHECK_USAGE;
        throw e;
    });
    return cmd.action((o) => {
        let root;
        try {
            root = deps.root();
        }
        catch {
            deps.err(chalk.red('omg factory attention must run inside a git repository'));
            process.exitCode = EXIT_CHECK_USAGE;
            return;
        }
        try {
            const warnings = [];
            let limits = null;
            try {
                const loaded = deps.limits?.(root);
                if (loaded) {
                    limits = loaded.limits;
                    warnings.push(...loaded.warnings);
                }
            }
            catch (error) {
                warnings.push(`the run limits could not be resolved, so no credit cap is shown: ${error instanceof Error ? error.message : String(error)}`);
            }
            const data = collectAttention(root, { ledgerDir: deps.ledgerDir ?? defaultLedgerDir(), limits, verbose: Boolean(o.verbose) || Boolean(o.json), ...(deps.now ? { now: deps.now } : {}), ...(deps.owner ? { owner: deps.owner } : {}) });
            data.warnings.unshift(...warnings.map((w) => plainText(w)));
            if (o.json)
                deps.out(JSON.stringify(attentionJson(data), null, 2));
            else {
                for (const w of data.warnings)
                    deps.err(chalk.yellow(w));
                deps.out(renderAttention(data, { verbose: o.verbose }));
            }
            process.exitCode = data.readFailed ? EXIT_CHECK_FAILED : data.items.length > 0 && !o.exitZero ? EXIT_AWAITING_HUMAN : 0;
        }
        catch (error) {
            deps.err(chalk.red(plainText(error instanceof Error ? error.message : String(error))));
            process.exitCode = EXIT_CHECK_FAILED;
        }
    });
}
//# sourceMappingURL=factory-attention.js.map