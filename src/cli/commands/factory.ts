/**
 * Factory command (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * `omg factorylisten` — the resident intake daemon. Transport adapters
 * (smee.io / cloudflared / direct) live outside the OMC boundary: the daemon
 * only receives already-unpacked webhook events as POSTs and does the OMC-side
 * work itself (HMAC verification, repo whitelist, intake label gate, routing
 * through the shared pure function, headless intent session spawn).
 *
 * `omg factoryinit` — seeds the project route table (`.omg/factory-routes.json`,
 * the single source of truth the SessionEnd chain enqueuer reads) and validates
 * the factory prerequisites. Default seeds the narrow starter loop; --no-narrow
 * seeds the full-pipeline widening template. Never overwrites without --force.
 *
 * Liveness: pid file at <omc root>/state/factory-listener.json (SessionStart
 * supervision reads it) plus a GET /status endpoint on the listening port.
 */

import { Command } from 'commander';
import { integerOption } from '../utils/integer-option.js';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { INTAKE_ROUTE_TABLE, startListener, stopListener } from '../../factory/listener.js';
import { readChainStatus, type ChainStatus } from '../../factory/status.js';
import { type RouteTable } from '../../hooks/session-end/routing.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CopilotRunManager, defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { resolveFactoryRunLimits, runCredits, type LoadedFactoryRunLimits } from '../../factory/run/budget.js';
import { cleanFactoryRun } from '../../factory/run/clean.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine, type FactoryRunOutcome } from '../../factory/run/engine.js';
import { factoryGuardExec } from '../../factory/run/exec.js';
import { CopilotLaneBackend, type LaneBackend } from '../../factory/run/lane.js';
import type { GateConfigLoader } from '../../factory/run/prepare.js';
import { factoryCancelRequested, factoryStatePath, readFactoryState, requestFactoryCancel, verifyFactoryIntegrity, type FactoryRunState } from '../../factory/run/state.js';
import { resolveShipConfig, userConfigLayers } from '../../ship/config.js';
import { defaultExec, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { healCommand } from '../../factory/heal/cli.js';
import { resolveHealConfig } from '../../factory/heal/config.js';

export function renderChainStatus(status: ChainStatus): string {
  const lines: string[] = [];
  lines.push(`链状态 ${status.directory}`);
  lines.push(`路由表（.omg/factory-routes.json，单一权威）: ${status.routeKeys.length} 键${status.routeKeys.length > 0 ? ` — ${status.routeKeys.join(', ')}` : ''}`);
  lines.push(`活跃 ledger: ${status.activeLedgers}`);
  lines.push(`意图（${status.intents.length}）:`);
  if (status.intents.length === 0) lines.push('  （无决策记录）');
  for (const intent of status.intents) {
    const last = intent.lastDecision ? `${intent.lastDecision} @ ${intent.lastDecisionAt ?? '?'}` : '无';
    const stopped = intent.stopped ? `  停链[${intent.stopped.reason}]` : '';
    lines.push(`  ${intent.intentId}  决策 ${intent.decisionCount}  末次 ${last}${stopped}`);
    intent.links.forEach((link, index) => {
      const host = link.host ? ` [${link.host}]` : '';
      const ended = link.closedAt
        ? `已结束 ${link.outcome ?? '?'}→${link.decision ?? '?'}${link.hostSessionId && link.hostSessionId !== link.chainLink ? ` session=${link.hostSessionId}` : ''}`
        : '运行中';
      lines.push(`    环 ${index + 1} ${link.stage}${host} link=${link.chainLink} ${ended}`);
    });
  }
  lines.push(`停滞环（阈值 30min 未推进）: ${status.stalled.length}`);
  for (const stall of status.stalled) {
    lines.push(`  ${stall.intentId} stage=${stall.stage} 停滞 ${Math.round(stall.stalledForMs / 60_000)}min session=${stall.session}`);
  }
  return lines.join('\n');
}

/** Seams for `omg factory run` (tests script gh/git and the lanes; nothing live). */
export interface FactoryRunDeps {
  exec: Exec;
  lanes: (root: string) => LaneBackend;
  /** Limits from `factory.run` (trusted user config; the project config can only tighten). */
  limits: (root: string) => LoadedFactoryRunLimits;
  /** The integration branch: ship.base from the project config, else the user config, else dev. */
  base: (root: string) => string;
  /** Engine ledger directory outside the repo (default: `$OMC_STATE_DIR` or `~/.omg`, then `factory-ledger`). */
  ledgerDir?: string;
  /** Ship's gate config at GitHub's base sha (default: ship's strict safety-key loader). */
  gateConfig?: GateConfigLoader;
}

function projectConfig(root: string): unknown {
  const path = resolveProjectConfigPath(root);
  return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
}

export const defaultFactoryRunDeps: FactoryRunDeps = {
  exec: defaultExec,
  // `omg factory run` without --dry-run is itself the opt-in to live, billed lanes.
  lanes: () => new CopilotLaneBackend(new CopilotRunManager(defaultCopilotRunDeps()), { allowLive: true }),
  limits: (root) => resolveFactoryRunLimits(userConfigLayers().trustedUser, projectConfig(root)),
  base: (root) => {
    const pick = (c: unknown) => (c as { ship?: { base?: unknown } } | null | undefined)?.ship?.base;
    return resolveShipConfig({ base: pick(projectConfig(root)) ?? pick(userConfigLayers().user) }).base;
  },
};

class FactoryUsageError extends Error {}

/** --dry-run never starts a lane: any call is a bug and throws. */
const NO_LANES: LaneBackend = {
  kind: 'local-sdk',
  start: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
  poll: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
  wait: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
  cancel: () => Promise.reject(new Error('omg factory run --dry-run starts no lanes')),
};

function parseIssue(raw: string | undefined): number {
  const n = Number(String(raw ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new FactoryUsageError(`issue must be a positive number, got ${JSON.stringify(raw)}`);
  return n;
}

function factoryRoot(exec: Exec): string {
  const r = exec('git', ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw new FactoryUsageError('omg factory run must run inside a git repository');
  return r.stdout.trim();
}

async function factoryGuarded(json: boolean, fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(chalk.red(`Error: ${message}`));
    process.exitCode = error instanceof FactoryUsageError ? 2 : 1;
  }
}

export function renderFactoryRunState(state: FactoryRunState): string {
  const lines = [`${chalk.bold(`factory run #${state.issue}`)}  phase=${chalk.cyan(state.phase)}  base=${state.base}  branch=${state.branch}${state.pr ? `  PR #${state.pr}` : ''}`];
  if (state.gate) lines.push(chalk.yellow(`awaiting-human: ${state.gate.name}: ${state.gate.reason}`));
  if (state.cancelRequested && state.phase !== 'cancelled') lines.push(chalk.yellow('cancel requested'));
  if (state.head) lines.push(`head ${state.head.slice(0, 12)}`);
  lines.push(`lanes ${state.lanes.length}  run AI credits ${runCredits(state).toFixed(2)}  elapsed ${Math.round(state.elapsedMs / 60_000)} min`);
  for (const lane of state.lanes) {
    const credits = lane.usage ? `${lane.usage.credits.toFixed(2)}/${lane.maxCredits}` : `-/${lane.maxCredits}`;
    lines.push(`  ${lane.id} ${lane.status}${lane.verdict ? ` ${lane.verdict}` : ''} credits ${credits}${lane.jobId ? ` job ${lane.jobId}` : ''}`);
  }
  for (const h of state.history.slice(-5)) lines.push(chalk.gray(`  ${h.at} ${h.from ?? '-'} -> ${h.to}: ${h.note}`));
  return lines.join('\n');
}

function printOutcome(json: boolean, outcome: FactoryRunOutcome): void {
  if (json) {
    console.log(JSON.stringify({ ok: outcome.exitCode === 0, ...outcome }, null, 2));
    return;
  }
  if (outcome.state) console.log(renderFactoryRunState(outcome.state));
  const color = outcome.exitCode === 0 ? chalk.green : outcome.exitCode === 1 ? chalk.red : chalk.yellow;
  console.log(color(outcome.message));
}

/** `omg factory run <issue>`, `run cancel|clean|status <issue>` (experimental; manual trigger only; merge is always human). */
export function factoryRunCommand(deps: FactoryRunDeps = defaultFactoryRunDeps): Command {
  const exec = factoryGuardExec(deps.exec);
  const run = new Command('run');
  run
    .description('Experimental: drive one issue through implement -> draft PR -> independent review / fix rounds -> prepare -> CI gates, then park for the human merge')
    .argument('[issue]', 'GitHub issue number')
    .option('--dry-run', 'Resolve the issue and plan and print the next step; no state, lanes or pushes')
    .option('--json', 'JSON output')
    .action((issueRaw: string | undefined, o: { dryRun?: boolean; json?: boolean }) =>
      factoryGuarded(Boolean(o.json), async () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const { limits, warnings } = deps.limits(root);
        for (const w of warnings) console.error(chalk.yellow(w));
        let signals = 0;
        const onSignal = () => {
          signals += 1;
          if (signals > 1) process.exit(130);
          console.error(chalk.yellow('omg factory run: stopping after the current poll (cancelling the lane); press again to exit at once'));
        };
        if (!o.dryRun) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }
        try {
          const outcome = await runFactoryEngine({
            root, issue, exec: deps.exec, limits, base: deps.base(root), dryRun: Boolean(o.dryRun),
            lanes: o.dryRun ? NO_LANES : deps.lanes(root),
            ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}),
            ...(deps.gateConfig ? { gateConfig: deps.gateConfig } : {}),
            interrupted: () => signals > 0,
            warn: (m) => console.error(chalk.yellow(m)),
          });
          printOutcome(Boolean(o.json), outcome);
          return outcome.exitCode;
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        }
      }));

  run
    .command('cancel <issue>')
    .description('Ask the running engine to cancel the lane and stop (the PR, branch and worktrees are kept)')
    .option('--json', 'JSON output')
    .action((issueRaw: string, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const state = requestFactoryCancel(factoryRoot(exec), issue, new Date().toISOString());
        if (c.optsWithGlobals().json) console.log(JSON.stringify({ ok: true, cancelRequested: true, phase: state.phase }, null, 2));
        else console.log(chalk.green(`cancel requested for factory run #${issue} (phase ${state.phase}); a running engine stops within seconds, otherwise the next run finishes the cancel`));
        return 0;
      }));

  run
    .command('clean <issue>')
    .description('Remove the worktrees and local branches of a merged or cancelled run, only when nothing would be lost (the PR branch on GitHub is kept)')
    .option('--json', 'JSON output')
    .action((issueRaw: string, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const result = cleanFactoryRun({ root: factoryRoot(exec), issue, exec: deps.exec, ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}) });
        if (c.optsWithGlobals().json) console.log(JSON.stringify({ ok: result.kept.length === 0, ...result }, null, 2));
        else {
          for (const path of result.removed) console.log(chalk.green(`removed ${path}`));
          for (const k of result.kept) console.log(chalk.yellow(`kept ${k.worktree}: ${k.reason}`));
          if (result.removed.length === 0 && result.kept.length === 0) console.log(`nothing to clean for factory run #${issue}`);
        }
        return result.kept.length === 0 ? 0 : EXIT_AWAITING_HUMAN;
      }));

  run
    .command('status <issue>')
    .description('Print the persisted factory run state (read-only)')
    .option('--json', 'JSON output')
    .action((issueRaw: string, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const stored = readFactoryState(root, issue);
        if (!stored) throw new FactoryUsageError(`no factory run for issue #${issue} (${factoryStatePath(root, issue)})`);
        const state = factoryCancelRequested(root, issue) ? { ...stored, cancelRequested: true } : stored;
        const integrity = verifyFactoryIntegrity(stored);
        if (c.optsWithGlobals().json) console.log(JSON.stringify({ ...state, integrityOk: integrity, runCredits: runCredits(state) }, null, 2));
        else {
          console.log(renderFactoryRunState(state));
          if (!integrity) console.log(chalk.red('integrity check FAILED: the state was edited outside omg factory run'));
        }
        return 0;
      }));
  return run;
}

