/**
 * Parallel private-layout runs in one checkout (item 2 lane B2; design i23
 * 5/8): the factory.run.maxConcurrent / maxInFlightCredits settings, the
 * per-repository credit reservation of in-flight lanes, and the
 * `omg factory run --next --parallel N` supervisor. The slots and the
 * repository import lock are owner records in state.ts (its LOCK ORDER
 * comment is the one rule every holder follows).
 *
 * Parallelism exists only for private-layout runs: each run is its own
 * engine process with its own private repository; lanes, prepare and gates
 * run in parallel, while every git transport into or out of the user's
 * repository (base fetches, the seed fetch, import + push, the local forge's
 * mirror sync) is serialised by the import lock. With maxConcurrent 1 (the
 * default) or the shared layout nothing here is used.
 */
import { type Exec } from '../../ship/exec.js';
import { type FactoryOwner, type OwnerDeps } from './state.js';
/** The park of a parallel engine whose layout resolved to shared at the sealed base (before any lane). */
export declare const PARALLEL_LAYOUT_GATE = "parallel-needs-private";
/** The highest factory.run.maxConcurrent accepted (each run is a process with its own private clone). */
export declare const MAX_CONCURRENT_LIMIT = 16;
export interface ParallelSettings {
    /** factory.run.maxConcurrent: 1 (default) = one engine per checkout, exactly as before. */
    maxConcurrent: number;
    /** factory.run.maxInFlightCredits when set (default: laneMaxCredits x maxConcurrent, i.e. no limit of its own). */
    maxInFlightCredits?: number;
    /** Where maxConcurrent came from (`default`, `user config`, `the base .copilot/omg.jsonc`). */
    source: string;
}
/**
 * factory.run.maxConcurrent and maxInFlightCredits from the trusted layers
 * only: the user config, then the `.copilot/omg.jsonc` committed on a
 * trusted base (the caller passes undefined for an untrusted base). An
 * invalid user value throws; an invalid base value is warned about and
 * counts as unset (review-483 MEDIUM-1's rule for the base layer).
 */
export declare function resolveParallelSettings(user: unknown, base: unknown, warn?: (m: string) => void): ParallelSettings;
/** Why more than one concurrent run is refused for this layout, or null. */
export declare function parallelLayoutRefusal(settings: ParallelSettings, layout: 'shared' | 'private'): string | null;
/**
 * The `.copilot/omg.jsonc` committed at the base's local tracking ref (no
 * fetch: the lock is not held yet), read only when the base is in
 * ship.trustedBases of the user config; undefined when untrusted, absent or
 * unreadable (warned). The engine reads the layout again at the sealed base.
 */
export declare function readTrustedBaseLayerAtRef(exec: Exec, root: string, base: string, ref: string, user: unknown, warn?: (m: string) => void): unknown;
/** One in-flight lane's reserved cap; the holder is the engine process (identity checked like an owner file). */
export interface CreditReservation extends FactoryOwner {
    /** The lane id. */
    id: string;
    cap: number;
}
/** `<ledgerDir>/credits/<repo8>.json`: one file per repository (claimRepoKey), shared by every checkout and clone of it. */
export declare function creditReservationPath(ledgerDir: string, repo8: string): string;
export type CreditDecision = {
    ok: true;
    settle: (credits: number) => void;
} | {
    ok: false;
    reason: string;
    inFlight: number;
    wait: boolean;
};
/**
 * Reserve `cap` credits for lane `id` under the file's own short lock: the
 * live reservations (holder identity checked; dead holders dropped and the
 * file rewritten without them) plus `cap` must stay within `limit`. Refused:
 * `wait` says whether a live reservation ending can make room (else the cap
 * alone is over the limit). `settle` drops the reservation after the lane:
 * a lane that ended is no longer in flight (its measured credits are the
 * lane's own record). A crashed engine's reservations go with its process.
 */
export declare function reserveLaneCredits(o: {
    ledgerDir: string;
    repo8: string;
    id: string;
    run: string;
    cap: number;
    limit: number;
    now: string;
    deps: OwnerDeps;
    warn?: (m: string) => void;
}): CreditDecision;
/** The live reservations (read-only; for status). Throws on an unreadable file. */
export declare function liveCreditReservations(ledgerDir: string, repo8: string, deps: OwnerDeps): CreditReservation[];
/**
 * `omg factory run release`: drop the reservations whose holder is dead; an
 * unreadable file is removed (its holders cannot be told). Live ones stay.
 * Returns what was freed, as text.
 */
export declare function releaseDeadCreditReservations(ledgerDir: string, repo8: string, deps: OwnerDeps): {
    freed: string[];
    kept: string[];
};
/** One child `omg factory run --next --json` as the supervisor sees it end. */
export interface ParallelChildOutcome {
    exitCode: number;
    parsed: boolean;
    next: number | null;
    message: string;
}
export interface ParallelSupervisorOptions {
    /** How many children at most at once (min(--parallel, maxConcurrent)). */
    n: number;
    /** Start one child `omg factory run --next --json`; resolves when it ends (never rejects). */
    spawn: () => Promise<ParallelChildOutcome>;
    /** Subscribe to the supervisor's stop signal (Ctrl+C / SIGTERM); returns the unsubscribe. The children get it from spawn's own forwarding. */
    onStop: (stop: () => void) => () => void;
    /** One line per ended child (the text output). */
    report?: (index: number, outcome: ParallelChildOutcome) => void;
}
export interface ParallelSupervisorResult {
    exitCode: number;
    interrupted: boolean;
    children: Array<ParallelChildOutcome & {
        index: number;
    }>;
}
/**
 * Run up to `n` children at once: a child that exits with a code other than
 * busy (EXIT_BUSY: no free slot, the item or checkout held) gets its slot
 * refilled; a child that found nothing runnable (exit 0, no item) stops the
 * refills; a stop signal stops the refills and waits for the running
 * children (spawn forwards the signal to them). Exit code: 130 when
 * stopped, else 1 when a child failed (exit 1), else the highest other
 * child code, else 0.
 */
export declare function runParallelSupervisor(o: ParallelSupervisorOptions): Promise<ParallelSupervisorResult>;
//# sourceMappingURL=parallel.d.ts.map