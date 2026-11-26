/**
 * `omg factory poll [--interval 5m] [--once] [--no-heal] [--no-intake] [--no-prs] [--json]`
 * (ADO parity design §2): a foreground polling loop, forge-neutral (GitHub
 * and Azure DevOps). It replaces webhooks where there is no public endpoint.
 * One tick, in this order:
 *
 * 1. heal: `runHealScan` (classify new red CI runs into heal state), only
 *    when `forge.capabilities.heal` (Azure DevOps: factory.heal.pipeline set;
 *    without it the tick is skipped with heal scan's message); on Azure DevOps
 *    through heal scan's own wiring (adoHealFor), so the read guard pins
 *    `definitions` to that pipeline. Never `heal run` or `heal approve`.
 * 2. intake: the source's ids diffed against `.omg/state/factory-poll.json`
 *    `seen`; each new id is checked (check's rules) and audited
 *    (`intake-new` in `.omg/state/factory-poll-audit.jsonl`).
 * 3. PRs: every run in flight with a PR. A PR a human completed or abandoned
 *    prints the resume hint; open human review threads are counted
 *    (ForgeReviews.reviewFeedback on every forge; ADO's listThreads where a forge has no feedback read).
 * 3c. attention: `omg factory attention`'s collector (local state only,
 *    read-only): the first tick prints a one-line summary, later ticks one
 *    line per item that is new since the previous tick (run key, group,
 *    trust, gate, park time), with its first next command; a stale-gate
 *    reminder (3b) in the same tick stands for an item's line (never its
 *    notice) only when its sealed park time is a reminder window old. Only trusted items get a line and an item notice
 *    (queued past the per-tick cap and rate limit), once per identity: only
 *    an identity that really got its line or notice counts as announced, and
 *    a queued notice waits while its run's row is not trusted; rows whose
 *    state is not trusted are only counted (one line when the count changes,
 *    one count notice per hour, one more per 10 min when the count rises), so
 *    a lane cannot crowd out, drop or indefinitely delay a trusted item. The
 *    `factory-attention` notification is off unless configured and carries
 *    engine-composed text only (attention/notify.ts).
 * 4. board: the board rows that changed since the previous tick
 *    (src/factory/board), or with `--json` one JSON object per tick.
 *
 * Steps 1-4 never spawn a session or a lane and never write to the tracker or
 * the forge: every forge call goes through check's read guard with no marker
 * (openReadForge), and the heal scan through the heal guard. It writes local
 * state only: the poll file and its audit; the heal tick also writes heal
 * state under its `scan.lock` and the heal scan records in the ledger
 * directory outside the repository, as `heal scan` does. The tick result says whether the
 * repository was idle (no engine owner, no run in flight, no unreadable run
 * state).
 *
 * 5. auto-start (`factory.intake.autoStart`, trusted layers only, default
 *    off; shipyard-factory design D7): after an idle tick whose intake read
 *    succeeded and was not rate-limited (a broken run state is never idle),
 *    with budget headroom (PollBudget), and once poll's atomic claim of the
 *    engine's repo owner lock succeeds (a refusal skips the tick), poll starts one
 *    `omg factory run --next --json` and waits for it. It runs as a child
 *    `omg` process, not in-process: the run gets the engine's own guard,
 *    lock, limits, forge config and signal handling exactly as if the user
 *    had typed it, and none of it leaks into the tick's read guard (which
 *    refuses `omg`, so a tick still cannot spawn). It never starts the
 *    listener chain, `heal run` or `heal approve`, and at most one run per
 *    tick. Its budget gate fails closed (defaultPollBudget). Design note: the
 *    working-tree `intake.source` / `limit` (and `check.*`) stay
 *    allowed, so a working-tree file steers which item an unattended start
 *    picks; check's rules still decide what is runnable, and the switch and
 *    the budget come only from the trusted layers.
 *
 * One poller per repository (the owner pid in the poll file, under its lock,
 * with a `beatAt` heartbeat each tick; an owner silent for 2 x the 60 min
 * ceiling is stale and taken over).
 * SIGINT / SIGTERM end the loop after the current tick. A rate-limited tick
 * (TF400733, HTTP 429) doubles the interval, up to 60 min; a clean tick
 * resets it. The interval floor is 2 min.
 *
 * Exit codes: 0 (a loop stopped by a signal, or a clean `--once` tick);
 * 1 a read failed in the `--once` tick, or another poller runs; 2 usage;
 * 5 incompatible (as `omg factory check`).
 */

import { spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, lstatSync } from 'fs';
import { join } from 'path';
import { ledgerPath, ledgerTotals, parseLedger } from '../budget/ledger.js';
import { atomicWriteFileSync, ensureDirSync } from '../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot, withWorktreePathRenderScope } from '../lib/worktree-paths.js';
import type { AzEntry } from '../forge/ado/az-binary.js';
import { ADO_RATE_LIMITED } from '../forge/ado/checks.js';
import { GITHUB_RATE_LIMITED } from '../forge/github/graphql.js';
import type { Forge, ForgeKind, ForgePr, ResolvedForgeConfig } from '../forge/types.js';
import { readBaseFile } from '../ship/config.js';
import { ShipSafetyError, type Exec } from '../ship/exec.js';
import { collectBoard, readRuns, type BoardRow, type BoardStage, type FactoryBoardDeps } from './board/collect.js';
import { backlogLine, runLine } from './board/render.js';
import { CheckUsageError, checkEnvFor, defaultResolveAz, openReadForge, type FactoryCheckDeps } from './check/cli.js';
import { checkItems, plainText } from './check/score.js';
import type { CheckBucket } from './check/rules.js';
import type { HealConfig } from './heal/config.js';
import { adoHealFor, ciDeps, HEAL_PIPELINE_MISSING, runHealScan, type AdoHeal, type ScanResult } from './heal/cli.js';
import { HealRunRefused } from './heal/run.js';
import { DEFAULT_FACTORY_RUN_LIMITS, resolveFactoryRunLimits, type FactoryRunLimits } from './run/budget.js';
import { FactoryForgeUnavailableError } from './run/forge-roots.js';
import { defaultLedgerDir } from './run/ledger.js';
import { tamperHoldMessage } from './run/tamper-quarantine.js';
import { visibleLine } from '../forge/review-feedback.js';
import { commandText, GROUP_TITLES, reminderCommand, type AttentionGroup } from './attention/actions.js';
import { collectAttention, missingRunKeys, readRegularFile, type AttentionData, type AttentionItem } from './attention/collect.js';
import { attentionCountNotice, attentionMoreNotice, attentionNotice, noticeGate, sendAttentionNotice, untilAborted, type AnyAttentionNotice, type AttentionNotice } from './attention/notify.js';
import { summaryLine } from './attention/render.js';
import { resumeCommand } from './run/engine.js';
import { resolveTeamConfig, TeamConfigError } from './team/context.js';
import { staleGateReminders, type Reminder } from './team/reminders.js';
import {
  AUTO_START_SCAN_WAIT_MS, acquireFactoryRepoOwnerForRun, acquireRunSlot, defaultOwnerDeps, heldSlots, EXIT_BUSY, FactoryBusyError, factoryRepoOwnerPath, ownerHolding, runLabel, TERMINAL_FACTORY_PHASES, tryScanLock, verifyFactoryIntegrity, type FactoryRunKey, type FactoryRunState, type HeldOwner, type OwnerDeps,
} from './run/state.js';
import { resolveParallelSettings } from './run/parallel.js';
import { resolveRunLayout, userParallelOptIn } from './run/private-run.js';
import { killProcessTree } from '../smoke/process-utils.js';

/**
 * B2: factory.run.maxConcurrent when it is above 1 and factory.run.layout is
 * "private" in the trusted layers (the user config, the base layer); else
 * undefined (one run at a time). An invalid value is reported and counts as 1.
 * Only with the user config's opt-in (userParallelOptIn, the CLI's rule,
 * review-487b F-1): keys committed only on the base start one run at a time.
 */
export function pollParallel(trustedUser: unknown, base: unknown, err: (m: string) => void): number | undefined {
  try {
    if (!userParallelOptIn(trustedUser)) return undefined;
    const s = resolveParallelSettings(trustedUser, base, err);
    return s.maxConcurrent > 1 && resolveRunLayout(trustedUser, base).layout === 'private' ? s.maxConcurrent : undefined;
  } catch (error) {
    err(`omg factory poll: ${message(error)}; the auto-start starts one run at a time`);
    return undefined;
  }
}

/** Bumped on any change to the `--json` tick shape (src/factory/__tests__/poll.test.ts pins it). */
export const POLL_JSON_SCHEMA_VERSION = 1;
export const POLL_DEFAULT_INTERVAL_MS = 5 * 60_000;
/** The floor: ADO allows 200 TSTU per sliding 5 minutes per user (design §2.3). */
export const POLL_MIN_INTERVAL_MS = 2 * 60_000;
/** The backoff ceiling. */
export const POLL_MAX_INTERVAL_MS = 60 * 60_000;
/** An owner whose last heartbeat is older than this is stale (a crashed poller on another host, or a reused pid). */
export const POLL_OWNER_STALE_MS = 2 * POLL_MAX_INTERVAL_MS;

