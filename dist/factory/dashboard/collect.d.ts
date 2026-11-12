/**
 * `omg factory dashboard` data (goal 6): everything comes from LOCAL state,
 * the sealed run states under `.omg/state/factory/` (finished runs stay there)
 * and optional `bench-results/*.json`. No forge or network call.
 *
 * Every string taken from a run (issue title, park reason, finding text) is
 * untrusted, so it goes through plainText here and is HTML-escaped again at
 * render time (render.ts).
 */
import { type FactoryRunState } from '../run/state.js';
export declare const DASHBOARD_SCHEMA_VERSION = 1;
export interface UsageTotals {
    credits: number;
    premiumRequests: number;
    lanes: number;
}
export interface DashboardRun extends UsageTotals {
    key: string;
    kind: 'issue' | 'ci-heal';
    title: string;
    phase: string;
    gate: {
        name: string;
        reason: string;
    } | null;
    pr: number | null;
    createdAt: string;
    updatedAt: string;
    /** Engine wall time across invocations. */
    elapsedMs: number;
    /** Time spent in each phase, from the run history (the last phase runs to updatedAt). */
    phaseMs: Record<string, number>;
    /** Credits and requests per lane role. */
    roles: Record<string, UsageTotals>;
    /** Names of every human gate the run parked at (repeats kept). */
    parks: string[];
}
export interface DashboardBench {
    file: string;
    schemaVersion: number;
    createdAt: string | null;
    mode: string | null;
    /** Scalar entries of the file's `totals` object. */
    totals: Record<string, string | number | boolean>;
    /** Up to MAX_BENCH_ISSUES rows with an id and an outcome, when the file has an `issues` array. */
    issues: {
        id: string;
        outcome: string;
        expect: string | null;
    }[];
}
export interface DashboardData {
    schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
    generatedAt: string;
    since: string | null;
    runs: DashboardRun[];
    totals: UsageTotals & {
        runs: number;
        elapsedMs: number;
    };
    statuses: {
        phase: string;
        count: number;
    }[];
    parkReasons: {
        name: string;
        count: number;
    }[];
    phaseMs: {
        phase: string;
        ms: number;
    }[];
    byRole: ({
        role: string;
    } & UsageTotals)[];
    byDay: ({
        day: string;
    } & UsageTotals)[];
    bench: DashboardBench[];
    warnings: string[];
}
/** Milliseconds per phase: each transition runs until the next one; the last runs to updatedAt (nothing once terminal). Park notes are not transitions. */
export declare function phaseDurations(s: Pick<FactoryRunState, 'history' | 'updatedAt'>): Record<string, number>;
export declare function summarizeRun(s: FactoryRunState, o?: {
    sinceMs?: number | null;
    warnings?: string[];
}): DashboardRun;
/** Read `bench-results/*.json`: a file counts when it parses and carries a numeric `schemaVersion`; anything else is skipped with a warning. */
export declare function readBenchResults(root: string, warnings: string[]): DashboardBench[];
/** Parse `--since`: a date (`2026-11-01`, local midnight) or an ISO timestamp. */
export declare function parseSince(value: string): number;
export declare function collectDashboard(root: string, o?: {
    since?: string;
    now?: () => Date;
}): DashboardData;
//# sourceMappingURL=collect.d.ts.map