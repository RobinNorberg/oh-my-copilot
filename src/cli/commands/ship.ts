/**
 * `omg ship` — deterministic half of the ship workflow (skill
 * `/oh-my-copilot:ship` drives the agent lanes):
 *   init     start a run for a PR and name the implementer lane
 *   verdict  record an independent reviewer/verifier verdict
 *   prepare  merge the base in, run checks, regenerate the inventory last
 *   gates    apply the merge rule to `gh pr checks` (optionally watch)
 *   merge    refuse unless gates are green and an independent approval
 *            covers the head, and the PR touches no merge-rule file;
 *            admin-merge only with ship.allowAdminMerge (no CLI override)
 *   status   print the persisted run state
 *
 * The safety keys (allowAdminMerge, advisoryChecks, requiredChecks,
 * knownFlakyFile) come from the user config at its default location or the
 * `.copilot/omg.jsonc` committed on a trusted base (ship.trustedBases) at
 * the sha GitHub reports, never the working tree (loadTrustedShipConfig).
 * The base, base sha and head sha always come from GitHub, not the state.
 *
 * Owner-only escape hatch (OMG_SHIP_HUMAN=1, which lane briefs forbid):
 * `init --force` over a blocked or merged run, a state that fails its
 * integrity check, or a run with verdicts under a new implementer / reset
 * fix-round budget; `merge` of a PR touching `.copilot/omg.jsonc`,
 * `.github/known-flaky-tests.json` or `.github/workflows/`.
 *
 * Trust note: OMG_SHIP_HUMAN, the --implementer / --reviewer names and every
 * other environment input are advisory against a hostile lane. A process
 * that controls this command's environment can set OMG_SHIP_HUMAN=1, name
 * any reviewer, or put another `git` / `gh` first on PATH. The engine scrubs
 * the git / gh variables that redirect its commands (scrubShipEnv), reads
 * the user config's safety keys from the OS-reported home only, and checks
 * the remote URL and the base sha against GitHub, but it guards against lanes that follow their
 * briefs or slip, not against one that rewrites its own environment.
 *
 * Exit codes: 0 ok / green / ready, 1 refused or failed, 2 usage error,
 * 8 gates still pending (re-run to keep watching; `gates --drive` never
 * exits 8: it watches up to --drive-max hours, see src/release/drive.ts).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { dirname } from 'path';
import {
  DEFAULT_SHIP_CONFIG,
  isPlainBranchName,
  loadBaseKnownFlaky,
  loadTrustedShipConfig,
  prRepoUrl,
  userConfigLayers,
  type LoadedShipConfig,
  type ShipConfig,
} from '../../ship/config.js';
import { defaultExec, guardExec, TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { watchGates, type GateReport, type WatchResult } from '../../ship/gates.js';
import { emitProgress, resolveProgressFile } from '../../lib/agent-progress.js';
import {
  defaultDriveProcess,
  detachDriver,
  driveLockPath,
  driveLogPath,
  DRIVE_HEARTBEAT_MS,
  DRIVE_MAX_HOURS,
  lastLines,
  readDriveLock,
  stopDriver,
  withDriveLock,
  type DriveProcess,
  type DriveSpawn,
} from '../../release/drive.js';
import { decideMerge, listChangedFiles, readCommitsSinceReview, type PrView } from '../../ship/merge.js';
import { runPrepare } from '../../ship/prepare.js';
import {
  createShipState,
  latestVerdict,
  readShipState,
  recordVerdict,
  shipStatePath,
  transition,
  updateShipState,
  type ShipState,
} from '../../ship/state.js';

export const EXIT_PENDING = 8;

class UsageError extends Error {}

function parsePr(raw: string): number {
  const n = Number(raw.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`PR must be a positive number, got ${JSON.stringify(raw)}`);
  return n;
}

function parseNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a non-negative number`);
  return n;
}

function repoRoot(exec: Exec): string {
  const r = exec('git', ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw new UsageError('omg ship must run inside a git repository');
  return r.stdout.trim();
}

export interface ShipConfigContext {
  exec: Exec;
  root: string;
  /** The PR's base branch on GitHub: its committed `.copilot/omg.jsonc` is the trusted project layer. */
  base: string;
  /** GitHub's base sha (baseRefOid); the fetched base must equal it before its files are read. */
  baseSha?: string;
  /** The PR's repository URL on GitHub; the remote must point at it before the base is fetched. */
  repoUrl?: string;
  /** merge: an unverifiable base throws (fail closed) instead of falling back to the defaults. */
  strict?: boolean;
}

