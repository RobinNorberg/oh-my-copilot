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
 * origin remote, factoryClaimRepo), so every clone of one repository shares
 * the directory. The claim lives as long as the run is not terminal:
 * - a live engine holds it (pid, host and start identity, as state.ts's
 *   owner files);
 * - when the engine stops before a terminal phase (a park, an error) it
 *   rewrites the claim without a pid ("parked"); a crash leaves its dead pid.
 *   Either way the claim stays held while the run state of its checkout
 *   (`<root>`'s run-<key>.json) exists and is not terminal; a missing or
 *   unreadable root or state keeps it held too, and is reported;
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
 * derived from), or null without an origin (no cross-clone claim: the local
 * forge's mirror is per checkout). Needs no forge config, so heal runs and
 * `run clean` / `reset` / `release` key their claims the same way.
 */
export declare function factoryClaimRepo(exec: Exec, root: string): string | null;
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
}
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
};
/** Every claim of the repository that holds against the engine of `root`, and `root`'s own; a free one is left out (read-only). */
export declare function listFactoryClaims(ledgerDir: string, repoUrl: string, root: string, deps?: OwnerDeps, platform?: NodeJS.Platform): ListedClaim[];
//# sourceMappingURL=claims.d.ts.map