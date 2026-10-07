/**
 * Tier 2 `team` scenario of `omg smoke copilot` (opt-in): a real 2-worker
 * `omg team` on the sdk transport, driven only through the CLI under test.
 *
 * 1. `omg team 2:copilot --json "<numbered task list>"` from the sandbox
 *    project with no `--transport`: under the Copilot host (COPILOT_CLI=1) the
 *    default must pick the sdk transport. Workers get detached worktrees.
 * 2. `omg team status --json` is polled until both tasks settle; the last
 *    snapshot is kept. `omg team api list-tasks` then lists owners and states,
 *    and each worker worktree's commits on top of the leader HEAD are read.
 * 3. Each worker's sdk events and runtime debug logs are copied into the smoke
 *    home (the team state is disposed at shutdown), so `scn.team.cost` and
 *    `scn.team.adapter_errors` see them.
 * 4. `omg team shutdown`, while each worker's `sdk-session.json` is polled for
 *    the final `session.shutdown` totals. Then: no host or runtime pid left,
 *    the instance reservation released, the team state gone.
 *
 * Everything runs as child processes of `node <root>/bridge/cli.cjs`, so this
 * module imports no team code; the smoke entry injects it like `chain`.
 *
 * Cost: one user prompt per worker, about 2 premium requests. Each host is
 * capped at half of the run's remaining credit budget.
 */

import { spawn as nodeSpawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, dirname, isAbsolute, join } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { excerpt, parseJsonl, type CopilotEvent } from './copilot-session-eval.js';
import {
  scenarioCost,
  SCENARIOS,
  TEAM_BUDGET_MS,
  type ScenarioCost,
  type ScenarioRun,
  type TeamEvidence,
} from './copilot-sdk-scenarios.js';
import { runAsync, type RunResult, type SpawnFn, type SpawnSyncFn } from './process-utils.js';

export interface TeamScenarioInput {
  /** Plugin under test: its `bridge/cli.cjs` is the `omg` that runs the team. */
  root: string;
  /** The installed copilot binary as resolved for tier 1 (a shim is fine): its dir goes first on PATH. */
  bin: string;
  /** Tier 2 session env (isolated COPILOT_HOME with the login identity). */
  env: NodeJS.ProcessEnv;
  /** Sandbox git repo (trusted in the home's config.json). */
  projectDir: string;
  home: string;
  /** Raised to {@link TEAM_BUDGET_MS}: a team run spans start, two tasks and shutdown. */
  timeoutMs: number;
  maxCredits: number;
  /** Credits left of the run cap; each host gets half. */
  budget: number;
  eventsPath: string;
  spawnSync: SpawnSyncFn;
  /** Test seams. */
  spawn?: SpawnFn;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** The leader env: the Copilot host signal, copilot on PATH, detached worktrees, the per-host credit cap. */
export function teamLeaderEnv(base: NodeJS.ProcessEnv, bin: string, budget: number): NodeJS.ProcessEnv {
  const key = pathKey(base);
  const env: NodeJS.ProcessEnv = {
    ...base,
    [key]: [dirname(bin), base[key]].filter(Boolean).join(delimiter),
    COPILOT_CLI: '1',
    OMC_RUNTIME_V2: '1',
    OMC_TEAM_WORKTREE_MODE: 'detached',
    OMC_TEAM_SDK_MAX_CREDITS: String(Math.max(1, Math.floor(budget / 2))),
  };
  // A measurement knob for the launch path (1 = serial), passed through when set.
  if (process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY) env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY = process.env.OMC_TEAM_SDK_LAUNCH_CONCURRENCY;
  delete env.OMC_TEAM_WORKER;
  delete env.OMX_TEAM_WORKER;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** The last stdout line that parses as a JSON object. */
export function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* next */ }
  }
  return null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** `[omg team] sdk workers launched: N in X ms` from the start command's stderr. */