export function factoryCommand(): Command {
  const cmd = new Command('factory');
  cmd.description('Software factory automation (chain trigger + intake listener)');
  cmd.addCommand(factoryRunCommand());
  cmd.addCommand(healCommand({
    exec: defaultExec,
    base: defaultFactoryRunDeps.base,
    config: (root) => resolveHealConfig(userConfigLayers().trustedUser, projectConfig(root)),
    now: () => new Date(),
  }));

  cmd
    .command('listen')
    .description('Run the intake listener daemon: HMAC-verified webhook events -> intake label gate -> headless intent sessions')
    .option('--port <n>', 'port to listen on (transport adapters forward here)', integerOption(0, 65535), 7788)
    .option('--host <addr>', 'host to bind to (default: 127.0.0.1 for localhost only; set to 0.0.0.0 only when transport adapter runs on another machine)', '127.0.0.1')
    .requiredOption('--repo <names>', 'repository whitelist, comma-separated owner/name')
    .option('--cwd <dir>', 'repository whose .omg state root the daemon writes to', process.cwd())
    .action((options: { port: number; host: string; repo: string; cwd: string }) => {
      const secret = process.env.OMC_FACTORY_HMAC_SECRET;
      if (!secret) {
        console.error(chalk.red('refused: no HMAC secret. Set OMC_FACTORY_HMAC_SECRET.'));
        process.exitCode = 1;
        return;
      }
      const whitelist = options.repo.split(',').map((s) => s.trim()).filter(Boolean);
      if (whitelist.length === 0) {
        console.error(chalk.red('refused: --repo whitelist is empty.'));
        process.exitCode = 1;
        return;
      }
      const cwd = resolve(options.cwd);
      void startListener({ port: options.port, secret, whitelist, cwd, host: options.host }).then((server) => {
        const addr = server.address();
        const port = addr && typeof addr !== 'string' ? addr.port : options.port;
        const host = addr && typeof addr !== 'string' ? addr.address : options.host;
        console.log(chalk.green(`factory listener on ${host}:${port} — whitelist: ${whitelist.join(', ')}`));
        console.log(chalk.gray(`liveness: GET http://${host === '::' ? '[::1]' : host}:${port}/status or check .omg/state/factory-listener.json`));
        const stop = () => {
          stopListener(server, cwd);
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
    });

  cmd
    .command('init')
    .description('Seed the project route table .omg/factory-routes.json (the chain-routing source of truth) and validate factory prerequisites')
    // Negatable option: Commander defaults `narrow` to true, so the default
    // seed is the narrow starter loop; --no-narrow seeds the widening template.
    .option('--no-narrow', 'seed the full-pipeline widening template (intake -> intent -> launch -> diagnose) instead of the narrow starter loop')
    .option('--cwd <dir>', 'project directory to seed (defaults to the working directory)', process.cwd())
    .option('--force', 'replace an existing route table (read it first — it is the routing source of truth)', false)
    .action((options: { narrow?: boolean; cwd: string; force?: boolean }) => {
      const result = runFactoryInit({ narrow: options.narrow, cwd: options.cwd, force: options.force });
      if (result.exitCode === 0) {
        console.log(chalk.green(result.message));
      } else {
        console.error(chalk.red(result.message));
        process.exitCode = result.exitCode;
      }
    });

  // Read-only audit view of this project's chain: decision trail, stop
  // markers, live ledgers, stalled links (D2). Never writes.
  cmd
    .command('status')
    .description('Summarize this project\'s chain decisions, stop markers, and stalled links (read-only)')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const status = readChainStatus(process.cwd());
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(renderChainStatus(status));
    });

  return cmd;
}

/**
 * Narrow starter route table: exactly the listener's INTAKE_ROUTE_TABLE — the
 * single intake -> intent hop. Everything after a completed intent session
 * halts (`no-route`) until the project deliberately widens the table.
 */
export function buildRouteTableNarrow(): RouteTable {
  return { ...INTAKE_ROUTE_TABLE };
}

/**
 * Full-pipeline widening template: a documented example widening the starter
 * loop into the intent -> launch -> diagnose progression. Keys are
 * `outcome:reason` pairs (the listener's intake label event, or the ending
 * session's outcome + hook reason); values name the next stage/skill. This is
 * a starting point to edit per project — a missing route halts the chain, and
 * `skill: "stop"` declares a terminal stage.
 */
export function buildRouteTableFull(): RouteTable {
  return {
    'success:intake': { stage: 'intent', skill: 'intent' },
    'success:intent': { stage: 'launch', skill: 'launch' },
    'success:launch': { stage: 'diagnose', skill: 'diagnose' },
  };
}

/**
 * Factory prerequisites, checked loudly before anything is written:
 * harbor needs the OMC state root (`.omg/state/`) and the shipyard layout
 * needs `docs/design/`.
 */
export function validateFactoryPrerequisites(cwd: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!existsSync(join(getOmcRoot(cwd), 'state'))) missing.push('.omg/state/');
  if (!existsSync(join(cwd, 'docs', 'design'))) missing.push('docs/design/');
  return { ok: missing.length === 0, missing };
}

