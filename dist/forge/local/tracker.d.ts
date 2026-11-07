/**
 * The local forge's tracker (offline forge plan §1.1): the backlog directory.
 * A run reads items at the verified base commit (`git ls-tree` + `git show`
 * through the caller's guarded Exec), so they are authorTrusted. With
 * `workingTree` (check, board, enqueue) it also reads the files on disk: an
 * item that is missing from, or differs at, the base commit is `uncommitted`
 * and untrusted. Comments and progress are written for the human under
 * `.omg/factory/local/items/<id>/`; enqueue writes backlog files that the
 * human commits.
 */
import type { Exec } from '../../ship/exec.js';
import { type ForgeTracker, type LocalTrackerOptions } from '../types.js';
export interface LocalTrackerContext {
    exec: Exec;
    root: string;
    /** factory.forge.local.backlogDir (repo-relative, `/`-separated). */
    backlogDir: string;
    /** ForgeItem.repoUrl (the mirror). */
    repoUrl: string;
    /** `<omgRoot>/factory/local` (ForgeOptions.local.omgRoot). */
    humanDir: string;
    options: LocalTrackerOptions;
    /** enqueue's body directory: createItem/updateItem read a body file only directly in it. */
    trackerBodyDir?: string;
}
export declare function localTracker(ctx: LocalTrackerContext): ForgeTracker;
//# sourceMappingURL=tracker.d.ts.map