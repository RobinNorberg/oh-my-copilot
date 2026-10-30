/**
 * Gate engine for `omg ship gates`: classify `gh pr checks --json` output
 * under the fork's merge rule, attribute failures to known-flaky tests from
 * the failed job's log, and watch until green / failed / timeout.
 *
 * Merge rule: green only when every check outside the advisory list is
 * SUCCESS or SKIPPED, every name in `ship.requiredChecks` has been reported
 * (a missing one is pending: `needs:`-dependent jobs appear late), and every
 * Actions workflow run for the head sha has status `completed`. Unknown
 * states count as failed (fail closed), and a PR with no required checks yet
 * is pending, never green.
 */
import type { ShipConfig, KnownFlakyTest } from './config.js';
import type { Exec } from './exec.js';
import type { ForgeChecks, ForgeKind, ForgeReviews } from '../forge/types.js';
/**
 * The forge reads of a gate evaluation (factory forges design §2): the PR
 * head and its checks, runs, logs and reruns. Omitted = GitHub through the
 * gh calls in this file, unchanged; the factory engine passes the Azure
 * DevOps adapter's.
 */
export interface GateForge {
    checks: ForgeChecks;
    reviews: Pick<ForgeReviews, 'prHead'>;
    /** Picks the rerun hint in flaky suggestions; omitted = GitHub. */
    kind?: ForgeKind;
}
export declare const CHECK_FIELDS = "name,state,bucket,link,workflow,event,startedAt,completedAt";
export interface GhCheck {
    name: string;
    state: string;
    bucket?: string;
    link?: string;
    workflow?: string;
    event?: string;
    startedAt?: string;
    completedAt?: string;
}
export type CheckClass = 'pass' | 'pending' | 'failed' | 'advisory';
export interface ClassifiedCheck extends GhCheck {
    class: CheckClass;
    runId?: string;
    jobId?: string;
}
export interface FailingTest {
    file: string;
    title?: string;
}
export interface FlakyAnalysis {
    check: string;
    runId?: string;
    /** Actions job id the log came from; analyses are matched to checks by it. */
    jobId?: string;
    failingTests: FailingTest[];
    /**
     * True when at least one failing test was found, every one is on the
     * known-flaky list, and the log shows no non-test failure (`blockers`).
     */
    knownFlaky: boolean;
    unknown: FailingTest[];
    /** Log evidence that the job failed for a reason other than its failing tests. */
    blockers: string[];
}
/** One `gh run list --commit <sha> --json ...` entry. */
export interface WorkflowRun {
    databaseId: number;
    status: string;
    conclusion?: string;
    workflowName?: string;
    headSha?: string;
}
export declare const RUN_FIELDS = "databaseId,status,conclusion,workflowName,headSha";
export type GateVerdict = 'green' | 'pending' | 'failed' | 'flaky';
export interface GateReport {
    pr: number;
    verdict: GateVerdict;
    checks: ClassifiedCheck[];
    pending: string[];
    failed: string[];
    advisoryFailed: string[];
    flaky: FlakyAnalysis[];
    /** Run ids whose failed jobs are all known-flaky and have no pending sibling jobs. */
    rerunnable: string[];
    suggestions: string[];
}
export declare class GhChecksError extends Error {
    constructor(message: string);
}
/** A transient GitHub failure (5xx, GraphQL "Something went wrong"): worth a retry, never a verdict. */
export declare const TRANSIENT_GH_ERROR: RegExp;
/** Parse `gh pr checks --json` stdout; throws GhChecksError on anything but an array of {name,state}. */
export declare function parseChecksJson(stdout: string): GhCheck[];
/** `advisory` is set only by a forge adapter (an ADO non-blocking policy); gh's JSON has no such field. */
export declare function classifyCheck(check: GhCheck & {
    advisory?: boolean;
}, advisory: readonly string[]): ClassifiedCheck;
/**
 * Pure merge-rule evaluation without log analysis (failed stays failed). A
 * `requiredChecks` name absent from `checks` is listed as pending.
 */
export declare function evaluateChecks(pr: number, checks: GhCheck[], config: Pick<ShipConfig, 'advisoryChecks' | 'requiredChecks'>): GateReport;
/** Parse `gh run list --json` stdout; throws GhChecksError on anything but an array of {databaseId,status}. */
export declare function parseRunsJson(stdout: string): WorkflowRun[];
/** Pending label when the head sha has no checks and no workflow runs at all. */
export declare const NO_WORKFLOWS_TRIGGERED = "no-workflows-triggered";
/**
 * A green report stays green only when every workflow run for the head sha is
 * `completed`; a queued / in-progress run (jobs not yet reported) is pending.
 * The latest run of each workflow that completed with a conclusion other than
 * success / skipped / neutral and reported no check (a workflow that failed at
 * startup, e.g. an invalid workflow file) is failed. A run whose jobs did
 * report is judged by its checks (its advisory jobs may fail).
 */
