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
import { sdkCreateSessionAcceptsSandbox } from '../smoke/copilot-sdk-driver.js';
import type { SdkPermissionRequest } from '../team/sdk-policy.js';
import { errText, withTimeout } from './timeout.js';
import {
  REVIEW_READ_TOOLS,
  SANDBOX_KILL_ENV,
  SANDBOX_SHELL_TOOLS,
  applySandboxConfig,
  buildSandboxConfig,
  probeHostSupport,
  readEnforcement,
  unconfirmedMode,
  type CopilotRunSandboxState,
  type SandboxConfig,
  type SandboxPolicyContext,
  type SandboxProfile,
  type SandboxSettings,
} from './sandbox.js';

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
export function sandboxBypassDenial(req: SdkPermissionRequest): { approve: false; reason: string } | null {
  return req.requestSandboxBypass === true || req.requestSandboxPermissive === true
    ? { approve: false, reason: 'sandbox bypass requests are never approved' }
    : null;
}

export class SessionSandboxController {
  /** The sandbox record once `decide` ran; `confirm` and `toolCompleted` update it in place. */
  state: CopilotRunSandboxState | null = null;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly opts: SessionSandboxOptions) {}

  /** Whether createSession takes `config` (else confirm applies it via options.update). */
  atCreate(loaded: LoadedSdk, config: SandboxConfig | null): boolean {
    return config !== null && sdkCreateSessionAcceptsSandbox(loaded);
  }

  /**
   * Probe the host and set `state` (§5). Returns the config to apply when
   * the host supports the sandbox (the mode stays the unconfirmed one until
   * confirm), else null with the final mode: `detect-only` when the sandbox
   * is switched off, otherwise the fail-closed mode.
   */
  async decide(client: SdkClientLike, loaded: LoadedSdk): Promise<SandboxConfig | null> {
    const { opts } = this;
    let cliVersion = 'unknown';
    try {
      const status = await withTimeout(client.getStatus(), opts.rpcTimeoutMs, 'getStatus()');
      if (typeof status.version === 'string') cliVersion = status.version;
    } catch { /* recorded as unknown */ }
    const host = await probeHostSupport(client, opts.rpcTimeoutMs, { platform: opts.platform, ...(opts.trialLaunch ? { trialLaunch: opts.trialLaunch } : {}) });
    const base = { host, applied: 'none' as const, canary: 'skipped' as const, unsandboxedCalls: 0, cliVersion, sdkVersion: loaded.version ?? 'unknown' };
    const { settings, profile } = opts;
    const off = !settings.enabled ? 'sandbox.enabled is false' : opts.env[SANDBOX_KILL_ENV] === 'off' ? `${SANDBOX_KILL_ENV}=off` : null;
    if (off) {
      // detect-only applies to write sessions only: a review without an enforced sandbox has no shell.
      if (profile === 'review') {
        this.state = { ...base, mode: 'read-only-no-shell', reason: off };
        opts.note(`sandbox: switched off (${off}); the review runs read-only without a shell.`);
      } else {
        this.state = { ...base, mode: 'detect-only', reason: off };
        opts.note(`sandbox: switched off (${off}); this session is not OS-sandboxed (detect-only).`);
      }
      return null;
    }
    const fallback = (reason: string) => {
      this.state = { ...base, mode: unconfirmedMode(profile, settings), reason };
      if (this.state.mode === 'detect-only') opts.note(`sandbox: not available (${reason}); writeUnsandboxed "detect-only" runs this session unsandboxed.`);
      if (this.state.mode === 'read-only-no-shell') opts.note(`sandbox: not available (${reason}); the review runs read-only without a shell.`);
    };
    if (!host.supported) {
      fallback(host.reason ?? 'the host does not support the sandbox');
      return null;
    }
    try {
      const config = buildSandboxConfig(profile, opts.policyContext(), host);
      this.state = { ...base, mode: unconfirmedMode(profile, settings), reason: 'not confirmed yet' };
      return config;
    } catch (err) {
      fallback(errText(err));
      return null;
    }
  }

  /** Apply `config` (unless createSession took it) and read the enforcement status; downgrade to the fail-closed mode on any doubt. */
  async confirm(session: SdkSessionLike, config: SandboxConfig, atCreate: boolean): Promise<void> {
    const { opts } = this;
    const sbx = this.state!;
    let why = atCreate ? null : await applySandboxConfig(session, config, opts.rpcTimeoutMs);
    if (!why) {
      sbx.applied = atCreate ? 'create' : 'options.update';
      const enf = await readEnforcement(session, opts.rpcTimeoutMs);
      if (typeof enf === 'string') why = enf;
      else {
        sbx.enforcement = enf;
        if (enf.blocked) why = `sandbox enforcement is blocked${enf.reason ? `: ${enf.reason}` : ''}`;
      }
    }
    if (!why) {
      sbx.mode = 'enforced';
      delete sbx.reason;
      return;
    }
    sbx.mode = unconfirmedMode(opts.profile, opts.settings);
    sbx.reason = why;
    if (sbx.mode === 'detect-only') opts.note(`sandbox: not confirmed (${why}); writeUnsandboxed "detect-only" runs this session unsandboxed.`);
    if (sbx.mode === 'read-only-no-shell') {
      opts.note(`sandbox: not confirmed (${why}); the review runs read-only without a shell.`);
      // The permission handler already refuses every shell call; this also hides the tools.
      try { await withTimeout<unknown>(session.rpc.options?.update?.({ availableTools: [...REVIEW_READ_TOOLS] }) ?? Promise.resolve(), opts.rpcTimeoutMs, 'options.update()'); } catch { /* the handler still refuses */ }
    }
  }

  /** `tool.execution_start` data: remembers the call's tool name for its attestation. */
  toolStarted(data: Record<string, unknown>): void {
    if (typeof data.toolCallId === 'string' && typeof data.toolName === 'string') this.toolNames.set(data.toolCallId, data.toolName);
  }

  /**
   * `tool.execution_complete` data: the attestation (§5). A shell call must
   * report sandboxed: true. A call of an unknown tool must not report false,
   * and in an enforced session it must report true (a missing field is an
   * escape). Counts every escape; returns the `sandbox-escaped:` error when
   * the session must stop (any mode but detect-only), else null.
   */
  toolCompleted(data: Record<string, unknown>): string | null {
    const id = String(data.toolCallId ?? '');
    const name = this.toolNames.get(id) ?? (typeof data.toolName === 'string' ? data.toolName : null);
    this.toolNames.delete(id);
    const sbx = this.state;
    const escaped = name === null
      ? (sbx?.mode === 'enforced' ? data.sandboxed !== true : data.sandboxed === false)
      : SANDBOX_SHELL_TOOLS.has(name) && data.sandboxed !== true;
    if (!sbx || !escaped) return null;
    sbx.unsandboxedCalls += 1;
    if (sbx.mode === 'detect-only') return null;
    return `sandbox-escaped: ${name ?? 'a tool'} call ${id || '?'} ran outside the sandbox (sandboxed: ${String(data.sandboxed)}); the session was stopped`;
  }
}
