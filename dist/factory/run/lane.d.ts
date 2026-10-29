/**
 * Lanes for `omg factory run`: one LLM work unit (implement, review, fix)
 * that the engine starts, waits on, and reads back as data.
 *
 * `LaneBackend` is host-agnostic and shared with the cloud lanes design
 * (.omc/plans/2026-10-27-cloud-lanes-design.md §3): a backend starts a lane
 * and returns a handle (`remoteId`), `poll`/`wait` return a `LaneResult`, and
 * `cancel` aborts it. `LaneRunner` is the factory design's name for the same
 * interface.
 *
 * `CopilotLaneBackend` (`local-sdk`) is a thin adapter over the in-process
 * CopilotRunManager: a job worktree at `baseRef`, the `write` or `review`
 * permission profile, and no persistent-mode Stop continuations. Its jobs
 * live in the creating process; after a restart a handle is unknown and
 * `poll` throws {@link LaneLostError}, which the engine records as `lost`.
 */
import { type ChangeSummary, type CopilotRunManager, type CopilotRunProfile } from '../../copilot-run/job.js';
import type { CopilotRunSandboxState } from '../../copilot-run/sandbox.js';
export type LaneBackendKind = 'local-sdk' | 'cloud-task' | 'cloud-issue' | 'cloud-sdk';
export type LaneState = 'queued' | 'running' | 'needs-input' | 'completed' | 'failed' | 'timeout' | 'cancelled';
export type LaneProfile = CopilotRunProfile;
export interface LaneStartInput {
    /**
     * The engine's id for the lane (state file key); the backend's handle is
     * `remoteId`. The local backend records the lane's spend in the budget
     * ledger as `factory-lane:<laneId>` (ledger key characters only).
     */
    laneId: string;
    /** Local checkout of the repository: the job's git repository and the budget ledger location. */
    cwd: string;
    /** GitHub repository, for remote backends. */
    repo?: {
        owner: string;
        name: string;
    };
    /** Commit sha or branch the lane starts at. */
    baseRef: string;
    prompt: string;
    /**
     * `write` (default) edits its worktree. `review` denies the write
     * tool and runs only the read-only shell allowlist, and only inside a
     * confirmed OS sandbox (otherwise without a shell); the engine still
     * verifies the worktree after the lane (refs, config and HEAD unchanged).
     */
    profile?: LaneProfile;
    /**
     * Local backend: start the session with a credential-free env
     * (scrubLaneCredentials in copilot-run/job.ts). The heal debugger lane sets it.
     */
    scrubCredentials?: boolean;
    /**
     * A write lane whose changes the engine commits after it (lane-commit.ts):
     * the local backend's sandbox keeps the whole common git dir read-only
     * (copilot_run `hostCommits`), so the lane leaves its changes uncommitted.
     */
    engineCommits?: boolean;
    model?: string;
    /** Cloud backends only. */
    customAgent?: string;
    timeoutMs: number;
    maxCredits: number;
}
export interface LaneUsage {
    /** Legacy unit (premium requests), kept for the ledger and older readers. */
    premiumRequests: number;
    /** AI Credits: the billing unit. */
    credits: number;
    source: 'measured' | 'estimated';
    detail: string;
}
export interface LaneResult {
    state: LaneState;
    /** The lane's branch: `omc-team/copilot-run/<jobId>` locally, `copilot/...` in the cloud. */
    branch: string | null;
    pr: number | null;
    /** The lane's HEAD once it ended (null while it runs). */
    headSha: string | null;
    /** The commit the lane started at. */
    baseSha: string | null;
    /** Local worktree path (null for remote backends). */
    worktree: string | null;
    changes: ChangeSummary | null;
    /** The last assistant message (a review lane's verdict block lives here). */
    finalText: string | null;
    /** github.com/copilot/tasks/{id} or the local events log. */
    logsUrl: string | null;
    usage: LaneUsage;
    remoteId: string | null;
    error: string | null;
    notes: string[];
    /** The local Copilot child once it started (pid and start identity), null when unknown or remote. */
    process: LaneProcess | null;
    /** The local job's OS sandbox (copilot_run snapshot.sandbox); absent for remote backends and before it was decided. */
    sandbox?: CopilotRunSandboxState;
    /** The model the local session ran on (copilot_run snapshot.model); absent when unknown or remote. */
    model?: string;
}
/** A lane's local child process: the engine checks it is gone before it trusts a lost lane's end. */
export interface LaneProcess {
    pid: number;
    /** Start identity (pid-reuse guard, platform/process-utils.ts); null when it could not be read. */
    identity: string | null;
}
export interface LaneBackend {
    readonly kind: LaneBackendKind;
    start(input: LaneStartInput): Promise<{
        remoteId: string;
    }>;
    /** Current result without waiting; idempotent. */
    poll(remoteId: string): Promise<LaneResult>;
    /** Wait until the lane ends or `timeoutMs` passes; the result's state says which. */
    wait(remoteId: string, timeoutMs: number): Promise<LaneResult>;
    cancel(remoteId: string): Promise<{
        supported: boolean;
        result: LaneResult;
    }>;
}
/** The factory design's name for {@link LaneBackend}. */
export type LaneRunner = LaneBackend;
/** The backend no longer knows the handle (a local job whose process ended). */
export declare class LaneLostError extends Error {
    readonly remoteId: string;
    constructor(remoteId: string, message: string);
}
export declare const TERMINAL_LANE_STATES: readonly LaneState[];
export declare const isTerminalLaneState: (state: LaneState) => boolean;
export type LaneJobManager = Pick<CopilotRunManager, 'start' | 'status' | 'wait' | 'cancel'>;
export interface CopilotLaneBackendOptions {
    /**
     * The caller's explicit opt-in to live, billed sessions (`omg factory run`
     * without `--dry-run`). False falls back to OMG_COPILOT_RUN_ALLOW=1 in the
     * manager's env.
     */
    allowLive: boolean;
}
export declare class CopilotLaneBackend implements LaneBackend {
    private readonly manager;
    private readonly options;
    readonly kind: "local-sdk";
    constructor(manager: LaneJobManager, options: CopilotLaneBackendOptions);
    start(input: LaneStartInput): Promise<{
        remoteId: string;
    }>;
    poll(remoteId: string): Promise<LaneResult>;
    wait(remoteId: string, timeoutMs: number): Promise<LaneResult>;
    cancel(remoteId: string): Promise<{
        supported: boolean;
        result: LaneResult;
    }>;
    private known;
    private knownAsync;
    private lost;
    private result;
}
//# sourceMappingURL=lane.d.ts.map