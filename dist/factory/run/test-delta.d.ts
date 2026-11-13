/** One vitest run, as the verdict needs it. */
export interface VitestRunSummary {
    /** How many tests passed. */
    passed: number;
    /** `<file> > <describe> > <test>` of every failed test (file relative to the run dir), sorted, unique. */
    failed: string[];
    /** Test files that failed with no failed test of their own (the file did not load, or a hook failed), relative, sorted. */
    brokenFiles: string[];
}
/** A report above this size is not read (no report: fail closed). */
export declare const VITEST_REPORT_MAX_BYTES: number;
/** A base with more failing tests than this keeps today's park (the sandbox cannot run the suite); also bounds the sealed state. */
export declare const BASE_FAILURES_MAX = 200;
/** Each test id is cut to this length, the same way on the base and the head. */
export declare const TEST_ID_MAX_CHARS = 300;
/** A fresh report file name in `dir` (random, so no file the PR's code left there is read by name). */
export declare function vitestReportPath(dir: string): string;
/** The vitest args that keep the console output and add the JSON report at `path`. */
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
 *   passes on the base, no head report, errors outside any test on both, or
 *   the head failed with no failing test, file or error in its report
 *   (something else failed: not attributable);
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
/**
 * vitest's summary line for errors outside every test (`Errors  1 error`).
 * The JSON report does not hold them (it says `success: true`), but the exit
 * code is 1. Read from the output tail: a head that forges the line only
 * fails itself.
 */
export declare function vitestUnhandledErrors(output: string): boolean;
/**
 * `unhandled`: whether each run printed vitest's unhandled-errors summary
 * (vitestUnhandledErrors). On the head only, it counts like a new failure;
 * on both, the run parks (it cannot be told apart).
 */
export declare function testDeltaVerdict(base: VitestRunSummary | undefined, head: VitestRunSummary | null, unhandled?: {
    head: boolean;
    base: boolean;
}): TestDeltaVerdict;
/** A summary the sealed state may hold (state.ts shape check). */
export declare function vitestSummaryShapeOk(v: unknown): v is VitestRunSummary;
//# sourceMappingURL=test-delta.d.ts.map