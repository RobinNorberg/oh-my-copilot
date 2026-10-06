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
    log?: (line: string) => void;
    /** Session-file writer (test seam for win32 rename contention); defaults to atomicWriteJson. */
    writeSessionJson?: (path: string, value: unknown) => Promise<void>;
}
export type SdkHostOutcome = 'stopped' | 'terminated' | 'team_gone' | 'invalid_spec' | 'decision_revoked' | 'decision_timeout' | 'ack_conflict' | 'sdk_missing' | 'start_failed';
/** Parse doorbell lines after `offset`; returns entries and the new offset (complete lines only). */
export declare function readDoorbell(path: string, offset: number): {
    entries: SdkDoorbellEntry[];
    offset: number;
};
/** Prepend `dir` to PATH, matching the key case-insensitively on win32. */
export declare function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): void;
export declare function runSdkHost(spec: SdkHostSpec, deps: SdkHostDeps): Promise<SdkHostOutcome>;
/** CLI entry (`omg team sdk-host --spec <file>`): runs the host, then exits the process. */
export declare function runSdkHostMain(specPath: string): Promise<never>;
//# sourceMappingURL=sdk-host.d.ts.map