export class PollBusyError extends Error {}

export const pollStatePath = (root: string): string => join(getOmcRoot(root), 'state', 'factory-poll.json');
export const pollAuditPath = (root: string): string => join(getOmcRoot(root), 'state', 'factory-poll-audit.jsonl');

/** `--interval`: `<n>s`, `<n>m` (also a bare number) or `<n>h`, at least 2 min. */
export function parseInterval(raw: string): number {
  const m = /^([1-9]\d{0,5})(s|m|h)?$/.exec(raw.trim());
  if (!m) throw new CheckUsageError(`--interval ${JSON.stringify(raw)} is not <n>s, <n>m or <n>h`);
  const ms = Number(m[1]) * (m[2] === 's' ? 1_000 : m[2] === 'h' ? 3_600_000 : 60_000);
  if (ms < POLL_MIN_INTERVAL_MS) throw new CheckUsageError(`--interval ${raw} is below the 2 min floor (Azure DevOps rate limits)`);
  if (ms > POLL_MAX_INTERVAL_MS) throw new CheckUsageError(`--interval ${raw} is above 60 min`);
  return ms;
}

/** The wait after a tick: doubled (up to 60 min) after a rate-limited tick, the configured interval after a clean one. */
export function nextInterval(current: number, base: number, rateLimited: boolean): number {
  return rateLimited ? Math.min(Math.max(current, base) * 2, POLL_MAX_INTERVAL_MS) : base;
}

/** The poll file: the owner (while a poller runs) and the ids the intake tick has seen. */
interface PollFile {
  pid?: number;
  hostname?: string;
  startedAt?: string;
  /** The owner's heartbeat, written each tick. */
  beatAt?: string;
  seen: number[];
  at?: string;
}

/** The poll file's size cap: the owner plus the intake ids seen; a larger file reads as corrupt. */
const POLL_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The poll file through the bounded regular-file read (no link, FIFO or directory is opened or followed): anything
 * but a readable regular JSON file reads as a missing or corrupt one does, no owner and nothing seen.
 */
function readPollFile(path: string): PollFile {
  const file = readRegularFile(path, POLL_FILE_MAX_BYTES);
  if (!('bytes' in file)) return { seen: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(file.bytes.toString('utf8'));
  } catch {
    return { seen: [] };
  }
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    // A pid without a hostname cannot be checked: no owner.
    ...(Number.isSafeInteger(f.pid) && typeof f.hostname === 'string' ? { pid: f.pid as number, hostname: f.hostname } : {}),
    ...(typeof f.startedAt === 'string' ? { startedAt: f.startedAt } : {}),
    ...(typeof f.beatAt === 'string' ? { beatAt: f.beatAt } : {}),
    seen: Array.isArray(f.seen) ? f.seen.filter((n): n is number => Number.isSafeInteger(n) && (n as number) > 0) : [],
    ...(typeof f.at === 'string' ? { at: f.at } : {}),
  };
}

const writePollFile = (path: string, f: PollFile): void => atomicWriteFileSync(path, `${JSON.stringify(f, null, 2)}\n`);

/** The poll file without its owner. */
const ownerless = (f: PollFile): PollFile => ({ seen: f.seen, ...(f.at ? { at: f.at } : {}) });

/** The owner's last heartbeat (its start before the first beat) is older than POLL_OWNER_STALE_MS, or unreadable. */
const stale = (f: PollFile, now: string): boolean => {
  const beat = Date.parse(f.beatAt ?? f.startedAt ?? '');
  return !Number.isFinite(beat) || Date.parse(now) - beat > POLL_OWNER_STALE_MS;
};

/** A live owner, or one on another host (its pid cannot be checked), holds the file. */
const heldBy = (f: { pid?: number; hostname?: string }, me: OwnerDeps): boolean =>
  f.pid !== undefined && (f.hostname !== me.hostname || (f.pid !== me.pid && me.isAlive(f.pid)));

/**
 * Claim the poller owner (the pid in the poll file, under its lock): a second
 * poller refuses; a dead one on this host is taken over.
 */
export function acquirePoller(root: string, now: string, me: OwnerDeps = defaultOwnerDeps()): { release: () => void } {
  const path = pollStatePath(root);
  ensureDirSync(join(path, '..'));
  withFileLockSync(lockPathFor(path), () => {
    const f = readPollFile(path);
    if (heldBy(f, me) && !stale(f, now)) {
      throw new PollBusyError(`omg factory poll already runs in this repository (pid ${f.pid} on ${f.hostname} since ${f.startedAt}, last beat ${f.beatAt ?? 'none'}); one poller per repository. If no poller runs, delete ${path}`);
    }
    writePollFile(path, { pid: me.pid, hostname: me.hostname, startedAt: now, beatAt: now, ...ownerless(f) });
  }, { timeoutMs: 5_000 });
  return {
    release: () => {
      try {
        withFileLockSync(lockPathFor(path), () => {
          const f = readPollFile(path);
          if (f.pid === me.pid && f.hostname === me.hostname) writePollFile(path, ownerless(f));
        }, { timeoutMs: 5_000 });
      } catch { /* the next poller takes a dead owner over */ }
    },
  };
}

function updateSeen(root: string, seen: readonly number[], at: string): void {
  const path = pollStatePath(root);
  withFileLockSync(lockPathFor(path), () => writePollFile(path, { ...readPollFile(path), seen: [...seen].sort((a, b) => a - b), at }), { timeoutMs: 5_000 });
}

/** The owner's heartbeat; false when another poller has taken the file over. */
function beat(root: string, me: OwnerDeps, at: string): boolean {
  const path = pollStatePath(root);
  return withFileLockSync(lockPathFor(path), () => {
    const f = readPollFile(path);
    if (f.pid !== me.pid || f.hostname !== me.hostname) return false;
    writePollFile(path, { ...f, beatAt: at });
    return true;
  }, { timeoutMs: 5_000 });
}

function audit(root: string, record: Record<string, unknown>, at: string): void {
  try {
    const path = pollAuditPath(root);
    ensureDirSync(join(path, '..'));
    // Never append through a link planted at the audit path.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    appendFileSync(path, `${JSON.stringify({ ...record, at })}\n`, 'utf8');
  } catch {
    // best-effort audit trail (as the listener's)
  }
}

/** Whether an engine holds the repository (factoryRepoOwnerPath), as acquireFactoryRepoOwner would see it (start identity included; an unreadable file is held). */
function engineBusy(root: string, me: OwnerDeps): boolean {
  return ownerHolding(factoryRepoOwnerPath(root), me) !== null;
}

/**
 * The checkout's engine lock for a tick step that fetches or moves refs (the
 * heal tick, the local base sync): a git fetch under a live engine would
 * read as lane tampering to it. A string: the step is skipped this tick (an
 * engine runs; or the lock could not be taken at all, which also goes to the
 * tick's `errors` as `<step>: ...`). Released before the auto-start, whose
 * child takes the lock itself, so the two never wait on each other.
 */
export function holdForRefs(root: string, at: string, me: OwnerDeps, label: 'heal' | 'base sync', errors: string[]): HeldOwner | string {
  let held: HeldOwner | FactoryBusyError;
  try {
    held = tryScanLock(root, at, me);
  } catch (error) {
    errors.push(`${label}: ${message(error)}`);
    return `skipped: the engine lock could not be taken (${message(error)})`;
  }
  return held instanceof FactoryBusyError ? `skipped: engine busy (${message(held)})` : held;
}

/** The heal tick's scan; a HealRunRefused skips the heal tick with its message. `forge`: the tick's forge config (Azure DevOps reads it; GitHub never does). */
export type PollHealScan = (o: { root: string; base: string; kind: ForgeKind; forge?: ResolvedForgeConfig; now: Date; warn: (m: string) => void }) => ScanResult;

/**
 * The production heal tick: `omg factory heal scan` (writing heal state, never
 * a lane) through the heal guard on the raw Exec. On Azure DevOps it is heal
 * scan's wiring (adoHealFor over the tick's forge config): factory.heal.pipeline's
 * reads under the `read` policy, GETs only.
 */
export function defaultPollHealScan(exec: Exec, config: (root: string) => { config: HealConfig; warnings: string[] }, ledgerDir: string, resolveAz: (root: string) => AzEntry = defaultResolveAz): PollHealScan {
  return (o) => {
    let ado: AdoHeal | undefined;
    if (o.kind === 'azure-devops') {
      if (!o.forge) throw new HealRunRefused(HEAL_PIPELINE_MISSING);
      ado = adoHealFor(o.forge, () => resolveAz(o.root), o.root);
    }
    const heal = config(o.root);
    for (const w of heal.warnings) o.warn(w);
    return runHealScan({ exec, root: o.root, base: o.base, config: heal.config, now: o.now, dryRun: false, warn: o.warn, ledgerDir, ...ciDeps({}, ado) });
  };
}

