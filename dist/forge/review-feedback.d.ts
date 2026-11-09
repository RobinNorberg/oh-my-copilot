/**
 * Shared pieces of the human review read (ForgeReviews.reviewFeedback, factory
 * night 3 goal 2): the typed errors every forge throws when it cannot vouch for
 * the whole answer, and the sanitizer for printing review text on a terminal.
 *
 * The read decides whose words the factory obeys and whether a PR may merge,
 * so every uncertainty fails closed: a forge throws, never answers "no feedback".
 * A caller (the engine) parks the run awaiting a human on any throw.
 */
/** The review read could not be trusted as complete or current (base class: park, never "no feedback"). */
export declare class ReviewFeedbackError extends Error {
    constructor(message: string);
}
/** A list in the answer had more entries than one read returns (threads, comments, reviews or requests): input may be hidden. */
export declare class ReviewFeedbackTruncatedError extends ReviewFeedbackError {
    readonly pr: number;
    readonly what: string;
    constructor(pr: number, what: string);
}
/** The PR's head is not the head the caller asked about: the feedback would describe another commit. */
export declare class ReviewHeadMovedError extends ReviewFeedbackError {
    readonly pr: number;
    readonly expected: string;
    readonly actual: string;
    constructor(pr: number, expected: string, actual: string);
}
/** A full lowercase commit sha. */
export declare const REVIEW_HEAD: RegExp;
/** Throws unless `head` is a full sha equal to the forge's `actual` head. */
export declare function assertReviewHead(pr: number, head: string, actual: unknown): void;
/**
 * Review or lane text for a terminal: format characters (bidi overrides and
 * isolates, zero-width spaces and joiners, the BOM, every other \p{Cf}) and
 * line/paragraph separators are shown as `<U+XXXX>`, so trojan-source text
 * cannot look harmless; every other control character but tab and newline is
 * dropped (an ANSI escape loses its ESC).
 */
export declare const visibleText: (text: string) => string;
//# sourceMappingURL=review-feedback.d.ts.map