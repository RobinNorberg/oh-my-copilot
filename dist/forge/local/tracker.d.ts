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
    /**
     * F31: the item's merged local PR in the engine-owned PR store, if any. An
     * item whose PR merged reads as closed (as a GitHub issue closes at the
     * merge), while its backlog file still says `state: open` until the human
     * commits the change; a warning names the file. `mergedHead` is the PR
     * head the merge was detected at: a later commit on the base that changes
     * the file's `state:` line (a reopen) wins over the merge; other edits do not.
     * Known limit: the pickaxe (`-G^state:`) also matches a body line that starts
     * with `state:`, which then reads as a reopen; telling the two apart needs the
     * hit's parent version, a git read neither exec guard allows yet.
     */
    mergedPr?: (id: number) => {
        number: number;
        mergedHead?: string;
    } | undefined;
}
export declare function localTracker(ctx: LocalTrackerContext): ForgeTracker;
//# sourceMappingURL=tracker.d.ts.map