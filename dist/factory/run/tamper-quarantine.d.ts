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
 * change found by the recheck), compared with the snapshot taken by THIS run
 * before the lane or prepare (RepoSnapshot.restore keeps the bytes):
 * - hooks/ and info/ (not info/refs): every file added or changed is copied
 *   into `<ledgerDir>/quarantine/<repo>/<stamp>/`, then the snapshot's bytes
 *   are written back (an added file is removed); a deleted file is restored.
 * - config and config.worktree: copied into the quarantine always; put back
 *   from the snapshot only when an added or changed key is one that can run
 *   a program or redirect git (PROGRAM_KEYS: core.hooksPath, core.fsmonitor,
 *   alias.*, filter.*, include.*, url.*.insteadOf, ...). A user's own
 *   `git push -u`, `git remote add` or `git config user.email` during the run
 *   changes only other keys, so it is left in place (no clobbering).
 * - refs: a created refs/replace/* is deleted (its value saved); every other
 *   ref change is only listed with the update-ref command that undoes it,
 *   because the user's own commit or branch switch during a run moves refs
 *   too, and moving those back would hide their work.
 * Everything is copied before anything is changed; when a copy fails nothing
 * is changed and the result says so. Nothing is deleted that is not first
 * in the quarantine. A file the snapshot holds only as a hash (over 1 MiB)
 * is quarantined but cannot be restored; the result names it.
 *
 * The hold (`<ledgerDir>/holds/<repo>.json`) makes `omg factory run`, the
 * poller's auto-start and the engine refuse (exit 6) with the quarantine
 * path, until `omg factory run release --tamper` (a human) prints what was
 * quarantined and removes it. An unreadable hold counts as held.
 */
import { type RepoSnapshot } from './review-guard.js';
/** The checkout's key under quarantine/ and holds/ (the ledger's own per-root key). */
export declare const repoKey: (root: string) => string;
export declare const tamperHoldPath: (ledgerDir: string, root: string) => string;
export declare const RELEASE_TAMPER_COMMAND = "omg factory run release --tamper";
export interface TamperHold {
    root: string;
    at: string;
    run: string;
    gate: string;
    /** The quarantine folder, absent when nothing could be copied there. */
    quarantine?: string;
    moved: string[];
    restored: string[];
    notRestored: string[];
    refs: string[];
    failed?: string;
}
export interface QuarantineInput {
    ledgerDir: string;
    root: string;
    before: RepoSnapshot;
    /** The refs as they are now (the after-snapshot's, or read again). */
    refsNow?: Record<string, string>;
    /** Only these refs count (the ones the tamper compare reported); omitted = every difference. */
    onlyRefs?: readonly string[];
    run: string;
    gate: string;
    at: string;
}
/**
 * Quarantine and restore after a tamper (see the module comment), then
 * write the hold. Never throws: a failure is in `failed`, and the hold is
 * still written when it can be.
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