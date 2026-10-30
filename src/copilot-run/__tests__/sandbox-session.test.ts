import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import type { LoadedSdk, SdkClientLike, SdkSessionLike } from '../../smoke/copilot-sdk-driver.js';
import { DEFAULT_SANDBOX_SETTINGS, REVIEW_READ_TOOLS, type SandboxPolicyContext, type SandboxProfile, type SandboxSettings } from '../sandbox.js';
import { SessionSandboxController, sandboxBypassDenial, type SessionSandboxOptions } from '../sandbox-session.js';
import { fakeClientRpc, fakeSessionRpc, type FakeSandbox } from './fake-sdk.js';

const root = join(tmpdir(), 'omg-sandbox-session-test');
const settingsWith = (over: Partial<SandboxSettings> = {}): SandboxSettings =>
  ({ ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [], ...over });

function policyContext(settings: SandboxSettings): SandboxPolicyContext {
  return {
    worktree: join(root, 'wt'),
    commonGitDir: join(root, 'repo', '.git'),
    pluginRoot: join(root, 'plugin'),
    jobHome: join(root, 'job', 'home'),
    jobDir: join(root, 'job'),
    realHome: join(root, 'me'),
    platform: process.platform,
    settings,
    hostCommits: true,
  };
}

/** An SDK whose createSession forwards sandboxConfig (`atCreate`) or not. */
function loadedSdk(atCreate = false): LoadedSdk {
  // sdkCreateSessionAcceptsSandbox reads the createSession source for the field name.
  class Forwards {
    async createSession(cfg: Record<string, unknown>) { return cfg.sandboxConfig; }
  }
  class Ignores {
    async createSession(cfg: Record<string, unknown>) { return cfg; }
  }
  return { module: { CopilotClient: atCreate ? Forwards : Ignores } as never, version: '1.0.16', from: 'test' };
}

const client = (mode: FakeSandbox) => ({ getStatus: async () => ({ version: '1.0.105' }), rpc: fakeClientRpc(mode) }) as unknown as SdkClientLike;

interface SetupOptions {
  profile?: SandboxProfile;
  settings?: Partial<SandboxSettings>;
  env?: NodeJS.ProcessEnv;
  policyContext?: () => SandboxPolicyContext;
}

function setup(mode: FakeSandbox, opts: SetupOptions = {}) {
  const notes: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  let contexts = 0;
  const settings = settingsWith(opts.settings);
  const options: SessionSandboxOptions = {
    profile: opts.profile ?? 'write',
    settings,
    env: opts.env ?? {},
    platform: process.platform,
    rpcTimeoutMs: 1_000,
    trialLaunch: () => null,
    policyContext: () => { contexts += 1; return (opts.policyContext ?? (() => policyContext(settings)))(); },
    note: (text) => { notes.push(text); },
  };
  const ctl = new SessionSandboxController(options);
  const session = { sessionId: 's-1', rpc: fakeSessionRpc(mode, { optionsUpdates: updates }) } as unknown as SdkSessionLike;
  return { ctl, notes, updates, session, contexts: () => contexts };
}