/**
 * The auto-start: run `omg factory run --next` to its end. `parsed` is false
 * when its stdout held no outcome (none, truncated, or not one of the run's
 * JSON documents); `next` is then null and means nothing. Otherwise `next` is
 * the item it took (null: none). Never rejects.
 */
/** `issue`: run that item (`omg factory run <issue>`) instead of `--next` (omg factory bench picks its own items). */
export type PollAutoStart = (o: { root: string; parallel?: number; issue?: number; args?: readonly string[] }) => Promise<{ exitCode: number; parsed: boolean; next: number | null; message: string }>;

/** Null when there is budget headroom for one more run; otherwise why not. */
export type PollBudget = (root: string) => string | null;

/** The child's JSON stdout is the run outcome (state included); more than this is not parsed. */
const AUTO_START_MAX_STDOUT = 4 * 1024 * 1024;

/** The run key of poll's claim on the repo owner lock: no item is picked yet (0 is never an issue number). */
const AUTO_START_CLAIM: FactoryRunKey = 0;

/** Slack on top of the run's own bounds, for its git and forge calls. */
const AUTO_START_SLACK_MS = 30 * 60_000;

/** SIGTERM to SIGKILL when the child outlives its wall-clock limit. */
const AUTO_START_GRACE_MS = 2 * 60_000;

/**
 * The child's wall-clock limit: maxRunWallTimeMs + laneTimeoutMs +
 * gatesTimeoutMs + 30 min. The engine checks maxRunWallTimeMs only at step
 * boundaries, so one invocation can overrun it by one step: a lane (its
 * laneTimeoutMs) or a gates phase (its gatesTimeoutMs). The 30 min cover the
 * git and forge calls around them. Defaults: 4 h + 30 min + 90 min + 30 min = 6.5 h.
 */
export function autoStartTimeoutMs(limits: FactoryRunLimits): number {
  return limits.maxRunWallTimeMs + limits.laneTimeoutMs + limits.gatesTimeoutMs + AUTO_START_SLACK_MS;
}

/**
 * Read `omg factory run --next --json`'s stdout: one of factoryRunJson's
 * documents (src/cli/commands/factory.ts), which all carry `message` or
 * `error`. Anything else is not parsed.
 */
export function parseRunNextOutcome(stdout: string): { parsed: boolean; next: number | null; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = undefined;
  }
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as { next?: unknown; message?: unknown; error?: unknown };
  const text = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : undefined;
  if (text === undefined) return { parsed: false, next: null, message: 'no outcome on stdout' };
  return { parsed: true, next: Number.isSafeInteger(o.next) && (o.next as number) > 0 ? o.next as number : null, message: text };
}

export interface PollAutoStartOptions {
  /** The child's wall-clock limit (default autoStartTimeoutMs of DEFAULT_FACTORY_RUN_LIMITS). */
  timeoutMs?: (root: string) => number;
  /** SIGTERM to SIGKILL after a timeout (default 2 min). */
  graceMs?: number;
  /** Subscribe to poll's stop signals, forwarded to the child; returns the unsubscribe. */
  signals?: (forward: (signal: NodeJS.Signals) => void) => () => void;
}

/**
 * The production auto-start: a child `omg factory run --next --json` (the
 * same node and CLI entry as this poller) in the repository root, stdin
 * closed, stderr shared (the run's progress shows), stdout parsed for the
 * outcome. Poll's stop signals are forwarded, so the run stops after its
 * current poll as when typed by hand. On POSIX the child runs in its own
 * process group, so a Ctrl+C reaches it once (forwarded by poll), not twice;
 * on Windows it shares the console, which delivers Ctrl+C itself, so only
 * SIGTERM is forwarded there. Past timeoutMs it gets SIGTERM, then SIGKILL
 * after graceMs; on POSIX both go to the whole process group, on Windows only
 * to the engine process (its lanes are not reached).
 */
export function defaultPollAutoStart(entry: string | undefined = process.argv[1], o: PollAutoStartOptions = {}): PollAutoStart {
  return ({ root, parallel, issue, args }) => new Promise((resolve) => {
    if (!entry) {
      resolve({ exitCode: 1, parsed: false, next: null, message: 'cannot locate the omg CLI entry to start omg factory run --next' });
      return;
    }
    const timeoutMs = o.timeoutMs?.(root) ?? autoStartTimeoutMs(DEFAULT_FACTORY_RUN_LIMITS);
    let stdout = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;
    let unsubscribe = (): void => {};
    const settle = (r: { exitCode: number; parsed: boolean; next: number | null; message: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      unsubscribe();
      resolve(r);
    };
    const notStarted = (error: unknown) => settle({ exitCode: 1, parsed: false, next: null, message: `omg factory run --next did not start: ${message(error)}` });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [entry, 'factory', 'run', ...(issue !== undefined ? [String(issue)] : ['--next']), '--json', ...(parallel !== undefined ? ['--parallel', String(parallel)] : []), ...(args ?? [])], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      notStarted(error);
      return;
    }
    // On POSIX the child leads its own process group: signal the group so its lane children die with it.
    const killTree = (sig: NodeJS.Signals): void => {
      if (process.platform === 'win32' || child.pid === undefined) { child.kill(sig); return; }
      try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (stdout.length + d.length <= AUTO_START_MAX_STDOUT) stdout += d;
      else truncated = true;
    });
    child.on('error', notStarted);
    child.on('close', (code, signal) => {
      const ended = signal ? ` (ended by ${signal})` : '';
      if (timedOut) {
        settle({ exitCode: code ?? 1, parsed: false, next: null, message: `omg factory run --next ran past its ${Math.round(timeoutMs / 60_000)} min limit and was stopped${ended}` });
        return;
      }
      const out = truncated ? { parsed: false, next: null, message: `the outcome on stdout exceeded ${AUTO_START_MAX_STDOUT} bytes` } : parseRunNextOutcome(stdout);
      settle({ exitCode: code ?? 1, ...out, message: out.parsed ? out.message : `${out.message}${ended}` });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killer = setTimeout(() => killTree('SIGKILL'), o.graceMs ?? AUTO_START_GRACE_MS);
    }, timeoutMs);
    unsubscribe = o.signals?.((signal) => {
      // SIGKILL (a supervisor's second Ctrl+C): the child's whole tree, synchronously (taskkill /T on Windows), before the caller exits.
      if (signal === 'SIGKILL') { killProcessTree(child.pid, spawnSync); return; }
      if (process.platform !== 'win32' || signal !== 'SIGINT') child.kill(signal);
    }) ?? unsubscribe;
  });
}

/** The config layers of the auto-start's budget gate (read once, at poll start). */
export interface PollBudgetLayers {
  /** The user config at its default location (trustedUser). */
  trustedUser: unknown;
  /** The base branch's committed `.copilot/omg.jsonc` (ReadForge.baseConfig). */
  base: unknown;
  /** The working-tree project config: it can only lower a limit. */
  project: unknown;
}

function softLimitOf(config: unknown, source: string): number | undefined {
  const raw = (config as { budget?: { softLimit?: unknown } } | null | undefined)?.budget?.softLimit;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw new Error(`${source}: budget.softLimit must be a positive number (got ${JSON.stringify(raw)})`);
  return raw;
}

/**
 * The production budget gate of an unattended start. It fails closed:
 * - the `factory.run` limits must resolve (`omg factory run` refuses without
 *   a valid per-lane AI-credit cap);
 * - the governor must be on (`OMC_BUDGET_GOVERNOR=0` means no auto-start);
 * - `budget.softLimit` comes from the user config, then the base branch (as
 *   factory.intake.autoStart); the working-tree layer can only lower it
 *   (resolveFactoryRunLimits' tighten-only rule). No trusted value, an
 *   invalid one, or an unreadable ledger blocks the start;
 * - the AI credits in the ledger must be below it (the governor only warns a
 *   human; an unattended start stops at it).
 * A human `omg factory run` never reads this gate.
 */
export function defaultPollBudget(layers: (root: string) => PollBudgetLayers, env: NodeJS.ProcessEnv = process.env): PollBudget {
  return (root) => {
    try {
      const l = layers(root);
      resolveFactoryRunLimits(l.trustedUser, l.project);
      if (env.OMC_BUDGET_GOVERNOR === '0') return 'the budget governor is off (OMC_BUDGET_GOVERNOR=0); autoStart needs it on';
      const trusted = softLimitOf(l.trustedUser, 'user config') ?? softLimitOf(l.base, 'base-branch .copilot/omg.jsonc');
      if (trusted === undefined) return 'autoStart needs budget.softLimit (user config or base branch)';
      const project = softLimitOf(l.project, 'project config');
      const limit = project !== undefined && project < trusted ? project : trusted;
      const path = ledgerPath(root);
      const { ledger, invalid } = parseLedger(path);
      if (invalid) return `the budget ledger is unreadable (${path}); autoStart needs it (omg budget status)`;
      const used = ledgerTotals(ledger).credits;
      return used >= limit ? `the AI credits used (${used.toFixed(2)}) reached budget.softLimit ${limit} (omg budget status)` : null;
    } catch (error) {
      return message(error);
    }
  };
}

