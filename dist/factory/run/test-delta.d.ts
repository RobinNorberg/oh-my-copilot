/** One vitest run, as the verdict needs it. */
export interface VitestRunSummary {
    /** How many tests passed. */
    passed: number;
    /** The id (testId) of every failed test (file relative to the run dir), sorted, unique. */
    failed: string[];
    /**
     * The id (testId of the file alone) of each test file that failed with no
     * failed test of its own, or with an error of the file itself (vitest's
     * file-level `message`: the file did not load, or a hook failed), sorted.
     */
    brokenFiles: string[];
    /** How many files hold a failure (a failed test or a broken file), counted by full file name (N4, review-548b). A head's only; a base summary may lack it. */
    failedFiles?: number;
}
/** A report above this size is not read (no report: fail closed). */
export declare const VITEST_REPORT_MAX_BYTES: number;
/** A base with more failing tests than this keeps today's park (the sandbox cannot run the suite); also bounds the sealed state. */
export declare const BASE_FAILURES_MAX = 200;
/** The longest test id (testId) the sealed state holds. */
export declare const TEST_ID_MAX_CHARS = 300;
/**
 * A test's id: 16 hex chars of the sha256 of the whole tuple
 * `[file, ...describes, title]` as JSON (so " > " inside a name cannot
 * collide with the separator, and a long shared prefix is not cut away),
 * then a space and the readable `file > describe > title`, cut so the id
 * fits TEST_ID_MAX_CHARS. Two ids are equal only when their full tuples are
 * (up to the hash); the readable part is for people (testIdText).
 */
export declare function testId(parts: readonly string[]): string;
/** The readable part of a test id (the hash left out); any other id as it is. */
export declare function testIdText(id: string): string;
/** A fresh report file name in `dir` (random, so no file the PR's code left there is read by name). */
export declare function vitestReportPath(dir: string): string;
/**
 * The vitest args that keep the console output and add the JSON report at
 * `path`. Coverage is off: a coverage threshold the project sets fails the
 * run with no failed test in the report (M1, review-548).
 */
export declare function vitestReportArgs(path: string): string[];
/**
 * vitest's JSON report (jest-compatible: testResults[].assertionResults[])
 * as a summary, or null when it is not one.
 */
export declare function parseVitestReport(text: string, root: string): VitestRunSummary | null;
/** The report at `path` (its file names made relative to `root`), then the file removed; null when it is missing, too large or not a report. */
export declare function readVitestReport(path: string, root: string): VitestRunSummary | null;
/**
 * The head's failures against the base's, for a head run that failed:
 * - `park` (today's gate-sandbox-incompatible): no base report, no test
 *   passes on the base, no head report, a failure in the output that the
 *   base has too, or anything the verdict cannot account for (testDeltaVerdict);
 * - `fail`: a test or file fails on the head that did not fail on the base
 *   (a new test counts: it never passed on the base);
 * - `pass`: every failure on the head failed on the base too (`excused`).
 */
export type TestDeltaVerdict = {
    kind: 'park';
    why: string;
} | {
    kind: 'fail';
    counted: string[];
    excused: string[];
} | {
    kind: 'pass';
    excused: string[];
};
/** What an error outside every test is listed as. */
export declare const UNHANDLED_ERRORS_ID = "errors outside any test (vitest \"Unhandled Errors\")";
/** What a coverage threshold the run missed is listed as. */
export declare const COVERAGE_THRESHOLD_ID = "a coverage threshold is not met";
/** What vitest's experimental.importDurations.failOnDanger failure (an import over the danger threshold) is listed as. */
export declare const IMPORT_DANGER_ID = "an import exceeded vitest's danger threshold (experimental.importDurations.failOnDanger)";
/** Terminal color codes (FORCE_COLOR), taken out before any output is read. */
export declare function stripAnsi(text: string): string;
/**
 * The failures in vitest's console output that its JSON report does not
 * hold, as ids: errors outside every test (the summary line `Errors  1
 * error`; the report says `success: true`, the exit code is 1) and a
 * coverage threshold the run missed (`... does not meet global threshold
 * ...`; the report args turn coverage off, so only a run that turns it back
 * on prints it), and an import over vitest's danger threshold with
 * experimental.importDurations.failOnDanger (`ERROR: 1 import(s) exceeded
 * the danger threshold`; N2, review-548b: the report args do not turn it
 * off, since vitest before 4.1 refuses an unknown option). A head that
 * forges a line only fails itself.
 */
export declare function vitestOutputFailures(output: string): string[];
/**
 * vitest's summary counts of failed tests and test files (`Tests  2 failed |
 * 5 passed (7)`); a count is left out when its line is not there. `seen`:
 * a `Tests` or `Test Files` summary line is there at all.
 */
export declare function vitestSummaryFailed(output: string): {
    tests?: number;
    files?: number;
    seen: boolean;
};
/** The head run besides its report: its exit status, vitestOutputFailures and vitestSummaryFailed of its output. */
export interface HeadRunSignals {
    status: number;
    output: readonly string[];
    summary: {
        tests?: number;
        files?: number;
        seen: boolean;
    };
}
/** The head run's signals from its exit status and console output. */
export declare function headRunSignals(status: number, output: string): HeadRunSignals;
/**
 * `head`'s failures against `base`'s. `signals`: the head run's exit status
 * and output (headRunSignals); `baseOutput`: vitestOutputFailures of the
 * base's output. An output failure on the head only counts like a new
 * failure; on both, the run parks (it cannot be told apart). When in doubt
 * it parks: an exit status other than vitest's 1 for failed tests, no
 * summary line at all (N3, review-548b), or a summary that names more
 * failed tests or files than the report.
 */
export declare function testDeltaVerdict(base: VitestRunSummary | undefined, head: VitestRunSummary | null, signals: HeadRunSignals, baseOutput?: readonly string[]): TestDeltaVerdict;
/** A summary the sealed state may hold (state.ts shape check). */
export declare function vitestSummaryShapeOk(v: unknown): v is VitestRunSummary;
//# sourceMappingURL=test-delta.d.ts.map