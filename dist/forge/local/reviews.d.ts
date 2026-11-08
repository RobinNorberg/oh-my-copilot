/**
 * The local forge's PRs (offline forge plan §1.1): numbers and states in the
 * engine-owned JSON store, heads and bases read from the bare mirror's refs.
 * A PR turns MERGED when its head is an ancestor of the mirror's base (the
 * human merged it and the next run/poll synced the base). Bodies and
 * comments are written for the human under `.omg/factory/local/prs/<n>/`.
 * There are no review threads (listThreads is omitted).
 */
import type { Exec } from '../../ship/exec.js';
import type { ForgeReviews } from '../types.js';
import { type LocalPr } from './store.js';
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
export declare function localReviews(ctx: LocalReviewsContext): ForgeReviews & {
    refreshPr(pr: LocalPr): LocalPr;
};
//# sourceMappingURL=reviews.d.ts.map