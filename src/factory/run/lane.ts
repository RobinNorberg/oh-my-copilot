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

import {
  CopilotRunError,
  type ChangeSummary,
  type CopilotRunManager,
  type CopilotRunProfile,
  type CopilotRunSnapshot,
  type CopilotRunStatus,
} from '../../copilot-run/job.js';
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
  repo?: { owner: string; name: string };
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
  start(input: LaneStartInput): Promise<{ remoteId: string }>;
  /** Current result without waiting; idempotent. */
  poll(remoteId: string): Promise<LaneResult>;
  /** Wait until the lane ends or `timeoutMs` passes; the result's state says which. */
  wait(remoteId: string, timeoutMs: number): Promise<LaneResult>;
  cancel(remoteId: string): Promise<{ supported: boolean; result: LaneResult }>;
}

/** The factory design's name for {@link LaneBackend}. */
export type LaneRunner = LaneBackend;

/** The backend no longer knows the handle (a local job whose process ended). */
export class LaneLostError extends Error {
  constructor(readonly remoteId: string, message: string) {
    super(message);
    this.name = 'LaneLostError';
  }
}

export const TERMINAL_LANE_STATES: readonly LaneState[] = ['completed', 'failed', 'timeout', 'cancelled'];
export const isTerminalLaneState = (state: LaneState): boolean => TERMINAL_LANE_STATES.includes(state);

export type LaneJobManager = Pick<CopilotRunManager, 'start' | 'status' | 'wait' | 'cancel'>;

export interface CopilotLaneBackendOptions {
  /**
   * The caller's explicit opt-in to live, billed sessions (`omg factory run`
   * without `--dry-run`). False falls back to OMG_COPILOT_RUN_ALLOW=1 in the
   * manager's env.
   */
  allowLive: boolean;
}

const STATE_OF: Record<CopilotRunStatus, LaneState> = {
  starting: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timeout: 'timeout',
  cancelled: 'cancelled',
};

export class CopilotLaneBackend implements LaneBackend {
  readonly kind = 'local-sdk' as const;

  constructor(private readonly manager: LaneJobManager, private readonly options: CopilotLaneBackendOptions) {}

  async start(input: LaneStartInput): Promise<{ remoteId: string }> {
    const snap = this.manager.start(
      {
        prompt: input.prompt,
        cwd: input.cwd,
        isolation: 'worktree',
        startRef: input.baseRef,
        profile: input.profile ?? 'write',
        timeoutMs: input.timeoutMs,
        maxCredits: input.maxCredits,
        ...(input.model ? { model: input.model } : {}),
      },
      { allowLive: this.options.allowLive, disableStopContinuations: true, ledgerKey: `factory-lane:${input.laneId}`, sandboxScope: 'factory', ...(input.scrubCredentials ? { scrubCredentials: true } : {}), ...(input.engineCommits ? { hostCommits: true } : {}) },
    );
    return { remoteId: snap.jobId };
  }

  async poll(remoteId: string): Promise<LaneResult> {
    return this.result(this.known(remoteId, () => this.manager.status(remoteId)));
  }

  async wait(remoteId: string, timeoutMs: number): Promise<LaneResult> {
    return this.result(await this.knownAsync(remoteId, () => this.manager.wait(remoteId, timeoutMs)));
  }

  async cancel(remoteId: string): Promise<{ supported: boolean; result: LaneResult }> {
    return { supported: true, result: this.result(await this.knownAsync(remoteId, () => this.manager.cancel(remoteId))) };
  }

  private known(remoteId: string, fn: () => CopilotRunSnapshot): CopilotRunSnapshot {
    try {
      return fn();
    } catch (err) {
      throw this.lost(remoteId, err);
    }
  }

  private async knownAsync(remoteId: string, fn: () => Promise<CopilotRunSnapshot>): Promise<CopilotRunSnapshot> {
    try {
      return await fn();
    } catch (err) {
      throw this.lost(remoteId, err);
    }
  }

  private lost(remoteId: string, err: unknown): unknown {
    return err instanceof CopilotRunError ? new LaneLostError(remoteId, err.message) : err;
  }

  private result(snap: CopilotRunSnapshot): LaneResult {
    const state = STATE_OF[snap.status];
    const worktree = snap.worktree?.path ?? null;
    return {
      state,
      branch: snap.worktree?.branch ?? null,
      pr: null,
      // Read by the job when it ended, through the recorded git dir, hardened: never via the lane-writable `.git` file.
      headSha: worktree && isTerminalLaneState(state) ? snap.worktree?.headCommit ?? null : null,
      baseSha: snap.worktree?.baseCommit ?? null,
      worktree,
      changes: snap.changes ?? null,
      finalText: snap.finalText,
      logsUrl: snap.eventsPath,
      usage: {
        premiumRequests: snap.usage.premiumRequests,
        credits: snap.usage.credits,
        source: snap.usage.source,
        detail: snap.usage.summary,
      },
      remoteId: snap.jobId,
      error: snap.error,
      notes: snap.notes ?? [],
      process: snap.runtime ? { pid: snap.runtime.pid, identity: snap.runtime.identity } : null,
      ...(snap.sandbox ? { sandbox: snap.sandbox } : {}),
      ...(snap.model ? { model: snap.model } : {}),
    };
  }
}
