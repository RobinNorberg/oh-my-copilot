/**
 * Persisted `omg factory run` state: `.omg/state/factory/run-<issue>.json`,
 * written with the ship pattern (src/ship/state.ts): read-modify-write under
 * the file lock, atomic write, sha256 `integrity` seal re-checked before every
 * update. A single-runner owner file `run-<issue>.owner` keeps two engines off
 * one issue. The seal is an unkeyed sha256 that anyone can recompute, so it
 * only catches accidental edits; the engine's defence against a lane that
 * rewrites the file is its own record of the bytes it wrote (ledger.ts).
 *
 * Phases (design §3, PR 2 scope): intake -> plan -> implement -> publish ->
 * review -> (fix -> publish -> review)* -> prepare. `gate` set means
 * awaiting-human: the phase is kept, and the next `omg factory run <issue>`
 * clears the gate and re-evaluates that phase. cancelled and failed are terminal.
 */
import type { ShipVerdict } from '../../ship/state.js';
export declare const FACTORY_PHASES: readonly ["intake", "plan", "implement", "publish", "review", "fix", "prepare", "cancelled", "failed"];
export type FactoryPhase = (typeof FACTORY_PHASES)[number];
export declare const TERMINAL_FACTORY_PHASES: readonly FactoryPhase[];
export type FactoryLaneKind = 'implement' | 'review' | 'fix';
export type FactoryLaneStatus = 'running' | 'completed' | 'failed' | 'lost' | 'cancelled';
export type FactoryLaneVerdict = 'approve' | 'changes-requested' | 'invalid';
export interface FactoryLaneRecord {
    id: string;
    kind: FactoryLaneKind;
    jobId?: string;
    /** The job's local Copilot child (pid and start identity), recorded at the first poll that reports it. */
    process?: {
        pid: number;
        identity: string | null;
    };
    worktree?: string;
    startSha: string;
    endSha?: string;
    status: FactoryLaneStatus;
    /** The AI-credit cap the lane was started with. */
    maxCredits: number;
    /** AI Credits is the unit; premiumRequests is legacy, kept for older readers. */
    usage?: {
        credits: number;
        premiumRequests: number;
        source: 'measured' | 'estimated';
    };
    verdict?: FactoryLaneVerdict;
    /**
     * sha256 of the ship verdict the engine recorded from this lane
     * (shipVerdictHash), written before the ship state: a ship verdict is
     * adopted only when a review lane the engine ran carries its hash.
     */
    verdictHash?: string;
    note?: string;
    startedAt: string;
    endedAt?: string;
}
export interface FactoryGate {
    name: string;
    reason: string;
    at: string;
}
export interface FactoryFinding {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    file?: string;
    line?: number;
    summary: string;
}
export interface FactoryHistoryEntry {
    at: string;
    from: FactoryPhase | null;
    to: FactoryPhase;
    note: string;
}
export interface FactoryRunState {
    version: 1;
    issue: number;
    repoUrl: string;
    base: string;
    branch: string;
    phase: FactoryPhase;
    gate?: FactoryGate;
    /** Issue snapshot taken at intake (title and body feed the lane prompts). */
    issueTitle?: string;
    issueBody?: string;
    /** `omg-plan: <repo path>` from the issue body, else the newest comment carrying one. */
    planLink?: string;
    plan?: {
        source: 'link' | 'issue-body';
        path?: string;
        blob?: string;
        text: string;
    };
    /** origin/<base> the implement lane started at. */
    baseSha?: string;
    pr?: number;
    implementer: string;
    /** Last head the engine pushed. */
    head?: string;
    /** A write lane's head waiting for publish. */
    pendingHead?: string;
    /** The last review's findings, fed to the next fix lane. */
    findings?: FactoryFinding[];
    lanes: FactoryLaneRecord[];
    /** Lane failures retried per phase key (`implement`, `review@<sha12>`, `fix@<round>`). */
    retries: Record<string, number>;
    /** Consecutive lost lanes per kind (a completed lane resets it). */
    lostStreak: Partial<Record<FactoryLaneKind, number>>;
    /** Wall time the engine spent on this run, across invocations. */
    elapsedMs: number;
    ciFixRounds: number;
    cancelRequested?: boolean;
    history: FactoryHistoryEntry[];
    createdAt: string;
    updatedAt: string;
    integrity?: string;
}
export declare class FactoryStateError extends Error {
    constructor(message: string);
}
export declare function implementerName(issue: number): string;
export declare function reviewerName(issue: number, jobId: string): string;
export declare function factoryBranch(issue: number): string;
export declare function factoryStateDir(root: string): string;
export declare function factoryStatePath(root: string, issue: number): string;
export declare function factoryOwnerPath(root: string, issue: number): string;
/** `omg factory run cancel` drops this file; the engine alone writes the state file. */
export declare function factoryCancelPath(root: string, issue: number): string;
export declare function factoryCancelRequested(root: string, issue: number): boolean;
/** The hash a review lane record keeps of the ship verdict the engine recorded from it. */
export declare function shipVerdictHash(v: Pick<ShipVerdict, 'reviewer' | 'verdict' | 'sha' | 'at' | 'notes'>): string;
export declare function createFactoryState(input: {
    issue: number;
    repoUrl: string;
    base: string;
}, now: string): FactoryRunState;
/** Move to `to` (clearing any gate), appending history. Terminal phases never move. */
export declare function moveTo(state: FactoryRunState, to: FactoryPhase, note: string, now: string): FactoryRunState;
/** Park at a named human gate; the phase stays so a rerun re-evaluates it. */
export declare function setGate(state: FactoryRunState, name: string, reason: string, now: string): FactoryRunState;
export declare function computeFactoryIntegrity(state: FactoryRunState): string;
export declare function verifyFactoryIntegrity(state: FactoryRunState): boolean;
/** Read and shape-check the state file; throws FactoryStateError on malformed content. */
export declare function readFactoryState(root: string, issue: number): FactoryRunState | null;
/** Parse and shape-check the bytes of a state file (read once by the caller). */
export declare function parseFactoryState(path: string, issue: number, raw: string): FactoryRunState;
/**
 * Read-modify-write under the state file's lock; the result is sealed. A
 * stored state failing its integrity check is refused (the run is `failed`
 * for the engine; a human replaces the file).
 */