export interface PollPr {
  id: FactoryRunKey;
  pr: number;
  state?: ForgePr['state'];
  /** Open human threads on the PR head (reviewFeedback; ADO listThreads as the fallback); absent when the forge reads none. */
  threads?: number;
  /** Authors whose review input was dropped as untrusted (reviewFeedback only). */
  ignored?: number;
  /** The forge's trust list was not read whole (ForgeReviewFeedback.trustIncomplete): a write-access reviewer may be among the ignored. */
  trustIncomplete?: true;
  /** For a PR a human completed or abandoned: the command that records it. */
  hint?: string;
  error?: string;
}

export interface PollTick {
  schemaVersion: number;
  tick: number;
  at: string;
  forge: ForgeKind;
  repo: string;
  heal: { ran: true; entries: number; recorded: number; queued: number } | { ran: false; reason: string };
  intake: { ran: true; items: number; new: Array<{ id: number; bucket: CheckBucket; reasons: string[] }> } | { ran: false; reason: string };
  /** The local forge: the base sync of the engine's mirror (ff-only) before the PR reads; absent on GitHub and Azure DevOps. */
  baseSync?: { ran: true; message: string } | { ran: false; reason: string };
  prs: PollPr[];
  /** Runs parked at a human gate past factory.poll.remindAfterHours (printed, never posted); absent when none is due. */
  reminders?: Reminder[];
  /**
   * `omg factory attention` items that are new since the previous tick (first tick: a one-line summary instead).
   * Engine-composed fields only: no title, reason or other text from a state. Absent when the step did not run.
   * `new` holds trusted items only (at most ATTENTION_PRINT_ITEMS, the rest counted in `more`); `unverified`: how many
   * rows are not trusted (counts only), when that count changed or such a row is new; `queued`: trusted notices waiting
   * for the rate limit; `dropped`: trusted item notices dropped because the queue was full (one count notice covers them).
   */
  attention?: { summary?: string; new: PollAttentionItem[]; more?: number; unverified?: number; queued?: number; dropped?: number };
  /** Board rows that changed since the previous tick (every row on the first). */
  board: Array<{ stage: BoardStage | 'outside'; row: BoardRow }>;
  /**
   * No engine owns the repository, no run is in flight (a parked run is not)
   * and every run state is readable: an auto-start could begin one. Advisory
   * only: it is read without the engine's repo owner lock, so a consumer must
   * still take that lock atomically (acquireFactoryRepoOwner) and treat a
   * refusal as "skip this tick".
   */
  idle: boolean;
  /** factory.intake.autoStart: why no run started, or the `omg factory run --next` it started (the item it took, null when nothing was runnable). */
  autoStart: { started: false; reason: string } | { started: true; parsed: boolean; next: number | null; exitCode: number; message: string };
  rateLimited: boolean;
  errors: string[];
  warnings: string[];
  /** The wait before the next tick (absent with --once). */
  nextIntervalMs?: number;
}

export interface PollContext {
  forge: Forge;
  config: ResolvedForgeConfig;
  root: string;
  base: string;
  exec: Exec;
  baseSha: string | null;
  heal: boolean;
  intake: boolean;
  prs: boolean;
  healScan: PollHealScan;
  autoStart: PollAutoStart;
  /** The local forge's base sync (FactoryPollDeps.localBaseSync), bound to the root and base. */
  localBaseSync?: () => string;
  budget: PollBudget;
  /** factory.poll.remindAfterHours; absent or 0 = no stale-gate reminders. */
  remindAfterHours?: number;
  owner: OwnerDeps;
  /** A `scan` lock whose release failed (it warned): retried at the next tick (L7). */
  unreleasedScan?: HeldOwner;
  /** The tamper hold on the checkout (tamper-quarantine.ts), null when none: no auto-start while it is set (default: the factory ledger's). */
  tamperHold?: () => string | null;
  /** Engine ledger directory (default defaultLedgerDir()): board rows and reminders of a state that fails the trust check show "not verified" only. */
  ledgerDir?: string;
  /**
   * B2: factory.run.maxConcurrent when it is above 1 with factory.run.layout
   * "private" (trusted layers): the auto-start runs `omg factory run --next
   * --parallel <n>` whenever a slot is free, also while other runs are in
   * flight. Absent: one run at a time, on an idle tick only (as before).
   */
  parallel?: number;
  now: () => number;
  /** Row signatures of the previous tick (board diff), and PR facts (audit on change); updated by pollTick. */
  previous: {
    board: Map<string, string>; prs: Map<string, string>; ledger?: boolean; attention?: Set<string>;
    /** Attention ids last seen, with the time (bounded, oldest evicted): a row that comes back within the quiet window is not new. */
    seen?: Map<string, number>;
    /** When this poll sent its recent trusted `factory-attention` notices (the rate limit). */
    notified?: number[];
    /** Trusted ids that got their own line, and trusted ids that got a notice (or the overflow's count notice): when (bounded). */
    printed?: Map<string, number>;
    notifiedIds?: Map<string, number>;
    /** Trusted item notices waiting for the rate limit, oldest first (at most ATTENTION_QUEUE_MAX, one per identity). */
    queue?: Array<{ id: string; key: string; notice: AttentionNotice }>;
    /** Trusted items whose notice did not fit the queue: one count notice for them when the rate limit allows. */
    overflow?: Array<{ id: string; key: string; group: AttentionGroup }>;
    /** The untrusted row count of the previous tick (its line is printed when it changes). */
    unverified?: number;
    /** An untrusted row appeared since the last untrusted count notice; when that notice went out (its own budget) and the count it carried. */
    countDue?: boolean;
    countNotifiedAt?: number;
    countNotified?: number;
    /** The first tick ran (its attention summary is the baseline, even when its collector failed). */
    baselined?: boolean;
    /** Notices started and not yet settled, abandoned ones included (bounded by ATTENTION_PENDING_MAX). */
    pending?: number;
  };
  tick: number;
  /** `omg factory attention`'s collector for this repository (local, read-only); absent: no attention step. */
  attention?: () => AttentionData;
  /**
   * Sends one `factory-attention` notification (it decides itself whether notifications are configured). `signal`
   * aborts when the tick's timeout passes: the send is abandoned then.
   */
  notifyAttention?: (n: AnyAttentionNotice, signal?: AbortSignal) => Promise<void>;
  /** The longest a tick waits for its notifications (default ATTENTION_NOTIFY_TIMEOUT_MS). */
  notifyTimeoutMs?: number;
}

/** Per tick: at most this many trusted notices sent (the rest wait in the queue); trusted item lines printed, then one "and K more" line. */
export const ATTENTION_NOTICE_ITEMS = 3;
export const ATTENTION_PRINT_ITEMS = 10;
/** At most this many trusted `factory-attention` notices per window for the repository; the rest wait in the queue. */
export const ATTENTION_RATE_MAX = 6;
export const ATTENTION_RATE_WINDOW_MS = 10 * 60_000;
/** Trusted notices waiting for the rate limit; past this, one count notice covers the overflow. */
export const ATTENTION_QUEUE_MAX = 100;
/** The untrusted rows' count notice: at most one per this window for the repository (its own budget). */
export const ATTENTION_COUNT_NOTICE_WINDOW_MS = 60 * 60_000;
/** A count above the last notified one (a new untrusted row) may send one more count notice per this window. */
export const ATTENTION_COUNT_RISE_MS = 10 * 60_000;
export const ATTENTION_NOTIFY_TIMEOUT_MS = 10_000;
/** Sends that may be in flight at once, abandoned ones included until they settle (a hung notifier stops here). */
export const ATTENTION_PENDING_MAX = 2 * (ATTENTION_NOTICE_ITEMS + 1);
/** How many attention ids the poll remembers; and how long a row that went away stays known without remindAfterHours. */
export const ATTENTION_SEEN_MAX = 10_000;
const ATTENTION_QUIET_DEFAULT_HOURS = 24;

/** One new attention item in a tick: the run key, group, the gate of a trusted row, and the first next command's argv. */
export interface PollAttentionItem {
  key: string;
  group: AttentionGroup;
  gate: string | null;
  next: string[] | null;
}

/**
 * What makes an attention item "the same" from tick to tick. A trusted row: the run, its group, its gate and park
 * time (all from the engine's own state). An untrusted row: its key only, as nothing else of it is the engine's (a
 * lane can rewrite the state's times and flip it between unreadable and unverified as often as it likes).
 */
/** Trusted: the engine's own state (seal and ledger). The `state-files` row stands for files nobody read: counted as untrusted. */
const trustedItem = (i: AttentionItem): boolean => i.trust === 'ok' && i.key !== 'state-files';
const attentionId = (i: AttentionItem): string => (trustedItem(i) ? JSON.stringify([i.key, i.group, 'ok', i.gate, i.at]) : JSON.stringify([i.key, 'untrusted']));

