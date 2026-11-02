import { type Exec, type ExecResult } from '../../../ship/exec.js';
import { type FactoryEngineOptions, type FactoryForgeInput } from '../engine.js';
import { FakeLanes, type Harness, type LaneScript } from './fake-lanes.js';
export declare const ADO_URL: string;
export declare const PR_ID = 17;
export declare const PROJECT_ID = "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c";
export declare const MERGE_COMMIT: string;
export declare const fixtures: import("../../../forge/ado/__tests__/fixtures.js").AdoFixture[];
export declare const fixture: (name: string) => any;
export interface AdoCall {
    route: string;
    routeParameters: Record<string, string>;
    queryParameters: Record<string, string>;
    body?: any;
}
/** The Azure DevOps side of one run: work item ISSUE, PR 17 on the harness's bare remote. */
export declare class AdoModel {
    private readonly h;
    readonly calls: AdoCall[];
    prCreated: boolean;
    ready: boolean;
    /** Reported instead of the branch head (a push the engine did not make). */
    headOverride?: string;
    /** The next `reads` PR reads report `sha` (lastMergeSourceCommit lagging a push). */
    lag?: {
        sha: string;
        reads: number;
    };
    /** Work item PATCHes answered with a rev conflict before one succeeds. */
    revConflicts: number;
    /** The recorded item's predecessor #40 (Dependency-Reverse): dropped (none), open, or open with its factory PR completed into dev. */
    predecessor: 'none' | 'open' | 'merged';
    /** The run's branch (a ci-heal run pushes factory/heal-<sig8>). */
    branch: string;
    constructor(h: Harness);
    private dev;
    private head;
    private pr;
    answer(args: string[]): ExecResult;
    /** The PR thread bodies the engine posted. */
    threads(): string[];
}
export declare let h: Harness;
export declare let ado: AdoModel;
export declare let sleeps: number[];
/** A fresh harness per test; call once at the top of each test file that uses it. */
export declare function useAdoHarness(): void;
/** The harness's git (origin is the ADO repository), az to the model, and no gh at all. */
export declare function adoExec(): Exec;
export declare const forgeInput: (over?: Partial<FactoryForgeInput>) => FactoryForgeInput;
export declare function opts(lanes: FakeLanes, over?: Partial<FactoryEngineOptions>): FactoryEngineOptions;
export declare const happy: () => LaneScript[];
export declare const run: (scripts: LaneScript[], over?: Partial<FactoryEngineOptions>) => Promise<import("../engine.js").FactoryRunOutcome>;
/** Nothing merges: every PR PATCH is exactly the ready flip, and no az call completes a PR. */
export declare function expectNoMerge(): void;
//# sourceMappingURL=engine-ado-harness.d.ts.map