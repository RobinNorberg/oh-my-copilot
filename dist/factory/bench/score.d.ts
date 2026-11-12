/**
 * `omg factory bench` scoring: one outcome per issue from its run state (or
 * from omg factory check when --next never offered it), the pass verdict
 * against the issue's `expect`, the trap containment checks, the totals, the
 * results document (BENCH_RESULTS_SCHEMA_VERSION; additive changes keep the
 * version, a changed meaning bumps it), its markdown summary and the
 * `compare` diff. Pure except containment, which reads git and files.
 */
import type { Exec } from '../../ship/exec.js';
import { type FactoryRunState } from '../run/state.js';
import type { BenchFixtureMeta } from './fixture.js';
import type { BenchIssue, TrapKind } from './fixtures/issues.js';
export declare const BENCH_RESULTS_SCHEMA_VERSION = 1;
export declare const BENCH_RESULTS_KIND = "omg-factory-bench";
/** The gate name of the human merge park (engine: awaiting-human: merge). */
export declare const MERGE_PARK = "merge";
export interface BenchAcceptance {
    ran: boolean;
    passed: boolean;
    /** The gate's exit status (null when it did not run). */
    status: number | null;
    timedOut?: boolean;
    /** Why it did not run, or the output tail of a failure. */
    detail?: string;
}
export interface BenchContainment {
    trap: TrapKind;
    contained: boolean;
    /** What was checked and, when not contained, what leaked (never the secret or the canary itself). */
    detail: string;
}
export interface BenchLaneUsage {
    id: string;
    kind: string;
    premiumRequests: number;
    credits: number;
    source: string;
}
export interface BenchIssueResult {
    id: number;
    slug: string;
    title: string;
    difficulty: number;
    category: BenchIssue['category'];
    trap?: TrapKind;
    expect: readonly string[];
    /** merged-park | park:<gate> | not-runnable:<bucket> | merged | cancelled | failed | phase:<phase> | not-run | error */
    outcome: string;
    pass: boolean;
    park?: {
        name: string;
        reason: string;
    };
    acceptance: BenchAcceptance | null;
    containment: BenchContainment | null;
    head: string | null;
    pr: number | null;
    premiumRequests: number;
    credits: number;
    lanes: BenchLaneUsage[];
    /** From the run's first to its last history entry. */
    wallMs: number;
    /** Time per engine phase (history entry -> next entry). */
    phaseMs: Record<string, number>;
    /** The harness's note (a run error, why acceptance was skipped). */
    note?: string;
}
export interface BenchTotals {
    issues: number;
    passed: number;
    passRate: number;
    mergedParks: number;
    acceptancePassed: number;
    premiumRequests: number;
    credits: number;
    /** premiumRequests / mergedParks (null without a merged park). */
    requestsPerMergedPark: number | null;
    traps: number;
    trapsContained: number;
    trapContainmentRate: number | null;
    parkReasons: Record<string, number>;
    wallMs: number;
}
export interface BenchResults {
    schemaVersion: typeof BENCH_RESULTS_SCHEMA_VERSION;
    kind: typeof BENCH_RESULTS_KIND;
    mode: 'fake' | 'live';
    omgVersion: string;
    fixtureVersion: number;
    startedAt: string;
    finishedAt: string;
    caps: {
        maxRequests: number | null;
        maxCredits: number | null;
        maxMinutes: number;
        parallel: number;
    };
    /** Why the runner stopped before every issue was terminal or parked, else null. */
    stopped: null | 'max-requests' | 'max-credits' | 'max-minutes' | 'interrupted' | 'run-error';
    /** Usage the budget ledger recorded over the bench (live; null in fake mode). */
    ledger: {
        premiumRequests: number;
        credits: number;
    } | null;
    notes: string[];
    issues: BenchIssueResult[];
    totals: BenchTotals;
}
/** The outcome of a run state (null: no run). */
export declare function outcomeOf(state: FactoryRunState | null): string;
/** `expect` patterns: exact, or `prefix:*` for any outcome with that prefix. */
export declare function outcomeMatches(outcome: string, expect: readonly string[]): boolean;
export declare function laneUsage(state: FactoryRunState | null): BenchLaneUsage[];
/** Time per phase from the run's history (each entry's `to` phase lasts until the next entry). */
export declare function phaseTimes(state: FactoryRunState | null): {
    wallMs: number;
    phaseMs: Record<string, number>;
};
/** The pass verdict: the outcome is expected, and a merged park's hidden acceptance test is green. */
export declare function issuePasses(issue: Pick<BenchIssue, 'expect' | 'acceptanceTest'>, outcome: string, acceptance: BenchAcceptance | null): boolean;
export interface ContainmentInput {
    exec: Exec;
    /** The bare mirror the PR heads live in (the local forge's repo url). */
    mirror: string;
    meta: Pick<BenchFixtureMeta, 'root' | 'baseSha' | 'canary'>;
    /** The pushed PR head, or null when nothing was pushed. */
    head: string | null;
}
/**
 * Whether a trap stayed contained, from what reached the forge: the pushed
 * PR head (via the mirror), the local PR store and run records under
 * `.omg/factory/`, and the mirror's PR file.
 */
export declare function trapContainment(trap: TrapKind, i: ContainmentInput): BenchContainment;
export declare function computeTotals(issues: readonly BenchIssueResult[]): BenchTotals;
export declare function renderResultsMarkdown(r: BenchResults): string;
/** Read a results file; refuses another kind or schema version. */
export declare function readBenchResults(path: string): BenchResults;
/** `omg factory bench compare a.json b.json`: totals side by side and every issue whose outcome or pass changed. */
export declare function compareResults(a: BenchResults, b: BenchResults, names?: [string, string]): string;
//# sourceMappingURL=score.d.ts.map