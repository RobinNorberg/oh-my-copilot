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
 *    trust, gate, park time), with its first next command; an item that
 *    gets a stale-gate reminder (3b) in the same tick is printed by the
 *    reminder only. Only trusted items get a line and an item notice
 *    (queued past the per-tick cap and rate limit); rows whose state is not
 *    trusted are only counted (one line when the count changes, one count
 *    notice per hour), so a lane cannot crowd out a trusted item. The
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
import type { AzEntry } from '../forge/ado/az-binary.js';
import type { Forge, ForgeKind, ForgePr, ResolvedForgeConfig } from '../forge/types.js';
import { type Exec } from '../ship/exec.js';
import { type BoardRow, type BoardStage, type FactoryBoardDeps } from './board/collect.js';
import type { CheckBucket } from './check/rules.js';
import type { HealConfig } from './heal/config.js';
import { type ScanResult } from './heal/cli.js';
import { type FactoryRunLimits } from './run/budget.js';
import { type AttentionGroup } from './attention/actions.js';
import { type AttentionData } from './attention/collect.js';
import { type AnyAttentionNotice, type AttentionNotice } from './attention/notify.js';
import { type Reminder } from './team/reminders.js';
import { type FactoryRunKey, type HeldOwner, type OwnerDeps } from './run/state.js';
/**
 * B2: factory.run.maxConcurrent when it is above 1 and factory.run.layout is
 * "private" in the trusted layers (the user config, the base layer); else
 * undefined (one run at a time). An invalid value is reported and counts as 1.
 * Only with the user config's opt-in (userParallelOptIn, the CLI's rule,
 * review-487b F-1): keys committed only on the base start one run at a time.
 */
export declare function pollParallel(trustedUser: unknown, base: unknown, err: (m: string) => void): number | undefined;
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
/**
 * The checkout's engine lock for a tick step that fetches or moves refs (the
 * heal tick, the local base sync): a git fetch under a live engine would
 * read as lane tampering to it. A string: the step is skipped this tick (an
 * engine runs; or the lock could not be taken at all, which also goes to the
 * tick's `errors` as `<step>: ...`). Released before the auto-start, whose
 * child takes the lock itself, so the two never wait on each other.
 */
export declare function holdForRefs(root: string, at: string, me: OwnerDeps, label: 'heal' | 'base sync', errors: string[]): HeldOwner | string;
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
/** `issue`: run that item (`omg factory run <issue>`) instead of `--next` (omg factory bench picks its own items). */
export type PollAutoStart = (o: {
    root: string;
    parallel?: number;
    issue?: number;
    args?: readonly string[];
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
    /** The local forge: the base sync of the engine's mirror (ff-only) before the PR reads; absent on GitHub and Azure DevOps. */
    baseSync?: {
        ran: true;
        message: string;
    } | {
        ran: false;
        reason: string;
    };
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
    attention?: {
        summary?: string;
        new: PollAttentionItem[];
        more?: number;
        unverified?: number;
        queued?: number;
        dropped?: number;
    };
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
        board: Map<string, string>;
        prs: Map<string, string>;
        ledger?: boolean;
        attention?: Set<string>;
        /** Attention ids last seen, with the time (bounded, oldest evicted): a row that comes back within the quiet window is not new. */
        seen?: Map<string, number>;
        /** When this poll sent its recent trusted `factory-attention` notices (the rate limit). */
        notified?: number[];
        /** Trusted item notices waiting for the rate limit, oldest first (at most ATTENTION_QUEUE_MAX, one per identity). */
        queue?: Array<{
            id: string;
            notice: AttentionNotice;
        }>;
        /** The groups of trusted items whose notice did not fit the queue: one count notice when the rate limit allows. */
        overflow?: AttentionGroup[];
        /** The untrusted row count of the previous tick (its line is printed when it changes). */
        unverified?: number;
        /** An untrusted row appeared since the last untrusted count notice; when that notice went out (its own budget). */
        countDue?: boolean;
        countNotifiedAt?: number;
        /** Notices started and not yet settled or abandoned (bounded by ATTENTION_PENDING_MAX). */
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
export declare const ATTENTION_NOTICE_ITEMS = 3;
export declare const ATTENTION_PRINT_ITEMS = 10;
/** At most this many trusted `factory-attention` notices per window for the repository; the rest wait in the queue. */
export declare const ATTENTION_RATE_MAX = 6;
export declare const ATTENTION_RATE_WINDOW_MS: number;
/** Trusted notices waiting for the rate limit; past this, one count notice covers the overflow. */
export declare const ATTENTION_QUEUE_MAX = 100;
/** The untrusted rows' count notice: at most one per this window for the repository (its own budget). */
export declare const ATTENTION_COUNT_NOTICE_WINDOW_MS: number;
export declare const ATTENTION_NOTIFY_TIMEOUT_MS = 10000;
/** Sends that may be in flight at once (a tick's timeout abandons its sends, so this is a backstop). */
export declare const ATTENTION_PENDING_MAX: number;
/** How many attention ids the poll remembers; and how long a row that went away stays known without remindAfterHours. */
export declare const ATTENTION_SEEN_MAX = 10000;
/** One new attention item in a tick: the run key, group, the gate of a trusted row, and the first next command's argv. */
export interface PollAttentionItem {
    key: string;
    group: AttentionGroup;
    gate: string | null;
    next: string[] | null;
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
    /**
     * The local forge: sync the engine's mirror base from the local `<base>` (fast-forward only) once per tick, so a PR the
     * human merged reads as MERGED. Returns what it did; throws when it refuses (a divergence). The engine owns the mirror,
     * so the CLI wires the engine's helper here; without it the tick reports the sync as not run.
     */
    localBaseSync?: (o: {
        root: string;
        base: string;
        config: ResolvedForgeConfig;
    }) => string;
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
/** Run the poller until a stop signal (or one tick with --once); returns the exit code. */
export declare function runFactoryPoll(o: FactoryPollOptions, deps: FactoryPollDeps): Promise<number>;
//# sourceMappingURL=poll.d.ts.map