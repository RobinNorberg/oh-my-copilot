import type { CopilotRunSandboxState } from '../../../copilot-run/sandbox.js';
import { type FactoryEngineOptions } from '../engine.js';
import { FakeLanes, type Harness, type LaneScript } from './fake-lanes.js';
export declare let h: Harness;
/** A fresh harness per test; call once at the top of each test file that uses it. */
export declare function useSandboxHarness(): void;
export declare function run(scripts: LaneScript[], over?: Partial<FactoryEngineOptions>): {
    lanes: FakeLanes;
    done: Promise<import("../engine.js").FactoryRunOutcome>;
};
export declare const sandboxOf: (mode: CopilotRunSandboxState["mode"]) => CopilotRunSandboxState;
/** A write lane that leaves `path` changed in its worktree, uncommitted. */
export declare const edit: (path: string, content: string, sandbox?: CopilotRunSandboxState) => LaneScript;
export declare const DIR_LINK: string;
/** A directory link at `path` to `target`; the returned function removes the link itself, never its target. */
export declare function dirLink(target: string, path: string, type?: 'junction' | 'dir'): () => void;
/** A directory outside every worktree holding a secret file. */
export declare function outsideDir(): string;
//# sourceMappingURL=engine-sandbox-harness.d.ts.map