export interface FactoryInitResult {
  exitCode: number;
  message: string;
}

/**
 * `omg factoryinit`: seed `.omg/factory-routes.json` — narrow starter table
 * by default, full widening template with narrow:false. Refuses loudly when
 * prerequisites are missing and never overwrites an existing table without
 * force (the SessionEnd chain enqueuer reads that file as the single source
 * of truth).
 */
export function runFactoryInit(options: { narrow?: boolean; cwd?: string; force?: boolean } = {}): FactoryInitResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const routesPath = join(getOmcRoot(cwd), 'factory-routes.json');

  const prerequisites = validateFactoryPrerequisites(cwd);
  if (!prerequisites.ok) {
    return {
      exitCode: 1,
      message: `factory init refused: missing prerequisites (${prerequisites.missing.join(', ')}). Harbor needs .omg/state/ (run an OMC session or omg setup first); the shipyard layout needs docs/design/. Point --cwd at the project root.`,
    };
  }
  if (existsSync(routesPath) && !options.force) {
    return {
      exitCode: 1,
      message: `factory init refused: ${routesPath} already exists and the project route table is never overwritten. Read it first, then pass --force to replace it.`,
    };
  }
  const table = options.narrow === false ? buildRouteTableFull() : buildRouteTableNarrow();
  try {
    mkdirSync(join(routesPath, '..'), { recursive: true });
    writeFileSync(routesPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { exitCode: 1, message: `factory init failed: cannot write ${routesPath}: ${(error as Error).message}` };
  }
  const mode = options.narrow === false ? 'full-pipeline widening template' : 'narrow starter table';
  const routes = Object.entries(table).map(([key, directive]) => `${key} -> ${directive.stage}/${directive.skill}`).join('; ');
  return {
    exitCode: 0,
    message: `factory init wrote ${routesPath} (${mode}): ${routes}. The SessionEnd chain enqueuer reads this file as the single source of truth — a missing route halts the chain, and skill "stop" marks a terminal stage.`,
  };
}
