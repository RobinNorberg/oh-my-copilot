/**
 * Deterministic CI failure classifier (design §3). No LLM and no network:
 * the inputs are parsed job logs (logs.ts), the dev history and the sha
 * range, all fetched by the caller. Steps per failed job, in order: infra
 * patterns, known-flaky, history, environment diff (with the rule that one
 * sha green on one image version and red on another is env-change). The run
 * takes the most severe job class.
 */
import type { FailingTest } from '../../ship/gates.js';
import { type JobEnv, type ParsedJob } from './logs.js';
import type { ShaRange } from './history.js';
export type HealClass = 'infra' | 'known-flaky' | 'intermittent' | 'env-change' | 'regression' | 'regression-or-env' | 'unknown';
/** Classes that get one recorded rerun probe (design §3 step 6). */
export declare const RERUN_CLASSES: readonly HealClass[];
/** Classes a debugger lane may take (PR 2). */
export declare const LANE_CLASSES: readonly HealClass[];
export interface JobSample {
    runId: string;
    sha: string;
    job: ParsedJob;
}
/** One dev push run in the history window, oldest first; failedTests only when its log was read. */
export interface HistoryEntry {
    runId: string;
    sha: string;
    green: boolean;
    failedTests?: readonly FailingTest[];
}
export interface EnvChange {
    field: keyof JobEnv;
    green?: string;
    red?: string;
}
export interface JobClassification {
    job: string;
    class: HealClass;
    reason: string;
    failingTests: FailingTest[];
    blockers: string[];
    infra: string[];
    history?: 'intermittent' | 'consistent';
    env: {
        red: JobEnv;
        green?: JobEnv;
        changed: EnvChange[];
    };
    sameShaImages?: {
        green: string;
        red: string;
    };
}
export interface HealClassification {
    class: HealClass;
    signature: string;
    sig8: string;
    firstRed: {
        runId: string;
        sha: string;
    };
    lastGreen?: {
        runId: string;
        sha: string;
    };
    range?: ShaRange;
    jobs: JobClassification[];
    rerun?: RerunIntent;
    laneEligible: boolean;
}
export interface RerunIntent {
    runId: string;
    command: string;
    /** Always false in PR 1: the rerun is recorded, never issued. */
    issued: false;
}
export declare function envDiff(green: JobEnv | undefined, red: JobEnv): EnvChange[];
/**
 * `intermittent` when a failing test failed, then a green run followed, then
 * it failed again inside the window; `consistent` when it fails in every run
 * since its first red. Undefined without history that names the test.
 */
export declare function historyPattern(history: readonly HistoryEntry[], tests: readonly FailingTest[]): 'intermittent' | 'consistent' | undefined;
export interface ClassifyJobInput {
    red: JobSample;
    /** The same-named job in the last green run before the first red one. */
    green?: JobSample;
    /** Green samples of the same job at the red sha (push or PR runs). */
    sameShaGreen?: readonly JobSample[];
    history?: readonly HistoryEntry[];
    range?: ShaRange;
}
export declare function classifyJob(input: ClassifyJobInput): JobClassification;
export interface ClassifyRunInput {
    signature: string;
    sig8: string;
    firstRed: {
        runId: string;
        sha: string;
    };
    lastGreen?: {
        runId: string;
        sha: string;
    };
    range?: ShaRange;
    jobs: readonly ClassifyJobInput[];
}
export declare function classifyRun(input: ClassifyRunInput): HealClassification;
//# sourceMappingURL=classify.d.ts.map