/** Mark ids seen at `now`, the most recent last; the oldest go once there are more than ATTENTION_SEEN_MAX. */
function markSeen(seen: Map<string, number>, ids: Iterable<string>, now: number): void {
  for (const id of ids) {
    seen.delete(id);
    seen.set(id, now);
  }
  for (const id of seen.keys()) {
    if (seen.size <= ATTENTION_SEEN_MAX) break;
    seen.delete(id);
  }
}

/**
 * Waits for every promise, at most `ms`; true when all settled in time. A notification never stalls the tick longer.
 * The timer stays referenced: a hung send that holds no handle must not let node exit in the middle of the tick.
 */
export async function settledWithin(ps: Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.allSettled(ps).then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

const message = (error: unknown): string => plainText(error instanceof Error ? error.message : String(error));

/** A resume re-parks a run whose branch rewrote decisions.md, so its reminder offers the cancel instead (the attention table's commands). */
const reminderHint = (key: FactoryRunKey, gate: string): string => reminderCommand(key, gate);

/**
 * One tick. Steps 1-4 never spawn and never write to the tracker or forge; a
 * guard refusal propagates (a bug, not an unreadable item). Step 5 is the
 * auto-start, outside the read guard.
 */
export async function pollTick(ctx: PollContext): Promise<PollTick> {
  const { forge, config, root } = ctx;
  const at = new Date(ctx.now()).toISOString();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (ctx.unreleasedScan?.release()) delete ctx.unreleasedScan;
  const step = <T>(name: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      // A guard refusal is a bug; an unusable forge (a refused local forge config) exits 5, like omg factory run.
      if (error instanceof ShipSafetyError || error instanceof FactoryForgeUnavailableError) throw error;
      errors.push(`${name}: ${message(error)}`);
      return undefined;
    }
  };
  ctx.tick += 1;
  if (step('heartbeat', () => beat(root, ctx.owner, at)) === false) warnings.push(`another poller owns ${pollStatePath(root)}; stop this one`);

  const ledgerNow = step('ledger', () => existsSync(ledgerPath(root)));
  if (ledgerNow !== undefined) {
    if (ctx.previous.ledger && !ledgerNow) warnings.push(`budget ledger ${ledgerPath(root)} disappeared; spend restarts at 0`);
    ctx.previous.ledger = ledgerNow;
  }

  // 1. heal
  let heal: PollTick['heal'];
  if (!ctx.heal) heal = { ran: false, reason: '--no-heal' };
  else if (!forge.capabilities.heal) heal = { ran: false, reason: forge.kind === 'azure-devops' ? HEAL_PIPELINE_MISSING : 'the forge has no heal capability' };
  else {
    const held = holdForRefs(root, at, ctx.owner, 'heal', errors);
    if (typeof held === 'string') heal = { ran: false, reason: held };
    else {
      try {
        const r = ctx.healScan({ root, base: ctx.base, kind: forge.kind, forge: config, now: new Date(ctx.now()), warn: (m) => warnings.push(plainText(m)) });
        heal = { ran: true, entries: r.entries.length, recorded: r.entries.filter((e) => e.recorded).length, queued: r.queued };
      } catch (error) {
        if (error instanceof ShipSafetyError) throw error;
        heal = { ran: false, reason: message(error) };
        if (!(error instanceof HealRunRefused)) errors.push(`heal: ${message(error)}`);
      } finally {
        if (!held.release()) ctx.unreleasedScan = held;
      }
    }
  }

  // 2. intake
  const source = config.intake.source;
  let ids: number[] = [];
  let intake: PollTick['intake'];
  if (!ctx.intake) intake = { ran: false, reason: '--no-intake' };
  else if (!source) intake = { ran: false, reason: 'no intake source (factory.intake.source)' };
  else {
    const listed = step('intake', () => forge.tracker.queryItems(source, config.intake.limit));
    if (!listed) intake = { ran: false, reason: 'the intake query failed' };
    else {
      ids = listed;
      const seen = new Set(readPollFile(pollStatePath(root)).seen);
      const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
      const results = fresh.length ? step('intake check', () => checkItems(forge, fresh, checkEnvFor(ctx.exec, root, config, ctx.base, ctx.baseSha))) : [];
      // A failed check marks nothing seen: the next tick checks every new id again.
      if (!results) intake = { ran: false, reason: 'the intake check failed' };
      else {
        for (const r of results) {
          audit(root, { kind: 'intake-new', id: r.id, bucket: r.bucket, reasons: r.reasons }, at);
          if (r.reasons[0] === 'read-failed') errors.push(`intake: ${r.detail}`);
        }
        // A read-failed item stays new, so the next tick checks it again.
        const failed = new Set(results.filter((r) => r.reasons[0] === 'read-failed').map((r) => r.id));
        // F53: an item a run is already on is not new work (a first tick, with an empty seen file, would list it).
        // It is not marked seen either, so it shows as new once the run is reset or moved aside.
        const active = new Set(results.filter((r) => (r.reasons[0] ?? '').startsWith('run-active')).map((r) => r.id));
        step('intake seen', () => updateSeen(root, ids.filter((id) => !failed.has(id) && !active.has(id)), at));
        const work = results.filter((r) => !active.has(r.id));
        intake = { ran: true, items: ids.length, new: work.map((r) => ({ id: r.id, bucket: r.bucket, reasons: r.reasons })) };
      }
    }
  }

  // 2b. the local forge: sync the mirror base first, so a PR the human merged on <base> reads as MERGED below.
  let baseSync: PollTick['baseSync'];
  if (forge.kind === 'local') {
    if (!ctx.localBaseSync) baseSync = { ran: false, reason: 'no base sync wired; omg factory run syncs the mirror base' };
    else {
      const held = holdForRefs(root, at, ctx.owner, 'base sync', errors);
      if (typeof held === 'string') baseSync = { ran: false, reason: held };
      else {
        let synced: string | undefined;
        try {
          synced = step('base sync', ctx.localBaseSync);
        } finally {
          if (!held.release()) ctx.unreleasedScan = held;
        }
        baseSync = synced === undefined ? { ran: false, reason: 'the base sync failed' } : { ran: true, message: plainText(synced) };
      }
    }
  }

  // 3. PRs (and the idle seam): the runs in flight.
  const ledgerDir = ctx.ledgerDir ?? defaultLedgerDir();
  // Capped as attention's collector (every ledger-recorded run, then at most MAX_UNRECORDED_STATES other files): a
  // lane's flood of state files cannot slow the tick's PR step, reminders or idle check.
  // One render scope (the state root resolved once, not once per file). A read that throws fails closed: no runs, and
  // the tick is unsound (never idle), so the poll loop goes on.
  const read = step('run states', () => withWorktreePathRenderScope(() => readRuns(root, warnings, ledgerDir)));
  const { runs, broken, untrusted, unverified, omitted } = read ?? { runs: new Map<FactoryRunKey, FactoryRunState>(), broken: new Set<FactoryRunKey>(), untrusted: new Set<FactoryRunKey>(), unverified: new Set<FactoryRunKey>(), omitted: 0 };
  const live = [...runs].filter(([, s]) => !TERMINAL_FACTORY_PHASES.includes(s.phase));
  const prs: PollPr[] = [];
  if (ctx.prs) {
    for (const [key, s] of live) {
      // An untrusted state's PR number is not the engine's: no forge read and no line from it.
      if (s.pr === undefined || untrusted.has(key)) continue;
      const pr = s.pr;
      const row: PollPr = { id: key, pr };
      const view = step(`PR ${pr}`, () => forge.reviews.viewPr(pr));
      if (!view) row.error = errors[errors.length - 1];
      else {
        row.state = view.state;
        if (view.state !== 'OPEN') row.hint = resumeCommand(key);
        else if (forge.reviews.reviewFeedback) {
          const feedback = step(`PR ${pr} review feedback`, () => forge.reviews.reviewFeedback!(pr, view.headRefOid));
          if (feedback) {
            row.threads = feedback.threads.length;
            row.ignored = feedback.ignored.length;
            if (feedback.trustIncomplete === true) row.trustIncomplete = true;
          } else row.error = errors[errors.length - 1];
        } else if (forge.reviews.listThreads) {
          const threads = step(`PR ${pr} threads`, () => forge.reviews.listThreads!(pr));
          if (threads) row.threads = threads.filter((t) => (t.status === 'active' || t.status === 'pending') && t.kind === 'text' && !t.byFactory).length;
          else row.error = errors[errors.length - 1];
        }
      }
      const facts = JSON.stringify([row.state, row.threads, row.ignored, row.trustIncomplete]);
      if (row.state !== undefined && ctx.previous.prs.get(runLabel(key)) !== facts) {
        if (row.state !== 'OPEN') audit(root, { kind: 'pr-done', id: key, pr, state: row.state, hint: row.hint }, at);
        else if (row.threads !== undefined) audit(root, { kind: 'pr-threads', id: key, pr, active: row.threads, ...(row.ignored !== undefined ? { ignored: row.ignored } : {}), ...(row.trustIncomplete ? { trustIncomplete: true } : {}) }, at);
        ctx.previous.prs.set(runLabel(key), facts);
      }
      prs.push(row);
    }
  }
  const sharedEngine = engineBusy(root, ctx.owner);
  // B2: idle means no shared engine AND no parallel slot held (a private-layout run holds a slot, not the engine lock).
  const slots = heldSlots(root, ctx.owner).length;
  const locked = sharedEngine || slots > 0;
  // A run state that may hide a real run in flight or parked: never idle. Unreadable, failing its seal, not the bytes
  // the engine ledger records, or missing while the ledger records an unfinished run: `damaged`. Sealed but unknown to
  // this host's ledger: `unverifiedLive` unless its phase is terminal. A real run's key is in the ledger, so replacing
  // its state is a ledger mismatch (damaged); a sealed terminal state the ledger has no record of is old history from
  // another host or checkout (or a new key a lane made up), not a run, and does not block (as before the trust check).
  const missing = step('missing states', () => missingRunKeys(root, ledgerDir));
  const damaged = read === undefined || broken.size > 0 || missing === undefined || missing.length > 0 || [...runs.values()].some((s) => !verifyFactoryIntegrity(s))
    || [...untrusted].some((k) => !unverified.has(k));
  // State files left unread (past the cap) are unknown to the ledger as well: they block as unverified unfinished ones.
  const unverifiedLive = omitted > 0 || [...unverified].some((k) => !TERMINAL_FACTORY_PHASES.includes(runs.get(k)!.phase));
  const unsound = damaged || unverifiedLive;
  const idle = !locked && !unsound && !live.some(([, s]) => !s.gate);

  // 3b. stale-gate reminders: read-only on git (the base commit's routing file), printed only.
  // Skipped when the run states could not be read this tick: an empty run set would rewrite the record as {} and
  // re-remind every parked run on the next tick.
  const reminders = read === undefined ? undefined : step('reminders', () => staleGateReminders({ root, ledgerDir, runs, untrusted, nowMs: ctx.now(), afterHours: ctx.remindAfterHours, ...(ctx.baseSha ? { readBase: (path) => readBaseFile(ctx.exec, root, ctx.baseSha!, path) ?? undefined } : {}), warn: (m) => warnings.push(plainText(m)) }));

  // 3c. attention: the items that are new since the previous tick (local state only, read-only). The reminder path
  // owns a park that is still waiting after remindAfterHours; this path owns a park when it first appears.
  let attention: PollTick['attention'];
  if (ctx.attention) {
    // Only the poll's first tick is the baseline: a collector that failed on the first ticks must not turn a later
    // tick into one (its summary would swallow a park that appeared meanwhile).
    const baseline = ctx.previous.baselined !== true;
    ctx.previous.baselined = true;
    const d = step('attention', ctx.attention);
    if (d) {
      const before = ctx.previous.attention ?? new Set<string>();
      const ids = d.items.map(attentionId);
      ctx.previous.attention = new Set(ids);
      const seen = (ctx.previous.seen ??= new Map());
      const nowMs = ctx.now();
      const quietMs = (ctx.remindAfterHours && ctx.remindAfterHours > 0 ? ctx.remindAfterHours : ATTENTION_QUIET_DEFAULT_HOURS) * 3_600_000;
      const prev = ctx.previous;
      const unverified = d.items.filter((i) => !trustedItem(i)).length;
      // Trusted rows are announced once per identity: an id stays announced (printed, notified) while it is listed and
      // for the quiet window after it went away. Only ids that really got a line or a notice count: a trusted id that
      // was listed but never announced (past the per-tick cap, queued, or hidden by a lane for a tick) is still due.
      const rows = d.items.map((i, n) => ({ i, id: ids[n] }));
      const trustedRows = rows.filter(({ i }) => trustedItem(i));
      const printedIds = (prev.printed ??= new Map());
      const notifiedIds = (prev.notifiedIds ??= new Map());
      const recent = (m: Map<string, number>, id: string): boolean => {
        const t = m.get(id);
        return t !== undefined && t <= nowMs && nowMs - t < quietMs;
      };
      for (const m of [printedIds, notifiedIds]) markSeen(m, trustedRows.map((r) => r.id).filter((id) => recent(m, id)), nowMs);
      if (baseline) {
        attention = { summary: summaryLine(d), new: [] };
        // The first tick's summary stands for what is listed at the start: none of it gets its own line or notice.
        markSeen(printedIds, trustedRows.map((r) => r.id), nowMs);
        markSeen(notifiedIds, trustedRows.map((r) => r.id), nowMs);
      } else {
        // A stale-gate reminder in this tick stands for the item's line, never its notice, and only when the trusted
        // state's own park time (sealed, ledger-matched gate.at) is a reminder window old: the reminders record is
        // lane-writable, so a reminder of a younger park must not take the park's first line.
        const windowMs = (ctx.remindAfterHours ?? 0) * 3_600_000;
        const reminded = new Map<string, number>();
        for (const r of reminders ?? []) {
          const s = 'verified' in r || untrusted.has(r.run) ? undefined : runs.get(r.run);
          const parked = s?.gate ? Date.parse(s.gate.at) : Number.NaN;
          if (windowMs > 0 && Number.isFinite(parked) && nowMs - parked >= windowMs) reminded.set(runLabel(r.run), parked);
        }
        markSeen(printedIds, trustedRows.filter(({ i }) => reminded.get(i.key) === i.at).map((r) => r.id), nowMs);
        const lineDue = trustedRows.filter(({ id }) => !recent(printedIds, id));
        // A lane can write any number of untrusted rows (and they sort first): they are only ever counted, so they can
        // never delay or crowd out a trusted item's line or notice. New: not in the previous tick nor within the quiet window.
        const untrustedNew = rows.filter(({ i, id }) => {
          const last = seen.get(id);
          return !trustedItem(i) && !before.has(id) && (last === undefined || nowMs - last >= quietMs);
        }).length;
        // At most ATTENTION_PRINT_ITEMS lines a tick; the rest stay due and get their lines on the next ticks.
        const printed = lineDue.slice(0, ATTENTION_PRINT_ITEMS);
        markSeen(printedIds, printed.map((r) => r.id), nowMs);
        attention = {
          new: printed.map(({ i }) => ({ key: i.key, group: i.group, gate: noticeGate(i), next: i.next[0]?.argv ?? null })),
          ...(lineDue.length > printed.length ? { more: lineDue.length - printed.length } : {}),
          ...(unverified > 0 && (unverified !== prev.unverified || untrustedNew > 0) ? { unverified } : {}),
        };
        if (ctx.notifyAttention) {
          // Trusted notices wait in the queue (oldest first, one per identity) until the rate limit lets them out. A
          // waiting notice goes only when its run is no longer listed or its trusted row changed (the new row is due on
          // its own); while the run's row is not trusted it keeps waiting and is not sent.
          const trustedId = new Map(trustedRows.map(({ i, id }) => [i.key, id]));
          const listed = new Set(d.items.map((i) => i.key));
          const waits = (q: { id: string; key: string }): boolean => listed.has(q.key) && (trustedId.get(q.key) ?? q.id) === q.id;
          const sendable = (q: { id: string; key: string }): boolean => trustedId.get(q.key) === q.id;
          const queue = (prev.queue ?? []).filter(waits);
          const overflow = (prev.overflow ?? []).filter(waits);
          const waiting = new Set([...queue, ...overflow].map((q) => q.id));
          let dropped = 0;
          for (const { i, id } of trustedRows) {
            if (waiting.has(id) || recent(notifiedIds, id)) continue;
            const notice = attentionNotice(root, i);
            if (!notice) continue;
            if (queue.length >= ATTENTION_QUEUE_MAX) { overflow.push({ id, key: i.key, group: i.group }); dropped += 1; } else queue.push({ id, key: i.key, notice });
            waiting.add(id);
          }
          const sent = (prev.notified ?? []).filter((t) => nowMs - t < ATTENTION_RATE_WINDOW_MS && t <= nowMs);
          const pending = prev.pending ?? 0;
          const room = pending >= ATTENTION_PENDING_MAX ? 0 : Math.max(0, Math.min(ATTENTION_NOTICE_ITEMS, ATTENTION_RATE_MAX - sent.length));
          const batch: AnyAttentionNotice[] = [];
          const announced: string[] = [];
          // The overflow's one count notice goes first: the queue ahead of it can take hours to drain.
          const ready = overflow.filter(sendable);
          if (ready.length > 0 && room > 0) {
            batch.push(attentionMoreNotice(root, ready.map(({ group }) => ({ group }))));
            announced.push(...ready.map((q) => q.id));
          }
          const take = new Set(queue.filter(sendable).slice(0, Math.max(0, room - batch.length)));
          for (const q of take) batch.push(q.notice);
          announced.push(...[...take].map((q) => q.id));
          markSeen(notifiedIds, announced, nowMs);
          const left = new Set(announced);
          prev.notified = [...sent, ...batch.map(() => nowMs)];
          prev.queue = queue.filter((q) => !left.has(q.id));
          prev.overflow = overflow.filter((q) => !left.has(q.id));
          if (prev.queue.length + prev.overflow.length > 0) attention.queued = prev.queue.length + prev.overflow.length;
          if (dropped > 0) attention.dropped = dropped;
          if (pending >= ATTENTION_PENDING_MAX) warnings.push(`attention: ${pending} notification(s) are still in flight; no more are sent until they settle`);
          // Untrusted rows: one count notice per ATTENTION_COUNT_NOTICE_WINDOW_MS, its own budget, never the trusted
          // one's; a count that rose above the last notified one may go out once per ATTENTION_COUNT_RISE_MS.
          if (untrustedNew > 0) prev.countDue = true;
          if (unverified === 0) prev.countDue = false;
          // The last notified count is a high-water mark for the hourly window: a count that drops and comes back
          // (alternating rows) is no rise.
          const last = prev.countNotifiedAt;
          const since = last === undefined || last > nowMs ? Infinity : nowMs - last;
          const due = since >= ATTENTION_COUNT_NOTICE_WINDOW_MS || (unverified > (prev.countNotified ?? 0) && since >= ATTENTION_COUNT_RISE_MS);
          if (prev.countDue && pending < ATTENTION_PENDING_MAX && due) {
            batch.push(attentionCountNotice(root, unverified));
            prev.countDue = false;
            prev.countNotifiedAt = nowMs;
            prev.countNotified = unverified;
          }
          const notify = ctx.notifyAttention;
          const timeoutMs = ctx.notifyTimeoutMs ?? ATTENTION_NOTIFY_TIMEOUT_MS;
          if (batch.length > 0) {
            // A send past the timeout is aborted (the signal) and no longer waited for; it counts as pending until it
            // really settles, so a notifier that ignores the signal cannot pile up calls past ATTENTION_PENDING_MAX.
            const abort = new AbortController();
            prev.pending = (prev.pending ?? 0) + batch.length;
            const sends = batch.map((n) => untilAborted(Promise.resolve().then(() => notify(n, abort.signal)).catch(() => undefined)
              .finally(() => { prev.pending = Math.max(0, (prev.pending ?? 1) - 1); }), abort.signal));
            if (!(await settledWithin(sends, timeoutMs))) {
              abort.abort();
              warnings.push(`attention: the notifications did not finish within ${Math.round(timeoutMs / 1000)} s; the poll goes on`);
            }
          }
        }
      }
      prev.unverified = unverified;
      markSeen(seen, ids, nowMs);
    }
  }

  // 4. board: the rows that changed.
  const board: PollTick['board'] = [];
  const shown = step('board', () => collectBoard({ forge, config, root, ids, check: null, now: ctx.now(), warnings, ledgerDir }));
  if (shown) {
    const rows = [...shown.columns.flatMap((c) => c.items.map((row) => ({ stage: c.stage as BoardStage | 'outside', row }))), ...shown.outside.map((row) => ({ stage: 'outside' as const, row }))];
    const next = new Map<string, string>();
    for (const r of rows) {
      const sig = JSON.stringify(r);
      next.set(runLabel(r.row.id), sig);
      if (ctx.previous.board.get(runLabel(r.row.id)) !== sig) board.push(r);
    }
    ctx.previous.board = next;
  }

  const rateLimited = [...errors, ...warnings].some((m) => ADO_RATE_LIMITED.test(m) || GITHUB_RATE_LIMITED.test(m));

  // 5. auto-start: at most one run, on an idle tick only; B2 (ctx.parallel): `--next --parallel <n>` while a slot is free.
  let autoStart: PollTick['autoStart'];
  const par = ctx.parallel !== undefined && ctx.parallel > 1 ? ctx.parallel : undefined;
  const held = config.intake.autoStart ? (ctx.tamperHold ?? (() => tamperHoldMessage(defaultLedgerDir(), root)))() : null;
  const blocked = !config.intake.autoStart ? 'factory.intake.autoStart is off'
    : held ? held
    : par !== undefined && sharedEngine ? 'the run lock is held: a shared-layout engine runs in this repository'
    : par !== undefined && slots >= par ? `all ${par} parallel slots are held (factory.run.maxConcurrent ${par})`
    : par === undefined && locked ? 'the run lock is held: an engine runs in this repository'
      : damaged ? 'a run state is damaged or missing: omg factory attention'
        : unverifiedLive ? 'a run state is not verified on this host: omg factory attention'
          : par === undefined && !idle ? 'a run is in flight'
            : !intake.ran ? `no intake read this tick (${intake.reason})`
              : rateLimited ? 'the tick was rate-limited'
                : null;
  if (blocked) autoStart = { started: false, reason: blocked };
  else {
    let reason = ctx.budget(root);
    // The poller's own unreleased `scan` hold would be waited on for nothing: skip this tick's auto-start.
    if (!reason && ctx.unreleasedScan) reason = 'skipped: scan lock not released yet';
    if (!reason) {
      // `idle` is advisory: claim the engine's repo owner lock atomically (as an engine would); a refusal skips this
      // tick. It is released for the child, whose own claim at start is the binding one: an engine that slips in
      // between makes that claim refuse, so two engines never run.
      try {
        // B2: a parallel auto-start probes for a free slot the same way (taken and released; the children take their own).
        if (par !== undefined) acquireRunSlot(root, 'next', par, () => at, ctx.owner, AUTO_START_SCAN_WAIT_MS).release();
        else acquireFactoryRepoOwnerForRun(root, AUTO_START_CLAIM, () => at, ctx.owner, AUTO_START_SCAN_WAIT_MS).release();
      } catch (error) {
        reason = `the run lock is held: ${message(error)}`;
      }
    }
    if (reason) autoStart = { started: false, reason: plainText(reason) };
    else {
      audit(root, { kind: 'auto-start', ...(par !== undefined ? { parallel: par - slots } : {}) }, at);
      const r = await ctx.autoStart({ root, ...(par !== undefined ? { parallel: par - slots } : {}) });
      audit(root, { kind: 'auto-start-done', ...(r.parsed ? { next: r.next } : { outcome: 'unreadable' }), exitCode: r.exitCode }, new Date(ctx.now()).toISOString());
      autoStart = { started: true, parsed: r.parsed, next: r.parsed ? r.next : null, exitCode: r.exitCode, message: plainText(r.message) };
    }
  }

  return {
    schemaVersion: POLL_JSON_SCHEMA_VERSION, tick: ctx.tick, at, forge: config.kind, repo: config.repo.url,
    heal, intake, ...(baseSync ? { baseSync } : {}), prs, ...(reminders && reminders.length > 0 ? { reminders } : {}), ...(attention ? { attention } : {}), board, idle, autoStart, rateLimited, errors: errors.map(plainText), warnings: warnings.map(plainText),
  };
}

