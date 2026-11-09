/**
 * Night 3 goal 2 (L2a), fix round 2: the typed review-read errors say what was
 * cut and how to unblock it, carry a stable `code`, and single-line sinks
 * render newline, carriage return and tab visibly.
 */
import { describe, expect, it } from 'vitest';
import { ReviewFeedbackError, ReviewFeedbackTruncatedError, ReviewHeadMovedError, assertReviewHead, visibleLine, visibleText } from '../review-feedback.js';
describe('ReviewFeedbackTruncatedError: an actionable message per list', () => {
    it('threads: names the 100 limit, that resolved and outdated count, and how to unblock', () => {
        expect(new ReviewFeedbackTruncatedError(7, 'reviewThreads').message).toBe('PR #7: more than 100 review threads (resolved and outdated ones count), so human feedback cannot be read completely. Delete the spam threads or lock the conversation on the forge, then rerun.');
    });
    it('reviews, review requests and a long thread each get their own sentence', () => {
        expect(new ReviewFeedbackTruncatedError(7, 'latestReviews').message).toMatch(/^PR #7: more than 50 latest reviews, .*Dismiss or delete the surplus reviews on the forge, then rerun\.$/);
        expect(new ReviewFeedbackTruncatedError(7, 'reviewRequests').message).toMatch(/^PR #7: more than 20 pending review requests, .*Remove the surplus review requests on the forge, then rerun\.$/);
        expect(new ReviewFeedbackTruncatedError(7, 'comments of thread PRRT_1').message).toMatch(/^PR #7: comments of thread PRRT_1 has more than 20 comments, .*Resolve the thread or trim its comments on the forge, then rerun\.$/);
    });
    it('an unknown list still fails with a generic unblock sentence, and a hostile name is shown visibly', () => {
        const message = new ReviewFeedbackTruncatedError(7, 'x\ny').message;
        expect(message).toContain('x<U+000A>y has more entries than one read returns');
        expect(message).not.toContain('\n');
    });
});
describe('error codes', () => {
    it('are stable per class', () => {
        expect(new ReviewFeedbackError('m').code).toBe('review-feedback');
        expect(new ReviewFeedbackTruncatedError(1, 'reviewThreads').code).toBe('review-feedback-truncated');
        expect(new ReviewHeadMovedError(1, 'a', 'b').code).toBe('review-head-moved');
    });
    it('ReviewHeadMovedError renders both heads visibly on one line', () => {
        const error = new ReviewHeadMovedError(3, 'abc\n\u202Edef', 'x\ty');
        expect(error.message).toBe('PR 3 head moved: asked about abc<U+000A><U+202E>def, the forge reports x<U+0009>y');
        expect(error.expected).toBe('abc\n\u202Edef');
    });
    it('assertReviewHead still throws the moved error with its code', () => {
        const head = 'a'.repeat(40);
        expect(() => assertReviewHead(2, head, 'b'.repeat(40))).toThrow(expect.objectContaining({ code: 'review-head-moved' }));
    });
});
describe('visibleLine', () => {
    it('shows newline, carriage return and tab as <U+XXXX> and keeps what visibleText shows', () => {
        expect(visibleLine('a\nb\rc\td')).toBe('a<U+000A>b<U+000D>c<U+0009>d');
        expect(visibleLine('a\u202Eb\u200Bc\u001B[31m')).toBe(visibleText('a\u202Eb\u200Bc\u001B[31m'));
        expect(visibleLine('a\u202Eb\nc')).toBe('a<U+202E>b<U+000A>c');
    });
    it('visibleText still keeps tab and newline', () => {
        expect(visibleText('a\nb\tc')).toBe('a\nb\tc');
    });
});
//# sourceMappingURL=review-feedback.test.js.map