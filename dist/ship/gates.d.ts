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
    /**
     * The job keys it names when the job failed only because jobs it needs
     * failed (aggregateOnly): those jobs carry the verdict (needsExplained).
     */
    aggregate?: string[];
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
    /** Green with no check and no workflow run at all, under the reported-checks rule (NO_CI_CHECKS_NOTE). */
    noChecks?: true;
    /**
     * Required names (configured or branch protection) still unreported after
     * every reported check and run completed and the settle window passed:
     * they will not appear (applySettle). The verdict stays pending.
     */
    missing?: string[];
    /**
     * Nothing reported for this head past the settle window, but the gates do
     * not treat the repository as having no CI (applySettle): `base` = the
     * checks the PR's base commit reported, undefined = not read (unreadable,
     * or a read with no GitHub API access); `ciDefinitions` = the CI
     * definition files the base or head tree holds (empty list = the trees
     * could not be read); `suites` = the head's check suites could not be
     * read, or GitHub lists some (all completed) for it. Text: noHeadChecksText.
     */
    noHeadChecks?: {
        base?: string[];
        ciDefinitions?: string[];
        suites?: 'unreadable' | 'present';
    };
}
/**
 * The GitHub reads a factory run adds to a gate evaluation (its guard allows
 * them; ship's and Azure DevOps' evaluations have none). Each returns
 * undefined when unreadable.
 */
export interface GateHeadReads {
    /** The check names the PR's base commit reported (the no-CI rule). */
    baseChecks: () => readonly string[] | undefined;
    /**
     * The CI definition files (`.github/workflows/` and the other CI systems')
     * in the sealed base commit's tree or the head's tree (the no-CI rule:
     * any = this repository has CI); undefined = unreadable.
     */
    ciDefinitions: () => readonly string[] | undefined;
    /** The head's check suites (green needs each completed). */
    suites: (head: string) => ReadonlyArray<{
        status: string;
        app?: string;
        runs: number;
    }> | undefined;
    /** The PR base commit's check suites (an idle app's suite is exempt only when that app ran nothing on the base either). */
    baseSuites: () => ReadonlyArray<{
        status: string;
        app?: string;
        runs: number;
    }> | undefined;
    /** The head's check runs with their app ids (ShipConfig.requiredCheckApps). */
    runApps: (head: string) => ReadonlyArray<{
        name: string;
        appId?: number;
    }> | undefined;
}
/**
 * The settle window: how long the set of reported checks must stay quiet
 * (no check started or completed) before the gate decides it is complete.
 * Bounded by the caller's own timeout (the factory's gatesTimeoutMinutes).
 */
export declare const CHECK_SETTLE_MS = 120000;
/** Carried into the merge park and the PR note when a head was green with no CI at all. */
export declare const NO_CI_CHECKS_NOTE = "no CI checks are configured for this repository";
/**
 * When a watch first read a head (kept by the caller across watch windows:
 * the factory's gates driver). The settle window of a check without a
 * timestamp, and of a head with no check at all, counts from here.
 */
export interface SettleClock {
    head?: string;
    since?: number;
}
/** How to fix a required name that never reports, by where it came from. */
export declare function missingCheckHint(missing: readonly string[], config: Pick<ShipConfig, 'requiredChecksFrom'>): string;
/**
 * The settle window over one gate report (CHECK_SETTLE_MS from the newest
 * check start / completion the forge reports; a check without a timestamp,
 * or no check at all, counts from `watchedSince`; undefined = this read has
 * no history, so a window that needs it has not passed: fail closed).
 *
 * - `requiredChecks` empty (the reported-checks rule): a green read waits
 *   out the window (a late check may still appear), and a head with no check
 *   and no workflow run is green with `noChecks` once the window passed,
 *   but only when `reads.baseChecks` says the base commit reported no check
 *   either, `reads.ciDefinitions` finds no CI definition in the base or head
 *   tree, and the head's check suites read succeeded and are empty;
 *   otherwise (or any of them unreadable, or no `reads`) it stays pending
 *   with `noHeadChecks`.
 * - `reads.suites` (the head's check suites, when readable): green also needs
 *   each suite completed (openSuites).
 * - names required: when every reported check and run completed, nothing
 *   failed, and only required names are pending past the window, they are
 *   `missing` with a hint (the verdict stays pending).
 */