export function renderTick(t: PollTick): string {
  const prefix = t.forge === 'azure-devops' ? '!' : '#';
  const lines = [`factory poll  tick ${t.tick}  ${t.at}  ${t.forge} ${t.repo}${t.idle ? '  idle' : ''}${t.nextIntervalMs ? `  next in ${Math.round(t.nextIntervalMs / 60_000)} min` : ''}${t.rateLimited ? '  rate-limited: backing off' : ''}`];
  if (t.heal.ran && t.heal.entries > 0) lines.push(`  heal: ${t.heal.entries} run(s) scanned, ${t.heal.recorded} recorded${t.heal.queued ? `, ${t.heal.queued} queued` : ''} (omg factory heal status)`);
  if (t.intake.ran) for (const n of t.intake.new) lines.push(`  intake: new #${n.id} ${n.bucket}${n.reasons[0] ? ` ${n.reasons[0]}` : ''}`);
  if (t.baseSync) lines.push(`  base sync: ${t.baseSync.ran ? t.baseSync.message : `not run (${t.baseSync.reason})`}`);
  for (const p of t.prs) {
    if (p.hint) lines.push(`  PR ${prefix}${p.pr} of ${runLabel(p.id)} is ${p.state === 'MERGED' ? 'merged' : 'closed'} by a human: run \`${p.hint}\` to record it`);
    else if (p.threads || p.ignored || p.trustIncomplete) {
      const trust = p.trustIncomplete ? '; trust incomplete: the collaborator list was not read whole, so list reviewers in factory.review.trustedReviewers' : '';
      lines.push(`  PR ${prefix}${p.pr} of ${runLabel(p.id)}: ${p.threads ?? 0} human thread(s)${p.ignored ? ` (${p.ignored} ignored)` : ''}${trust}`);
    }
  }
  if (t.attention?.summary) lines.push(`  attention: ${t.attention.summary} (omg factory attention)`);
  for (const a of t.attention?.new ?? []) {
    const c = a.next ? commandText(a.next) : null;
    lines.push(`  attention: ${a.key} needs you: ${GROUP_TITLES[a.group].toLowerCase()}${a.gate ? ` at ${a.gate}` : ''}${c ? `; next: ${c.inRoot ? 'in the repository root, ' : ''}${c.line}` : ''}`);
  }
  if (t.attention?.more) lines.push(`  attention: and ${t.attention.more} more new item(s) need you (omg factory attention)`);
  if (t.attention?.unverified) lines.push(`  attention: ${t.attention.unverified} unverified or damaged state file(s) need inspection: omg factory attention`);
  if (t.attention?.queued) lines.push(`  attention: ${t.attention.queued} notification(s) queued: at most ${ATTENTION_RATE_MAX} per ${ATTENTION_RATE_WINDOW_MS / 60_000} min for this repository`);
  if (t.attention?.dropped) lines.push(`  attention: ${t.attention.dropped} notification(s) not sent: more than ${ATTENTION_QUEUE_MAX} were queued; one count notice covers them`);
  for (const r of t.reminders ?? []) lines.push('verified' in r ? `  reminder: ${runLabel(r.run)} is parked, not verified (${r.next})` : `  reminder: ${runLabel(r.run)} has waited ${r.hours} h at ${visibleLine(r.gate)}${r.handles.length ? ` ${r.handles.join(' ')}` : ''}: ${r.reason} (${reminderHint(r.run, r.gate)})`);
  // F33: a run whose PR a human already merged or closed shows the record step, not its stale gate reason (a merge command).
  const done = new Map(t.prs.filter((p) => p.hint).map((p) => [runLabel(p.id), p]));
  for (const b of t.board) {
    const p = done.get(runLabel(b.row.id));
    const gate = b.row.run?.gate;
    const row = p && gate ? { ...b.row, run: { ...b.row.run!, gate: { name: gate.name, reason: `the PR is ${p.state === 'MERGED' ? 'merged' : 'closed'}: run \`${p.hint}\` to record it` } } } : b.row;
    lines.push(`  ${b.stage.toUpperCase()}${b.stage === 'backlog' ? backlogLine(row) : runLine(row, prefix)}`);
  }
  if (t.autoStart.started) {
    const a = t.autoStart;
    const took = a.exitCode === EXIT_BUSY ? 'was busy (another engine holds this checkout or the item; retried next tick)'
      : !a.parsed ? 'outcome unreadable' : a.next !== null ? `took #${a.next}` : a.exitCode === 0 ? 'found nothing runnable' : 'took no item';
    lines.push(`  auto-start: omg factory run --next ${took}, exit ${a.exitCode}: ${a.message}`);
  }
  return lines.join('\n');
}

