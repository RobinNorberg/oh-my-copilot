import type { CopilotRunDeps } from '../job.js';
import type { LoadedSdk, SdkSessionConfig } from '../../smoke/copilot-sdk-driver.js';
/** `idle`: answers and idles, changes nothing. `commit`: commits a file in the worktree first. `hang`: never idles. */
export type FakeBehavior = 'idle' | 'commit' | 'hang';
/**
 * The fake runtime's sandbox: `supported` (default) confirms it; `unsupported`
 * reports no host support; `blocked` reports enforcement blocked;
 * `update-fails` rejects options.update; `no-rpc` has no sandbox RPCs (an old SDK).
 */
export type FakeSandbox = 'supported' | 'unsupported' | 'blocked' | 'update-fails' | 'no-rpc';
export interface FakeCalls {
    connections: Array<{
        path?: string;
        args?: string[];
        env?: NodeJS.ProcessEnv;
    }>;
    sessions: SdkSessionConfig[];
    prompts: string[];
    /** Every session.rpc.options.update payload. */
    optionsUpdates: Array<Record<string, unknown>>;
    /** Each connection's GIT_CONFIG_GLOBAL content when it started (the job home is gone afterwards), or null. */
    globalGitConfigs: Array<string | null>;
}
export declare const newCalls: () => FakeCalls;
/** The server `rpc` of a fake client with sandbox support `sandbox`. */
export declare function fakeClientRpc(sandbox: FakeSandbox): unknown;
/** The session `rpc` of a fake session with sandbox support `sandbox`. */
export declare function fakeSessionRpc(sandbox: FakeSandbox, calls: {
    optionsUpdates: Array<Record<string, unknown>>;
}): never;
export declare const gitIn: (cwd: string, ...args: string[]) => string;
export declare function fakeSdk(behavior: FakeBehavior, calls: FakeCalls, sandbox?: FakeSandbox): LoadedSdk;
export declare function fakeDeps(root: string, behavior: FakeBehavior, calls: FakeCalls, env: NodeJS.ProcessEnv, sandbox?: FakeSandbox): CopilotRunDeps;
/** A temp root with a logged-in user config and a one-commit repository at `<root>/repo` (branch main). */
export declare function scratchRepo(prefix: string): {
    root: string;
    repo: string;
};
//# sourceMappingURL=fake-sdk.d.ts.map