export type ShipConfigLoader = (ctx: ShipConfigContext) => LoadedShipConfig;

/** User config (default location for the safety keys) + the trusted base's committed project config. */
const shipConfig: ShipConfigLoader = (ctx) => loadTrustedShipConfig({ ...ctx, ...userConfigLayers() });

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The PR's base branch, base sha and repository URL as GitHub reports them. */
function prBaseInfo(exec: Exec, pr: number): { base: string; baseSha: string; repoUrl: string | undefined } {
  const view = exec('gh', ['pr', 'view', String(pr), '--json', 'baseRefName,baseRefOid,url']);
  let info: { baseRefName?: unknown; baseRefOid?: unknown; url?: unknown } = {};
  try {
    info = JSON.parse(view.stdout) as typeof info;
  } catch {
    info = {};
  }
  if (view.status !== 0 || !isPlainBranchName(info.baseRefName) || typeof info.baseRefOid !== 'string' || !FULL_SHA.test(info.baseRefOid)) {
    throw new Error(`gh pr view ${pr} did not return a base branch and sha: ${view.stderr.trim()}`);
  }
  return { base: info.baseRefName, baseSha: info.baseRefOid, repoUrl: prRepoUrl(info.url) };
}

/**
 * OMG_SHIP_HUMAN=1: the owner's override for replacing a terminal or
 * hand-edited run. Lane briefs forbid it; like every environment input it is
 * advisory against a hostile lane (see the trust note above).
 */
function humanOverride(): boolean {
  return process.env.OMG_SHIP_HUMAN === '1';
}

function assertBranchName(exec: Exec, name: string, label: string): string {
  if (!isPlainBranchName(name) || exec('git', ['check-ref-format', '--branch', name]).status !== 0) {
    throw new UsageError(`${label} ${JSON.stringify(name)} is not a valid branch name`);
  }
  return name;
}

function requireState(root: string, pr: number): ShipState {
  const state = readShipState(root, pr);
  if (!state) throw new UsageError(`no ship run for PR #${pr}; start one with omg ship init ${pr} --implementer <lane>`);
  return state;
}

function now(): string {
  return new Date().toISOString();
}

function emit(json: boolean, payload: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else human();
}

