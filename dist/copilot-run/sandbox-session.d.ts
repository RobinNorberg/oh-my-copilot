/**
 * The OS sandbox of one Copilot SDK session, from the host probe to the
 * running session's attestation (.omc/plans/2026-10-27-sandboxed-lanes-design.md §5).
 *
 * A {@link SessionSandboxController} is driven in this order:
 * - `decide(client, loaded)` after `client.start()`: probes the host and
 *   returns the config to apply, or null with the final mode (switched off,
 *   unsupported, or a policy that cannot be built); a null with mode
 *   `refused` means the session must not be created;
 * - `atCreate(loaded, config)` / `confirm(session, config, atCreate)`: the config
 *   goes in at create when the SDK forwards it, else via options.update, and
 *   the enforcement status decides the final mode (fail closed on any doubt);
 * - `toolStarted(data)` / `toolCompleted(data)` from the session's events:
 *   a shell call that does not report `sandboxed: true` is an escape;
 * - {@link sandboxBypassDenial} in the permission handler: every bypass
 *   request is rejected.
 *
 * The controller holds no session or job state beyond the sandbox record
 * (`state`); what an escape or a refusal does to the session is the caller's.
 */
import type { LoadedSdk, SdkClientLike, SdkSessionLike } from '../smoke/copilot-sdk-driver.js';
import type { SdkPermissionRequest } from '../team/sdk-policy.js';
import { type CopilotRunSandboxState, type SandboxConfig, type SandboxPolicyContext, type SandboxProfile, type SandboxSettings } from './sandbox.js';
export interface SessionSandboxOptions {
    profile: SandboxProfile;
    settings: SandboxSettings;
    /** The env the kill switch ({@link SANDBOX_KILL_ENV}) is read from: the caller's, never the session's. */
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    rpcTimeoutMs: number;
    /** Why a trial sandbox launch failed on Linux, or null (default cachedBwrapTrialLaunchError). */
    trialLaunch?: () => string | null;
    /** The policy context, built only once the host supports the sandbox; a throw falls back to the fail-closed mode. */
    policyContext: () => SandboxPolicyContext;
    /** A line for the caller's notes (why the session runs unsandboxed or without a shell). */
    note: (text: string) => void;
}
/** A rejection for a sandbox bypass request (`requestSandboxBypass` / `requestSandboxPermissive`), else null. */
export declare function sandboxBypassDenial(req: SdkPermissionRequest): {
    approve: false;
    reason: string;
} | null;
export declare class SessionSandboxController {
    private readonly opts;
    /** The sandbox record once `decide` ran; `confirm` and `toolCompleted` update it in place. */
    state: CopilotRunSandboxState | null;
    private readonly toolNames;
    constructor(opts: SessionSandboxOptions);
    /** Whether createSession takes `config` (else confirm applies it via options.update). */
    atCreate(loaded: LoadedSdk, config: SandboxConfig | null): boolean;
    /**
     * Probe the host and set `state` (§5). Returns the config to apply when
     * the host supports the sandbox (the mode stays the unconfirmed one until
     * confirm), else null with the final mode: `detect-only` when the sandbox
     * is switched off, otherwise the fail-closed mode.
     */
    decide(client: SdkClientLike, loaded: LoadedSdk): Promise<SandboxConfig | null>;
    /** Apply `config` (unless createSession took it) and read the enforcement status; downgrade to the fail-closed mode on any doubt. */
    confirm(session: SdkSessionLike, config: SandboxConfig, atCreate: boolean): Promise<void>;
    /** `tool.execution_start` data: remembers the call's tool name for its attestation. */
    toolStarted(data: Record<string, unknown>): void;
    /**
     * `tool.execution_complete` data: the attestation (§5). A shell call must
     * report sandboxed: true. A call of an unknown tool must not report false,
     * and in an enforced session it must report true (a missing field is an
     * escape). Counts every escape; returns the `sandbox-escaped:` error when
     * the session must stop (any mode but detect-only), else null.
     */
    toolCompleted(data: Record<string, unknown>): string | null;
}
//# sourceMappingURL=sandbox-session.d.ts.map