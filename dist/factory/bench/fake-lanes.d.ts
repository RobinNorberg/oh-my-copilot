/**
 * The scripted lanes of `omg factory bench --fake`: the same shape as the
 * engine tests' fake lanes (a real git worktree per lane, like copilot_run;
 * the write lane leaves its change uncommitted for the engine to commit; a
 * review lane answers with a verdict block for the sha it started at), with
 * the steps of one bench issue (fixtures/issues.ts `fake`). No Copilot
 * session, no network, no credits: usage is reported as one premium request
 * and a fixed credit count per lane, marked `estimated`.
 */
import type { LaneProcessOps } from '../run/engine.js';
import { type LaneBackend, type LaneResult, type LaneStartInput } from '../run/lane.js';
import type { FakeStep } from './fixtures/issues.js';
/** The credits a fake lane reports (a write lane and a review lane alike). */
export declare const FAKE_LANE_CREDITS = 1;
export declare class BenchFakeLanes implements LaneBackend {
    private readonly root;
    private readonly steps;
    private readonly fill;
    readonly kind: "local-sdk";
    readonly started: LaneStartInput[];
    private readonly jobs;
    private readonly suffix;
    /** `fill` resolves the fixture placeholders in a written file. */
    constructor(root: string, steps: readonly FakeStep[], fill: (text: string) => string);
    start(input: LaneStartInput): Promise<{
        remoteId: string;
    }>;
    private run;
    private result;
    poll(remoteId: string): Promise<LaneResult>;
    wait(remoteId: string, _timeoutMs: number): Promise<LaneResult>;
    cancel(remoteId: string): Promise<{
        supported: boolean;
        result: LaneResult;
    }>;
}
/** The fake lanes' process seam: every lane child is already gone. */
export declare const BENCH_FAKE_PROCESSES: LaneProcessOps;
//# sourceMappingURL=fake-lanes.d.ts.map