async function guarded(json: boolean, fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(chalk.red(`Error: ${message}`));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

function printState(state: ShipState): void {
  console.log(`${chalk.bold(`ship PR #${state.pr}`)}  phase=${chalk.cyan(state.phase)}  base=${state.base}  implementer=${state.implementer}`);
  console.log(`fix rounds ${state.fixRounds}/${state.maxFixRounds}  verdicts ${state.verdicts.length}  housekeeping commits ${state.housekeepingCommits.length}`);
  if (state.blockedReason) console.log(chalk.red(`blocked: ${state.blockedReason}`));
  if (state.lastGates) console.log(`last gates: ${state.lastGates.verdict} @ ${state.lastGates.at}`);
  for (const h of state.history.slice(-5)) console.log(chalk.gray(`  ${h.at} ${h.from ?? '-'} -> ${h.to}: ${h.note}`));
}

function printGates(report: GateReport): void {
  const color = report.verdict === 'green' ? chalk.green : report.verdict === 'pending' ? chalk.yellow : chalk.red;
  console.log(`${chalk.bold(`gates PR #${report.pr}`)}: ${color(report.verdict)}`);
  for (const name of report.failed) console.log(chalk.red(`  failed   ${name}`));
  for (const name of report.pending) console.log(chalk.yellow(`  pending  ${name}`));
  for (const name of report.advisoryFailed) console.log(chalk.gray(`  advisory ${name} (not blocking)`));
  for (const s of report.suggestions) console.log(`  -> ${s}`);
}

/** A watch that ran out of time while a flaky run's rerun / sibling jobs were still going is pending, not failed. */
export function gateExit(report: GateReport, timedOut = false): number {
  if (report.verdict === 'green') return 0;
  return report.verdict === 'pending' || (timedOut && report.verdict === 'flaky') ? EXIT_PENDING : 1;
}

/** `gates --drive`: the clock, process probes and the detached spawn (tests). */
export interface ShipDriveDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  proc: DriveProcess;
  spawnDriver?: DriveSpawn;
  /** CLI script the detached driver runs (default: the one running now). */
  entry?: string;
}

const defaultShipDrive: ShipDriveDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  proc: defaultDriveProcess,
};

export function shipCommand(execImpl: Exec = defaultExec, loadShipConfig: ShipConfigLoader = shipConfig, drive: ShipDriveDeps = defaultShipDrive): Command {
  // The guard also refuses pushes to the run's base once a command knows it.
  let runBase: string[] = [];
  const exec = guardExec(execImpl, () => runBase);
  const cmd = new Command('ship');
  cmd.description('Ship a PR: independent review verdicts, mechanical prepare, CI gate engine, guarded admin merge');

  cmd
    .command('init <pr>')
    .description('Start a ship run for a PR and name the lane that implemented it')
    .requiredOption('--implementer <lane>', 'Name of the implementing agent/lane (its own verdicts are refused)')
    .option('--base <branch>', 'Integration branch (default: ship.base, else dev)')
    .option('--max-fix-rounds <n>', 'Fix rounds before the run blocks (default: ship.maxFixRounds, else 2)')
    .option('--force', 'Replace an existing non-terminal run for this PR (kept in previousRuns); a blocked or merged run needs OMG_SHIP_HUMAN=1')
    .option('--json', 'JSON output')
    .action((prRaw: string, o: { implementer: string; base?: string; maxFixRounds?: string; force?: boolean; json?: boolean }) =>
      guarded(Boolean(o.json), () => {
        const pr = parsePr(prRaw);
        const root = repoRoot(exec);
        const view = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefName,baseRefName,baseRefOid,url']);
        const prInfo = view.status === 0 ? (JSON.parse(view.stdout) as { headRefName?: string; baseRefName?: string; baseRefOid?: string; url?: string }) : {};
        if (o.base !== undefined && prInfo.baseRefName !== undefined && o.base !== prInfo.baseRefName) {
          throw new UsageError(`--base ${JSON.stringify(o.base)} differs from PR #${pr}'s base on GitHub (${prInfo.baseRefName}); retarget the PR on GitHub instead`);
        }
        const known = prInfo.baseRefName ?? o.base;
        const config = loadShipConfig({ exec, root, base: assertBranchName(exec, known ?? DEFAULT_SHIP_CONFIG.base, '--base'), baseSha: prInfo.baseRefOid, repoUrl: prRepoUrl(prInfo.url) });
        const base = assertBranchName(exec, known ?? config.base, '--base');
        const branch = prInfo.headRefName === undefined ? undefined : assertBranchName(exec, prInfo.headRefName, 'PR head branch');
        const maxFixRounds = parseNumber(o.maxFixRounds, '--max-fix-rounds') ?? config.maxFixRounds;
        const human = humanOverride();
        const state = updateShipState(root, pr, (current) => {
          const fresh = createShipState({ pr, base, branch, implementer: o.implementer, maxFixRounds: Math.floor(maxFixRounds) }, now());
          if (!current) return fresh;
          if (!o.force) throw new UsageError(`a ship run for PR #${pr} exists (phase ${current.phase}); pass --force to replace it`);
          if ((current.phase === 'blocked' || current.phase === 'merged') && !human) {
            throw new UsageError(`the ship run for PR #${pr} is ${current.phase}; only the owner may replace it (OMG_SHIP_HUMAN=1)`);
          }
          const { previousRuns = [], ...prior } = current;
          // A run with verdicts (now or in a replaced run) keeps its fix-round budget and implementer.
          const reviewed = current.verdicts.length > 0 || current.fixRounds > 0 || previousRuns.some((p) => p.verdicts.length > 0);
          if (reviewed && !human) {
            if (o.implementer.trim().toLowerCase() !== current.implementer.trim().toLowerCase()) {
              throw new UsageError(`the ship run for PR #${pr} has verdicts; its implementer stays ${current.implementer} (only the owner may reset it: OMG_SHIP_HUMAN=1)`);
            }
            return {
              ...fresh,
              implementer: current.implementer,
              fixRounds: current.fixRounds,
              maxFixRounds: current.maxFixRounds,
              previousRuns: [...previousRuns, prior],
            };
          }
          return { ...fresh, previousRuns: [...previousRuns, prior] };
        }, { allowUnverified: human });
        emit(Boolean(o.json), { ok: true, state, path: shipStatePath(root, pr) }, () => printState(state));
        return 0;
      }));

  cmd
    .command('status <pr>')
    .description('Print the persisted ship state for a PR')
    .option('--json', 'JSON output')
    .action((prRaw: string, o: { json?: boolean }) =>
      guarded(Boolean(o.json), () => {
        const state = requireState(repoRoot(exec), parsePr(prRaw));
        emit(Boolean(o.json), state, () => printState(state));
        return 0;
      }));

  cmd
    .command('verdict <pr>')
    .description('Record an independent reviewer/verifier verdict for the reviewed commit')
    .requiredOption('--reviewer <name>', 'Reviewer lane name (must differ from the implementer)')
    .requiredOption('--sha <commit>', 'The commit the reviewer was given')
    .option('--approve', 'The change is approved')
    .option('--request-changes', 'The change needs a fix round')
    .option('--notes <text>', 'Short verdict summary')
    .option('--json', 'JSON output')
    .action((prRaw: string, o: { reviewer: string; sha: string; approve?: boolean; requestChanges?: boolean; notes?: string; json?: boolean }) =>
      guarded(Boolean(o.json), () => {
        if (Boolean(o.approve) === Boolean(o.requestChanges)) throw new UsageError('pass exactly one of --approve / --request-changes');
        const pr = parsePr(prRaw);
        const root = repoRoot(exec);
        if (!/^[0-9a-fA-F]{7,40}$/.test(o.sha)) throw new UsageError(`--sha must be a hex commit id (7-40 characters), got ${JSON.stringify(o.sha)}`);
        const resolved = exec('git', ['rev-parse', '--verify', `${o.sha}^{commit}`]);
        if (resolved.status !== 0) throw new UsageError(`--sha ${o.sha} is not a commit in this repository (fetch it first)`);
        const state = updateShipState(root, pr, (current) => {
          if (!current) throw new UsageError(`no ship run for PR #${pr}; run omg ship init first`);
          return recordVerdict(current, {
            reviewer: o.reviewer,
            verdict: o.approve ? 'approve' : 'changes-requested',
            sha: resolved.stdout.trim(),
            at: now(),
            notes: o.notes,
          });
        });
        emit(Boolean(o.json), { ok: true, state }, () => printState(state));
        return state.phase === 'blocked' ? 1 : 0;
      }));

  cmd
    .command('prepare <pr>')
    .description('Merge origin/<base> in (never rebase), run tsc/lint/targeted tests, regenerate the inventory as the last commit')
    .option('--no-checks', 'Skip tsc/lint/tests (merge + inventory only)')
    .option('--push', 'Plain push of the branch afterwards (never forced)')
    .option('--json', 'JSON output')
    .action((prRaw: string, o: { checks?: boolean; push?: boolean; json?: boolean }) =>
      guarded(Boolean(o.json), () => {
        const pr = parsePr(prRaw);
        const root = repoRoot(exec);
        const state = requireState(root, pr);
        if (!['prepare', 'gates', 'ready'].includes(state.phase)) {
          throw new UsageError(`phase is ${state.phase}; prepare runs after an approve verdict`);
        }
        if (!state.branch) throw new UsageError(`the ship run for PR #${pr} has no PR branch recorded; re-run omg ship init ${pr} --force once gh pr view works`);
        const reviewedSha = latestVerdict(state)?.sha;
        if (!reviewedSha) throw new UsageError(`no verdict recorded for PR #${pr}`);
        runBase = [state.base];
        // GitHub's base sha is what gets merged; the local ref only has to agree with it.
        const { base: prBaseBranch, baseSha, repoUrl } = prBaseInfo(exec, pr);
        if (prBaseBranch !== state.base) throw new Error(`PR #${pr} targets ${prBaseBranch} on GitHub, but the ship run expects ${state.base}; re-run omg ship init ${pr} --force`);
        const result = runPrepare({ exec, cwd: root, base: state.base, branch: state.branch, reviewedSha, baseSha, repoUrl, checks: o.checks, push: o.push });
        const next = updateShipState(root, pr, (current) => {
          const s = current ?? state;
          const withCommits = { ...s, housekeepingCommits: [...s.housekeepingCommits, ...result.housekeepingCommits] };
          return result.ok
            ? transition(withCommits, 'gates', `prepared (${result.housekeepingCommits.length} housekeeping commits)`, now())
            : transition(withCommits, 'prepare', `prepare failed: ${result.blockedReason}`, now());
        });
        emit(Boolean(o.json), { ...result, phase: next.phase }, () => {
          for (const step of result.steps) {
            const mark = step.status === 'ok' ? chalk.green('ok     ') : step.status === 'skipped' ? chalk.gray('skipped') : chalk.red('FAILED ');
            console.log(`${mark} ${step.name}${step.detail ? `: ${step.detail}` : ''}`);
          }
          console.log(result.ok ? chalk.green(`prepared; phase ${next.phase}`) : chalk.red(`prepare stopped: ${result.blockedReason}`));
        });
        return result.ok ? 0 : 1;
      }));

  cmd
    .command('gates <pr>')
    .description('Apply the merge rule to gh pr checks (advisory checks excluded; known-flaky failures detected)')
    .option('--watch', 'Poll until green, a real failure, or the timeout (exit 8 = still pending; run again)')
    .option('--interval <seconds>', 'Poll interval (default ship.pollIntervalSeconds, 30)')
    .option('--timeout <minutes>', 'Stop watching after this long (default ship.watchTimeoutMinutes, 9; 0 = no limit)')
    .option('--no-rerun', 'Never rerun known-flaky failures automatically')
    .option('--drive', 'Watch until green or a real failure with no watch window (exit 0 or 1, never 8); transient GitHub errors are retried; progress events under agent=ship-<pr>')
    .option('--drive-max <hours>', 'Hard ceiling of a --drive watch; then blocked (exit 1)', String(DRIVE_MAX_HOURS))
    .option('--detach', 'Run the --drive watch as a detached process that outlives this session')
    .option('--status', 'Print the drive lock and the last progress events of this PR, run nothing')
    .option('--stop', 'Stop the detached driver of this PR and remove its lock')
    .option('--json', 'JSON output')
    .action((prRaw: string, o: {
      watch?: boolean; interval?: string; timeout?: string; rerun?: boolean; json?: boolean;
      drive?: boolean; driveMax: string; detach?: boolean; status?: boolean; stop?: boolean;
    }) =>
      guarded(Boolean(o.json), async () => {
        const pr = parsePr(prRaw);
        const driveMaxHours = Number(o.driveMax);
        if (!Number.isFinite(driveMaxHours) || driveMaxHours <= 0) throw new UsageError('--drive-max must be a positive number of hours');
        if (o.status && o.stop) throw new UsageError('pass one of --status / --stop');
        const root = repoRoot(exec);
        const agent = `ship-${pr}`;
        const progressFile = resolveProgressFile(agent, undefined, root);
        const progress = (phase: string, status: 'start' | 'heartbeat' | 'done' | 'fail' | 'blocked', note: string) => { emitProgress({ phase, status, note, agent, cwd: root }); };
        const driveDir = dirname(shipStatePath(root, pr));
        const lockPath = driveLockPath(driveDir, String(pr));
        const logPath = driveLogPath(driveDir, String(pr));
        const monitor = `omg progress watch --file ${progressFile} --until settled --stall 30m`;
        if (o.status) {
          const lock = readDriveLock(lockPath);
          const liveness = lock ? await drive.proc.liveness(lock) : undefined;
          const events = lastLines(progressFile, 5);
          emit(Boolean(o.json), { lock, liveness, lockPath, logPath, progressFile, events }, () => {
            console.log(lock ? `driver: pid ${lock.pid} on ${lock.host} since ${lock.startedAt} (${liveness}); log ${logPath}` : `driver: none (no ${lockPath})`);
            console.log(lock && liveness === 'live' ? `wake on it: ${monitor}` : `drive: omg ship gates ${pr} --drive --detach`);
            for (const line of events) console.log(`  ${line}`);
          });
          return 0;
        }
        if (o.stop) {
          const stopped = await stopDriver(lockPath, drive.proc);
          if (stopped.stopped) progress('gates', 'blocked', `drive of PR #${pr} stopped by --stop (pid ${stopped.pid}); resume: omg ship gates ${pr} --drive --detach`);
          emit(Boolean(o.json), { ...stopped, lockPath }, () => console.log(stopped.stopped ? `stopped the driver (pid ${stopped.pid}) and removed ${lockPath}` : stopped.reason));
          return !stopped.stopped && stopped.refused ? 1 : 0;
        }
        if (o.detach) {
          const argv = ['ship', 'gates', String(pr), '--drive', '--drive-max', o.driveMax, ...(o.interval ? ['--interval', o.interval] : []), ...(o.rerun === false ? ['--no-rerun'] : [])];
          const detached = await detachDriver({
            lockPath, logPath, argv, cwd: root, proc: drive.proc, sleep: drive.sleep, spawnImpl: drive.spawnDriver,
            entry: drive.entry ?? process.argv[1], statusCommand: `omg ship gates ${pr} --status`,
          });
          emit(Boolean(o.json), { ...detached, lockPath, logPath, progressFile, monitor }, () => {
            if (!detached.ok) console.error(chalk.red(`Error: ${detached.reason}`));
            else {
              console.log(chalk.green(`gates PR #${pr}: driving detached as pid ${detached.pid}${detached.locked ? '' : ' (it has not taken the lock yet; check --status and the log)'}`));
              console.log(`  log      ${logPath}`);
              console.log(`  status   omg ship gates ${pr} --status   stop: omg ship gates ${pr} --stop`);
              console.log(`  wake on  ${monitor}`);
            }
          });
          return detached.ok ? 0 : 1;
        }
        const existing = readShipState(root, pr);
        // GitHub's base, never the state's: a retargeted PR is gated under its real base.
        const { base: prBaseBranch, baseSha, repoUrl } = prBaseInfo(exec, pr);
        if (existing && existing.base !== prBaseBranch) {
          console.error(chalk.yellow(`omg ship: PR #${pr} targets ${prBaseBranch} on GitHub, but the ship run expects ${existing.base}; merge will refuse until they agree`));
        }
        const loaded = loadShipConfig({ exec, root, base: prBaseBranch, baseSha, repoUrl });
        const config: ShipConfig = {
          ...loaded,
          pollIntervalSeconds: parseNumber(o.interval, '--interval') || loaded.pollIntervalSeconds,
          // --drive: no watch window but the --drive-max ceiling.
          watchTimeoutMinutes: o.drive ? driveMaxHours * 60 : parseNumber(o.timeout, '--timeout') ?? loaded.watchTimeoutMinutes,
          autoRerunFlaky: loaded.autoRerunFlaky && o.rerun !== false,
        };
        const hasState = existing !== null;
        let lastBeat = -Infinity;
        const beat = (note: string) => {
          if (drive.now() - lastBeat < DRIVE_HEARTBEAT_MS) return;
          lastBeat = drive.now();
          progress('gates', 'heartbeat', note);
        };
        const watch = (): Promise<WatchResult> => watchGates({
          exec,
          pr,
          config,
          known: loadBaseKnownFlaky(exec, root, loaded.trustedBaseCommit, config.knownFlakyFile),
          cwd: root,
          watch: Boolean(o.watch || o.drive),
          reruns: hasState
            ? {
                count: (id) => readShipState(root, pr)?.reruns[id] ?? 0,
                record: (id) => { updateShipState(root, pr, (s) => ({ ...s!, reruns: { ...s!.reruns, [id]: (s!.reruns[id] ?? 0) + 1 }, updatedAt: now() })); },
              }
            : undefined,
          sleep: drive.sleep,
          now: drive.now,
          onReport: (r) => {
            if ((o.watch || o.drive) && !o.json) console.error(chalk.gray(`[${now()}] gates ${r.verdict}: ${r.pending.length} pending, ${r.failed.length} failed`));
            if (o.drive) beat(`PR #${pr} gates ${r.verdict}: ${r.pending.length} pending, ${r.failed.length} failed`);
          },
          retryTransient: o.drive,
          onTransient: (message) => { if (o.drive) beat(`PR #${pr}: transient GitHub error, retrying (${message.slice(0, 120)})`); },
        });
        let result: WatchResult;
        if (o.drive) {
          const held = await withDriveLock(lockPath, process.argv.slice(2), drive.proc, (line) => console.error(line), async () => {
            progress('gates', 'start', `PR #${pr}: driving the gates (--drive-max ${driveMaxHours} h)`);
            try {
              return await watch();
            } catch (error) {
              progress('gates', 'fail', `PR #${pr}: ${error instanceof Error ? error.message : String(error)}; next: omg ship gates ${pr} --drive --detach`);
              throw error;
            }
          });
          if (!held.held) {
            throw new Error(`another driver holds ${lockPath}${held.holder ? ` (pid ${held.holder.pid} on ${held.holder.host})` : ''}; see omg ship gates ${pr} --status`);
          }
          result = held.value;
          const r = result.report;
          if (r.verdict === 'green') progress('gates', 'done', `PR #${pr} gates green; next: omg ship merge ${pr}`);
          else if (result.timedOut) progress('gates', 'blocked', `PR #${pr} gates still ${r.verdict} at --drive-max ${driveMaxHours} h (${r.pending.length} pending); check CI, then omg ship gates ${pr} --drive --detach`);
          else progress('gates', 'fail', `PR #${pr} gates ${r.verdict}: ${[...r.failed, ...r.suggestions].join('; ').slice(0, 300) || 'see omg ship gates'}; next: fix, push, omg ship gates ${pr} --drive --detach`);
        } else {
          result = await watch();
        }
        const { report } = result;
        if (hasState) {
          updateShipState(root, pr, (s) => {
            let next: ShipState = { ...s!, lastGates: { verdict: report.verdict, at: now(), failed: report.failed, pending: report.pending }, updatedAt: now() };
            if (report.verdict === 'green' && next.phase === 'gates') next = transition(next, 'ready', 'gates green', now());
            else if (report.verdict !== 'green' && next.phase === 'ready') next = transition(next, 'gates', `gates ${report.verdict}`, now());
            return next;
          });
        }
        emit(Boolean(o.json), { ...report, rerun: result.rerun, timedOut: result.timedOut }, () => {
          printGates(report);
          if (result.rerun.length > 0) console.log(`reran (once each): ${result.rerun.join(', ')}`);
          if (result.timedOut) console.log(chalk.yellow(o.drive ? `--drive-max ${driveMaxHours} h elapsed; blocked` : 'watch window elapsed; run the same command again to keep watching'));
        });
        // --drive never exits 8: green or not, the watch is over.
        if (o.drive) return report.verdict === 'green' ? 0 : 1;
        return gateExit(report, result.timedOut);
      }));

  cmd
    .command('merge <pr>')
    .description('Merge only when gates are green and an independent approval covers the head (running the admin merge needs the owner-set ship.allowAdminMerge)')
    .option('--json', 'JSON output')
    .action((prRaw: string, o: { json?: boolean }) =>
      guarded(Boolean(o.json), async () => {
        const pr = parsePr(prRaw);
        const root = repoRoot(exec);
        const state = requireState(root, pr);
        const view = exec('gh', ['pr', 'view', String(pr), '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,url']);
        if (view.status !== 0) throw new Error(`gh pr view ${pr} failed: ${view.stderr.trim()}`);
        const prView = JSON.parse(view.stdout) as PrView & { headRefName: string; baseRefOid: string; url?: string };
        if (!isPlainBranchName(prView.baseRefName) || !FULL_SHA.test(String(prView.baseRefOid)) || !FULL_SHA.test(String(prView.headRefOid))) {
          throw new Error(`gh pr view ${pr} did not return a base branch, base sha and head sha`);
        }
        // Trusted layer = the PR's real base on GitHub at its real sha (decideMerge also requires it to equal the run's base).
        const config = loadShipConfig({ exec, root, base: prView.baseRefName, baseSha: prView.baseRefOid, repoUrl: prRepoUrl(prView.url), strict: true });
        const trustedBase = config.trustedBases.includes(prView.baseRefName);
        const { report: gate } = await watchGates({
          exec, pr, config, known: loadBaseKnownFlaky(exec, root, config.trustedBaseCommit, config.knownFlakyFile), cwd: root, headSha: prView.headRefOid, watch: false,
          sleep: async () => {}, now: () => Date.now(),
        });
        // The head GitHub reports must be present locally before the diff and ancestry reads.
        if (exec('git', ['cat-file', '-e', `${prView.headRefOid}^{commit}`], { cwd: root }).status !== 0) {
          exec('git', ['fetch', 'origin', prView.headRefName], { cwd: root, env: TRUSTED_READ_ENV });
        }
        const changedFiles = listChangedFiles(exec, root, prView.baseRefOid, prView.headRefOid);
        const reviewed = state.verdicts[state.verdicts.length - 1]?.sha;
        // The base was fetched and checked against baseRefOid by the strict config load above.
        const since = readCommitsSinceReview(exec, root, reviewed, prView.headRefOid, prView.baseRefOid, state.housekeepingCommits);
        const decision = decideMerge({
          state, pr: prView, gate, ...since, changedFiles,
          humanOverride: humanOverride(),
          extraProtected: config.knownFlakyFile === DEFAULT_SHIP_CONFIG.knownFlakyFile ? [] : [config.knownFlakyFile],
        });
        // A base outside ship.trustedBases never gets an admin merge (a lane can create and target a branch).
        const allowAdmin = config.allowAdminMerge && trustedBase;
        const commandText = decision.command.join(' ');
        if (!decision.ok) {
          emit(Boolean(o.json), { ok: false, merged: false, reasons: decision.reasons, command: decision.command }, () => {
            console.log(chalk.red(`merge refused for PR #${pr}:`));
            for (const r of decision.reasons) console.log(chalk.red(`  - ${r}`));
          });
          return 1;
        }
        if (!allowAdmin) {
          updateShipState(root, pr, (s) => (s!.phase === 'ready' ? s! : transition(s!, 'ready', 'merge-ready', now())));
          emit(Boolean(o.json), { ok: true, merged: false, command: decision.command }, () => {
            const why = config.allowAdminMerge
              ? `base ${prView.baseRefName} is not in ship.trustedBases, so ship does not admin-merge`
              : 'ship.allowAdminMerge is off';
            console.log(chalk.green(`PR #${pr} is merge-ready. ${why}; run:`));
            console.log(`  ${commandText}`);
          });
          return 0;
        }
        const merged = exec(decision.command[0], decision.command.slice(1), { cwd: root });
        if (merged.status !== 0) throw new Error(`${commandText} failed: ${merged.stderr.trim()}`);
        updateShipState(root, pr, (s) => {
          const ready = s!.phase === 'ready' ? s! : transition(s!, 'ready', 'merge-ready', now());
          return transition(ready, 'merged', `merged at ${prView.headRefOid.slice(0, 12)}`, now());
        });
        emit(Boolean(o.json), { ok: true, merged: true, command: decision.command }, () => console.log(chalk.green(`merged PR #${pr}`)));
        return 0;
      }));

  return cmd;
}
