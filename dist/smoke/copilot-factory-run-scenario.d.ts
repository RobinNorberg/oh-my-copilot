/**
 * Tier 2 `factory-run` and `factory-run-fix` scenarios of `omg smoke copilot`
 * (opt-in, never in `all`): `omg factory run` end to end, in-process, with
 * real Copilot lanes and nothing on GitHub.
 *
 * 1. A fresh repository next to the sandbox project, on `dev`, with a local
 *    bare `origin`. `git remote get-url` answers a GitHub URL, so the engine's
 *    repository checks pass, while every real push lands in the bare remote.
 * 2. `gh` is a scripted in-process Exec ({@link scriptedFactoryGh}): one open
 *    issue with acceptance criteria, a draft PR create, PR views at the bare
 *    remote's heads, green checks. It refuses `gh pr merge` and records the
 *    attempt; the engine's factory guard refuses it first anyway.
 * 3. The engine runs with the real copilot_run lane backend (the installed
 *    binary, the plugin under test, the smoke home's login), each lane capped
 *    at the 30-credit runtime minimum. Prepare's node checks are scripted
 *    green: the sandbox has no toolchain.
 * 4. `factory-run`: implement, review (approve), prepare, gates, then the park
 *    at `awaiting-human: merge` with the merge command. `factory-run-fix`: the
 *    first review prompt carries an operator instruction to request changes
 *    once, so a fix lane runs and a new review approves the new head.
 *
 * Cost: one user prompt per lane, billed in AI credits; the evidence sums the
 * lane usage the engine recorded in its state.
 */
import { type FactoryRunLimits } from '../factory/run/budget.js';
import { type FactoryEngineOptions } from '../factory/run/engine.js';
import { type LaneBackend, type LaneResult, type LaneStartInput } from '../factory/run/lane.js';
import type { GateConfigLoader } from '../factory/run/prepare.js';
import { type Exec } from '../ship/exec.js';
import { type CopilotEvent } from './copilot-session-eval.js';
import { type FactoryRunScenario, type ScenarioRun } from './copilot-sdk-scenarios.js';
import type { SpawnSyncFn } from './process-utils.js';
/** Appended to the first review prompt of `factory-run-fix` (by the scenario, not the issue: the implementer never sees it). */
export declare const FIX_REVIEW_INSTRUCTION: string;
/** A lane wall time that fits one small write or review with its tool turns. */
export declare const FACTORY_LANE_TIMEOUT_MS = 600000;
export interface FactoryRunScenarioInput {
    name: FactoryRunScenario;
    /** Plugin under test: the lanes' plugin root. */
    root: string;
    /** The copilot binary the lanes run (a resolved .js/.exe, not a shim). */
    bin: string;
    /** Tier 2 session env (isolated COPILOT_HOME, login identity). */
    env: NodeJS.ProcessEnv;
    /** Sandbox project: its parent holds this scenario's repository. */
    projectDir: string;
    /** Smoke home: its config.json holds the login identity the lanes copy. */
    home: string;
    /** Raised to {@link FACTORY_LANE_TIMEOUT_MS} per lane. */
    timeoutMs: number;
    maxCredits: number;
    budget: number;
    eventsPath: string;
    spawnSync: SpawnSyncFn;
    /** Test seams: the lane backend over the scenario repository, the clock, and the engine's poll, process and sleep seams. */
    lanes?: (repoRoot: string) => LaneBackend;
    now?: () => number;
    engine?: Pick<FactoryEngineOptions, 'pollMs' | 'processes' | 'sleep'>;
    /** The model every lane runs on (the driver's cheap pick); unset: runtime auto. */
    model?: string;
}
/** What the scripted gh saw. */
export interface ScriptedGhRecord {
    calls: string[];
    prCreates: string[];
    ready: boolean;
    /** Any `gh pr merge` (or merge through `gh api`) that reached the exec seam. */
    mergeCalls: string[];
}
/** A ref of the bare remote, or '' when it does not exist. */
export declare function bareRef(bare: string, ref: string): string;
/** The issue the engine reads: one file, with acceptance criteria. */
export declare function factoryRunIssue(): {
    title: string;
    body: string;
};
/**
 * The exec the engine runs: real git (pushes go to the bare `origin`) except
 * `git remote get-url`, scripted gh, and green node checks. Nothing reaches
 * GitHub; a merge is refused and recorded.
 */
export declare function scriptedFactoryGh(bare: string): {
    exec: Exec;
    record: ScriptedGhRecord;
};
/** Ship's gate config without a fetch: the one required check `Test` the scripted gh reports green. */
export declare const smokeGateConfig: GateConfigLoader;
/** `<dir>/remote.git` (bare) and `<dir>/repo` on the base branch tracking it; `.omg/` ignored. Returns an error or null. */
export declare function prepareFactoryRepo(dir: string): string | null;
/**
 * The lane backend as the engine sees it, plus what the scenario needs: every
 * start and final result, the lanes' copilot_run events, and for
 * `factory-run-fix` the first review prompt's operator instruction.
 */
export declare class RecordingLanes implements LaneBackend {
    private readonly inner;
    private readonly requestChangesOnce;
    private readonly model?;
    readonly kind: LaneBackend['kind'];
    readonly starts: Array<Pick<LaneStartInput, 'laneId' | 'profile' | 'maxCredits' | 'baseRef'>>;
    readonly results: Map<string, LaneResult>;
    private reviews;
    /** `model`: pinned on every lane start (the engine sets none, so lanes would run on runtime auto). */
    constructor(inner: LaneBackend, requestChangesOnce: boolean, model?: string | undefined);
    start(input: LaneStartInput): Promise<{
        remoteId: string;
    }>;
    poll(remoteId: string): Promise<LaneResult>;
    wait(remoteId: string, timeoutMs: number): Promise<LaneResult>;
    cancel(remoteId: string): Promise<{
        supported: boolean;
        result: LaneResult;
    }>;
    private keep;
    /** copilot_run's per-job events.jsonl (logsUrl) of every lane, in start order of what was seen. */
    events(): CopilotEvent[];
}
/** The real copilot_run backend on the smoke's binary, plugin and login. */
export declare function copilotLanes(input: Pick<FactoryRunScenarioInput, 'env' | 'bin' | 'root' | 'home'>): LaneBackend;
/** Lane bounds: the 30-credit runtime minimum per lane, one fix round, no retry or respawn, so the lane count is fixed. */
export declare function factoryRunLimits(timeoutMs: number): FactoryRunLimits;
export declare function runFactoryRunScenario(input: FactoryRunScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & {
    wedged: boolean;
}>;
//# sourceMappingURL=copilot-factory-run-scenario.d.ts.map