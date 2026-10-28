/**
 * Heal signature state (design §2): `.omg/state/factory/heal/<sig8>.json`
 * under the state root, one file per failure signature, plus the per-UTC-day
 * counters in `limits.json`. A run already counted for a signature is never
 * counted again, so rescans are idempotent. A signature with an open heal run,
 * or closed by a human as won't-fix within WONT_FIX_DAYS, only increments its
 * count. Lane-eligible signatures over a limit are queued with
 * `blocked: rate-limit` and re-evaluated by the next scan.
 *
 * The scan starts no heal run and no lane: `next` records what the next stage
 * would do, and a rerun is recorded as an intent (at most one per signature),
 * never issued. `omg factory heal run` (run.ts) starts the heal run and its
 * debugger lane and records them here.
 *
 * `webhook-queue.json` holds the run ids the listener's `workflow_run`
 * handler enqueued. It is a hint only: the scan (the poller) stays the
 * source of truth, re-reads every queued run through `gh`, and clears the
 * entries it has seen.
 */
import type { HealClass, HealClassification, RerunIntent } from './classify.js';
import type { HealConfig } from './config.js';
import type { Diagnosis } from './diagnosis-output.js';
export declare const SIG8: RegExp;
export declare const WONT_FIX_DAYS = 14;
/** Open heal runs at a time (fixed). */
export declare const MAX_OPEN_HEAL_RUNS = 1;
/** Reruns the classifier records per signature (fixed). */
export declare const MAX_RERUNS_PER_SIGNATURE = 1;
/**
 * `heal-approve`: a valid diagnosis is recorded and the heal run waits for a
 * human (implementing the fix is PR 3). `heal-diagnosis`: the debugger lane
 * produced no usable diagnosis; a human reads the record, and
 * `omg factory heal run` may try again within the limits.
 */
export type HealNext = 'debug-lane' | 'rerun-probe' | 'report' | 'heal-approve' | 'heal-diagnosis';
export interface HealLaneRecord {
    id: string;
    kind: 'debug';
    jobId?: string;
    startSha: string;
    status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'lost' | 'start-failed' | 'unconfirmed';
    maxCredits: number;
    startedAt: string;
    endedAt?: string;
    /** The process that started the lane (a stale `running` record of a dead process is settled as lost). */
    pid: number;
    confinement: string;
    /** The lane ran with confinement `none` under OMG_HEAL_UNCONFINED=1. */
    unconfinedOptIn?: true;
    usage?: {
        credits: number;
        premiumRequests: number;
        source: 'measured' | 'estimated';
    };
    note?: string;
}
export interface HealDiagnosisRecord {
    at: string;
    laneId: string;
    outcome: 'valid' | 'rejected' | 'invalid' | 'tampered' | 'lane-failed';
    reason?: string;
    /** The validated lane output (valid or rejected outcomes only). */
    diagnosis?: Diagnosis;
    /** Bundle file -> sha256 at the time the lane read it. */
    evidence: Record<string, string>;
}
export interface HealSignatureState {
    version: 1;
    sig8: string;
    signature: string;
    class: HealClass;
    classification: HealClassification;
    /** `push`: a red dev push run; `pr`: seen on PR runs of two or more head branches. */
    source: 'push' | 'pr';
    firstSeen: {
        runId: string;
        at: string;
    };
    lastSeen: {
        runId: string;
        at: string;
    };
    count: number;
    seenRuns: string[];
    prBranches?: string[];
    healRun?: {
        id: string;
        open: boolean;
        startedAt: string;
        closedAt?: string;
    };
    /** Debugger lanes of the heal run, oldest first. */
    lanes?: HealLaneRecord[];
    diagnosis?: HealDiagnosisRecord;
    wontFixAt?: string;
    next: HealNext;
    blocked?: 'rate-limit';
    rerunIntents: RerunIntent[];
    updatedAt: string;
}
export interface HealDailyCounters {
    day: string;
    healRuns: number;
    debugLanes: number;
    /** AI credits of heal lanes today: a lane's cap is reserved at its start, then replaced by its measured spend. */
    credits: number;
}
export declare function healStateDir(root: string): string;
export declare function healStatePath(root: string, sig8: string): string;
export declare function readHealState(root: string, sig8: string): HealSignatureState | null;
export declare function listHealStates(root: string): HealSignatureState[];
/** Today's counters in one counters file; a file from an earlier UTC day reads as zero. */
export declare function readDailyCountersAt(path: string, now: Date): HealDailyCounters;
export declare const dailyCountersPath: (root: string) => string;
/** Today's counters; a file from an earlier UTC day reads as zero. */
export declare function readDailyCounters(root: string, now: Date): HealDailyCounters;
export declare function writeDailyCountersAt(path: string, counters: HealDailyCounters): void;
/** Why a lane-eligible signature may not start a heal run now, or null. */
export declare function healLimitReason(states: readonly HealSignatureState[], counters: HealDailyCounters, config: Pick<HealConfig, 'dailyRuns' | 'dailyDebugLanes'>): string | null;
export interface RecordInput {
    classification: HealClassification;
    runId: string;
    source: 'push' | 'pr';
    prBranches?: string[];
}
export interface RecordResult {
    state: HealSignatureState;
    /** False when the run was already counted for this signature. */
    changed: boolean;
    /** Only the count moved: an open heal run or a recent won't-fix. */
    suppressed: boolean;
}
/**
 * Fold one classified run into its signature state (pure: the caller writes
 * it). `others` are the other signatures' states, for the open-run limit.
 */
export declare function foldSignature(prev: HealSignatureState | null, input: RecordInput, others: readonly HealSignatureState[], counters: HealDailyCounters, config: HealConfig, now: Date): RecordResult;
export interface QueuedRun {
    runId: string;
    receivedAt: string;
}
/** Entries kept in the webhook queue (oldest dropped first). */
export declare const MAX_QUEUED_RUNS = 50;
/** A queued run the scan has not seen after this long is dropped. */
export declare const QUEUE_TTL_MS: number;
export declare const webhookQueuePath: (root: string) => string;
export declare function readWebhookQueue(root: string): QueuedRun[];
/** Add one run id (idempotent); false when it was already queued. The caller holds the scan lock. */
export declare function enqueueWebhookRun(root: string, runId: string, now: Date): boolean;
/** Drop queued runs the scan saw and expired ones; returns what is left. The caller holds the scan lock. */
export declare function pruneWebhookQueue(root: string, seen: ReadonlySet<string>, now: Date): QueuedRun[];
export declare function writeHealState(root: string, state: HealSignatureState): void;
//# sourceMappingURL=state.d.ts.map