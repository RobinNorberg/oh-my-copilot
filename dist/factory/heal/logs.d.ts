/**
 * Job-log parsing for `omg factory heal` (design §3 step 1). CI logs are
 * untrusted input: they are only ever matched against fixed regexes here,
 * never evaluated or interpolated into a command, and every read is capped.
 * Failing tests, blockers and the known-flaky verdict come from
 * src/ship/gates.ts unchanged.
 */
import { type FailingTest } from '../../ship/gates.js';
import type { KnownFlakyTest } from '../../ship/config.js';
/** A log longer than this keeps its head (setup lines) and its tail (the failures). */
export declare const MAX_LOG_CHARS: number;
/** Lines longer than this are cut before any regex runs on them. */
export declare const MAX_LINE_CHARS = 4000;
/** Cap the log's size and its line lengths; the result is what every parser sees. */
export declare function capLog(log: string): string;
/** One log line without ANSI codes, the `job<TAB>step<TAB>` prefix and the timestamp. */
export declare function cleanLine(rawLine: string): string;
export interface JobEnv {
    image?: string;
    imageVersion?: string;
    runnerVersion?: string;
    git?: string;
    node?: string;
    npm?: string;
}
export declare const ENV_FIELDS: readonly ["image", "imageVersion", "runnerVersion", "git", "node", "npm"];
/**
 * Runner metadata from the "Set up job" group lines (`Image:`, the image
 * `Version:` after it, the provisioner `Version:`), `git version` from
 * checkout and `node:` / `npm:` from setup-node's environment details.
 * The first value of each field wins.
 */
export declare function parseJobEnv(log: string): JobEnv;
/** With `failedSteps`, only lines of those steps count: a test that prints `ETIMEDOUT` is not an infra failure. */
export declare function infraMatches(log: string, failedSteps?: readonly string[]): string[];
/** The first `##[error]` line, cleaned (the signature's fallback when no test failed). */
export declare function firstErrorLine(log: string): string | undefined;
export interface ParsedJob {
    jobId: string;
    name: string;
    failedSteps: string[];
    failingTests: FailingTest[];
    blockers: string[];
    knownFlaky: boolean;
    infra: string[];
    firstError?: string;
    env: JobEnv;
}
export declare function parseJob(job: {
    jobId: string;
    name: string;
    failedSteps: string[];
}, rawLog: string, known: readonly KnownFlakyTest[]): ParsedJob;
//# sourceMappingURL=logs.d.ts.map