export interface FactoryPollOptions {
  interval?: string;
  once?: boolean;
  /** false with --no-heal / --no-intake / --no-prs. */
  heal?: boolean;
  intake?: boolean;
  prs?: boolean;
  json?: boolean;
}

/** board's deps plus the heal tick, the owner identity, the wait and the stop signals. */
export type FactoryPollDeps = FactoryBoardDeps & {
  healScan: PollHealScan;
  /**
   * The local forge: sync the engine's mirror base from the local `<base>` (fast-forward only) once per tick, so a PR the
   * human merged reads as MERGED. Returns what it did; throws when it refuses (a divergence). The engine owns the mirror,
   * so the CLI wires the engine's helper here; without it the tick reports the sync as not run.
   */
  localBaseSync?: (o: { root: string; base: string; config: ResolvedForgeConfig }) => string;
  /** factory.intake.autoStart's start (default defaultPollAutoStart) and budget gate (default defaultPollBudget over trustedUser, the base layer and projectConfig, read at start). */
  autoStart?: PollAutoStart;
  budget?: PollBudget;
  owner?: OwnerDeps;
  /** The factory ledger dir its tamper holds are read from (default defaultLedgerDir()). */
  ledgerDir?: string;
  /** Waits `ms` or until `wake` aborts. */
  sleep?: (ms: number, wake: AbortSignal) => Promise<void>;
  /** Subscribe to the stop signals (default SIGINT and SIGTERM, passed to the handler); returns the unsubscribe. */
  onStop?: (handler: (signal?: NodeJS.Signals) => void) => () => void;
  /** The `factory-attention` notification of new attention items (default: the notification stack, off unless configured). */
  notifyAttention?: (n: AnyAttentionNotice, signal?: AbortSignal) => Promise<void>;
  /** The longest a tick waits for its attention notifications (default ATTENTION_NOTIFY_TIMEOUT_MS; tests). */
  notifyTimeoutMs?: number;
};