export declare function applySettle(report: GateReport, config: Pick<ShipConfig, 'requiredChecks' | 'advisoryChecks' | 'requiredChecksFrom'>, now: number, watchedSince: number | undefined, reads?: GateHeadReads, head?: string): GateReport;
/** Why a head that reported nothing is not "no CI" (GateReport.noHeadChecks): the park, heartbeat and suggestion text. */
export declare function noHeadChecksText(n: NonNullable<GateReport['noHeadChecks']>): string;
/**
 * ShipConfig.requiredCheckApps on the head's check runs (`runApps`): a
 * required name whose check runs all come from another app is pending (a
 * same-named check of another app does not satisfy it; GitHub itself keeps
 * it expected). Unreadable runs (undefined) keep name matching, and so does
 * a commit status, which carries no app id: the check-runs API is the only
 * place GitHub exposes the app, so a status of the name keeps it pending.
 */
export declare function applyRequiredApps(report: GateReport, config: Pick<ShipConfig, 'requiredCheckApps'>, runApps: ReadonlyArray<{
    name: string;
    appId?: number;
}> | undefined): GateReport;
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
 */
export declare function logBlockers(log: string): string[];
/**
 * The job keys a job that failed only because jobs it needs failed names:
 * every step with an `##[error]` logged an aggregator line (AGGREGATE_ERROR)
 * and otherwise only its exit code, and vitest reported no unhandled error or
 * failed suite. CI Gate's line names the keys; the Test summary's is
 * `test-shards`. Undefined when the job failed on its own (any other error,
 * or a CI Gate naming the evidence job).
 */
export declare function aggregateOnly(log: string): string[] | undefined;
/**
 * True when every job key an aggregator names is accounted for in its run:
 * the key maps (`jobChecks`, from ci.yml) to check names, at least one of
 * them is a non-passing check of the run, and every non-passing one has been
 * analysed. Otherwise the aggregator stays a blocker.
 */
export declare function needsExplained(keys: readonly string[], jobChecks: ReadonlyMap<string, readonly string[]>, run: ReadonlyArray<{
    name: string;
    failed: boolean;
    analysed: boolean;
}>): boolean;
/** ci.yml's job key -> check names from `root`; empty when it is missing (no aggregator is set aside). */
export declare function readJobChecks(root: string): Map<string, string[]>;
export declare function analyzeFailedLog(check: string, runId: string | undefined, log: string, known: readonly KnownFlakyTest[], jobId?: string): FlakyAnalysis;
/**
 * Fold log analyses into a report: verdict becomes `flaky` when every failed
 * required check is a known-flaky failure (matched by job id); a run is
 * rerunnable only when all its required jobs are finished. An aggregator
 * check (CI Gate, the Test summary) that failed only because jobs it needs
 * failed is judged by those jobs: it is set aside only when every job it
 * names is a failed, analysed check of its run (needsExplained over
 * `jobChecks`, ci.yml's key -> check names; empty = never set aside).
 */
export declare function applyFlakyAnalysis(report: GateReport, analyses: FlakyAnalysis[], kind?: ForgeKind, jobChecks?: ReadonlyMap<string, readonly string[]>): GateReport;
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
 * jobs' logs are read for known-flaky attribution; an aggregator's named jobs
 * are mapped to checks from the checkout's ci.yml. `forge` replaces the gh
 * reads (GateForge); without it every call is the GitHub one.
 * `watchedSince` (ms) feeds the settle window (applySettle): when this
 * head was first read; omitted = a read without history (fail closed).
 * `reads` (GateHeadReads, the factory run only) adds the base commit's
 * checks, the head's check suites and its check runs' apps.
 */
export declare function evaluateGates(exec: Exec, pr: number, config: ShipConfig, known: readonly KnownFlakyTest[], cwd?: string, headSha?: string, forge?: GateForge, watchedSince?: number, now?: () => number, reads?: GateHeadReads): GateReport;
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
    /** The settle clock (SettleClock); omitted = one per call, started at its first read. */
    settle?: SettleClock;
    /** Return at once when a required name is `missing` (applySettle); otherwise the watch polls on to its timeout. */
    stopOnMissing?: boolean;
    /** The factory run's GitHub reads (GateHeadReads); omitted = none. */
    reads?: GateHeadReads;
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