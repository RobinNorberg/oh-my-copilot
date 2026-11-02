import type { Exec, ExecResult } from '../../../ship/exec.js';
import type { FactoryEngineOptions } from '../engine.js';
import { type Harness, type LaneScript } from './fake-lanes.js';
export declare const SPEC = 12;
export declare let h: Harness;
/** Every issue comment the engine posted: target and body. */
export declare let posted: Array<{
    n: number;
    body: string;
}>;
/** The parent spec's comments as `gh issue view` reports them. */
export declare let specComments: Array<{
    body: string;
    authorAssociation?: string;
    author?: {
        login: string;
    };
}>;
/** Answer for `gh issue comment <n>` (posting still records nothing on failure). */
export declare let commentResult: (n: number) => ExecResult;
export declare let warnings: string[];
/** Answer every later `gh issue comment` with `result`. */
export declare function setCommentResult(result: (n: number) => ExecResult): void;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export declare function useOutcomeHarness(): void;
export declare const ok: (stdout: string) => ExecResult;
export declare const exec: Exec;
export declare function opts(scripts: LaneScript[], over?: Partial<FactoryEngineOptions>): FactoryEngineOptions;
export declare const happy: () => LaneScript[];
export declare const on: (n: number) => {
    n: number;
    body: string;
}[];
export declare const outcomes: () => {
    n: number;
    body: string;
}[];
//# sourceMappingURL=engine-outcome-harness.d.ts.map