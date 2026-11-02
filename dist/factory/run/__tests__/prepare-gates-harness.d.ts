import { type FactoryRunLimits } from '../budget.js';
import { type FactoryEngineOptions } from '../engine.js';
import type { ExecResult } from '../../../ship/exec.js';
import { FakeLanes, type Harness, type LaneScript } from './fake-lanes.js';
export declare let h: Harness;
export declare let t: number;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export declare function usePrepareGatesHarness(): void;
export declare const limits: (over?: Partial<FactoryRunLimits>) => FactoryRunLimits;
export declare function run(scripts: LaneScript[], over?: Partial<FactoryEngineOptions>): {
    lanes: FakeLanes;
    done: Promise<import("../engine.js").FactoryRunOutcome>;
};
/** Move dev on the remote from a separate clone (the engine's main checkout is never touched). */
export declare function moveBase(path: string, content: string): string;
/** The first PR view of prepare (and of every later phase): GitHub's base sha is read here. */
export declare const PREPARE_VIEW = "gh pr view 42 --json number,";
/** Run `fn` once, right before the first command that starts with `prefix`. */
export declare function before(prefix: string, fn: () => void): void;
export declare const events: () => import("../../../lib/agent-progress.js").ProgressEvent[];
export declare const okRun: ExecResult;
export declare const isTsc: (args: string[]) => boolean;
export declare const pushes: () => string[];
//# sourceMappingURL=prepare-gates-harness.d.ts.map