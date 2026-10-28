/**
 * Failure signatures (design §2): the dedupe key of a red CI run. Per failed
 * job: the job name plus the sorted `file > title` set from parseFailingTests,
 * or, with no FAIL line, the failing step plus the first `##[error]` line with
 * timestamps, durations, hex ids and runner temp paths normalized away. The
 * run signature is the sha256 of the sorted job signatures; sig8 is its first
 * 8 hex characters.
 */
import type { ParsedJob } from './logs.js';
/** Strip the parts of an error line that differ between two runs of the same failure. */
export declare function normalizeErrorLine(line: string): string;
export declare function jobSignature(job: Pick<ParsedJob, 'name' | 'failingTests' | 'failedSteps' | 'firstError'>): string;
export interface RunSignature {
    signature: string;
    sig8: string;
    jobs: string[];
}
export declare function runSignature(jobs: readonly Pick<ParsedJob, 'name' | 'failingTests' | 'failedSteps' | 'firstError'>[]): RunSignature;
//# sourceMappingURL=signature.d.ts.map