const defaultSleep = (ms: number, wake: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (wake.aborted) { resolve(); return; }
  const timer = setTimeout(resolve, ms);
  wake.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

const defaultOnStop = (handler: (signal?: NodeJS.Signals) => void): (() => void) => {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
};

/** Run the poller until a stop signal (or one tick with --once); returns the exit code. */
export async function runFactoryPoll(o: FactoryPollOptions, deps: FactoryPollDeps): Promise<number> {
  const base = o.interval === undefined ? POLL_DEFAULT_INTERVAL_MS : parseInterval(o.interval);
  const now = deps.now ?? Date.now;
  const warnings: string[] = [];
  const checkDeps: FactoryCheckDeps = { ...deps, isTTY: () => false, confirm: async () => false };
  const read = openReadForge({}, checkDeps, warnings, 'omg factory poll');
  for (const w of warnings) deps.err(plainText(w));
  const owner = deps.owner ?? defaultOwnerDeps();
  // The budget gate's layers and the child's limits, read once like the rest of the config.
  const layers: PollBudgetLayers = { trustedUser: deps.trustedUser(), base: read.baseConfig, project: deps.projectConfig(read.root) };
  const runLimits = (): FactoryRunLimits => {
    try {
      return resolveFactoryRunLimits(layers.trustedUser, layers.project).limits;
    } catch {
      return DEFAULT_FACTORY_RUN_LIMITS; // the budget gate refuses the start first
    }
  };
  let teamConfig;
  try {
    teamConfig = resolveTeamConfig([layers.trustedUser, layers.base]);
  } catch (error) {
    if (error instanceof TeamConfigError) throw new CheckUsageError(error.message);
    throw error;
  }
  const { release } = acquirePoller(read.root, new Date(now()).toISOString(), owner);

  let stopping = 0;
  const wake = new AbortController();
  // An auto-started run in flight gets every stop signal too (defaultPollAutoStart), the second before the exit.
  const forwards = new Set<(signal: NodeJS.Signals) => void>();
  const off = (deps.onStop ?? defaultOnStop)((signal = 'SIGTERM') => {
    stopping += 1;
    for (const forward of forwards) forward(signal);
    if (stopping > 1) process.exit(130);
    deps.err('omg factory poll: stopping after the current tick; press again to exit at once');
    wake.abort();
  });
  const ctx: PollContext = {
    forge: read.forge, config: read.config, root: read.root, base: read.base, exec: read.exec, baseSha: read.baseSha,
    heal: o.heal !== false, intake: o.intake !== false, prs: o.prs !== false,
    healScan: deps.healScan,
    ...(deps.localBaseSync && read.config.kind === 'local' ? { localBaseSync: () => deps.localBaseSync!({ root: read.root, base: read.base, config: read.config }) } : {}),
    autoStart: deps.autoStart ?? defaultPollAutoStart(process.argv[1], {
      timeoutMs: () => autoStartTimeoutMs(runLimits()),
      signals: (forward) => { forwards.add(forward); return () => { forwards.delete(forward); }; },
    }),
    budget: deps.budget ?? defaultPollBudget(() => layers),
    remindAfterHours: teamConfig.remindAfterHours,
    tamperHold: () => tamperHoldMessage(deps.ledgerDir ?? defaultLedgerDir(), read.root),
    ...(deps.ledgerDir !== undefined ? { ledgerDir: deps.ledgerDir } : {}),
    ...((): { parallel?: number } => { const n = pollParallel(layers.trustedUser, layers.base, (m) => deps.err(plainText(m))); return n !== undefined ? { parallel: n } : {}; })(),
    attention: () => collectAttention(read.root, { ledgerDir: deps.ledgerDir ?? defaultLedgerDir(), owner, now }),
    notifyAttention: deps.notifyAttention ?? ((n, signal) => sendAttentionNotice(n, undefined, signal)),
    ...(deps.notifyTimeoutMs !== undefined ? { notifyTimeoutMs: deps.notifyTimeoutMs } : {}),
    owner, now, previous: { board: new Map(), prs: new Map() }, tick: 0,
  };
  let interval = base;
  try {
    for (;;) {
      const t = await pollTick(ctx);
      if (!o.once) {
        interval = nextInterval(interval, base, t.rateLimited);
        t.nextIntervalMs = interval;
      }
      if (o.json) deps.out(JSON.stringify(t));
      else {
        for (const w of t.warnings) deps.err(visibleLine(w));
        for (const e of t.errors) deps.err(`omg factory poll: ${visibleLine(e)}`);
        deps.out(renderTick(t));
      }
      if (o.once) return t.errors.length ? 1 : 0;
      if (stopping) return 0;
      await (deps.sleep ?? defaultSleep)(interval, wake.signal);
      if (stopping) return 0;
    }
  } finally {
    off();
    release();
  }
}
