/**
 * `omg factory check` (factory forges design §5): bucket intake items as
 * runnable / needs-plan / blocked, ordered by priority; `--mark` tags the
 * runnable ones. The command lives in src/factory/check/cli.ts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline/promises';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE, runFactoryCheck, type FactoryCheckDeps } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { createForge } from '../../forge/index.js';
import { userConfigLayers } from '../../ship/config.js';
import { defaultExec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { integerOption } from '../utils/integer-option.js';

async function ttyConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function defaultFactoryCheckDeps(base: (root: string) => string): FactoryCheckDeps {
  return {
    exec: defaultExec,
    base,
    trustedUser: () => userConfigLayers().trustedUser,
    projectConfig: (root) => {
      const path = resolveProjectConfigPath(root);
      return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
    },
    createForge,
    isTTY: () => Boolean(process.stdin.isTTY),
    confirm: ttyConfirm,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

export function factoryCheckCommand(deps: FactoryCheckDeps): Command {
  return new Command('check')
    .description('Bucket intake items as runnable / needs-plan / blocked (read-only; --mark tags the runnable ones)')
    .argument('[ids...]', 'item ids (GitHub issue numbers or ADO work item ids); default: the intake source')
    .option('--source <spec>', 'intake source: label:<name> | milestone:<name> | wiql-query:<guid> | board-column:<team>/<board>/<column> | area-tag:<area path>#<tag>')
    .option('--limit <n>', 'items read from the source (1..200)', integerOption(1, 200))
    .option('--json', 'JSON output (schemaVersion 1)')
    .option('--mark', 'add factory.intake.marker to the runnable items (asks first)')
    .option('--yes', 'confirm --mark without a prompt')
    .action(async (ids: string[], o: { source?: string; limit?: number; json?: boolean; mark?: boolean; yes?: boolean }) => {
      try {
        process.exitCode = await runFactoryCheck({ ids, ...o }, deps);
      } catch (error) {
        const message = plainText(error instanceof Error ? error.message : String(error));
        if (o.json) deps.out(JSON.stringify({ ok: false, error: message }, null, 2));
        else deps.err(chalk.red(`Error: ${message}`));
        process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
      }
    });
}
