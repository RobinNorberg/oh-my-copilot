/**
 * The local forge's PRs (offline forge plan §1.1): numbers and states in the
 * engine-owned JSON store, heads and bases read from the bare mirror's refs.
 * A PR turns MERGED when its head is an ancestor of the mirror's base (the
 * human merged it and the next run/poll synced the base). Bodies and
 * comments are written for the human under `.omg/factory/local/prs/<n>/`.
 * There are no review threads (listThreads is omitted). Human review is
 * played back: `omg factory pr review` appends a record to the engine-owned
 * `<store>/prs/<n>/reviews.jsonl` (store.ts), which reviewFeedback reads.
 */
import type { Exec } from '../../ship/exec.js';
import type { ForgeReviewFeedback, ForgeReviews } from '../types.js';
import { type LocalPr, type LocalReviewRecord } from './store.js';
export interface LocalReviewsContext {
    exec: Exec;
    /** The user's checkout (the merge happens there). */
    root: string;
    /** The bare mirror. */
    mirror: string;
    /** The PR store file. */
    storePath: string;
    /** `<omgRoot>/factory/local` (ForgeOptions.local.omgRoot): bodies and comments for the human. */
    humanDir: string;
}
export declare const localPrUrl: (pr: number) => string;
/**
 * Played-back reviews as forge feedback at `head`: each author's latest
 * record is their decision; a record with text, given on `head`, that does
 * not approve is an open thread (one given on an older head was answered by
 * the push since). The author is whoever ran the command: the records live
 * outside every lane-writable root, so nobody is ignored and nobody is pending.
 */
export declare function localReviewFeedback(records: readonly LocalReviewRecord[], head: string): ForgeReviewFeedback;
export declare function localReviews(ctx: LocalReviewsContext): ForgeReviews & {
    refreshPr(pr: LocalPr): LocalPr;
};
//# sourceMappingURL=reviews.d.ts.map