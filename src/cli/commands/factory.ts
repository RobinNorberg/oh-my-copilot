/**
 * Factory command (spec: the OMC software factory loop, tracker issue #9).
 *
 * `omg factorylisten` — the resident intake daemon. Transport adapters
 * (smee.io / cloudflared / direct) live outside the OMC boundary: the daemon
 * only receives already-unpacked webhook events as POSTs and does the OMC-side
 * work itself (HMAC verification, repo whitelist, intake label gate, routing
 * through the shared pure function, headless harbor session spawn).
 *
 * `omg factoryinit` — seeds the project route table (`.omg/factory-routes.json`,
 * the single source of truth the SessionEnd chain enqueuer reads) and validates
 * the factory prerequisites. It seeds the narrow starter loop; --no-narrow is
 * retired and refuses. Never overwrites without --force. `--check` audits an
 * existing table; `--migrate` rewrites an old one (backup first).
 *
 * `omg factory chain status` (alias `omg factory status`) — the chain audit.
 *
 * Liveness: pid file at <omc root>/state/factory-listener.json (SessionStart
 * supervision reads it) plus a GET /status endpoint on the listening port.
 */

import { Command } from 'commander';
import { integerOption } from '../utils/integer-option.js';
import chalk from 'chalk';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { INTAKE_ROUTE_TABLE, startListener, stopListener } from '../../factory/listener.js';
import { readChainStatus, type ChainStatus } from '../../factory/status.js';
import { canonicalChainSkill, chainSkillStatus, type ChainSkillStatus, type RouteTable } from '../../hooks/session-end/routing.js';
import { LABEL_PATTERN, resolveChainSkill } from '../../hooks/session-end/spawn-next.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CopilotRunManager, defaultCopilotRunDeps } from '../../copilot-run/job.js';
import { resolveFactoryRunLimits, runCredits, type LoadedFactoryRunLimits } from '../../factory/run/budget.js';
import { cleanFactoryRun } from '../../factory/run/clean.js';
import { resetFactoryRun } from '../../factory/run/reset.js';
import { claimBusyMessage, factoryClaimHolder, factoryClaimRepo, listFactoryClaims, removeFactoryClaim } from '../../factory/run/claims.js';
import { EXIT_AWAITING_HUMAN, EXIT_BUSY, runFactoryEngine, type FactoryRunOutcome } from '../../factory/run/engine.js';
import { factoryGuardExec, hardenedGitExec } from '../../factory/run/exec.js';
import { EXIT_FORGE_UNAVAILABLE, FactoryForgeUnavailableError, factoryForgeOptions, loadFactoryForgeConfig, originForgeKind, syncLocalMirror } from '../../factory/run/forge-roots.js';
import type { LoadedForgeConfig } from '../../forge/config.js';
import { CopilotLaneBackend, type LaneBackend } from '../../factory/run/lane.js';
import type { GateConfigLoader } from '../../factory/run/prepare.js';
import {
  acquireFactoryRepoOwner, defaultOwnerDeps, describeOwner, FactoryBusyError, factoryCancelRequested, factoryOwnerPath, factoryRepoOwnerPath, factoryStateDir, factoryStatePath, ownerHolding, readFactoryState,
  refuseWhileEngineRuns, runLabel, unreadableOwnerMessage, type HeldOwner,
  requestFactoryCancel, verifyFactoryIntegrity, type FactoryOwner, type FactoryRunKey, type FactoryRunState,
} from '../../factory/run/state.js';
import { resolveShipConfig, userConfigLayers } from '../../ship/config.js';
import { defaultExec, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { healCommand } from '../../factory/heal/cli.js';
import { defaultFactoryCheckDeps, factoryCheckCommand, ttyConfirm } from './factory-check.js';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE, factoryErrorLine, type FactoryCheckDeps } from '../../factory/check/cli.js';
import { runFactoryEnqueue } from '../../factory/enqueue.js';
import { resolveHealConfig } from '../../factory/heal/config.js';
import { defaultLedgerDir, emptyHooksDir } from '../../factory/run/ledger.js';
import type { FactoryPollDeps } from '../../factory/poll.js';
import { listenForgeRefusal } from '../../factory/setup/detect.js';
import { factorySetupCommand } from './factory-setup.js';
import { factoryBoardCommand } from './factory-board.js';
import { factoryPollCommand } from './factory-poll.js';
import { defaultPollHealScan } from '../../factory/poll.js';
import { checkEnvFor, fetchBase, forgeReadExec, localBase, missingLocalBase, parseItemId, readForgeOptions } from '../../factory/check/cli.js';
import { BUCKET_ORDER, checkItems, plainText, type CheckResult } from '../../factory/check/score.js';
import { createForge } from '../../forge/index.js';
import { skillSlash } from '../../utils/skill-slash.js';

