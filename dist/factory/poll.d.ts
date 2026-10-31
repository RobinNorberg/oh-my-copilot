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
 *    prints the resume hint; open human review threads are counted (ADO).
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
import type { AzEntry } from '../forge/ado/az-binary.js';
import type { Forge, ForgeKind, ForgePr, ResolvedForgeConfig } from '../forge/types.js';
import { type Exec } from '../ship/exec.js';
import { type BoardRow, type BoardStage, type FactoryBoardDeps } from './board/collect.js';
import type { CheckBucket } from './check/rules.js';
import type { HealConfig } from './heal/config.js';
import { type ScanResult } from './heal/cli.js';
import { type FactoryRunLimits } from './run/budget.js';
import { type FactoryRunKey, type OwnerDeps } from './run/state.js';
/** Bumped on any change to the `--json` tick shape (src/factory/__tests__/poll.test.ts pins it). */
export declare const POLL_JSON_SCHEMA_VERSION = 1;
export declare const POLL_DEFAULT_INTERVAL_MS: number;
/** The floor: ADO allows 200 TSTU per sliding 5 minutes per user (design §2.3). */
export declare const POLL_MIN_INTERVAL_MS: number;
/** The backoff ceiling. */
export declare const POLL_MAX_INTERVAL_MS: number;
/** An owner whose last heartbeat is older than this is stale (a crashed poller on another host, or a reused pid). */
export declare const POLL_OWNER_STALE_MS: number;
export declare class PollBusyError extends Error {
}
export declare const pollStatePath: (root: string) => string;
export declare const pollAuditPath: (root: string) => string;
/** `--interval`: `<n>s`, `<n>m` (also a bare number) or `<n>h`, at least 2 min. */
export declare function parseInterval(raw: string): number;
/** The wait after a tick: doubled (up to 60 min) after a rate-limited tick, the configured interval after a clean one. */
export declare function nextInterval(current: number, base: number, rateLimited: boolean): number;
/**
 * Claim the poller owner (the pid in the poll file, under its lock): a second
 * poller refuses; a dead one on this host is taken over.
 */
export declare function acquirePoller(root: string, now: string, me?: OwnerDeps): {
    release: () => void;
};
/** The heal tick's scan; a HealRunRefused skips the heal tick with its message. `forge`: the tick's forge config (Azure DevOps reads it; GitHub never does). */
export type PollHealScan = (o: {
    root: string;
    base: string;
    kind: ForgeKind;
    forge?: ResolvedForgeConfig;
    now: Date;
    warn: (m: string) => void;
}) => ScanResult;
/**
 * The production heal tick: `omg factory heal scan` (writing heal state, never
 * a lane) through the heal guard on the raw Exec. On Azure DevOps it is heal
 * scan's wiring (adoHealFor over the tick's forge config): factory.heal.pipeline's
 * reads under the `read` policy, GETs only.
 */
export declare function defaultPollHealScan(exec: Exec, config: (root: string) => {
    config: HealConfig;
    warnings: string[];
}, ledgerDir: string, resolveAz?: (root: string) => AzEntry): PollHealScan;
/**
 * The auto-start: run `omg factory run --next` to its end. `parsed` is false
 * when its stdout held no outcome (none, truncated, or not one of the run's
 * JSON documents); `next` is then null and means nothing. Otherwise `next` is
 * the item it took (null: none). Never rejects.
 */
export type PollAutoStart = (o: {
    root: string;
}) => Promise<{
    exitCode: number;
    parsed: boolean;
    next: number | null;
    message: string;
}>;
/** Null when there is budget headroom for one more run; otherwise why not. */
export type PollBudget = (root: string) => string | null;
/**
 * The child's wall-clock limit: maxRunWallTimeMs + laneTimeoutMs +
 * gatesTimeoutMs + 30 min. The engine checks maxRunWallTimeMs only at step
 * boundaries, so one invocation can overrun it by one step: a lane (its
 * laneTimeoutMs) or a gates phase (its gatesTimeoutMs). The 30 min cover the
 * git and forge calls around them. Defaults: 4 h + 30 min + 90 min + 30 min = 6.5 h.
 */
