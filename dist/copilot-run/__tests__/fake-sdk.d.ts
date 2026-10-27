import type { CopilotRunDeps } from '../job.js';
import type { LoadedSdk, SdkSessionConfig } from '../../smoke/copilot-sdk-driver.js';
/** `idle`: answers and idles, changes nothing. `commit`: commits a file in the worktree first. `hang`: never idles. */
export type FakeBehavior = 'idle' | 'commit' | 'hang';
export interface FakeCalls {
    connections: Array<{
        path?: string;
        args?: string[];
        env?: NodeJS.ProcessEnv;
    }>;
    sessions: SdkSessionConfig[];
    prompts: string[];
}
export declare const newCalls: () => FakeCalls;
export declare const gitIn: (cwd: string, ...args: string[]) => string;
export declare function fakeSdk(behavior: FakeBehavior, calls: FakeCalls): LoadedSdk;
export declare function fakeDeps(root: string, behavior: FakeBehavior, calls: FakeCalls, env: NodeJS.ProcessEnv): CopilotRunDeps;
/** A temp root with a logged-in user config and a one-commit repository at `<root>/repo` (branch main). */
export declare function scratchRepo(prefix: string): {
    root: string;
    repo: string;
};
//# sourceMappingURL=fake-sdk.d.ts.map