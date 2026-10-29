/**
 * `omg team sdk-host`: the detached per-worker process behind `--transport sdk`.
 *
 * One host owns one `@github/copilot-sdk` client and one session for one team
 * worker. It is the worker's launch "provider": it writes the launch-attempt
 * ack and the `provider_started` record with its own pid and strict process
 * start identity, so the existing provider liveness, retire and cleanup code
 * observes it like a pane provider. On exit it writes the `.terminal` record.
 *
 * Inputs (all under the worker's state dir, see sdk-transport.ts):
 * - `sdk-host-spec.json`  written by the leader before the spawn;
 * - `sdk-doorbell.jsonl`  appended by anyone (leader, other workers' mailbox
 *   sends); the host tails it and `send()`s prompts only while the session is
 *   idle, so a busy session never receives a second send;
 * - `<started>.termination-request`  written by the shared retire path: hard stop.
 * Outputs: `sdk-session.json` (state, usage, permissions, timeline),
 * `sdk-events.jsonl` (every session event), and `shutdown-ack.json` when the
 * doorbell carries a shutdown.
 */
import { type LoadedSdk } from '../smoke/copilot-sdk-driver.js';
import { type SdkDoorbellEntry, type SdkHostSpec } from './sdk-transport.js';
import type { buildSdkInProcessTools } from './sdk-inprocess-tools.js';
export interface SdkHostDeps {
    loadSdk: () => Promise<LoadedSdk | null>;
    pid: number;
    /** Strict start identity of `pid` (`ticks:<n>` on win32), as liveness reads it. */
    startIdentity: (pid: number) => string | null;
    isAlive: (pid: number) => boolean;
    killTree: (pid: number) => void;
    platform: NodeJS.Platform;
    pollMs: number;
    /** Source env for the runtime (the host's own env). */
    env: NodeJS.ProcessEnv;
    /** The Copilot credentials the leader handed over on stdin (readHostCredentials); they win over `env`. */
    credentials?: Record<string, string>;
    log?: (line: string) => void;
    /** Session-file writer (test seam for win32 rename contention); defaults to atomicWriteJson. */
    writeSessionJson?: (path: string, value: unknown) => Promise<void>;
    /** Loads the in-process tool builder for `spec.in_process_tools`; absent means the `t` MCP server. */
    loadInProcessTools?: () => Promise<typeof buildSdkInProcessTools>;
    /**
     * Where the in-process host listens for crashes and termination signals
     * (`process` in the CLI entry; a fake emitter in tests). Only used once the
     * in-process tool builder is loaded.
     */
    processEvents?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
}
export type SdkHostOutcome = 'stopped' | 'terminated' | 'team_gone' | 'invalid_spec' | 'decision_revoked' | 'decision_timeout' | 'ack_conflict' | 'sdk_missing' | 'start_failed'
/** An in-process tool threw past its handler (uncaughtException): stopped hard, session `failed`. */
 | 'tool_crash';
/** Parse doorbell lines after `offset`; returns entries and the new offset (complete lines only). */
export declare function readDoorbell(path: string, offset: number): {
    entries: SdkDoorbellEntry[];
    offset: number;
};
/** Prepend `dir` to PATH, matching the key case-insensitively on win32. */
export declare function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): void;
/**
 * Git config every worker command gets through GIT_CONFIG_COUNT/KEY_n/VALUE_n.
 * An empty value clears a multi-valued list: `credential.helper` (the system
 * `manager` included) and `http.extraHeader` (a CI checkout's
 * `AUTHORIZATION: basic ...`). A URL-scoped `http.<url>.extraheader` wins over
 * the plain key, so each one the repository config holds is reset by name
 * (probed with git 2.51: the plain reset leaves it in place).
 */
export declare const WORKER_GIT_CONFIG: ReadonlyArray<readonly [string, string]>;
/**
 * The `http.<url>.extraheader` keys git sees in `cwd` (every config level).
 * Listing the config runs nothing; any failure lists none.
 */
export declare function urlScopedExtraHeaderKeys(cwd: string, env: NodeJS.ProcessEnv): string[];
/**
 * A credential-free worker env, in place. Workers run arbitrary toolchains
 * unsandboxed, so this is a denylist (isCredentialEnvKey): every token,
 * secret-named var, ssh-agent and askpass hook, `GIT_CONFIG*` and `GCM_*` goes,
 * COPILOT_GITHUB_TOKEN included (the session gets it over RPC instead). `gh`
 * and `az` see an empty config dir; git never prompts, runs no credential
 * helper, sends no configured extra header and uses no ssh-agent
 * ({@link WORKER_GIT_CONFIG}, so identity, safe.directory and core.longpaths
 * from the user's config still apply). PATH, the home dirs, toolchain, proxy
 * and CA vars stay. This is hygiene against accidental use, not a boundary.
 */
export declare function scrubWorkerCredentials(env: NodeJS.ProcessEnv, emptyDir: string, cwd: string): void;
/**
 * The credentials the leader wrote to the host's stdin (sdk-transport.ts
 * hostCredentialHandoff): one JSON object of {@link HOST_CREDENTIAL_ENV}
 * strings, then EOF. Anything else (a TTY, no data, bad JSON, a timeout)
 * reads as none, and a host without a login then fails its start.
 */
export declare function readHostCredentials(stream: NodeJS.ReadableStream & {
    isTTY?: boolean;
    destroy?: () => void;
}, timeoutMs: number): Promise<Record<string, string>>;
/**
 * The Copilot credential for the session RPC: COPILOT_GITHUB_TOKEN, else
 * GH_TOKEN / GITHUB_TOKEN when no stored login was copied (with a login they
 * would shadow it, as buildSessionEnv drops them then).
 */
export declare function workerGitHubToken(env: NodeJS.ProcessEnv, hasLogin: boolean): string | undefined;
/**
 * Make `target` hold exactly `env`. The `t` MCP server child runs with the
 * session env; in-process tool handlers read `process.env`, so with
 * `in_process_tools` the host adopts that env once the runtime is spawned.
 */
export declare function adoptSessionEnv(target: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): void;
export declare function runSdkHost(spec: SdkHostSpec, deps: SdkHostDeps): Promise<SdkHostOutcome>;
/** CLI entry (`omg team sdk-host --spec <file>`): runs the host, then exits the process. */
export declare function runSdkHostMain(specPath: string, loadInProcessTools?: SdkHostDeps['loadInProcessTools']): Promise<never>;
//# sourceMappingURL=sdk-host.d.ts.map