export declare function updateFactoryState(root: string, issue: number, mutate: (current: FactoryRunState | null) => FactoryRunState, options?: {
    onWrite?: (path: string, content: string) => void;
    /**
     * Called under the lock with the exact bytes read (null: no file); throw
     * to refuse. `mutate` gets the state parsed from these same bytes, never
     * from a second read (the engine compares them with its ledger).
     */
    verify?: (bytes: Buffer | null) => void;
}): FactoryRunState;
/**
 * Seal and write `state` without the lock and without reading the file: the
 * engine's park at state-tampered, which must not depend on the current
 * bytes (or a lock file) that an unconfirmed lane may still be rewriting.
 */
export declare function overwriteFactoryState(root: string, issue: number, state: FactoryRunState): {
    sealed: FactoryRunState;
    content: string;
};
/**
 * `omg factory run cancel`: drop the cancel request file next to the state.
 * The state file stays engine-only (the engine ledger flags any other
 * writer); the returned state shows the request.
 */
export declare function requestFactoryCancel(root: string, issue: number, now: string): FactoryRunState;
export interface FactoryOwner {
    pid: number;
    hostname: string;
    startedAt: string;
}
export interface OwnerDeps {
    pid: number;
    hostname: string;
    isAlive: (pid: number) => boolean;
}
export declare const defaultOwnerDeps: () => OwnerDeps;
/**
 * Claim the single-runner owner file. A live owner (or one on another host,
 * whose pid cannot be checked) refuses; a dead pid on this host is taken
 * over, and `tookOver` names it for the history.
 */
export declare function acquireFactoryOwner(root: string, issue: number, now: string, deps?: OwnerDeps): {
    release: () => void;
    tookOver?: FactoryOwner;
};
//# sourceMappingURL=state.d.ts.map