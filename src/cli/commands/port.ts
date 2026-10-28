/**
 * `omg port drive --head <sha>`: the automated upstream port (src/port/engine.ts).
 * Exit codes: 0 done (draft PR open, a human merges), 1 a phase failed,
 * 2 usage error, 3 blocked on a human decision (the note names the brief or
 * the delta, and the next command).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'path';
import { CopilotRunManager, defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { CopilotLaneBackend, type LaneBackend } from '../../factory/run/lane.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { runPortDrive, type PortDriveResult } from '../../port/engine.js';
import { emitReleaseProgress } from '../../release/progress.js';
import { defaultExec, type Exec } from '../../ship/exec.js';
import { integerOption } from '../utils/integer-option.js';

export interface PortCommandDeps {
  exec?: Exec;
  /** Built only for --reconcile-lane: the paid lane's backend. */
  lanes?: () => LaneBackend;
  node?: string;
}

class PortUsageError extends Error {}

function printResult(r: PortDriveResult): void {
  const color = r.status === 'done' ? chalk.green : r.status === 'blocked' ? chalk.yellow : chalk.red;
  console.log(color(`port ${r.status}: ${r.message}`));
  if (r.brief) console.log(`brief: ${r.brief}`);
  for (const b of r.blockers) console.log(chalk.yellow(`  human gate: ${b}`));
  if (r.gates.length > 0) console.log(`gates: ${r.gates.join(', ')}`);
  if (r.next) console.log(`next: ${r.next}`);
}

export function portCommand(deps: PortCommandDeps = {}): Command {
  const cmd = new Command('port').description('Upstream port automation (maintainer-only)');
  cmd
    .command('drive')
    .description('Apply upstream to <sha> on port/upstream-<short>, drop junk, classify the package.json delta, reconcile (brief or capped lane), run the port gates, commit + inventory, push and open a draft PR')
    .requiredOption('--head <sha>', 'Upstream commit to port up to (fetch upstream first)')
    .option('--continue', 'Resume on the port branch after a human resolved what blocked the run (skips apply and delta)')
    .option('--reconcile-lane', 'On conflicts, run the brief as a paid write lane (needs --max-credits)')
    .option('--max-credits <n>', 'Mandatory AI-credit cap of the reconcile lane', integerOption(1))
    .option('--lane-timeout <minutes>', 'Reconcile lane timeout in minutes', integerOption(1), 60)
    .option('--model <model>', 'Reconcile lane model')
    .option('--base <branch>', 'PR base branch', 'dev')
    .option('--remote <name>', 'Remote to push the port branch to', 'origin')
    .option('--no-push', 'Commit locally; no push, no PR')
    .option('--date <YYYY-MM-DD>', 'ported_at date for the marker')
    .option('--progress-file <path>', 'Progress log (default $OMG_PROGRESS_FILE, else <state root>/progress/port.log)')
    .option('--json', 'JSON output')
    .action(async (o: {
      head: string; continue?: boolean; reconcileLane?: boolean; maxCredits?: number; laneTimeout: number; model?: string;
      base: string; remote: string; push: boolean; date?: string; progressFile?: string; json?: boolean;
    }) => {
      const json = Boolean(o.json);
      try {
        if (o.reconcileLane && o.maxCredits === undefined) throw new PortUsageError('--reconcile-lane needs --max-credits <n> (the lane is paid)');
        const exec = deps.exec ?? defaultExec;
        const top = exec('git', ['rev-parse', '--show-toplevel']);
        if (top.status !== 0) throw new PortUsageError('omg port drive must run inside a git repository');
        const cwd = top.stdout.trim();
        const progressFile = o.progressFile ?? process.env.OMG_PROGRESS_FILE ?? join(getOmcRoot(cwd), 'progress', 'port.log');
        const result = await runPortDrive({
          cwd, head: o.head, exec, node: deps.node, base: o.base, remote: o.remote, push: o.push, resume: o.continue, date: o.date, progressFile,
          reconcileLane: o.reconcileLane ? { maxCredits: o.maxCredits as number, timeoutMs: o.laneTimeout * 60_000, ...(o.model ? { model: o.model } : {}) } : null,
          lanes: deps.lanes ?? (() => new CopilotLaneBackend(new CopilotRunManager(defaultCopilotRunDeps()), { allowLive: true })),
          progress: (phase, status, note) => { emitReleaseProgress({ phase, status, note, agent: 'port', file: progressFile }, getOmcRoot(cwd)); },
          log: (line) => { if (!json) console.error(line); },
        });
        if (json) console.log(JSON.stringify(result, null, 2));
        else printResult(result);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
        else console.error(chalk.red(`Error: ${message}`));
        process.exitCode = error instanceof PortUsageError ? 2 : 1;
      }
    });
  return cmd;
}
