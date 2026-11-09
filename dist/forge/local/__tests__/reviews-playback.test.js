/**
 * Night 3 goal 2 (L2a): the local forge's played-back reviews. Records live
 * in the engine-owned store (`<store>/prs/<n>/reviews.jsonl`); feedback reads
 * each author's latest record as the decision and the head's non-approving
 * records with text as open threads.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localReviewFeedback } from '../reviews.js';
import { appendLocalReview, localReviewsPath, MAX_LOCAL_REVIEW_CHARS, readLocalReviews } from '../store.js';
const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
let store;
beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'omg-local-playback-'));
});
afterEach(() => {
    rmSync(store, { recursive: true, force: true });
});
const rec = (o) => ({
    version: 1, id: `id-${Math.random().toString(16).slice(2)}`, pr: 3, author: 'robin', state: 'commented', body: 'note', head: HEAD, at: '2026-11-09T10:00:00.000Z', ...o,
});
describe('local review records', () => {
    it('append and read back in order; an absent file is no records', () => {
        expect(readLocalReviews(store, 3)).toEqual([]);
        const a = rec({ id: 'a' });
        const b = rec({ id: 'b', state: 'approved', body: '' });
        appendLocalReview(store, a);
        appendLocalReview(store, b);
        expect(readLocalReviews(store, 3)).toEqual([a, b]);
        expect(localReviewsPath(store, 3)).toBe(join(store, 'prs', '3', 'reviews.jsonl'));
    });
    it('refuses a malformed record, an over-long text, and a malformed line on read', () => {
        expect(() => appendLocalReview(store, rec({ head: 'HEAD' }))).toThrow(/malformed/);
        expect(() => appendLocalReview(store, rec({ author: '' }))).toThrow(/malformed/);
        expect(() => appendLocalReview(store, rec({ body: 'x'.repeat(MAX_LOCAL_REVIEW_CHARS + 1) }))).toThrow(/over/);
        mkdirSync(join(store, 'prs', '3'), { recursive: true });
        writeFileSync(localReviewsPath(store, 3), `${JSON.stringify(rec({}))}\n{"version":1,"pr":4}\n`);
        expect(() => readLocalReviews(store, 3)).toThrow(/record 2 .* malformed/);
        writeFileSync(localReviewsPath(store, 3), 'not json\n');
        expect(() => readLocalReviews(store, 3)).toThrow(/record 1 .* not valid JSON/);
    });
    it('never goes through a symbolic link (or a junction) below the store', () => {
        const elsewhere = mkdtempSync(join(tmpdir(), 'omg-local-playback-target-'));
        try {
            mkdirSync(join(store, 'prs'), { recursive: true });
            symlinkSync(elsewhere, join(store, 'prs', '3'), 'junction');
            expect(() => appendLocalReview(store, rec({}))).toThrow(/symbolic link/);
            expect(() => readLocalReviews(store, 3)).toThrow(/symbolic link/);
        }
        finally {
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });
});
describe('localReviewFeedback', () => {
    it('latest record per author is the decision; open threads are the head\'s non-approving records with text', () => {
        const records = [
            rec({ id: 'r1', state: 'changes-requested', body: 'Rename the flag.', head: OLD }),
            rec({ id: 'r2', state: 'commented', body: 'And add a test.' }),
            rec({ id: 'r3', author: 'dana', state: 'approved', body: 'lgtm' }),
            rec({ id: 'r4', author: 'dana', state: 'commented', body: '   ' }),
        ];
        expect(localReviewFeedback(records, HEAD)).toEqual({
            decisions: [
                { author: 'robin', state: 'commented', at: '2026-11-09T10:00:00.000Z', head: HEAD },
                { author: 'dana', state: 'commented', at: '2026-11-09T10:00:00.000Z', head: HEAD },
            ],
            threads: [{ id: 'r2', author: 'robin', body: 'And add a test.', at: '2026-11-09T10:00:00.000Z' }],
            pendingReviewers: [],
            ignored: [],
        });
        // On the old head, its request is the open thread.
        expect(localReviewFeedback(records, OLD).threads.map((t) => t.id)).toEqual(['r1']);
    });
});
//# sourceMappingURL=reviews-playback.test.js.map