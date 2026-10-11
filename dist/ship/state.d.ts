/**
 * Persisted `omg ship` run state: `.omg/state/ship/<pr>.json`, written
 * atomically under the repo's file lock so a run survives restarts and two
 * processes never interleave updates.
 *
 * Phases: review (awaiting the first independent verdict) -> fix (changes
 * requested; a fresh agent fixes, then the reviewer re-verifies) -> prepare
 * (approved; mechanical housekeeping) -> gates (CI watch) -> ready -> merged.
 * blocked is entered when the fix-round budget is spent or prepare hits a
 * conflict it may not resolve.
 */
export type ShipPhase = 'review' | 'fix' | 'prepare' | 'gates' | 'ready' | 'merged' | 'blocked';
export type VerdictKind = 'approve' | 'changes-requested';
export interface ShipVerdict {
    reviewer: string;
    verdict: VerdictKind;
    /** Full sha of the commit the reviewer was given. */
    sha: string;
    at: string;
    notes?: string;
}
export interface ShipHistoryEntry {
    at: string;
    from: ShipPhase | null;
    to: ShipPhase;
    note: string;
}
export interface ShipState {
    version: 1;
    pr: number;
    base: string;
    branch?: string;
    /** Lane that wrote the change; its verdicts are refused (no self-approval). */
    implementer: string;
    phase: ShipPhase;
    fixRounds: number;
    maxFixRounds: number;
    verdicts: ShipVerdict[];
    /** Commits `omg ship prepare` created (base merges, inventory regeneration). */
    housekeepingCommits: string[];
    /** Run id -> automatic reruns spent. */
    reruns: Record<string, number>;
    lastGates?: {
        verdict: string;
        at: string;
        failed: string[];
        pending: string[];
    };
    blockedReason?: string;
    history: ShipHistoryEntry[];
    createdAt: string;
    updatedAt: string;
    /** Earlier runs for this PR replaced by `init --force`, oldest first. */
    previousRuns?: Array<Omit<ShipState, 'previousRuns'>>;
    /**
     * sha256 over the rest of the state, written by the engine on every update
     * and re-checked before every update and by `merge`. Detects hand edits; it
     * is not a signature (anyone can recompute it), so it is not tamper-proof.
     */
    integrity?: string;
}
export declare class ShipStateError extends Error {
    constructor(message: string);
}
export declare function canTransition(from: ShipPhase, to: ShipPhase): boolean;
/** Move to `to`, appending history; throws ShipStateError on an illegal transition. */
export declare function transition(state: ShipState, to: ShipPhase, note: string, now: string): ShipState;
export declare function createShipState(input: {
    pr: number;
    base: string;
    branch?: string;
    implementer: string;
    maxFixRounds: number;
}, now: string): ShipState;
/**
 * Record an independent verdict. approve -> prepare; changes-requested ->
 * fix, or blocked once fixRounds would exceed maxFixRounds.
 */
export declare function recordVerdict(state: ShipState, verdict: ShipVerdict): ShipState;
export declare function latestVerdict(state: ShipState): ShipVerdict | undefined;
export declare function shipStatePath(repoRoot: string, pr: number): string;
/** sha256 of the state without its `integrity` field (key order as stored). */
export declare function computeIntegrity(state: ShipState): string;
export declare function sealShipState(state: ShipState): ShipState;
/** True when the stored integrity matches the content (false for a hand-edited or unsealed state). */
export declare function verifyShipIntegrity(state: ShipState): boolean;
/** Read and shape-check the state file; throws ShipStateError on malformed content. */
export declare function readShipState(repoRoot: string, pr: number): ShipState | null;
export interface UpdateShipStateOptions {
    /** Hand the mutator a state whose integrity check fails (owner-only `init --force`). */
    allowUnverified?: boolean;
}
/**
 * Read-modify-write under the state file's lock. `mutate` receives the
 * current state (null when none) and returns the next one, which is sealed
 * with a fresh integrity hash. A stored state that fails its integrity check
 * (hand-edited) is refused unless `allowUnverified`. `repoRoot` must be a git
 * work tree: elsewhere the state root would resolve under the home directory.
 */
export declare function updateShipState(repoRoot: string, pr: number, mutate: (current: ShipState | null) => ShipState, options?: UpdateShipStateOptions): ShipState;
//# sourceMappingURL=state.d.ts.map