export declare function applyWorkflowRuns(report: GateReport, runs: WorkflowRun[]): GateReport;
/**
 * No check and no workflow run for the head: a PR opened or pushed with the
 * Actions GITHUB_TOKEN (draft bot PRs) triggers no workflows, so waiting
 * would be pending forever. Reported as a distinct pending reason.
 */
export declare function applyNoWorkflows(report: GateReport, runs: WorkflowRun[], headSha: string): GateReport;
/** An Azure Pipelines log line's timestamp (after a byte-order mark on the first line); stripped only when the GitHub prefix is absent. */
export declare const ADO_LOG_PREFIX: RegExp;
/** Extract vitest ` FAIL  <file> > <title>` lines from a GitHub Actions or Azure Pipelines log. */
export declare function parseFailingTests(log: string): FailingTest[];
/** A file-level failure (no title) never matches: it is a collection error, not a flaky test. */
export declare function isKnownFlaky(test: FailingTest, known: readonly KnownFlakyTest[]): boolean;
/**
 * Evidence in a job log that the job did not fail only because of its failing
 * tests: vitest unhandled errors, failed suites (collection errors), or an
 * `##[error]` in a step that printed no FAIL line (a non-test step failed).
 * The step is the GitHub log's second tab column, or on an Azure Pipelines
 * log the last `##[section]Starting:` marker.
 */
export declare function logBlockers(log: string): string[];
export declare function analyzeFailedLog(check: string, runId: string | undefined, log: string, known: readonly KnownFlakyTest[], jobId?: string): FlakyAnalysis;
/**
 * Fold log analyses into a report: verdict becomes `flaky` when every failed
 * required check is a known-flaky failure (matched by job id); a run is
 * rerunnable only when all its required jobs are finished.
 */
export declare function applyFlakyAnalysis(report: GateReport, analyses: FlakyAnalysis[], kind?: ForgeKind): GateReport;
/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list (the GitHub forge's checks). */
export declare function fetchChecks(exec: Exec, pr: number, cwd?: string): GhCheck[];
/** The PR head sha from `gh pr view <pr> --json headRefOid`. */
export declare function fetchHeadSha(exec: Exec, pr: number, cwd?: string): string;
/**
 * Every Actions workflow run for the head sha (`gh run list --commit`); a run
 * whose reported head_sha is another commit is dropped (the GitHub forge's runsForHead).
 */
export declare function fetchWorkflowRuns(exec: Exec, headSha: string, cwd?: string): WorkflowRun[];
/**
 * One gate evaluation against a single head sha: resolve the head first
 * (unless given), read the checks and the workflow runs for it, then re-read
 * the head; a head that moved in between is pending whatever the verdict
 * (green, failed or flaky), since the read may mix two heads. Failed Actions
 * jobs' logs are read for known-flaky attribution. `forge` replaces the gh
 * reads (GateForge); without it every call is the GitHub one.
 */
export declare function evaluateGates(exec: Exec, pr: number, config: ShipConfig, known: readonly KnownFlakyTest[], cwd?: string, headSha?: string, forge?: GateForge): GateReport;
export interface WatchOptions {
    exec: Exec;
    pr: number;
    config: ShipConfig;
    known: readonly KnownFlakyTest[];
    cwd?: string;
    /** PR head sha for the workflow-run check (looked up per poll when omitted). */
    headSha?: string;
    watch: boolean;
    /** Rerun budget lookup/record (persisted in the ship state); omitted = never rerun. */
    reruns?: {
        count(runId: string): number;
        record(runId: string): void;
    };
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    onReport?: (report: GateReport) => void;
    /** Drive mode: a transient GitHub error while reading the gates is a pending poll, not a thrown error. */
    retryTransient?: boolean;
    onTransient?: (message: string) => void;
    /** The forge reads (GateForge); omitted = GitHub. */
    forge?: GateForge;
}
export interface WatchResult {
    report: GateReport;
    /** Run ids rerun during this watch. */
    rerun: string[];
    /** The window elapsed while waiting (pending, or a flaky run's reruns / sibling jobs still going). */
    timedOut: boolean;
}
/**
 * Poll until green, a real failure, a flaky failure that is out of rerun
 * budget, or the per-invocation timeout. Each run id is rerun at most once
 * across invocations (the budget lives in the ship state).
 */
export declare function watchGates(opts: WatchOptions): Promise<WatchResult>;
//# sourceMappingURL=gates.d.ts.map