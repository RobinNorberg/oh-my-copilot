/**
 * `omg factory heal run <sig8>` (design §5, §7): run the debugger lane for a
 * queued, lane-eligible signature, record its diagnosis, and park. A valid
 * diagnosis parks at `awaiting-human: heal-approve`; anything else parks at
 * `awaiting-human: heal-diagnosis`. Implementing the fix is a later change;
 * nothing here writes a tracked file, pushes, or calls a GitHub write.
 *
 * Limits, checked under the scan lock before the lane starts and recorded
 * write-ahead (a crash counts the lane at its full cap):
 * - one open heal run (MAX_OPEN_HEAL_RUNS), `factory.heal.dailyRuns` heal
 *   runs and `factory.heal.dailyDebugLanes` lanes per UTC day;
 * - the lane's cap `factory.heal.debugLaneMaxCredits` (mandatory, at least
 *   the CLI floor), `factory.heal.maxRunCredits` per heal run and
 *   `factory.heal.dailyCredits` per UTC day. The daily spend is the larger of
 *   the heal counters and the `factory-lane:heal-*` records of the budget
 *   ledger.
 *
 * The counters and a seal of the recorded heal run are mirrored outside the
 * repository (the factory ledger directory), because a lane's shell can reach
 * `.omg/`: the larger counter wins, and `heal status` reports a seal mismatch.
 * The class and classification come only from the scan-time record there; an
 * open heal run reuses the subject it was sealed with.
 */
import type { AdoGuardContext } from '../../forge/ado/guard.js';
import type { ForgeCi } from '../../forge/types.js';
import type { Exec } from '../../ship/exec.js';
import type { LaneBackend } from '../run/lane.js';
import { type HealClass, type HealClassification } from './classify.js';
import type { HealConfig } from './config.js';
import { type LaneConfinement } from './debug-lane.js';
import { type HealDailyCounters, type HealDiagnosisRecord, type HealLaneRecord, type HealNext, type HealSignatureState } from './state.js';
/** Wall time of one debugger lane. */
export declare const DEBUG_LANE_TIMEOUT_MS: number;
export declare const EXIT_HEAL_PARKED = 4;
export declare const EXIT_HEAL_REFUSED = 3;
/** Ledger keys of heal lanes (`factory-lane:<laneId>`, lane ids start `heal-`). */
export declare const HEAL_LEDGER_PREFIX = "factory-lane:heal-";
export declare class HealRunRefused extends Error {
}
export interface HealRunDeps {
    exec: Exec;
    lanes: (root: string) => LaneBackend;
    /** Out-of-repository directory for the mirrored counters, the seals and the engine's empty hooks dir. */
    ledgerDir: string;
    now: () => Date;
    clock?: () => number;
    pollMs?: number;
    confinement?: LaneConfinement;
    /** Test seam: the per-run fence delimiter. */
    delimiter?: () => string;
    /** Read for {@link HEAL_UNCONFINED_ENV} (default process.env). */
    env?: NodeJS.ProcessEnv;
    /** Where the unconfined-lane warning goes (default console.error). */
    warn?: (message: string) => void;
    /** Builds the forge's CI reads over the heal-guarded exec for the evidence (default GitHub Actions). */
    ci?: (exec: Exec, root: string) => ForgeCi;
    /** That forge's Azure DevOps guard context (adoHeal in cli.ts); without it every az call is refused. */
    ado?: () => AdoGuardContext;
}
/**
 * The owner's opt-in to a debugger lane without OS confinement. The lane's
 * shell can run repository code at the red sha (`npx vitest run`), so a
 * non-dry-run `heal run` refuses unless a confinement other than `none` is
 * set or this is `1`.
 */