describe('SessionSandboxController.decide/confirm', () => {
  it('supported: returns the config, then confirms it via options.update as enforced', async () => {
    const t = setup('supported');
    const config = await t.ctl.decide(client('supported'), loadedSdk());
    expect(config).not.toBeNull();
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'not confirmed yet', applied: 'none', cliVersion: '1.0.105', sdkVersion: '1.0.16', unsandboxedCalls: 0 });
    const atCreate = t.ctl.atCreate(loadedSdk(), config);
    expect(atCreate).toBe(false);
    await t.ctl.confirm(t.session, config!, atCreate);
    expect(t.ctl.state).toMatchObject({ mode: 'enforced', applied: 'options.update', enforcement: { required: false, blocked: false } });
    expect(t.ctl.state!.reason).toBeUndefined();
    expect(t.updates).toEqual([{ sandboxConfig: config, sandboxConfigSource: 'session_flag' }]);
    expect(t.notes).toEqual([]);
  });

  it('supported with an SDK that takes the config at create: no options.update', async () => {
    const t = setup('supported');
    const config = await t.ctl.decide(client('supported'), loadedSdk(true));
    expect(t.ctl.atCreate(loadedSdk(true), config)).toBe(true);
    expect(t.ctl.atCreate(loadedSdk(true), null)).toBe(false);
    await t.ctl.confirm(t.session, config!, true);
    expect(t.ctl.state).toMatchObject({ mode: 'enforced', applied: 'create' });
    expect(t.updates).toEqual([]);
  });

  it('unsupported: null and refused for a write session, detect-only with a note when allowed', async () => {
    const t = setup('unsupported');
    expect(await t.ctl.decide(client('unsupported'), loadedSdk())).toBeNull();
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'MXC is not available on this host', host: { supported: false } });
    expect(t.contexts()).toBe(0);
    const d = setup('unsupported', { settings: { writeUnsandboxed: 'detect-only' } });
    expect(await d.ctl.decide(client('unsupported'), loadedSdk())).toBeNull();
    expect(d.ctl.state?.mode).toBe('detect-only');
    expect(d.notes).toEqual(['sandbox: not available (MXC is not available on this host); writeUnsandboxed "detect-only" runs this session unsandboxed.']);
  });

  it('blocked: a write session is refused after confirm, a review loses its shell tools', async () => {
    const t = setup('blocked');
    const config = await t.ctl.decide(client('blocked'), loadedSdk());
    await t.ctl.confirm(t.session, config!, false);
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'sandbox enforcement is blocked: managed policy', enforcement: { blocked: true, reason: 'managed policy' } });

    const r = setup('blocked', { profile: 'review' });
    const rc = await r.ctl.decide(client('blocked'), loadedSdk());
    expect(r.ctl.state?.mode).toBe('read-only-no-shell');
    await r.ctl.confirm(r.session, rc!, false);
    expect(r.ctl.state?.mode).toBe('read-only-no-shell');
    expect(r.updates.at(-1)).toEqual({ availableTools: [...REVIEW_READ_TOOLS] });
    expect(r.notes).toEqual(['sandbox: not confirmed (sandbox enforcement is blocked: managed policy); the review runs read-only without a shell.']);
  });

  it('update-fails: refused with the update error, applied stays none', async () => {
    const t = setup('update-fails');
    const config = await t.ctl.decide(client('update-fails'), loadedSdk());
    await t.ctl.confirm(t.session, config!, false);
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'options.update failed: policy conflict', applied: 'none' });
  });

  it('no-rpc: the host probe fails closed', async () => {
    const t = setup('no-rpc');
    expect(await t.ctl.decide(client('no-rpc'), loadedSdk())).toBeNull();
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'the SDK has no sandbox.getHostSupport RPC' });
  });

  it('no-rpc on the session: a supported host still refuses when the config cannot be applied', async () => {
    const t = setup('no-rpc');
    const config = await t.ctl.decide(client('supported'), loadedSdk());
    await t.ctl.confirm(t.session, config!, false);
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'the SDK has no options.update RPC' });
  });

  it('switched off by settings or the kill switch: detect-only (write) or read-only-no-shell (review), no policy built', async () => {
    const w = setup('supported', { settings: { enabled: false } });
    expect(await w.ctl.decide(client('supported'), loadedSdk())).toBeNull();
    expect(w.ctl.state).toMatchObject({ mode: 'detect-only', reason: 'sandbox.enabled is false' });
    expect(w.notes).toEqual(['sandbox: switched off (sandbox.enabled is false); this session is not OS-sandboxed (detect-only).']);
    const r = setup('supported', { profile: 'review', env: { OMG_SANDBOX: 'off' } });
    expect(await r.ctl.decide(client('supported'), loadedSdk())).toBeNull();
    expect(r.ctl.state).toMatchObject({ mode: 'read-only-no-shell', reason: 'OMG_SANDBOX=off' });
    expect(w.contexts() + r.contexts()).toBe(0);
  });

  it('a policy that cannot be built falls back to the fail-closed mode with its error', async () => {
    const t = setup('supported', { policyContext: () => { throw new Error('no worktree'); } });
    expect(await t.ctl.decide(client('supported'), loadedSdk())).toBeNull();
    expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'no worktree' });
  });

  it('records the CLI and SDK versions as unknown when they cannot be read', async () => {
    const t = setup('supported');
    const failing = { getStatus: async () => { throw new Error('down'); }, rpc: fakeClientRpc('supported') } as unknown as SdkClientLike;
    await t.ctl.decide(failing, { ...loadedSdk(), version: null });
    expect(t.ctl.state).toMatchObject({ cliVersion: 'unknown', sdkVersion: 'unknown' });
  });
});

