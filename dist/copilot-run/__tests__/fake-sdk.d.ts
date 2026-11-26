import type { CopilotRunDeps } from '../job.js';
import type { LoadedSdk, SdkSessionConfig, SpawnedStdioOptions } from '../../smoke/copilot-sdk-driver.js';
/**
 * `idle`: answers and idles, changes nothing. `commit`: commits a file in the worktree first. `hang`: never idles.
 * `sandbox-off`: reports the session's sandbox opted out (`session.sandbox_state_changed`) mid-turn, then answers and idles.
 */
export type FakeBehavior = 'idle' | 'commit' | 'hang' | 'sandbox-off';
/**
 * The fake runtime's sandbox: `supported` (default) confirms it; `unsupported`
 * reports no host support; `blocked` reports enforcement blocked;
 * `update-fails` rejects options.update and a createSession that carries a sandbox (a v2 policy conflict at create,
 * with Copilot CLI 1.0.116's message); `no-rpc` has no sandbox RPCs. `ignored`: a runtime that silently drops the
 * policy (create and options.update succeed, enforcement reads `{ required: false, blocked: false }`, getState shows
 * no enabled sandbox). `no-state` has no sandbox.getState RPC; `state-throws` / `state-hangs`: getState throws or
 * never answers; `opted-out`: getState reports `disabledForSession: true`. `create-fails`: every createSession
 * fails with an auth error that is not a sandbox error.
 */
export type FakeSandbox = 'supported' | 'unsupported' | 'blocked' | 'update-fails' | 'no-rpc' | 'ignored' | 'no-state' | 'state-throws' | 'state-hangs' | 'opted-out' | 'create-fails';
/** The runtime's refusal of a policy that conflicts with managed policy (Copilot CLI 1.0.116). */
export declare const POLICY_CONFLICT_MESSAGE = "Sandbox configuration update violates managed policy. Contact your administrator for more information.";
export interface FakeCalls {
    connections: SpawnedStdioOptions[];
    sessions: SdkSessionConfig[];
    prompts: string[];
    /** Every session.rpc.options.update payload. */
    optionsUpdates: Array<Record<string, unknown>>;
    /** Each connection's GIT_CONFIG_GLOBAL content when it started (the job home is gone afterwards), or null. */
    globalGitConfigs: Array<string | null>;
}
export declare const newCalls: () => FakeCalls;
/** The server `rpc` of a fake client with sandbox support `sandbox` (`deniedPaths`: the host reports denied_paths). */
export declare function fakeClientRpc(sandbox: FakeSandbox, deniedPaths?: boolean): unknown;
/** The session `rpc` of a fake session with sandbox support `sandbox`; `created`: the sandbox config createSession took. */
export declare function fakeSessionRpc(sandbox: FakeSandbox, calls: {
    optionsUpdates: Array<Record<string, unknown>>;
}, created?: unknown): never;
export declare const gitIn: (cwd: string, ...args: string[]) => string;
export declare function fakeSdk(behavior: FakeBehavior, calls: FakeCalls, sandbox?: FakeSandbox, deniedPaths?: boolean): LoadedSdk;
export declare function fakeDeps(root: string, behavior: FakeBehavior, calls: FakeCalls, env: NodeJS.ProcessEnv, sandbox?: FakeSandbox): CopilotRunDeps;
/** A temp root with a logged-in user config and a one-commit repository at `<root>/repo` (branch main). */
export declare function scratchRepo(prefix: string): {
    root: string;
    repo: string;
};
//# sourceMappingURL=fake-sdk.d.ts.map