export declare function autoStartTimeoutMs(limits: FactoryRunLimits): number;
/**
 * Read `omg factory run --next --json`'s stdout: one of factoryRunJson's
 * documents (src/cli/commands/factory.ts), which all carry `message` or
 * `error`. Anything else is not parsed.
 */
export declare function parseRunNextOutcome(stdout: string): {
    parsed: boolean;
    next: number | null;
    message: string;
};
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
export declare function defaultPollAutoStart(entry?: string | undefined, o?: PollAutoStartOptions): PollAutoStart;
/** The config layers of the auto-start's budget gate (read once, at poll start). */
export interface PollBudgetLayers {
    /** The user config at its default location (trustedUser). */
    trustedUser: unknown;
    /** The base branch's committed `.copilot/omg.jsonc` (ReadForge.baseConfig). */
    base: unknown;
    /** The working-tree project config: it can only lower a limit. */
    project: unknown;
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
export declare function defaultPollBudget(layers: (root: string) => PollBudgetLayers, env?: NodeJS.ProcessEnv): PollBudget;
export interface PollPr {
    id: FactoryRunKey;
    pr: number;
    state?: ForgePr['state'];
    /** Active or pending text threads the factory did not post (ADO; absent where the forge has no listThreads). */
    threads?: number;
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
    heal: {
        ran: true;
        entries: number;
        recorded: number;
        queued: number;
    } | {
        ran: false;
        reason: string;
    };
    intake: {
        ran: true;
        items: number;
        new: Array<{
            id: number;
            bucket: CheckBucket;
            reasons: string[];
        }>;
    } | {
        ran: false;
        reason: string;
    };
    prs: PollPr[];
    /** Board rows that changed since the previous tick (every row on the first). */
    board: Array<{
        stage: BoardStage | 'outside';
        row: BoardRow;
    }>;
    /**
     * No engine owns the repository, no run is in flight (a parked run is not)
     * and every run state is readable: an auto-start could begin one. Advisory
     * only: it is read without the engine's repo owner lock, so a consumer must
     * still take that lock atomically (acquireFactoryRepoOwner) and treat a
     * refusal as "skip this tick".
     */
    idle: boolean;
    /** factory.intake.autoStart: why no run started, or the `omg factory run --next` it started (the item it took, null when nothing was runnable). */
    autoStart: {
        started: false;
        reason: string;
    } | {
        started: true;
        parsed: boolean;
        next: number | null;
        exitCode: number;
        message: string;
    };
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
    budget: PollBudget;
    owner: OwnerDeps;
    now: () => number;
    /** Row signatures of the previous tick (board diff), and PR facts (audit on change); updated by pollTick. */
    previous: {
        board: Map<string, string>;
        prs: Map<string, string>;
        ledger?: boolean;
    };
    tick: number;
}
/**
 * One tick. Steps 1-4 never spawn and never write to the tracker or forge; a
 * guard refusal propagates (a bug, not an unreadable item). Step 5 is the
 * auto-start, outside the read guard.
 */
export declare function pollTick(ctx: PollContext): Promise<PollTick>;
export declare function renderTick(t: PollTick): string;
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
    /** factory.intake.autoStart's start (default defaultPollAutoStart) and budget gate (default defaultPollBudget over trustedUser, the base layer and projectConfig, read at start). */
    autoStart?: PollAutoStart;
    budget?: PollBudget;
    owner?: OwnerDeps;
    /** Waits `ms` or until `wake` aborts. */
    sleep?: (ms: number, wake: AbortSignal) => Promise<void>;
    /** Subscribe to the stop signals (default SIGINT and SIGTERM, passed to the handler); returns the unsubscribe. */
    onStop?: (handler: (signal?: NodeJS.Signals) => void) => () => void;
};
/** Run the poller until a stop signal (or one tick with --once); returns the exit code. */
export declare function runFactoryPoll(o: FactoryPollOptions, deps: FactoryPollDeps): Promise<number>;
//# sourceMappingURL=poll.d.ts.map