export declare const HEAL_UNCONFINED_ENV = "OMG_HEAL_UNCONFINED";
export interface HealRunOptions {
    root: string;
    base: string;
    sig8: string;
    config: HealConfig;
    dryRun: boolean;
    lockTimeoutMs?: number;
}
export interface HealRunOutcome {
    sig8: string;
    exitCode: number;
    next: HealNext;
    message: string;
    bundleDir: string;
    /** Dry run only. */
    prompt?: string;
    lane?: HealLaneRecord;
    diagnosis?: HealDiagnosisRecord;
}
/**
 * The classifier fields a ci-heal run is built from, as the debugger lane was
 * given them. A later scan may rewrite the record's classification and a
 * lane's shell can reach `.omg/`, so they are kept in the out-of-repo seal
 * file and never read from the record.
 */
export interface HealSealSubject {
    class: HealClass;
    /** Whether the signature was seen on a dev push run or only on pull request runs. */
    source: 'push' | 'pr';
    firstRed: {
        runId: string;
        sha: string;
    };
    lastGreen?: {
        runId: string;
        sha: string;
    };
    /** `file > title` of the failing tests the classifier parsed. */
    failingTests: string[];
    env: Array<{
        field: string;
        green?: string;
        red?: string;
    }>;
}
export declare const healTestId: (t: {
    file: string;
    title?: string;
}) => string;
export declare function healSealSubject(cls: HealClass, c: HealClassification, source: 'push' | 'pr'): HealSealSubject;
/** The sealed classifier snapshot of `sig8`, or null when the seal file holds none or a malformed one. */
export declare function readHealSealSubject(ledgerDir: string, root: string, sig8: string): HealSealSubject | null;
/**
 * Seal the recorded heal run. `subject` is the classifier snapshot the
 * current debugger lane was given; without it the seal file keeps its own.
 */
export declare function writeHealSeal(ledgerDir: string, root: string, state: HealSignatureState, subject?: HealSealSubject): void;
/**
 * The class and classification `heal scan` derived from GitHub data, kept
 * outside the repository: `heal run` takes them only from here, never from
 * the in-repo record a lane's shell can reach.
 */
export interface HealScanRecord {
    sig8: string;
    class: HealClass;
    source: 'push' | 'pr';
    classification: HealClassification;
}
export declare function writeHealScanRecord(ledgerDir: string, root: string, r: HealScanRecord): void;
/** The scan-time record of `sig8`, or null when it is missing, corrupt or fails its integrity hash. */
export declare function readHealScanRecord(ledgerDir: string, root: string, sig8: string): HealScanRecord | null;
/** `ok` when the recorded heal run matches its out-of-repo seal; `none` without a heal run (and no seal). */
export declare function verifyHealSeal(ledgerDir: string, root: string, state: HealSignatureState): 'ok' | 'none' | 'missing' | 'mismatch';
/** Field-wise larger of the in-repo and the mirrored counters. */
export declare function readHealCounters(root: string, ledgerDir: string, now: Date): HealDailyCounters;
export declare function writeHealCounters(root: string, ledgerDir: string, counters: HealDailyCounters): void;
/** AI credits the budget ledger holds for heal lanes updated on `day` (UTC). */
export declare function ledgerHealCredits(root: string, day: string): number;
/**
 * The lane cap after the limits, or why the lane may not start. `others` are
 * the other signatures' states; `fresh` is true when this starts a new heal run.
 */
export declare function laneBudget(state: HealSignatureState, others: readonly HealSignatureState[], counters: HealDailyCounters, ledgerCredits: number, config: HealConfig, fresh: boolean): {
    ok: true;
    cap: number;
} | {
    ok: false;
    reason: string;
};
/**
 * `omg factory heal close <sig8>`: a human closes an open heal run parked at
 * heal-approve or heal-diagnosis, which frees the MAX_OPEN_HEAL_RUNS slot.
 * The signature keeps its record; the next red run on it folds in as usual.
 */
export declare function closeHeal(root: string, sig8: string, deps: Pick<HealRunDeps, 'ledgerDir' | 'now'>, lockTimeoutMs?: number): HealSignatureState;
export declare function runHeal(o: HealRunOptions, deps: HealRunDeps): Promise<HealRunOutcome>;
//# sourceMappingURL=run.d.ts.map