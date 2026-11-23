/**
 * `omg factory dashboard` data, schemaVersion 2: a pure `collect -> JSON`
 * step (render.ts turns the JSON into the page; a later `--serve` reuses
 * both). LOCAL reads only: run states, owner and slot files, progress-log
 * modification times, the engine ledger, bench result files. No forge or
 * network call and no write of any kind; the tracker columns come in only
 * as an already-read board (`--forge`, the CLI does that read).
 *
 * Trust: each run state is read once and checked like `omg factory
 * attention` checks it (readRun: the seal, then the engine ledger on the
 * same bytes). A run that fails is listed with its trust marker and no free
 * text from its state (no title, no reason), and its numbers are never
 * summed into a total: `cost.excluded` counts them apart. The Attention
 * section IS the attention collector's output (collectAttention), so its
 * rows and their trust rules are the same as the CLI's.
 *
 * Every string from a state, the tracker or a bench file is untrusted: it
 * goes through plainText here and is HTML-escaped again in render.ts.
 */
import type { ForgeKind } from '../../forge/types.js';
import { type AttentionData, type AttentionItem, type AttentionTrust } from '../attention/collect.js';
import type { BoardJson } from '../board/collect.js';
import type { FactoryRunLimits } from '../run/budget.js';
import { type FactoryRunState, type OwnerDeps } from '../run/state.js';
export declare const DASHBOARD_SCHEMA_VERSION_2 = 2;
export interface Usage {
    credits: number;
    premiumRequests: number;
    lanes: number;
}
/** One visit to a phase: engine time and time parked at a human gate, apart. */
export interface TimelineStep {
    phase: string;
    engineMs: number;
    waitingMs: number;
    /** The human gates the run parked at during this visit, in order. */
    gates: string[];
}
export interface RunTimeline {
    steps: TimelineStep[];
    engineMs: number;
    waitingMs: number;
    /** Parked now: since when (ISO), else null. */
    waitingSince: string | null;
    /** The first park at the merge gate (ISO), else null. */
    mergeReadyAt: string | null;
    /** Engine time before that first merge park (waiting excluded), else null. */
    engineToMergeReadyMs: number | null;
    /** Time parked at the merge gate in total (to now while still parked there). */
    mergeWaitMs: number;
    /** Why some timestamps were clamped (out of order, or later than now), else null: the spans are bounded, but the run is no sample for medians. */
    clamped: string | null;
}
/**
 * The run's timeline from its history. Each history entry starts a segment
 * that lasts to the next entry. A park note (`awaiting-human: <gate>: ...`,
 * written by setGate) starts WAITING time, which lasts until an entry ends the
 * park (parkEffect: a phase move, a rerun, a human-merge record, a cancel):
 * notes written while parked are waiting time too. While the run is still
 * parked the wait runs to `now`, from `waitingSince` (the later of the last
 * park note and `gate.at`). Every other segment is engine time of the phase
 * the last move entered; a terminal phase ends the run (no segment after it),
 * and the last segment of a run that is neither parked nor finished runs to
 * `updatedAt`. A state whose gate is newer than its last history entry (no
 * park note) waits from `gate.at`.
 *
 * Every time is clamped to `now`, and an entry older than the one before it
 * starts where that one ended: no span is negative or later than now.
 * `clamped` says why when an entry is out of order or later than now (beyond
 * a minute of clock skew).
 *
 * What it cannot tell: an engine that died without a park (the gap to the
 * next invocation counts as engine time), and when a human really merged a
 * PR (the wait ends when a read surface or a rerun recorded it).
 */
