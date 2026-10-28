/**
 * The heal debugger lane (design §5): one read-only lane that root-causes a
 * classified CI failure from the evidence bundle and proposes a fix. It runs
 * through the factory's LaneBackend (CopilotLaneBackend locally) with the
 * `review` profile (no write tool, no ref/config-changing git) at the first
 * red sha, always with an AI-credit cap of at least the CLI floor.
 *
 * The review profile is a denylist, not a sandbox, so the lane is wrapped in
 * the factory engine's tamper check (run/review-guard.ts): the shared git
 * state is snapshotted before the lane and compared after it, then the lane's
 * own worktree must be at the start sha, clean and unchanged. The only ref
 * and worktree entry allowed to appear are the lane's own.
 *
 * OS confinement (the sandbox lane) is a separate change. {@link LaneConfinement}
 * is its seam: a confinement may rewrite the start input (for example to run
 * the job inside a sandbox) but may not change its profile, start sha or
 * prompt, drop its credential-free env, or raise its credit cap or timeout.
 * Until one exists the lane runs with {@link NO_CONFINEMENT} only under the
 * owner's OMG_HEAL_UNCONFINED=1 (run.ts), and the record says so. Every lane
 * starts with `scrubCredentials` (no GitHub tokens, an empty gh config).
 */
import type { Exec } from '../../ship/exec.js';
import { type LaneBackend, type LaneResult, type LaneStartInput } from '../run/lane.js';
import { type RepoSnapshot } from '../run/review-guard.js';
import type { HealClassification } from './classify.js';
import type { EvidenceBundle } from './evidence.js';
/** Grace after the lane's own timeout before the runner cancels it. */
export declare const DEBUG_LANE_GRACE_MS: number;
export declare const DEFAULT_DEBUG_POLL_MS = 5000;
/** The sandbox seam: rewrites a lane start, never loosens it. */
export interface LaneConfinement {
    /** Recorded with the lane (`none` until the sandbox lane lands). */
    readonly name: string;
    confine(input: LaneStartInput): LaneStartInput;
}
export declare const NO_CONFINEMENT: LaneConfinement;
/** The debugger prompt: engine-authored instructions, then every bundle file fenced as untrusted data. */
export declare function debugPrompt(c: HealClassification, bundle: EvidenceBundle, delimiter: string): string;
export interface DebugLaneOptions {
    backend: LaneBackend;
    /** The engine's guarded, hardened git exec (factoryGuardExec over hardenedGitExec). */
    exec: Exec;
    root: string;
    laneId: string;
    startSha: string;
    prompt: string;
    maxCredits: number;
    timeoutMs: number;
    pollMs?: number;
    clock?: () => number;
    confinement?: LaneConfinement;
    /** Called once the backend accepted the lane (the caller records the job id). */
    onStarted?: (remoteId: string) => void;
}
export type DebugLaneStatus = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'lost' | 'start-failed' | 'unconfirmed';
export interface DebugLaneOutcome {
    status: DebugLaneStatus;
    result: LaneResult | null;
    remoteId?: string;
    usage: {
        credits: number;
        premiumRequests: number;
        source: 'measured' | 'estimated';
    };
    /** Tamper-check findings; non-empty means the lane's output must not be used. */
    problems: string[];
    confinement: string;
    error?: string;
}
/** The engine's lane tamper check, for a read-only lane at `startSha`. */
export declare function debugLaneProblems(exec: Exec, root: string, before: RepoSnapshot, result: LaneResult, startSha: string): string[];
/** Start the debugger lane, wait for it, and run the tamper check around it. */
export declare function runDebugLane(o: DebugLaneOptions): Promise<DebugLaneOutcome>;
//# sourceMappingURL=debug-lane.d.ts.map