/**
 * Cross-clone run claims (night-3 goal 1, fallback design). One engine runs
 * per checkout (factoryRepoOwnerPath): the tamper snapshot covers the whole
 * common git dir, so a second engine in the same checkout would look like
 * lane tampering to the first. Parallel runs therefore need separate clones.
 * Separate clones of one repository do not see each other's run state, so
 * two of them could start the same item; the claim prevents that on one host
 * (with one OMC_STATE_DIR: the claims live in its ledger dir).
 *
 * A claim is `<ledgerDir>/claims/<repo>/run-<key>.owner`, outside every
 * checkout (the engine ledger's directory, which the lane sandbox denies).
 * `<repo>` hashes the repository's identity (claimRepoKey over the trusted
 * origin remote, trustedFactoryClaimRepo), so every clone of one repository
 * shares the directory. The local forge makes no claim (its mirror is per
 * checkout). The claim lives as long as the run is not terminal:
 * - a live engine holds it (pid, host and start identity, as state.ts's
 *   owner files);
 * - when the engine stops before a terminal phase (a park, an error) it
 *   rewrites the claim without a pid ("parked"); a crash leaves its dead pid.
 *   Either way the claim stays held while the run state of its checkout
 *   (`<root>`'s run-<key>.json) exists and is not terminal. That state is
 *   read only as its engine sealed it (its integrity and its engine ledger
 *   entry in the shared ledger dir), so a lane of that checkout cannot free
 *   the claim by writing a terminal phase; a missing or unreadable root, a
 *   state that fails those checks or is gone though its engine wrote it,
 *   keeps the claim held too, and is reported;
 * - it is deleted at a terminal phase, by `omg factory run clean` / `reset`
 *   of the same checkout, and by `omg factory run release` (a human).
 * The claiming checkout itself always takes its own parked claim back (a
 * resume). A claim is never a trust anchor: a lane that could write it could
 * only block an item or let a second clone start it, which then stops at the
 * forge's pr-exists gate once the first clone pushed.
 */
import { type Exec } from '../../ship/exec.js';
import { type FactoryOwner, type FactoryRunKey, type OwnerDeps } from './state.js';
/**
 * The repository a claim is keyed on: the origin remote's URL (`git remote
 * get-url origin`, read-only, the same trusted origin the forge config is
 * derived from), or null without an origin. Needs no forge config, so heal
 * runs and `run clean` / `reset` / `release` key their claims the same way.
 * A FactorySafetyError of a hardened exec (trustedFactoryClaimRepo) is
 * thrown, never read as "no origin".
 */
export declare function factoryClaimRepo(exec: Exec, root: string): string | null;
/**
 * factoryClaimRepo through the engine's hardened git (no hooks, no
 * fsmonitor: hardenedGitExec over the ledger dir's empty hooks dir). The
 * one origin read for a claim key: the engine and the omg factory run CLI
 * both use it, over the raw exec.
 */
export declare function trustedFactoryClaimRepo(exec: Exec, root: string, ledgerDir: string): string | null;
/**
 * The claim directory's key: the repoIdentity of the repository, with
 * github.com aliases folded; a local path (an origin that is another
 * directory) is resolved against the checkout and canonicalized
 * (canonicalPath), so one directory never gets two keys.
 */
export declare function claimRepoKey(repoUrl: string, root: string, platform?: NodeJS.Platform): string;
export declare function factoryClaimsDir(ledgerDir: string, repoUrl: string, root: string): string;
export declare function factoryClaimPath(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey): string;
/** A claim file as written: a live engine's owner record, or a parked one (no pid). */
export type ClaimRecord = Partial<FactoryOwner> & {
    parkedAt?: string;
};
/** Why a claim is held: a live engine, a parked or crashed run of another checkout, or a file / root / state nobody can read. */
export interface ClaimHold {
    state: 'live' | 'parked' | 'unreadable';
    path: string;
    claim: ClaimRecord | null;
    why: string;
    /** The claim's checkout is another folder that resolves to this checkout's state root (claimSharesState). */
    sharedState?: true;
}
/**
 * A claim's `root`, only when it is a plain local absolute, normalized path
 * (it is data from a file, never a path to trust as given): no UNC or device
 * path (`\\server`, `//server`, `\\?\`, `\\.\`), which a stat would reach
 * over the network, no relative path, no control character. Checked before
 * anything stats it.
 */
export declare function claimRoot(root: unknown): string | null;
/** The warning a busy message carries when the holder's checkout shares this checkout's state root. */
export declare const SHARED_STATE_WARNING = "WARNING: that checkout shares this checkout's state root (with OMC_STATE_DIR set, parallel clones need distinct folder names)";
/** The claim holding `key` against the engine of `root`, or null (read-only; acquireFactoryClaim stays the binding check). */
export declare function factoryClaimHolder(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, deps?: OwnerDeps, platform?: NodeJS.Platform): ClaimHold | null;
/** The busy message of a held claim; it names the claim file and how a human clears a claim nobody holds. */
export declare function claimBusyMessage(key: FactoryRunKey, hold: ClaimHold): string;
/** A held claim: release() deletes it, park() rewrites it without a pid (the run stopped before a terminal phase); both only while it is still this process's. */
export interface HeldClaim {
    release: () => void;
    park: (at: string) => void;
    tookOver?: ClaimRecord;
}
/** Claim `key` of the repository for the engine in `root`; a held claim (factoryClaimHolder) refuses with a FactoryBusyError. */
export declare function acquireFactoryClaim(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, now: string, deps?: OwnerDeps, platform?: NodeJS.Platform): HeldClaim;
/**
 * The engine's end of a run in `root`: a terminal phase or a run that never
 * started (no state) releases the claim; any other phase parks it. The phase
 * counts only as the engine sealed it (runPhase: its ledger entry under
 * `ledgerDir` matches and the integrity seal holds), so a lane that wrote a
 * terminal phase after the engine's last write never frees it (L3); a state
 * that cannot be read or told parks it too: it may hide a run in flight.
 */
export declare function settleFactoryClaim(claim: HeldClaim, root: string, key: FactoryRunKey, ledgerDir: string, at: string): 'released' | 'parked';
/**
 * Delete the claim on `key` unless a live engine holds it (FactoryBusyError).
 * `onlyRoot`: only a claim of that checkout (run clean / reset); without it,
 * any claim nobody runs (omg factory run release, a human decision). Returns
 * the deleted path, or null when there was nothing to delete.
 */
export declare function removeFactoryClaim(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, o?: {
    onlyRoot?: boolean;
    deps?: OwnerDeps;
    platform?: NodeJS.Platform;
}): string | null;
/** A claim `run status` lists: one that holds against this checkout, or this checkout's own (`here`: its run resumes it). */
export type ListedClaim = {
    key: FactoryRunKey;
    state: ClaimHold['state'] | 'here';
    path: string;
    claim: ClaimRecord | null;
    sharedState?: true;
};
/** Every claim of the repository that holds against the engine of `root`, and `root`'s own; a free one is left out (read-only). */
export declare function listFactoryClaims(ledgerDir: string, repoUrl: string, root: string, deps?: OwnerDeps, platform?: NodeJS.Platform): ListedClaim[];
//# sourceMappingURL=claims.d.ts.map