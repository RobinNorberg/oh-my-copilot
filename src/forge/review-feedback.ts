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
export class ReviewFeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewFeedbackError';
  }
}

/** A list in the answer had more entries than one read returns (threads, comments, reviews or requests): input may be hidden. */
export class ReviewFeedbackTruncatedError extends ReviewFeedbackError {
  constructor(readonly pr: number, readonly what: string) {
    super(`review feedback of PR ${pr} is truncated (${what} has more entries than one read returns); review it on the forge`);
    this.name = 'ReviewFeedbackTruncatedError';
  }
}

/** The PR's head is not the head the caller asked about: the feedback would describe another commit. */
export class ReviewHeadMovedError extends ReviewFeedbackError {
  constructor(readonly pr: number, readonly expected: string, readonly actual: string) {
    super(`PR ${pr} head moved: asked about ${expected.slice(0, 40)}, the forge reports ${actual.slice(0, 40) || 'no head'}`);
    this.name = 'ReviewHeadMovedError';
  }
}

/** A full lowercase commit sha. */
export const REVIEW_HEAD = /^[0-9a-f]{40}$/;

/** Throws unless `head` is a full sha equal to the forge's `actual` head. */
export function assertReviewHead(pr: number, head: string, actual: unknown): void {
  if (!REVIEW_HEAD.test(head)) throw new ReviewFeedbackError(`review feedback of PR ${pr}: ${JSON.stringify(head.slice(0, 60))} is not a full commit sha`);
  if (actual !== head) throw new ReviewHeadMovedError(pr, head, typeof actual === 'string' ? actual : '');
}

/**
 * Review or lane text for a terminal: format characters (bidi overrides and
 * isolates, zero-width spaces and joiners, the BOM, every other \p{Cf}) and
 * line/paragraph separators are shown as `<U+XXXX>`, so trojan-source text
 * cannot look harmless; every other control character but tab and newline is
 * dropped (an ANSI escape loses its ESC).
 */
export const visibleText = (text: string): string =>
  text
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`)
    .replace(/(?![\t\n])\p{Cc}/gu, '');