export function parseLaunchMs(stderr: string): number | null {
  const m = /sdk workers launched: \d+ in (\d+) ms/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/** The tasks of an `omg team api list-tasks --json` reply. */
export function parseApiTasks(reply: Record<string, unknown> | null): TeamEvidence['tasks'] {
  const data = (reply?.data ?? reply) as { tasks?: unknown } | null;
  const tasks = Array.isArray(data?.tasks) ? data!.tasks as Array<Record<string, unknown>> : [];
  return tasks.map((t) => ({
    id: str(t.id) || String(t.id ?? ''),
    subject: str(t.subject),
    status: str(t.status),
    owner: str(t.owner) || null,
  }));
}

function sdkWorkers(status: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const sdk = (status?.workers as { sdk?: unknown } | undefined)?.sdk;
  return Array.isArray(sdk) ? sdk as Array<Record<string, unknown>> : [];
}

function workerList(status: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const list = (status?.workers as { list?: unknown } | undefined)?.list;
  return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

function tasksSettled(status: Record<string, unknown> | null): boolean {
  const t = (status?.tasks ?? {}) as Record<string, unknown>;
  const total = num(t.total);
  return total > 0 && num(t.completed) + num(t.failed) === total;
}

/** Instance reservations for `teamName` left under the project's `.omg/state/team-recovery`. */
export function leftoverReservations(projectDir: string, teamName: string): string[] {
  const base = join(getOmcRoot(projectDir), 'state', 'team-recovery', 'team-instances');
  let hashes: string[] = [];
  try { hashes = readdirSync(base); } catch { return []; }
  return hashes.map((h) => join(base, h, teamName, 'reservation.json')).filter((p) => existsSync(p));
}

/** Per worker: the latest parse of `sdk-session.json`, kept across the shutdown that deletes it. */
type SessionUsage = { premium: number; credits: number; final: boolean };

function sessionUsage(stateRoot: string, worker: string): SessionUsage | null {
  const session = readJson(join(stateRoot, 'workers', worker, 'sdk-session.json'));
  const usage = session?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const finalPremium = usage.shutdown_premium_requests;
  return {
    premium: typeof finalPremium === 'number' ? finalPremium : num(usage.premium_requests),
    credits: typeof usage.shutdown_credits === 'number' ? usage.shutdown_credits : num(usage.credits),
    final: typeof finalPremium === 'number',
  };
}

/** Sum per-worker usage; any worker without a session read falls back to its copied events. */
export function teamCost(usage: Map<string, SessionUsage>, eventsByWorker: Map<string, CopilotEvent[]>): ScenarioCost & { source: string } {
  let premiumRequests = 0;
  let credits = 0;
  const sources: string[] = [];
  for (const worker of new Set([...usage.keys(), ...eventsByWorker.keys()])) {
    const u = usage.get(worker);
    if (u) {
      premiumRequests += u.premium;
      credits += u.credits;
      sources.push(`${worker} ${u.final ? 'session.shutdown' : 'running sum'}`);
    } else {
      const c = scenarioCost(eventsByWorker.get(worker) ?? []);
      premiumRequests += c.premiumRequests;
      credits += c.credits;
      sources.push(`${worker} ${c.source}`);
    }
  }
  return { premiumRequests, credits, source: sources.join(', ') || 'no worker usage found' };
}

export async function runTeamScenario(input: TeamScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & { wedged: boolean }> {
  const now = input.now ?? Date.now;
  const isAlive = input.isAlive ?? pidAlive;
  const pollMs = input.pollMs ?? 5_000;
  const budgetMs = Math.max(input.timeoutMs, TEAM_BUDGET_MS);
  const started = now();
  const deadline = started + budgetMs;
  const env = teamLeaderEnv(input.env, input.bin, input.budget);
  const cli = join(input.root, 'bridge', 'cli.cjs');
  const spawnFn = input.spawn ?? nodeSpawn;
  const omg = (args: string[], timeoutMs: number): Promise<RunResult> =>
    runAsync(spawnFn, input.spawnSync, process.execPath, [cli, ...args], { cwd: input.projectDir, env, timeoutMs });
  const base = {
    name: 'team' as const,
    timeoutMs: budgetMs,
    model: 'sdk workers (team.sdk.model, else runtime auto)',
    maxCredits: input.maxCredits,
    budget: input.budget,
    capped: false,
    wedged: false,
  };

  const start = await omg(['team', '2:copilot', '--json', SCENARIOS.team.prompt], budgetMs);
  const startJson = lastJsonObject(start.stdout);
  const teamName = str(startJson?.teamName) || null;
  const evidence: TeamEvidence = {
    teamName,
    start: { code: start.code, ok: typeof startJson?.ok === 'boolean' ? startJson.ok : null, ms: start.durationMs, launchMs: parseLaunchMs(start.stderr), stderr: excerpt(start.stderr, 2_000) },
    status: null,
    tasks: [],
    commits: [],
    shutdown: null,
    orphans: [],
    reservationsLeft: [],
    stateLeft: false,
    durationMs: 0,
    budgetMs,
    cost: { premiumRequests: 0, credits: 0, source: 'no worker usage found' },
  };
  if (!teamName) {
    evidence.durationMs = now() - started;
    return { ...base, events: [], idle: false, timedOut: start.timedOut, error: `omg team start: ${start.error ?? `exit ${String(start.code)}`}: ${excerpt(start.stderr, 300)}`, team: evidence };
  }

  // Poll status until both tasks settle (or the budget runs out).
  let timedOut = false;
  for (;;) {
    const status = lastJsonObject((await omg(['team', 'status', teamName, '--json'], 60_000)).stdout);
    if (status) evidence.status = status;
    if (tasksSettled(status)) break;
    if (now() + pollMs >= deadline) { timedOut = true; break; }
    await sleep(pollMs);
  }
  const stateRoot = str(evidence.status?.team_state_root);
  const stateDir = stateRoot && isAbsolute(stateRoot) ? stateRoot : join(getOmcRoot(input.projectDir), 'state', 'team', teamName);
  const workers = sdkWorkers(evidence.status).map((w) => str(w.name)).filter(Boolean);

  evidence.tasks = parseApiTasks(lastJsonObject((await omg(['team', 'api', 'list-tasks', '--input', JSON.stringify({ team_name: teamName }), '--json'], 60_000)).stdout));

  const git = (args: string[], cwd: string) => input.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const leaderHead = String(git(['rev-parse', 'HEAD'], input.projectDir).stdout ?? '').trim();
  for (const worker of workerList(evidence.status)) {
    const name = str(worker.name);
    const worktree = str(worker.worktree_path) || null;
    if (!worktree || !leaderHead) { evidence.commits.push({ worker: name, worktree, subjects: [], files: [] }); continue; }
    const subjects = String(git(['log', '--format=%s', `${leaderHead}..HEAD`], worktree).stdout ?? '').split(/\r?\n/).filter(Boolean);
    const files = String(git(['diff', '--name-only', `${leaderHead}..HEAD`], worktree).stdout ?? '').split(/\r?\n/).filter(Boolean);
    evidence.commits.push({ worker: name, worktree, subjects, files });
  }

  // The team state is disposed at shutdown: copy events and runtime logs out first.
  const eventsByWorker = new Map<string, CopilotEvent[]>();
  const logDir = join(input.home, 'logs');
  for (const worker of workers) {
    try { eventsByWorker.set(worker, parseJsonl(readFileSync(join(stateDir, 'workers', worker, 'sdk-events.jsonl'), 'utf8')).events); } catch { /* none */ }
    const workerLogs = join(stateDir, 'workers', worker, 'copilot-home', 'logs');
    try {
      mkdirSync(logDir, { recursive: true });
      for (const f of readdirSync(workerLogs).filter((n) => n.endsWith('.log'))) copyFileSync(join(workerLogs, f), join(logDir, `team-${worker}-${f}`));
    } catch { /* no logs */ }
  }
  const pids = sdkWorkers(evidence.status).flatMap((w) => [num(w.host_pid), num(w.runtime_pid)]).filter((p) => p > 0);

  // Shut down (forced only when the tasks never settled), keeping each
  // worker's last session usage: the final totals land just before disposal.
  const usage = new Map<string, SessionUsage>();
  const readUsage = () => { for (const worker of workers) { const u = sessionUsage(stateDir, worker); if (u) usage.set(worker, u); } };
  readUsage();
  const forced = timedOut || !tasksSettled(evidence.status);
  const shutdownStarted = now();
  let shutdownDone = false;
  const shutdownRun = omg(['team', 'shutdown', teamName, ...(forced ? ['--force'] : [])], 120_000).finally(() => { shutdownDone = true; });
  while (!shutdownDone) { readUsage(); await sleep(250); }
  const shutdown = await shutdownRun;
  // The tail carries the outcome; the head is environment banners.
  evidence.shutdown = { code: shutdown.code, ms: now() - shutdownStarted, stdout: excerpt(shutdown.stdout.slice(-1_000), 1_000), stderr: excerpt(shutdown.stderr.slice(-1_500), 1_500), forced };
  const reapDeadline = now() + 10_000;
  while (pids.some(isAlive) && now() < reapDeadline) await sleep(250);
  evidence.orphans = pids.filter(isAlive);
  evidence.reservationsLeft = leftoverReservations(input.projectDir, teamName);
  evidence.stateLeft = existsSync(stateDir);
  evidence.durationMs = now() - started;
  evidence.cost = teamCost(usage, eventsByWorker);

  const events = [...eventsByWorker.values()].flat();
  try { writeFileSync(input.eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')); } catch { /* best effort */ }
  const error = timedOut ? `tasks did not settle within ${budgetMs} ms; the team was shut down with --force`
    : shutdown.code !== 0 ? `omg team shutdown exited ${String(shutdown.code)}: ${excerpt(shutdown.stderr.slice(-300), 300)}`
      : undefined;
  return {
    ...base,
    events,
    idle: !timedOut && start.code === 0 && shutdown.code === 0,
    timedOut,
    ...(error ? { error } : {}),
    team: evidence,
  };
}
