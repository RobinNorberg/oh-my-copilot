import { type ResolvedForgeConfig } from '../../../forge/types.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import type { FactoryEngineOptions } from '../engine.js';
import { type FactoryRunState } from '../state.js';
import { type Harness, type LaneScript } from './fake-lanes.js';
export declare const FAMILY: string[];
export declare function githubConfig(progress?: ResolvedForgeConfig['progress']): ResolvedForgeConfig;
export declare let h: Harness;
/** The `gh issue edit` argv the engine ran (after the guard), one per tracker write. */
export declare let edits: string[][];
/** Answer for each `gh issue edit`. */
export declare let editResult: () => ExecResult;
/** Answer every later `gh issue edit` with `result`. */
export declare function setEditResult(result: () => ExecResult): void;
/** Forget the edits recorded so far. */
export declare function clearEdits(): void;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export declare function useProgressHarness(): void;
export declare const exec: Exec;
export declare function opts(scripts: LaneScript[], over?: Partial<FactoryEngineOptions>): FactoryEngineOptions;
export declare const happy: () => LaneScript[];
/** The label each write adds (null: a removal only). */
export declare const added: () => (string | null)[];
/** Every write: issue ISSUE, the one stage label added and every other family label removed (mutually exclusive). */
export declare function expectExclusive(): void;
/** A state write the engine made (a crash simulated in the state). */
export declare function asEngine(mutate: (s: FactoryRunState) => FactoryRunState): void;
//# sourceMappingURL=engine-progress-harness.d.ts.map