/**
 * What the engine does after a detected tamper of the shared git dir (audit
 * M3): quarantine what changed, put the snapshot's bytes back where that is
 * safe, and hold every new run in this checkout until a human clears it.
 *
 * Before, a lane-tampered park left the planted hook, config key or ref in
 * `.git`: the user's next commit or checkout ran it, and the next run took
 * the tampered state as its baseline.
 *
 * Now, on lane-tampered, review-tampered and prepare-tampered (and a late
 * change found by the recheck), after the lane's process tree was killed,
 * compared with the snapshot taken by THIS run before the lane or prepare
 * (RepoSnapshot.restore keeps the bytes, restorableFiles), item by item:
 * - hooks/ and info/ (not info/refs) of the common git dir and of every
 *   submodule git dir under modules/: every file added or changed is saved
 *   into `<ledgerDir>/quarantine/<repo>/<stamp>/` and the snapshot's bytes
 *   are written back (an added file is removed); a deleted file is restored.
 * - config, config.worktree, every worktrees/<id>/config.worktree and the
 *   submodules' config files: saved into the quarantine always. When every
 *   added, changed or removed key is on BENIGN_KEYS (keys that name no
 *   program: user.*, a branch's upstream, a remote's URLs and refspecs...)
 *   the file stays as it is: that is what a user's own `git push -u`,
 *   `git remote add` or `git config user.email` during the run writes. Any
 *   other key counts as program-running (an allowlist, so a key git adds
 *   later, or one like diff.external, is never missed): its old values are
 *   put back (`git config --file` on a copy; the whole old file when that
 *   cannot be done), and the undo command for the user's own change is in
 *   undo.txt.
 * - refs: a created refs/replace/* is deleted (its value saved); every other
 *   ref change is only listed with the update-ref command that undoes it,
 *   because the user's own commit or branch switch during a run moves refs
 *   too, and moving those back would hide their work.
 * Each item on its own: a copy that fails (a file the lane made unreadable)
 * renames the item into the quarantine (or `<name>.omg-quarantined` next to
 * it on another volume), which needs no read; an item that can be neither
 * saved nor restored is named STILL ACTIVE, and the rest go on. Nothing is
 * deleted that is not first saved. A restore writes a temporary file next to
 * the target and renames it over (atomic), and leaves the item alone while
 * git holds its `.lock`. A file the snapshot holds only as a hash (over
 * 1 MiB, unreadable) or a link is moved away but not written back.
 *
 * Every compare problem that is not a ref change, an allowlisted config
 * change, a change the restore above undid, or a change that runs nothing
 * (the main checkout's files or HEAD, another worktree's HEAD, a removed
 * worktree or submodule) is named STILL ACTIVE with what to do: the global
 * git config and its include targets, objects/info/alternates, the shallow
 * file, links in place of directories, the main checkout's .env / .npmrc /
 * node_modules/.bin, a snapshot that failed.
 *
 * The hold is set unless only refs (not replace refs), allowlisted config
 * keys and changes that run nothing were found. The hold
 * (`<ledgerDir>/holds/<repo>.json`) makes `omg factory run`, the poller's
 * auto-start and the engine refuse (exit 6) with the quarantine path, until
 * `omg factory run release --tamper` (a human) prints what was quarantined
 * and removes it. An unreadable hold counts as held.
 *
 * Parameterised by the snapshot's common git dir and the checkout root only,
 * so a run whose lanes work in another repository (a private store) passes
 * that repository's snapshot; the hold stays keyed on the checkout.
 */
import { type RepoSnapshot } from './review-guard.js';
/** The checkout's key under quarantine/ and holds/ (the ledger's own per-root key). */
export declare const repoKey: (root: string) => string;
export declare const tamperHoldPath: (ledgerDir: string, root: string) => string;
export declare const RELEASE_TAMPER_COMMAND = "omg factory run release --tamper";
/** The prefix of every `active` entry. */
export declare const STILL_ACTIVE = "STILL ACTIVE (it can run on your next git command)";
export interface TamperHold {
    root: string;
    at: string;
    run: string;
    gate: string;
    /** The quarantine folder, absent when nothing was saved there. */
    quarantine?: string;
    moved: string[];
    restored: string[];
    notRestored: string[];
    refs: string[];
    /** Config files left as they are: only allowlisted keys changed. */
    kept?: string[];
    /** What is still in place and can run code or steer git, with what to do. */
    active?: string[];
    /** How to put the user's own change back, per item (also undo.txt in the quarantine). */
    undo?: string[];
    failed?: string;
    /** True when the hold was set; false: only listed and copied. */
    held?: boolean;
}
/**
 * Config keys that name no program and make git load nothing (as `git config
 * --list` prints them: section and key lowercased, subsection kept). A
 * change to any other key is put back. Each with why it is safe:
 */
export declare const BENIGN_KEYS: readonly {
    re: RegExp;
    why: string;
}[];
export declare const benignKey: (key: string) => boolean;
export interface QuarantineInput {
    ledgerDir: string;
    root: string;
    before: RepoSnapshot;
    /** The after-snapshot when there is one (decides whether a worktree entry change runs anything). */
    after?: RepoSnapshot;
    /** The refs as they are now (the after-snapshot's, or read again). */
    refsNow?: Record<string, string>;
    /** Only these refs count (the ones the tamper compare reported); omitted = every difference. */
    onlyRefs?: readonly string[];
    /** The compare's problems: each not handled here is named STILL ACTIVE and holds. */
    problems?: readonly string[];
    run: string;
    gate: string;
    at: string;
}
/**
 * Quarantine and restore after a tamper (see the module comment), then
 * write the hold. Never throws: a failure is in `failed` or `active`, and
 * the hold is still written when it can be.
 */
export declare function quarantineTamper(i: QuarantineInput): TamperHold;
export declare function writeTamperHold(ledgerDir: string, root: string, hold: TamperHold): void;
/** The hold on this checkout: null when there is none; `unreadable` when the file exists but does not parse (held). */
export declare function readTamperHold(ledgerDir: string, root: string): TamperHold | 'unreadable' | null;
/** The refusal text while a hold exists, or null. */
export declare function tamperHoldMessage(ledgerDir: string, root: string): string | null;
/** `release --tamper`: the hold's report lines, after the hold file is removed; null when there was none. */
export declare function releaseTamperHold(ledgerDir: string, root: string): string[] | null;
//# sourceMappingURL=tamper-quarantine.d.ts.map