export function renderChainStatus(status: ChainStatus): string {
  const lines: string[] = [];
  lines.push(`chain status ${status.directory}`);
  lines.push(`route table (.omg/factory-routes.json, single authority): ${status.routeKeys.length} keys${status.routeKeys.length > 0 ? ` — ${status.routeKeys.join(', ')}` : ''}`);
  lines.push(`active ledgers: ${status.activeLedgers}`);
  lines.push(`intents (${status.intents.length}):`);
  if (status.intents.length === 0) lines.push('  (no decisions recorded)');
  for (const intent of status.intents) {
    const last = intent.lastDecision ? `${intent.lastDecision} @ ${intent.lastDecisionAt ?? '?'}` : 'none';
    const stopped = intent.stopped ? `  stopped[${intent.stopped.reason}]` : '';
    lines.push(`  ${intent.intentId}  decisions ${intent.decisionCount}  last ${last}${stopped}`);
    intent.links.forEach((link, index) => {
      const host = link.host ? ` [${link.host}]` : '';
      const ended = link.closedAt
        ? `ended ${link.outcome ?? '?'}→${link.decision ?? '?'}${link.hostSessionId && link.hostSessionId !== link.chainLink ? ` session=${link.hostSessionId}` : ''}`
        : 'running';
      lines.push(`    link ${index + 1} ${link.stage}${host} link=${link.chainLink} ${ended}`);
    });
  }
  lines.push(`stalled links (no progress for 30 min): ${status.stalled.length}`);
  for (const stall of status.stalled) {
    lines.push(`  ${stall.intentId} stage=${stall.stage} stalled ${Math.round(stall.stalledForMs / 60_000)}min session=${stall.session}`);
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
  /**
   * The run's forge config (loadFactoryForgeConfig: user, base-branch and
   * project layers plus the origin remote). Omitted = GitHub through the gh
   * calls with no forge config, as before forges (the default deps set it).
   */
  forge?: (root: string, base: string, opts?: { dryRun?: boolean }) => LoadedForgeConfig;
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
  forge: (root, base, opts) => loadFactoryForgeConfig(factoryGuardExec(defaultExec), root, base, userConfigLayers().trustedUser, projectConfig(root), opts),
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

/**
 * The `omg factory run --json` documents on stdout. `omg factory poll`'s
 * auto-start parses them (parseRunNextOutcome; its contract test builds its
 * fixtures from these writers).
 */
export const factoryRunJson = {
  nothingRunnable: (counts: Record<string, number>, claimed: readonly number[] = []): string =>
    JSON.stringify({ ok: true, next: null, message: 'nothing runnable', counts, ...(claimed.length ? { claimed } : {}) }, null, 2),
  outcome: (outcome: FactoryRunOutcome, next?: number): string => JSON.stringify({ ok: outcome.exitCode === 0, ...(next !== undefined ? { next } : {}), ...outcome }, null, 2),
  error: (message: string, busy = false): string => JSON.stringify({ ok: false, error: message, ...(busy ? { busy: true } : {}) }, null, 2),
};

async function factoryGuarded(json: boolean, fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = error instanceof FactoryForgeUnavailableError;
    const busy = error instanceof FactoryBusyError;
    // F9: no usable forge exits 5 with the prefix check, board and setup print.
    const text = unavailable && !message.startsWith('unsupported forge') ? `unsupported forge: ${message}` : message;
    if (json) console.log(factoryRunJson.error(text, busy));
    else if (busy) console.error(chalk.yellow(`busy: ${plainText(message)}`));
    else console.error(chalk.red(unavailable ? text : `Error: ${message}`));
    process.exitCode = error instanceof FactoryUsageError ? 2 : unavailable ? EXIT_FORGE_UNAVAILABLE : busy ? EXIT_BUSY : 1;
  }
}

export function renderFactoryRunState(state: FactoryRunState, o: { gate?: boolean } = {}): string {
  const lines = [`${chalk.bold(`factory run #${state.issue}`)}  phase=${chalk.cyan(state.phase)}  base=${state.base}  branch=${state.branch}${state.pr ? `  PR #${state.pr}` : ''}`];
  if (state.gate && o.gate !== false) lines.push(chalk.yellow(`awaiting-human: ${state.gate.name}: ${state.gate.reason}`));
  if (state.cancelRequested && state.phase !== 'cancelled') lines.push(chalk.yellow('cancel requested'));
  if (state.head) lines.push(`head ${state.head.slice(0, 12)}`);
  lines.push(`lanes ${state.lanes.length}  run AI credits ${runCredits(state).toFixed(2)}  elapsed ${Math.round(state.elapsedMs / 60_000)} min`);
  for (const lane of state.lanes) {
    const credits = lane.usage ? `${lane.usage.credits.toFixed(2)}/${lane.maxCredits}` : `-/${lane.maxCredits}`;
    lines.push(`  ${lane.id} ${lane.status}${lane.verdict ? ` ${lane.verdict}` : ''} credits ${credits}${lane.jobId ? ` job ${lane.jobId}` : ''}${lane.sandbox ? ` sandbox ${lane.sandbox.mode}` : ''}`);
  }
  for (const h of state.history.slice(-5)) lines.push(chalk.gray(`  ${h.at} ${h.from ?? '-'} -> ${h.to}: ${h.note}`));
  return lines.join('\n');
}

/**
 * `run --next`: the first runnable item in `omg factory check` order
 * (priority, then id) among the spec's children (`--parent`) or the intake
 * source, read through check's read-only guard. A merged, cancelled, failed
 * or active run, an own factory PR open or merged, or an unsatisfied
 * dependency is never runnable (check/rules.ts), so --next never re-runs a
 * finished item. A runnable item another engine holds (its run here, or its
 * claim from another clone: claims.ts) is skipped, never waited on, and
 * listed in `claimed`. Null with the checked rows when nothing is runnable.
 */
function pickNext(deps: FactoryRunDeps, root: string, base: string, loaded: LoadedForgeConfig, parent: number | undefined, claimRepo: string | null, skip: readonly number[] = []): { next: CheckResult | null; items: CheckResult[]; claimed: number[]; warnings: string[] } {
  const { config } = loaded;
  const source = config.intake.source;
  if (parent === undefined && !source) throw new FactoryUsageError('--next needs --parent <spec> or factory.intake.source');
  const read = forgeReadExec(deps.exec, config, root);
  const warnings: string[] = [];
  // F29: the local forge's base is the local branch (it has no server to fetch from), read as check reads it.
  const baseSha = config.kind === 'local' ? localBase(read.exec, root, base, warnings) : fetchBase(read.exec, root, base, warnings);
  if (config.kind === 'local' && !baseSha) throw new FactoryUsageError(missingLocalBase(base));
  // Committed items only: a working-tree item is never runnable, and a dependency closed only on disk is not met.
  const forge = createForge(read.exec, root, config, readForgeOptions(config, root, read.options, base, baseSha, false));
  const ids = parent !== undefined ? forge.tracker.viewItem(parent).children : forge.tracker.queryItems(source!, config.intake.limit);
  const items = checkItems(forge, ids, checkEnvFor(read.exec, root, config, base, baseSha));
  const claimed: number[] = [];
  for (const r of items) {
    if (r.bucket !== 'runnable') continue;
    if (!skip.includes(r.id) && itemBusy(deps, root, r.id, claimRepo) === null) return { next: r, items, claimed, warnings };
    claimed.push(r.id);
  }
  return { next: null, items, claimed, warnings };
}

/**
 * Why a run of `key` here would be busy now: its owner file in this
 * checkout is held (or unreadable), or its cross-clone claim is held
 * (claims.ts); null when neither. Read-only: the engine's claims at start
 * stay the binding check.
 */
function itemBusy(deps: FactoryRunDeps, root: string, key: FactoryRunKey, claimRepo: string | null): string | null {
  const me = defaultOwnerDeps();
  const path = factoryOwnerPath(root, key);
  const h = ownerHolding(path, me);
  if (h === 'unreadable') return unreadableOwnerMessage(path);
  if (h) return `omg factory run ${runLabel(key)} is already running (${describeOwner(h)})`;
  const claim = claimRepo ? factoryClaimHolder(deps.ledgerDir ?? defaultLedgerDir(), claimRepo, root, key, me) : null;
  return claim ? claimBusyMessage(key, claim) : null;
}

const OWNER_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.owner$/;

/** One owner or claim record for `run status`: whitelisted fields, every string through plainText. */
const ownerView = (o: Partial<FactoryOwner> & { parkedAt?: string }) => ({
  ...(o.run !== undefined ? { run: plainText(String(o.run)) } : {}),
  ...(Number.isInteger(o.pid) ? { pid: o.pid } : {}),
  ...(typeof o.hostname === 'string' ? { hostname: plainText(o.hostname) } : {}),
  ...(typeof o.startedAt === 'string' ? { startedAt: plainText(o.startedAt) } : {}),
  ...(typeof o.root === 'string' ? { root: plainText(o.root) } : {}),
  ...(typeof o.parkedAt === 'string' ? { parkedAt: plainText(o.parkedAt) } : {}),
});

/**
 * The live engines of this checkout (its engine lock and every run owner
 * file a live process holds), the owner files nobody can read (held, listed
 * apart), and the cross-clone claims that hold an item of this repository.
 * Read-only.
 */
export function liveFactoryRuns(root: string, ledgerDir: string, claimRepo: string | null) {
  const me = defaultOwnerDeps();
  const unreadable: string[] = [];
  const held = (path: string) => {
    const h = ownerHolding(path, me);
    if (h === 'unreadable') unreadable.push(plainText(path));
    return h === null || h === 'unreadable' ? null : h;
  };
  const engine = held(factoryRepoOwnerPath(root));
  let names: string[] = [];
  try { names = readdirSync(factoryStateDir(root)).sort(); } catch { /* no runs yet */ }
  const runs: Array<ReturnType<typeof ownerView> & { key: FactoryRunKey }> = [];
  for (const name of names) {
    const m = OWNER_FILE.exec(name);
    if (!m) continue;
    const key: FactoryRunKey = /^\d+$/.test(m[1]) ? Number(m[1]) : (m[1] as `heal-${string}`);
    const h = held(factoryOwnerPath(root, key));
    if (h) runs.push({ key, ...ownerView(h) });
  }
  const claims = claimRepo
    ? listFactoryClaims(ledgerDir, claimRepo, root, me).map((c) => ({ key: c.key, state: c.state, path: plainText(c.path), ...(c.claim ? ownerView(c.claim) : {}) }))
    : [];
  return { engine: engine ? ownerView(engine) : null, runs, unreadable, claims };
}

const bucketCounts = (items: readonly CheckResult[]): Record<string, number> =>
  Object.fromEntries(BUCKET_ORDER.map((b) => [b, items.filter((r) => r.bucket === b).length]));

function printOutcome(json: boolean, outcome: FactoryRunOutcome, next?: number): void {
  if (json) {
    console.log(factoryRunJson.outcome(outcome, next));
    return;
  }
  // F35: the message already names the gate when it parks there; print it once.
  const parked = outcome.state?.gate !== undefined && outcome.message.startsWith(`awaiting-human: ${outcome.state.gate.name}:`);
  if (outcome.state) console.log(renderFactoryRunState(outcome.state, { gate: !parked }));
  const color = outcome.exitCode === 0 ? chalk.green : outcome.exitCode === 1 ? chalk.red : chalk.yellow;
  console.log(color(outcome.message));
}

/** `omg factory run <issue>`, `run cancel|clean|status <issue>` (experimental; manual trigger only; merge is always human). */
export function factoryRunCommand(deps: FactoryRunDeps = defaultFactoryRunDeps): Command {
  const exec = factoryGuardExec(deps.exec);
  const run = new Command('run');
  run
    .description('Experimental: drive one issue through implement -> draft PR -> independent review / fix rounds -> prepare -> CI gates, then park for the human merge')
    .argument('[issue]', 'the item number: a GitHub issue, an Azure DevOps work item or a local backlog item')
    .option('--next', 'Run the next runnable item (omg factory check order: priority, then id); exit 0 when nothing is runnable')
    .option('--parent <spec>', 'With --next: pick among the children of this spec item instead of factory.intake.source')
    .option('--dry-run', 'Resolve the issue and plan and print the next step; no state, lanes or pushes')
    .option('--allow-gate-change', 'Local forge: accept the one change to the local gate\'s definition (package.json script, package-manager config or gate file) that parked the run at gate-definition-changed; a later change parks again')
    .option('--json', 'JSON output')
    .action((issueRaw: string | undefined, o: { next?: boolean; parent?: string; dryRun?: boolean; allowGateChange?: boolean; json?: boolean }) =>
      factoryGuarded(Boolean(o.json), async () => {
        if (o.next && issueRaw !== undefined) throw new FactoryUsageError('--next takes no issue: it picks the next runnable item');
        if (o.parent !== undefined && !o.next) throw new FactoryUsageError('--parent applies to --next');
        let parent: number | undefined;
        try {
          parent = o.parent === undefined ? undefined : parseItemId(o.parent);
        } catch (error) {
          throw new FactoryUsageError(error instanceof Error ? error.message : String(error));
        }
        let issue: number | undefined = o.next ? undefined : parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const { limits, warnings } = deps.limits(root);
        for (const w of warnings) console.error(chalk.yellow(w));
        const base = deps.base(root);
        const claimRepo = factoryClaimRepo(exec, root);
        // A real run takes this checkout's engine lock before anything touches git (the forge-config loader fetches
        // origin/<base>): busy (exit 6) means nothing was fetched or written. The engine uses the held lock as its own.
        let held: HeldOwner | undefined;
        if (!o.dryRun) {
          held = acquireFactoryRepoOwner(root, issue ?? 'next', new Date().toISOString());
          const busy = issue !== undefined ? itemBusy(deps, root, issue, claimRepo) : null;
          if (busy) {
            held.release();
            throw new FactoryBusyError(busy);
          }
        }
        let signals = 0;
        const onSignal = () => {
          signals += 1;
          if (signals > 1) process.exit(130);
          console.error(chalk.yellow('omg factory run: stopping after the current poll (cancelling the lane); press again to exit at once'));
        };
        try {
          const loaded = deps.forge?.(root, base, { dryRun: Boolean(o.dryRun) });
          for (const w of loaded?.warnings ?? []) console.error(chalk.yellow(w));
          // The full untrusted roots, never a partial list (critic amendments §A.14; the engine re-checks).
          const forge = loaded ? { config: loaded.config, options: factoryForgeOptions(root) } : undefined;
          const skipped: number[] = [];
          let picked: number | undefined;
          if (!o.dryRun) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }
          for (;;) {
            if (o.next) {
              if (!loaded) throw new FactoryUsageError('--next needs the forge config (omg factory setup)');
              const { next, items, claimed, warnings: pickWarnings } = pickNext(deps, root, base, loaded, parent, claimRepo, skipped);
              for (const w of pickWarnings) console.error(chalk.yellow(plainText(w)));
              const counts = bucketCounts(items);
              if (!next) {
                if (o.json) console.log(factoryRunJson.nothingRunnable(counts, claimed));
                else console.log(`nothing runnable (${BUCKET_ORDER.map((b) => `${counts[b]} ${b}`).join(', ')})${claimed.length ? `; held by another engine: ${claimed.map((id) => `#${id}`).join(', ')}` : ''}`);
                return 0;
              }
              issue = picked = next.id;
              held?.relabel(String(issue));
              if (!o.json) console.log(chalk.cyan(`next runnable: #${next.id} ${plainText(next.title)}`));
            }
            try {
              const outcome = await runFactoryEngine({
                root, issue: issue!, exec: deps.exec, limits, base, dryRun: Boolean(o.dryRun), claimRepo,
                ...(held ? { repoOwner: held } : {}),
                ...(o.allowGateChange ? { allowGateChange: true } : {}),
                lanes: o.dryRun ? NO_LANES : deps.lanes(root),
                ...(forge ? { forge } : {}),
                ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}),
                ...(deps.gateConfig ? { gateConfig: deps.gateConfig } : {}),
                interrupted: () => signals > 0,
                warn: (m) => console.error(chalk.yellow(m)),
              });
              printOutcome(Boolean(o.json), outcome, picked);
              return outcome.exitCode;
            } catch (error) {
              // L9: another clone claimed the picked item after the pick: pick once more, skipping it.
              if (!(error instanceof FactoryBusyError) || !o.next || picked === undefined || skipped.length > 0) throw error;
              skipped.push(picked);
              if (!o.json) console.error(chalk.yellow(`busy: ${plainText(error.message)}; picking again`));
            }
          }
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          held?.release();
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
    .description('Remove the worktrees and local branches of a merged or cancelled run, only when nothing would be lost (the PR branch on GitHub is kept); busy (exit 6) while an engine runs in this checkout')
    .option('--json', 'JSON output')
    .action((issueRaw: string, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const result = cleanFactoryRun({ root, issue, exec: deps.exec, claimRepo: factoryClaimRepo(exec, root), ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}) });
        if (c.optsWithGlobals().json) console.log(JSON.stringify({ ok: result.kept.length === 0, ...result }, null, 2));
        else {
          for (const path of result.removed) console.log(chalk.green(`removed ${path}`));
          for (const k of result.kept) console.log(chalk.yellow(`kept ${k.worktree}: ${k.reason}`));
          if (result.removed.length === 0 && result.kept.length === 0) console.log(`nothing to clean for factory run #${issue}`);
        }
        return result.kept.length === 0 ? 0 : EXIT_AWAITING_HUMAN;
      }));

  run
    .command('reset <issue>')
    .description('Local forge only: start a cancelled run over (after run clean): close its local PR, keep its mirror branch as factory/cancelled/..., move the run state aside; busy (exit 6) while an engine runs in this checkout or another clone claims the item')
    .option('--json', 'JSON output')
    .action((issueRaw: string, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const issue = parseIssue(issueRaw);
        const root = factoryRoot(exec);
        const claimRepo = factoryClaimRepo(exec, root);
        // The engine lock before the forge-config loader (it may fetch): busy touches nothing.
        const held = acquireFactoryRepoOwner(root, issue, new Date().toISOString());
        try {
          const loaded = deps.forge?.(root, deps.base(root), { dryRun: false });
          if (!loaded || loaded.config.kind !== 'local') throw new FactoryUsageError('omg factory run reset is for the local forge only (factory.forge.kind "local")');
          const read = forgeReadExec(deps.exec, loaded.config, root);
          const forge = createForge(read.exec, root, loaded.config, { ...read.options, local: { omgRoot: getOmcRoot(root) } });
          const result = resetFactoryRun({ root, issue, exec: deps.exec, forge, mirror: loaded.config.repo.url, repoOwner: held, claimRepo, ...(deps.ledgerDir ? { ledgerDir: deps.ledgerDir } : {}) });
          if (c.optsWithGlobals().json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
          else {
            if (result.closedPr !== undefined) console.log(chalk.green(`closed local PR #${result.closedPr} (cancelled)`));
            if (result.keptBranch) console.log(chalk.green(`kept the run's branch as ${result.keptBranch} in the mirror`));
            console.log(chalk.green(`moved the run state to ${result.stateMovedTo}; omg factory run ${issue} starts a new run`));
          }
          return 0;
        } finally {
          held.release();
        }
      }));

  run
    .command('release [issue]')
    .description('A human clears a claim nobody runs: the item\'s cross-clone claim (parked, crashed or unreadable) and its owner file here; without an issue, this checkout\'s engine lock. A live holder is busy (exit 6)')
    .option('--json', 'JSON output')
    .action((issueRaw: string | undefined, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const root = factoryRoot(exec);
        const me = defaultOwnerDeps();
        const removed: string[] = [];
        const removeOwnerFile = (path: string) => {
          const h = ownerHolding(path, me);
          if (h && h !== 'unreadable') throw new FactoryBusyError(`${path} is held by a live engine (${describeOwner(h)}); omg factory run cancel stops it`);
          if (existsSync(path)) { unlinkSync(path); removed.push(path); }
        };
        if (issueRaw === undefined) removeOwnerFile(factoryRepoOwnerPath(root));
        else {
          const issue = parseIssue(issueRaw);
          refuseWhileEngineRuns(root, me);
          const claimRepo = factoryClaimRepo(exec, root);
          const claim = claimRepo ? removeFactoryClaim(deps.ledgerDir ?? defaultLedgerDir(), claimRepo, root, issue, { deps: me }) : null;
          if (claim) removed.push(claim);
          removeOwnerFile(factoryOwnerPath(root, issue));
        }
        if (c.optsWithGlobals().json) console.log(JSON.stringify({ ok: true, removed: removed.map(plainText) }, null, 2));
        else if (removed.length === 0) console.log('nothing to release');
        else for (const path of removed) console.log(chalk.green(`released ${plainText(path)}`));
        return 0;
      }));

  run
    .command('status [issue]')
    .description('Print the persisted factory run state (read-only); without an issue, list the engines running in this checkout and the cross-clone claims on this repository')
    .option('--json', 'JSON output')
    .action((issueRaw: string | undefined, _o: unknown, c: Command) =>
      factoryGuarded(Boolean(c.optsWithGlobals().json), () => {
        const root = factoryRoot(exec);
        if (issueRaw === undefined) {
          const live = liveFactoryRuns(root, deps.ledgerDir ?? defaultLedgerDir(), factoryClaimRepo(exec, root));
          const label = (key: FactoryRunKey) => (typeof key === 'number' ? `#${key}` : key);
          const line = (o: { run?: string; pid?: number; hostname?: string; startedAt?: string; root?: string; parkedAt?: string }) =>
            `${o.pid !== undefined ? `pid ${o.pid}` : 'no live process'} on ${o.hostname ?? 'unknown host'} since ${o.startedAt ?? 'unknown'}${o.parkedAt ? `, parked ${o.parkedAt}` : ''}${o.root ? ` in ${o.root}` : ''}`;
          if (c.optsWithGlobals().json) console.log(JSON.stringify({ ok: true, ...live }, null, 2));
          else {
            if (!live.engine && live.runs.length === 0) console.log('no factory engine runs in this checkout');
            if (live.engine) console.log(`engine lock: ${live.engine.run ?? 'run unknown'}, ${line(live.engine)}`);
            for (const r of live.runs) console.log(`live ${label(r.key)}: ${line(r)}`);
            for (const path of live.unreadable) console.log(chalk.yellow(`unreadable owner file (held until removed: omg factory run release): ${path}`));
            for (const cl of live.claims) console.log(`claim ${label(cl.key)} (${cl.state}): ${line(cl)}; ${cl.path}`);
          }
          return 0;
        }
        const issue = parseIssue(issueRaw);
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

/** `omg factory enqueue` (shipyard ↔ factory design §3.2-§3.4); the command lives in src/factory/enqueue.ts. */
export function factoryEnqueueCommand(deps: FactoryCheckDeps): Command {
  return new Command('enqueue')
    .description('Push launch\'s approved tickets to the tracker as children of a spec (GitHub or Azure DevOps; idempotent by shipyard-key)')
    .requiredOption('--spec <id>', 'the parent spec issue')
    .requiredOption('--file <path>', 'the ticket file launch wrote (schemaVersion 1)')
    .option('--dry-run', 'print the exact writes and write nothing')
    .option('--json', 'JSON output (schemaVersion 1)')
    .addHelpText('after', [
      '',
      'Without --dry-run, enqueue creates or updates the items (with the intake label and a priority label),',
      'rewrites the spec\'s task list, then runs the mark step `omg factory check <ids> --mark --yes` over',
      'this file\'s created, updated and unchanged items (never orphans), which adds factory.intake.marker',
      'to the runnable ones. The launch C3 signature is the confirmation',
      'for all of it: run --dry-run first and show its output at C3. Items already claimed by a factory run',
      'are never edited, and items whose key left the file are reported as orphaned, never closed.',
      'On Azure DevOps the items are work items of factory.intake.itemTypes[0] with the AC and priority fields,',
      'linked to the spec (parent) and their predecessors; the spec itself is not edited.',
    ].join('\n'))
    .action(async (o: { spec: string; file: string; dryRun?: boolean; json?: boolean }) => {
      try {
        process.exitCode = await runFactoryEnqueue(o, deps);
      } catch (error) {
        const message = plainText(error instanceof Error ? error.message : String(error));
        if (o.json) deps.out(JSON.stringify({ ok: false, error: message }, null, 2));
        else deps.err(chalk.red(factoryErrorLine(message)));
        process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
      }
    });
}

/**
 * `omg factory poll`'s local forge base sync (FactoryPollDeps.localBaseSync):
 * syncLocalMirror through the engine's exec shape, guarded with the base as
 * the one branch it may push to the mirror and hardened (no hooks, the
 * omg-local pack programs pinned), so a human merge on the base turns the
 * local PR MERGED on the next tick.
 */
export function pollLocalBaseSync(exec: Exec, ledgerDir: string): NonNullable<FactoryPollDeps['localBaseSync']> {
  return ({ root, base, config }) => {
    let basePush: string | undefined;
    const guarded = factoryGuardExec(hardenedGitExec(exec, emptyHooksDir(ledgerDir), () => config.repo.url), () => [base], undefined, undefined, () => ({ mirror: config.repo.url, baseSha: basePush }));
    const sha = syncLocalMirror(guarded, root, config.repo.url, base, (s) => { basePush = s; });
    return `synced ${base} ${sha.slice(0, 12)} to the local forge mirror`;
  };
}

export function factoryCommand(): Command {
  const cmd = new Command('factory');
  cmd.description('Software factory automation (chain trigger + intake listener)');
  cmd.addCommand(factoryRunCommand());
  cmd.addCommand(factoryCheckCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
  cmd.addCommand(factoryEnqueueCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
  cmd.addCommand(factoryBoardCommand(defaultFactoryCheckDeps(defaultFactoryRunDeps.base)));
  cmd.addCommand(factoryPollCommand({
    ...defaultFactoryCheckDeps(defaultFactoryRunDeps.base),
    healScan: defaultPollHealScan(defaultExec, (root) => resolveHealConfig(userConfigLayers().trustedUser, projectConfig(root)), defaultLedgerDir()),
    localBaseSync: pollLocalBaseSync(defaultExec, defaultLedgerDir()),
  }));
  cmd.addCommand(healCommand({
    exec: defaultExec,
    base: defaultFactoryRunDeps.base,
    config: (root) => resolveHealConfig(userConfigLayers().trustedUser, projectConfig(root)),
    now: () => new Date(),
    // `omg factory heal run` without --dry-run is itself the opt-in to one billed, capped debugger lane;
    // `omg factory heal approve` is the human's opt-in to the ci-heal run's billed, capped lanes.
    lanes: defaultFactoryRunDeps.lanes,
    ledgerDir: defaultLedgerDir(),
    runLimits: defaultFactoryRunDeps.limits,
    forgeKind: (root) => originForgeKind(factoryGuardExec(defaultExec), root),
    // Azure DevOps only: the trusted forge config naming factory.heal.pipeline (GitHub never loads it).
    forge: defaultFactoryRunDeps.forge,
  }));
  cmd.addCommand(factorySetupCommand());

  cmd
    .command('listen')
    .description('Run the intake listener daemon: HMAC-verified webhook events -> intake label gate -> headless harbor sessions')
    .option('--port <n>', 'port to listen on (transport adapters forward here)', integerOption(0, 65535), 7788)
    .option('--host <addr>', 'host to bind to (default: 127.0.0.1 for localhost only; set to 0.0.0.0 only when transport adapter runs on another machine)', '127.0.0.1')
    .requiredOption('--repo <names>', 'repository whitelist, comma-separated owner/name')
    .option('--cwd <dir>', 'repository whose .omg state root the daemon writes to', process.cwd())
    .action((options: { port: number; host: string; repo: string; cwd: string }) => {
      const forgeRefusal = listenForgeRefusal(defaultExec, resolve(options.cwd), userConfigLayers().trustedUser);
      if (forgeRefusal) {
        console.error(chalk.red(forgeRefusal));
        process.exitCode = 1;
        return;
      }
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
    // Negatable option: Commander defaults `narrow` to true. --no-narrow is
    // kept only so that it refuses with a pointer instead of "unknown option".
    .option('--no-narrow', 'retired: the full-pipeline template (intake -> intent -> launch -> diagnose) now refuses')
    .option('--cwd <dir>', 'project directory to seed (defaults to the working directory)', process.cwd())
    .option('--force', 'replace an existing route table (read it first — it is the routing source of truth)', false)
    .option('--check', 'print every route of the existing table with its status and replacement (read-only; exit 1 when a route needs --migrate)')
    .option('--migrate', 'rewrite an old table to the narrow one: captain/retired routes removed, intake -> harbor; writes a .bak first')
    .option('--yes', 'confirm --migrate without a prompt (required without an interactive terminal)')
    .action(async (options: { narrow?: boolean; cwd: string; force?: boolean; check?: boolean; migrate?: boolean; yes?: boolean }) => {
      let result: FactoryInitResult;
      if (options.check && options.migrate) result = { exitCode: 2, message: 'factory init: --check and --migrate are mutually exclusive' };
      else if (options.check) result = checkFactoryRoutes(options.cwd);
      else if (options.migrate) {
        result = await migrateFactoryRoutes({ cwd: options.cwd, yes: options.yes, isTTY: Boolean(process.stdin.isTTY), confirm: ttyConfirm });
      } else result = runFactoryInit({ narrow: options.narrow, cwd: options.cwd, force: options.force });
      if (result.exitCode === 0) {
        console.log(options.check ? result.message : chalk.green(result.message));
      } else {
        console.error(options.check ? result.message : chalk.red(result.message));
        process.exitCode = result.exitCode;
      }
    });

  // Read-only audit view of this project's chain: decision trail, stop
  // markers, live ledgers, stalled links (D2). Never writes.
  const chainStatus = (options: { json?: boolean }) => {
    const status = readChainStatus(process.cwd());
    console.log(options.json ? JSON.stringify(status, null, 2) : renderChainStatus(status));
  };
  const chain = cmd.command('chain').description('Legacy SessionEnd chain (frozen: single intake -> harbor hop)');
  chain
    .command('status')
    .description('Summarize this project\'s chain decisions, stop markers, and stalled links (read-only)')
    .option('--json', 'Output as JSON')
    .action(chainStatus);
  // Kept so existing scripts work; `omg factory run status <issue>` is the engine's.
  cmd
    .command('status')
    .description('Alias of omg factory chain status (legacy chain audit, read-only)')
    .option('--json', 'Output as JSON')
    .action(chainStatus);

  return cmd;
}

/**
 * Narrow starter route table: exactly the listener's INTAKE_ROUTE_TABLE — the
 * single intake -> harbor hop. Everything after a completed harbor session
 * halts (`no-route`) until the project deliberately widens the table.
 */
export function buildRouteTableNarrow(): RouteTable {
  return { ...INTAKE_ROUTE_TABLE };
}

/**
 * Factory prerequisites, checked loudly before anything is written:
 * harbor needs the OMC state root (`.omg/state/`) and the yard's two day-one
 * faces drydock seeds (`CLAUDE.md` + `GLOSSARY.md`).
 */
export function validateFactoryPrerequisites(cwd: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!existsSync(join(getOmcRoot(cwd), 'state'))) missing.push('.omg/state/');
  for (const face of ['CLAUDE.md', 'GLOSSARY.md']) {
    if (!existsSync(join(cwd, face))) missing.push(face);
  }
  return { ok: missing.length === 0, missing };
}

export interface FactoryInitResult {
  exitCode: number;
  message: string;
}

/**
 * `omg factoryinit`: seed `.omg/factory-routes.json` with the narrow starter
 * table. narrow:false (the retired full template) refuses. Refuses loudly when
 * prerequisites are missing and never overwrites an existing table without
 * force (the SessionEnd chain enqueuer reads that file as the single source
 * of truth).
 */
export function runFactoryInit(options: { narrow?: boolean; cwd?: string; force?: boolean } = {}): FactoryInitResult {
  if (options.narrow === false) {
    return {
      exitCode: 1,
      message: 'factory init refused: --no-narrow is retired. Its full template (intake -> intent -> launch -> diagnose) chained launch, which needs a live captain, into a diagnose skill that does not exist. Run launch in a session and deliver each issue with omg factory run <issue>; CI: failed push runs of ci.yml on the dev branch are queued by the listener (workflow_run) and processed by the next omg factory heal scan; failures on other branches or workflows are no longer acted on by the listener (run omg factory heal scan manually). See the factory section of docs/REFERENCE.md.',
    };
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const routesPath = join(getOmcRoot(cwd), 'factory-routes.json');

  const prerequisites = validateFactoryPrerequisites(cwd);
  if (!prerequisites.ok) {
    return {
      exitCode: 1,
      message: `factory init refused: missing prerequisites (${prerequisites.missing.join(', ')}). Harbor needs .omg/state/ (run an OMC session or omg setup first); the yard faces CLAUDE.md and GLOSSARY.md come from ${skillSlash('drydock')}. Point --cwd at the project root.`,
    };
  }
  if (existsSync(routesPath) && !options.force) {
    return {
      exitCode: 1,
      message: `factory init refused: ${routesPath} already exists and the project route table is never overwritten. Read it first, then pass --force to replace it.`,
    };
  }
  const table = buildRouteTableNarrow();
  try {
    mkdirSync(join(routesPath, '..'), { recursive: true });
    writeFileSync(routesPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { exitCode: 1, message: `factory init failed: cannot write ${routesPath}: ${(error as Error).message}` };
  }
  const routes = Object.entries(table).map(([key, directive]) => `${key} -> ${directive.stage}/${directive.skill}`).join('; ');
  return {
    exitCode: 0,
    message: `factory init wrote ${routesPath} (narrow starter table): ${routes}. The SessionEnd chain enqueuer reads this file as the single source of truth — a missing route halts the chain, and skill "stop" marks a terminal stage.`,
  };
}

/**
 * One route of `.omg/factory-routes.json` as `init --check` sees it. `captain`
 * and `retired` routes halt the chain at runtime (`route-retired:<skill>`);
 * `invalid` entries are ignored by the enqueuer.
 */
export interface RouteCheckRow {
  key: string;
  stage: string;
  skill: string;
  status: ChainSkillStatus | 'terminal' | 'unknown' | 'invalid';
  replacement: string;
}

export interface RouteCheckResult extends FactoryInitResult {
  rows: RouteCheckRow[];
}

type RawRoutes = { ok: true; raw: string; table: Record<string, unknown> } | { ok: false; message: string } | null;

function readRawRoutes(routesPath: string): RawRoutes {
  if (!existsSync(routesPath)) return null;
  const raw = readFileSync(routesPath, 'utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, raw, table: parsed as Record<string, unknown> };
  } catch {
    // reported below
  }
  return { ok: false, message: `${routesPath} is not a JSON object; fix it by hand or re-run omg factory init --force` };
}

function classifyRoute(cwd: string, key: string, value: unknown): RouteCheckRow {
  const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as { stage?: unknown; skill?: unknown } : {};
  const stage = typeof entry.stage === 'string' ? entry.stage : '';
  const skill = typeof entry.skill === 'string' ? entry.skill : '';
  const row = (status: RouteCheckRow['status'], replacement: string): RouteCheckRow => ({ key, stage, skill, status, replacement });
  if (!key.includes(':') || typeof entry.stage !== 'string' || typeof entry.skill !== 'string') {
    return row('invalid', 'ignored by the chain: not an outcome:reason route with a stage and a skill');
  }
  const name = canonicalChainSkill(skill);
  const status = chainSkillStatus(skill);
  if (status === 'retired') return row(status, 'none: omg factory heal scan handles CI failures');
  if (status === 'captain') {
    return row(status, name === 'launch'
      ? `none: run ${skillSlash('launch')} with the accepted intent`
      : `none: run ${skillSlash(name)} in a session (it needs a live captain)`);
  }
  if (!LABEL_PATTERN.test(stage) || !LABEL_PATTERN.test(skill)) return row('invalid', 'ignored by the chain: stage or skill has characters outside [A-Za-z0-9_.-]');
  if (name === 'stop') return row('terminal', '');
  if (status === 'deprecated') {
    return row(status, key === 'success:intake' ? 'success:intake -> harbor' : 'still spawns; tracker intake belongs to harbor');
  }
  const resolved = resolveChainSkill(cwd, skill);
  if (resolved.ok) return row('ok', '');
  return row('unknown', resolved.hint
    ? `halts the chain (route-unknown): ${resolved.hint}`
    : 'halts the chain (route-unknown): no bundled or project skill of this name');
}

function renderRouteRows(rows: RouteCheckRow[]): string {
  const cells = [['route', 'skill', 'status', 'replacement'], ...rows.map((r) => [r.key, r.skill, r.status, r.replacement])];
  const widths = [0, 1, 2].map((i) => Math.max(...cells.map((c) => c[i].length)));
  return cells.map((c) => c.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join('  ').trimEnd()).join('\n');
}

/** Routes `--migrate` rewrites: refused skills drop out, the old intake -> intent hop becomes intake -> harbor. */
function needsMigration(row: RouteCheckRow): boolean {
  return row.status === 'captain' || row.status === 'retired' || (row.status === 'deprecated' && row.key === 'success:intake');
}

/**
 * `omg factory init --check`: classify every route of the project table
 * (read-only). Exit 1 when a route halts at runtime (captain or retired
 * skill) or the table is malformed, so `--migrate` is due; else 0.
 */
export function checkFactoryRoutes(cwd: string = process.cwd()): RouteCheckResult {
  const root = resolve(cwd);
  const routesPath = join(getOmcRoot(root), 'factory-routes.json');
  const read = readRawRoutes(routesPath);
  if (!read) return { exitCode: 0, rows: [], message: `no route table at ${routesPath}; nothing to check` };
  if (!read.ok) return { exitCode: 1, rows: [], message: `factory init --check: ${read.message}` };
  const rows = Object.entries(read.table).map(([key, value]) => classifyRoute(root, key, value));
  const due = rows.filter(needsMigration);
  const summary = due.some((r) => r.status === 'captain' || r.status === 'retired')
    ? `${due.length} route(s) need migration: captain and retired routes halt the chain (route-retired:<skill>). Run omg factory init --migrate.`
    : due.length > 0
      ? `${due.length} route(s) can be migrated (omg factory init --migrate).`
      : 'no route needs migration.';
  return {
    exitCode: rows.some((r) => r.status === 'captain' || r.status === 'retired') ? 1 : 0,
    rows,
    message: `${routesPath}\n${rows.length > 0 ? renderRouteRows(rows) : '(empty table)'}\n${summary}`,
  };
}

/**
 * `omg factory init --migrate`: back the table up to
 * `factory-routes.json.bak-<timestamp>` (never overwriting a backup), then
 * drop the captain/retired routes and turn `success:intake -> intent` into
 * `-> harbor`. Every other entry stays byte-for-byte. Asks on a TTY; needs
 * `--yes` otherwise.
 */
export async function migrateFactoryRoutes(options: {
  cwd?: string;
  yes?: boolean;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  now?: Date;
} = {}): Promise<FactoryInitResult> {
  const root = resolve(options.cwd ?? process.cwd());
  const routesPath = join(getOmcRoot(root), 'factory-routes.json');
  const read = readRawRoutes(routesPath);
  if (!read) return { exitCode: 0, message: `no route table at ${routesPath}; nothing to migrate` };
  if (!read.ok) return { exitCode: 1, message: `factory init --migrate refused: ${read.message}` };
  // The rename below would replace the link with a regular file and silently
  // detach the table from its real target.
  if (lstatSync(routesPath).isSymbolicLink()) {
    return { exitCode: 1, message: `factory init --migrate refused: ${routesPath} is a symlink; migrate its target by hand (omg factory init --check shows the routes)` };
  }
  const rows = Object.entries(read.table).map(([key, value]) => classifyRoute(root, key, value));
  const due = rows.filter(needsMigration);
  if (due.length === 0) return { exitCode: 0, message: `${routesPath}: nothing to migrate` };

  const plan = due.map((r) => `  ${r.key} -> ${r.skill}: ${r.status === 'deprecated' ? 'becomes success:intake -> harbor' : 'removed'}`).join('\n');
  if (!options.yes) {
    if (!options.isTTY || !options.confirm) {
      return { exitCode: 2, message: `factory init --migrate needs --yes without an interactive terminal. It would rewrite ${routesPath}:\n${plan}` };
    }
    if (!await options.confirm(`Rewrite ${routesPath}?\n${plan}\nA backup is written first.`)) {
      return { exitCode: 1, message: 'factory init --migrate cancelled; nothing written' };
    }
  }

  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(read.table)) {
    const row = rows.find((r) => r.key === key)!;
    if (!needsMigration(row)) migrated[key] = value;
    else if (row.status === 'deprecated') migrated[key] = { ...(value as object), stage: 'harbor', skill: 'harbor' };
  }
  const stamp = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const backupPath = `${routesPath}.bak-${stamp}`;
  try {
    writeFileSync(backupPath, read.raw, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    return { exitCode: 1, message: `factory init --migrate refused: cannot write the backup ${backupPath} (${(error as Error).message}); nothing changed` };
  }
  const tmp = `${routesPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
    renameSync(tmp, routesPath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    return { exitCode: 1, message: `factory init --migrate failed: cannot write ${routesPath} (${(error as Error).message}); the backup is ${backupPath}` };
  }
  return { exitCode: 0, message: `factory init --migrate rewrote ${routesPath} (backup: ${backupPath}):\n${plan}` };
}
