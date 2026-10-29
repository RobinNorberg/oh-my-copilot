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
import { CopilotRunError, } from '../../copilot-run/job.js';
/** The backend no longer knows the handle (a local job whose process ended). */
export class LaneLostError extends Error {
    remoteId;
    constructor(remoteId, message) {
        super(message);
        this.remoteId = remoteId;
        this.name = 'LaneLostError';
    }
}
export const TERMINAL_LANE_STATES = ['completed', 'failed', 'timeout', 'cancelled'];
export const isTerminalLaneState = (state) => TERMINAL_LANE_STATES.includes(state);
const STATE_OF = {
    starting: 'queued',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    timeout: 'timeout',
    cancelled: 'cancelled',
};
export class CopilotLaneBackend {
    manager;
    options;
    kind = 'local-sdk';
    constructor(manager, options) {
        this.manager = manager;
        this.options = options;
    }
    async start(input) {
        const snap = this.manager.start({
            prompt: input.prompt,
            cwd: input.cwd,
            isolation: 'worktree',
            startRef: input.baseRef,
            profile: input.profile ?? 'write',
            timeoutMs: input.timeoutMs,
            maxCredits: input.maxCredits,
            ...(input.model ? { model: input.model } : {}),
        }, { allowLive: this.options.allowLive, disableStopContinuations: true, ledgerKey: `factory-lane:${input.laneId}`, sandboxScope: 'factory', ...(input.scrubCredentials ? { scrubCredentials: true } : {}), ...(input.engineCommits ? { hostCommits: true } : {}) });
        return { remoteId: snap.jobId };
    }
    async poll(remoteId) {
        return this.result(this.known(remoteId, () => this.manager.status(remoteId)));
    }
    async wait(remoteId, timeoutMs) {
        return this.result(await this.knownAsync(remoteId, () => this.manager.wait(remoteId, timeoutMs)));
    }
    async cancel(remoteId) {
        return { supported: true, result: this.result(await this.knownAsync(remoteId, () => this.manager.cancel(remoteId))) };
    }
    known(remoteId, fn) {
        try {
            return fn();
        }
        catch (err) {
            throw this.lost(remoteId, err);
        }
    }
    async knownAsync(remoteId, fn) {
        try {
            return await fn();
        }
        catch (err) {
            throw this.lost(remoteId, err);
        }
    }
    lost(remoteId, err) {
        return err instanceof CopilotRunError ? new LaneLostError(remoteId, err.message) : err;
    }
    result(snap) {
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
//# sourceMappingURL=lane.js.map