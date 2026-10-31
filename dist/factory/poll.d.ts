/**
 * `omg factory poll [--interval 5m] [--once] [--no-heal] [--no-intake] [--no-prs] [--json]`
 * (ADO parity design §2): a foreground polling loop, forge-neutral (GitHub
 * and Azure DevOps). It replaces webhooks where there is no public endpoint.
 * One tick, in this order:
 *
 * 1. heal: `runHealScan` (classify new red CI runs into heal state), only
 *    when `forge.capabilities.heal`; never `heal run` or `heal approve`.
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
 * state only: the poll file, its audit and heal state. The tick result says
 * whether the repository was idle (no engine owner, no run in flight).
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
 *    tick.
 *
 * One poller per repository (the owner pid in the poll file, under its lock).
 * SIGINT / SIGTERM end the loop after the current tick. A rate-limited tick
 * (TF400733, HTTP 429) doubles the interval, up to 60 min; a clean tick
 * resets it. The interval floor is 2 min.
 *
 * Exit codes: 0 (a loop stopped by a signal, or a clean `--once` tick);
 * 1 a read failed in the `--once` tick, or another poller runs; 2 usage;
 * 5 incompatible (as `omg factory check`).
 */
import type { Forge, ForgeKind, ForgePr, ResolvedForgeConfig } from '../forge/types.js';
import { type Exec } from '../ship/exec.js';
import { type BoardRow, type BoardStage, type FactoryBoardDeps } from './board/collect.js';
import type { CheckBucket } from './check/rules.js';
import type { HealConfig } from './heal/config.js';
import { type ScanResult } from './heal/cli.js';
import { type FactoryRunKey, type OwnerDeps } from './run/state.js';
/** Bumped on any change to the `--json` tick shape (src/factory/__tests__/poll.test.ts pins it). */
export declare const POLL_JSON_SCHEMA_VERSION = 1;
export declare const POLL_DEFAULT_INTERVAL_MS: number;
/** The floor: ADO allows 200 TSTU per sliding 5 minutes per user (design §2.3). */
export declare const POLL_MIN_INTERVAL_MS: number;
/** The backoff ceiling. */
export declare const POLL_MAX_INTERVAL_MS: number;
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
/** The heal tick's scan; a HealRunRefused skips the heal tick with its message. */
export type PollHealScan = (o: {
    root: string;
    base: string;
    kind: ForgeKind;
    now: Date;
    warn: (m: string) => void;
}) => ScanResult;
/**
 * The production heal tick: `omg factory heal scan` (writing heal state, never
 * a lane) through the heal guard on the raw Exec. On Azure DevOps the scan is
 * refused until heal runs there.
 */
export declare function defaultPollHealScan(exec: Exec, config: (root: string) => {
    config: HealConfig;
    warnings: string[];
}, ledgerDir: string): PollHealScan;
/** The auto-start: run `omg factory run --next` to its end; `next` is the item it took (null: nothing runnable). Never rejects. */
export type PollAutoStart = (o: {
    root: string;
}) => Promise<{
    exitCode: number;
    next: number | null;
    message: string;
}>;
/** Null when there is budget headroom for one more run; otherwise why not. */
export type PollBudget = (root: string) => string | null;
/**
 * The production auto-start: a child `omg factory run --next --json` (the
 * same node and CLI entry as this poller) in the repository root, stdin
 * closed, stderr shared (the run's progress shows), stdout parsed for the
 * outcome. A signal to the console reaches the run too, which stops after
 * its current poll as when typed by hand.
 */
export declare function defaultPollAutoStart(entry?: string | undefined): PollAutoStart;
/**
 * The production budget check, reusing the factory's and the governor's own:
 * the `factory.run` limits must resolve (`omg factory run` refuses without a
 * valid per-lane AI-credit cap), and the AI credits used must be below
 * `budget.softLimit` when one is set (the only period budget; the governor
 * only warns a human, but an unattended start stops at it).
 */
export declare function defaultPollBudget(limits: (root: string) => unknown): PollBudget;
export interface PollPr {
    id: FactoryRunKey;
    pr: number;
    state?: ForgePr['state'];
    /** Open review threads a person started (ADO; absent where the forge has no listThreads). */
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
    /** No engine owns the repository and no run is in flight (a parked run is not): an auto-start could begin one. */
    idle: boolean;
    /** factory.intake.autoStart: why no run started, or the `omg factory run --next` it started (the item it took, null when nothing was runnable). */
    autoStart: {
        started: false;
        reason: string;
    } | {
        started: true;
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
    /** factory.intake.autoStart's start (default defaultPollAutoStart) and budget check (default defaultPollBudget over the `factory.run` limits of trustedUser and projectConfig). */
    autoStart?: PollAutoStart;
    budget?: PollBudget;
    owner?: OwnerDeps;
    /** Waits `ms` or until `wake` aborts. */
    sleep?: (ms: number, wake: AbortSignal) => Promise<void>;
    /** Subscribe to the stop signals (default SIGINT and SIGTERM); returns the unsubscribe. */
    onStop?: (handler: () => void) => () => void;
};
/** Run the poller until a stop signal (or one tick with --once); returns the exit code. */
export declare function runFactoryPoll(o: FactoryPollOptions, deps: FactoryPollDeps): Promise<number>;
//# sourceMappingURL=poll.d.ts.map