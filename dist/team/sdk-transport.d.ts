/**
 * Leader side of the headless SDK team transport (`omg team --transport sdk`).
 *
 * Pane workers are processes a multiplexer owns; SDK workers are sessions a
 * detached `omg team sdk-host` process owns (sdk-host.ts). This module holds
 * what the leader, the monitor, mailbox delivery and shutdown need:
 * - the per-worker file layout under the team state root;
 * - the doorbell (`sdk-doorbell.jsonl`), the only way to reach a session;
 * - the session file (`sdk-session.json`), read instead of a pane capture;
 * - host launch (launch attempt + detached spawn + ack/started handshake)
 *   and host stop (doorbell stop, then a bounded wait, then a tree kill).
 *
 * The team target is `sdk:<team>` and each worker's `pane_id` is `sdk:<worker>`:
 * neither names a multiplexer resource, so pane code paths must skip them
 * ({@link isSdkTarget}).
 */
import { type WorkerLaunchAttempt } from './worker-launch-ack.js';
export declare const SDK_TARGET_PREFIX = "sdk:";
/** True for the sdk team target (`sdk:<team>`) and sdk worker ids (`sdk:<worker>`). */
export declare function isSdkTarget(value: string | null | undefined): boolean;
export declare function sdkTeamTarget(teamName: string): string;
export declare function sdkPaneId(workerName: string): string;
export declare function sdkWorkerFiles(stateRoot: string, workerName: string): {
    dir: string;
    spec: string;
    doorbell: string;
    session: string;
    probe: string;
    events: string;
    log: string;
    home: string;
    bin: string;
    shutdownAck: string;
};
export interface SdkHostSpec {
    schema_version: 1;
    leader_cwd: string;
    team_name: string;
    worker_name: string;
    instance_id: string;
    attempt_id: string;
    pane_id: string;
    runtime_cli_path: string;
    worker_cwd: string;
    state_root: string;
    plugin_root: string;
    /** The installed Copilot exe (or its npm package .js), never a .cmd shim. */
    copilot_bin: string;
    model?: string;
    max_credits: number;
    worker_env: Record<string, string>;
    deny_tools: string[];
    deny_urls: string[];
    mcp_server: string;
    /** The leader's `bridge/cli.cjs`; the worker's `omg` shim runs it. */
    omg_cli_path: string;
    node_path: string;
    /** Copilot config dir whose login identity the per-worker home copies. */
    user_config_dir: string;
}
export interface SdkDoorbellEntry {
    id: string;
    /** `probe`: zero-model introspection (tools offered, MCP servers) written to `sdk-probe.json`. */
    kind: 'prompt' | 'abort' | 'stop' | 'shutdown' | 'probe';
    text?: string;
    at: string;
    from?: string;
}
export type SdkSessionState = 'starting' | 'idle' | 'busy' | 'capped' | 'closing' | 'closed' | 'failed';
export interface SdkSessionFile {
    schema_version: 1;
    team_name: string;
    worker_name: string;
    attempt_id: string;
    host_pid: number;
    runtime_pid: number | null;
    /** Strict start identity of `runtime_pid`; absent in files written before it existed. */
    runtime_start_identity?: string | null;
    session_id: string | null;
    model: string | null;
    state: SdkSessionState;
    turns: number;
    queued: number;
    /** Doorbell ids sent to the session, in order. */
    delivered: string[];
    last_event_type: string | null;
    last_event_at: string | null;
    updated_at: string;
    usage: {
        credits: number;
        premium_requests: number;
        shutdown_premium_requests: number | null;
        shutdown_credits: number | null;
    };
    hooks: {
        session_end_runs: number;
        failed: number;
    };
    aborts: number;
    permissions: Array<{
        at: string;
        kind: string;
        approve: boolean;
        reason: string;
        detail: string;
    }>;
    last_error: string | null;
    timeline: Partial<Record<'host_started_at' | 'ack_at' | 'accepted_at' | 'client_started_at' | 'session_created_at' | 'first_send_at' | 'first_message_at' | 'closed_at', string>>;
}
/** Append one doorbell entry; returns its id. Appends are line-sized and atomic enough for one writer per call. */
export declare function ringDoorbell(stateRoot: string, workerName: string, entry: Omit<SdkDoorbellEntry, 'id' | 'at'> & {
    id?: string;
}): string;
export declare function readSdkSession(stateRoot: string, workerName: string): SdkSessionFile | null;
export interface SdkLaunchInput {
    leaderCwd: string;
    teamName: string;
    workerName: string;
    instanceId: string;
    workerCwd: string;
    stateRoot: string;
    workerEnv: Record<string, string>;
    copilotBin: string;
    pluginRoot: string;
    userConfigDir: string;
    model?: string;
    maxCredits: number;
    denyTools: string[];
    denyUrls: string[];
    mcpServer?: string;
    /** Test seam for the detached spawn. */
    spawnHost?: (cliPath: string, specPath: string, logPath: string, cwd: string) => number | undefined;
    ackTimeoutMs?: number;
}
export type SdkLaunchResult = {
    ok: true;
    attempt: WorkerLaunchAttempt;
    hostPid: number | undefined;
    paneId: string;
} | {
    ok: false;
    attempt: WorkerLaunchAttempt | null;
    reason: string;
    hostPid?: number;
};
/**
 * Create the launch attempt, write the host spec and spawn the detached host,
 * then run the same ack -> accepted -> provider_started handshake a pane
 * bootstrap runs. A failed handshake tree-kills the host it spawned.
 */
export declare function launchSdkHost(input: SdkLaunchInput): Promise<SdkLaunchResult>;
/** Floor for a shutdown's host stop budget: lets a host already mid-teardown finish. */
export declare const SDK_HOST_STOP_FLOOR_MS = 5000;
/**
 * Ring `stop` (or `shutdown`, which also writes the shutdown ack), wait for the
 * host to report its provider dead, then tree-kill it as the last resort.
 * True once the provider is observed dead.
 */
export declare function stopSdkHost(attempt: WorkerLaunchAttempt, stateRoot: string, opts?: {
    timeoutMs?: number;
    kind?: 'stop' | 'shutdown';
    pollMs?: number;
}): Promise<boolean>;
//# sourceMappingURL=sdk-transport.d.ts.map