describe('SessionSandboxController attestation', () => {
  async function enforced() {
    const t = setup('supported');
    const config = await t.ctl.decide(client('supported'), loadedSdk());
    await t.ctl.confirm(t.session, config!, false);
    return t.ctl;
  }

  it('is silent before decide', () => {
    const { ctl } = setup('supported');
    expect(ctl.toolCompleted({ toolCallId: 'c1', toolName: 'bash', sandboxed: false })).toBeNull();
  });

  it('a sandboxed shell call passes; an unsandboxed one is an escape', async () => {
    const ctl = await enforced();
    ctl.toolStarted({ toolCallId: 'c1', toolName: 'powershell' });
    expect(ctl.toolCompleted({ toolCallId: 'c1', sandboxed: true })).toBeNull();
    ctl.toolStarted({ toolCallId: 'c2', toolName: 'bash' });
    expect(ctl.toolCompleted({ toolCallId: 'c2' })).toBe('sandbox-escaped: bash call c2 ran outside the sandbox (sandboxed: undefined); the session was stopped');
    expect(ctl.state?.unsandboxedCalls).toBe(1);
    // A non-shell tool needs no attestation.
    ctl.toolStarted({ toolCallId: 'c3', toolName: 'view' });
    expect(ctl.toolCompleted({ toolCallId: 'c3' })).toBeNull();
  });

  it('an unknown tool must report sandboxed: true in an enforced session', async () => {
    const ctl = await enforced();
    expect(ctl.toolCompleted({ toolCallId: 'x' })).toBe('sandbox-escaped: a tool call x ran outside the sandbox (sandboxed: undefined); the session was stopped');
    expect(ctl.toolCompleted({ sandboxed: true })).toBeNull();
  });

  it('detect-only counts escapes without stopping; an unknown tool only escapes on sandboxed: false', async () => {
    const t = setup('unsupported', { settings: { writeUnsandboxed: 'detect-only' } });
    await t.ctl.decide(client('unsupported'), loadedSdk());
    expect(t.ctl.toolCompleted({ toolCallId: 'c1', toolName: 'shell', sandboxed: false })).toBeNull();
    expect(t.ctl.toolCompleted({ toolCallId: 'c2' })).toBeNull();
    expect(t.ctl.state?.unsandboxedCalls).toBe(1);
  });
});

describe('sandboxBypassDenial', () => {
  it('rejects every bypass request and passes others', () => {
    const reason = 'sandbox bypass requests are never approved';
    expect(sandboxBypassDenial({ kind: 'shell', requestSandboxBypass: true })).toEqual({ approve: false, reason });
    expect(sandboxBypassDenial({ kind: 'shell', requestSandboxPermissive: true })).toEqual({ approve: false, reason });
    expect(sandboxBypassDenial({ kind: 'shell' })).toBeNull();
  });
});
