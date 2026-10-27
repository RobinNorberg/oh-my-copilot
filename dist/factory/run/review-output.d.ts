/**
 * The review lane's output contract (design §5): the final assistant message
 * ends with exactly one fenced `json` block
 *
 *   { "verdict": "approve" | "request-changes", "sha": "<40 hex>",
 *     "findings": [{ "severity": "blocker"|"major"|"minor"|"nit", "file"?, "line"?, "summary" }],
 *     "notes"?: "<= 500 chars" }
 *
 * The lane reads untrusted PR content, so anything off-contract is `invalid`
 * (no verdict recorded): no block, two blocks (a quoted block could be the
 * PR's), text after the block, a wrong sha, bad fields. An approve carrying a
 * blocker or major finding counts as changes-requested (fail closed).
 */
import type { FactoryFinding } from './state.js';
export declare const MAX_REVIEW_NOTES = 500;
export type ParsedReview = {
    kind: 'valid';
    verdict: 'approve' | 'changes-requested';
    sha: string;
    findings: FactoryFinding[];
    notes: string;
    downgraded: boolean;
} | {
    kind: 'invalid';
    reason: string;
};
export declare function parseReviewOutput(finalText: string | null | undefined, expectedSha: string): ParsedReview;
/** One-line ship verdict notes: the top findings by severity. */
export declare function verdictNotes(review: Extract<ParsedReview, {
    kind: 'valid';
}>): string;
/** The PR comment the engine posts for a recorded review. */
export declare function reviewComment(review: Extract<ParsedReview, {
    kind: 'valid';
}>, reviewer: string): string;
//# sourceMappingURL=review-output.d.ts.map