/**
 * Cross-clone run claims (night-3 goal 1, fallback design). One engine runs
 * per checkout (factoryRepoOwnerPath): the tamper snapshot covers the whole
 * common git dir, so a second engine in the same checkout would look like
 * lane tampering to the first. Parallel runs therefore need separate clones.
 * Separate clones of one repository do not see each other's run state, so
 * two of them could start the same item; the claim prevents that on one host.
 *
 * A claim is `<ledgerDir>/claims/<repo>/run-<key>.owner`, outside every
 * checkout (the engine ledger's directory, which the lane sandbox denies),
 * with the owner-file semantics of state.ts (claimOwner): a live pid on this
 * host holds it, another host's owner refuses, a dead pid is taken over.
 * `<repo>` hashes the forge repository's identity (repoIdentity), so every
 * clone of one repository shares the directory. A claim is never a trust
 * anchor: a lane that could write it could only block an item or let a second
 * clone start it, which ends at the forge's pr-exists gate.
 */
import { type FactoryOwner, type FactoryRunKey, type OwnerDeps } from './state.js';
/**
 * The claim directory's key: the repoIdentity of the forge repository. A
 * local path (the local forge's mirror) is resolved against the checkout
 * first, so a relative path never names two repositories.
 */
export declare function claimRepoKey(repoUrl: string, root: string): string;
export declare function factoryClaimPath(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey): string;
/** Claim `key` of the repository for the engine in `root`; a live claim from any checkout refuses (FactoryBusyError). */
export declare function acquireFactoryClaim(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, now: string, deps?: OwnerDeps): {
    release: () => void;
    tookOver?: FactoryOwner;
};
/** The live claim on `key`, if any (read-only; acquireFactoryClaim stays the binding check). */
export declare function factoryClaimHolder(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, deps?: OwnerDeps): FactoryOwner | 'unreadable' | null;
//# sourceMappingURL=claims.d.ts.map