export declare function runTimeline(s: Pick<FactoryRunState, 'history' | 'updatedAt' | 'gate' | 'phase'>, now: number): RunTimeline;
export interface DashboardRunV2 {
    key: string;
    kind: 'issue' | 'ci-heal';
    trust: AttentionTrust;
    /** False: the state is not the engine's last write (or cannot be checked); no free text and no numbers from it below. */
    verified: boolean;
    title: string;
    phase: string | null;
    gate: {
        name: string;
        reason: string;
        at: string;
    } | null;
    outcome: 'merged' | 'cancelled' | 'failed' | 'parked' | 'in-progress' | 'unknown';
    pr: number | null;
    head: string | null;
    forge: ForgeKind | null;
    credits: number | null;
    premiumRequests: number | null;
    lanes: number | null;
    roles: Record<string, Usage>;
    startedAt: string | null;
    updatedAt: string | null;
    /** The engine's own wall-time counter across invocations. */
    elapsedMs: number | null;
    /** From the history (runTimeline): engine time and waiting-on-human time, apart. */
    engineMs: number | null;
    waitingMs: number | null;
    waitingSince: string | null;
    timeline: TimelineStep[];
    mergeReadyAt: string | null;
    engineToMergeReadyMs: number | null;
    mergeWaitMs: number | null;
}
export interface DashboardTask {
    key: string;
    verified: boolean;
    title: string;
    phase: string | null;
    gate: string | null;
    outcome: DashboardRunV2['outcome'] | 'no run';
    pr: number | null;
    credits: number | null;
    /** First history entry to the last one (or to now while parked). */
    wallMs: number | null;
    /** `--forge` only (from the board): the check bucket and the tracker's live stage. */
    tracker: {
        bucket: string | null;
        stage: string | null;
        liveText: string | null;
    } | null;
}
export interface DashboardBenchV2 {
    /** `bench-results` (the repository's) or `bench-dir` (--bench-dir). */
    source: 'bench-results' | 'bench-dir';
    file: string;
    schemaVersion: number | null;
    mode: string | null;
    omgVersion: string | null;
    model: string | null;
    startedAt: string | null;
    issues: number | null;
    passed: number | null;
    premiumRequests: number | null;
    credits: number | null;
    wallMs: number | null;
}
export interface DashboardDataV2 {
    schemaVersion: typeof DASHBOARD_SCHEMA_VERSION_2;
    generatedAt: string;
    since: string | null;
    /** Whether tracker data was read (`--forge`), and when. */
    forge: {
        read: boolean;
        at: string | null;
    };
    /** `omg factory attention --json`'s object (attentionJson). */
    attention: {
        schemaVersion: number;
        repo: string;
        forge: string | null;
        generatedAt: string;
        summary: AttentionData['summary'];
        items: Omit<AttentionItem, 'at'>[];
        warnings: string[];
    };
    live: {
        engines: number;
        slots: number;
        runs: {
            key: string;
            verified: boolean;
            phase: string | null;
            lane: {
                id: string;
                kind: string;
                startedAt: string;
                maxCredits: number;
            } | null;
            heartbeatAgeMs: number | null;
            credits: number | null;
            inFlightCredits: number;
        }[];
        /** The credit caps of the lanes running now (what they may still spend at most). */
        inFlightCredits: number;
    };
    runs: DashboardRunV2[];
    tasks: DashboardTask[];
    cost: {
        caps: {
            laneMaxCredits: number | null;
            maxRunCredits: number | null;
            source: 'config' | 'unresolved';
            note: string;
        };
        totals: Usage;
        byRole: ({
            role: string;
        } & Usage)[];
        byDay: ({
            day: string;
        } & Usage)[];
        byRun: {
            key: string;
            credits: number;
            premiumRequests: number;
            cap: number | null;
        }[];
        /**
         * Runs whose state is not verified, never in the totals above. Their own
         * numbers are not shown at all (an unverified state's claims are not data).
         * `missing`: of those, runs the engine ledger records whose state file is gone.
         */
        excluded: {
            runs: number;
            missing: number;
        };
    };
    throughput: {
        byDay: {
            day: string;
            started: number;
            mergeReady: number;
        }[];
        engineToMergeReady: {
            runs: number;
            medianMs: number | null;
            p90Ms: number | null;
        };
        waitingAtMerge: {
            runs: number;
            medianMs: number | null;
        };
        /** The --since both the medians and the per-day counts apply: a run is in the medians when it reached the merge park on or after it. */
        since: string | null;
        /** Runs left out of the medians because their history timestamps were clamped (runTimeline `clamped`). */
        excludedRuns: number;
    };
    bench: DashboardBenchV2[];
    warnings: string[];
}
export interface CollectDashboardV2Options {
    ledgerDir: string;
    since?: string;
    now?: () => number;
    /** The run limits as the engine would resolve them from config (null: could not be resolved). */
    limits?: FactoryRunLimits | null;
    owner?: OwnerDeps;
    /** Extra bench result directories (--bench-dir). */
    benchDirs?: readonly string[];
    /** `--forge` only: the board, already read by the CLI, and when. */
    board?: {
        json: BoardJson;
        at: string;
    } | null;
}
/** Bench results from `<root>/bench-results/` and every --bench-dir; one row per result file, oldest first. */
export declare function readBenchV2(root: string, dirs: readonly string[], warnings: string[]): DashboardBenchV2[];
export declare function collectDashboardV2(root: string, o: CollectDashboardV2Options): DashboardDataV2;
//# sourceMappingURL=collect-v2.d.ts.map