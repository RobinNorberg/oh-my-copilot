/**
 * `omg factory dashboard`: a static HTML page (or --json) of every factory run
 * of this repository, from local state only. Logic in src/factory/dashboard/.
 */

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { collectDashboard } from '../../factory/dashboard/collect.js';
import { renderDashboardHtml } from '../../factory/dashboard/render.js';
import { EXIT_CHECK_FAILED, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';

export interface FactoryDashboardDeps {
  root: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
}

const defaultRoot = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();

export const defaultDashboardDeps: FactoryDashboardDeps = { root: defaultRoot, out: (l) => console.log(l), err: (l) => console.error(l) };

export function factoryDashboardCommand(deps: FactoryDashboardDeps = defaultDashboardDeps): Command {
  return new Command('dashboard')
    .description('One static HTML page of all factory runs, parks, time per phase, credits per role and day, and bench results (local state only)')
    .option('--out <file>', 'write the HTML page to this file (default: print it)')
    .option('--json', 'emit the same data as JSON (schemaVersion 1)')
    .option('--since <date>', 'only runs updated on or after this date (2026-11-01)')
    .action((o: { out?: string; json?: boolean; since?: string }) => {
      let root: string;
      try {
        root = deps.root();
      } catch {
        deps.err(chalk.red('omg factory dashboard must run inside a git repository'));
        process.exitCode = EXIT_CHECK_USAGE;
        return;
      }
      try {
        const data = collectDashboard(root, { since: o.since, now: deps.now });
        const body = o.json ? JSON.stringify(data, null, 2) : renderDashboardHtml(data);
        if (o.out) {
          const file = resolve(o.out);
          writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
          deps.err(`wrote ${file} (${data.totals.runs} runs)`);
        } else {
          deps.out(body);
        }
        process.exitCode = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.err(chalk.red(message));
        process.exitCode = message.startsWith('--since') ? EXIT_CHECK_USAGE : EXIT_CHECK_FAILED;
      }
    });
}
