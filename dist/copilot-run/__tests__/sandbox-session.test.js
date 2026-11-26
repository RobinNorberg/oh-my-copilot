import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_SETTINGS, REVIEW_READ_TOOLS, isSandboxPolicyError, sandboxStateProblem } from '../sandbox.js';
import { SessionSandboxController, sandboxBypassDenial } from '../sandbox-session.js';
import { POLICY_CONFLICT_MESSAGE, fakeClientRpc, fakeSessionRpc } from './fake-sdk.js';
const root = join(tmpdir(), 'omg-sandbox-session-test');
const settingsWith = (over = {}) => ({ ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [], ...over });
function policyContext(settings) {
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
/** The loaded SDK as decide() sees it: only its version is read. */
function loadedSdk() {
    return { module: {}, version: '2.0.3', from: 'test' };
}
const client = (mode) => ({ getStatus: async () => ({ version: '1.0.105' }), rpc: fakeClientRpc(mode) });
function setup(mode, opts = {}) {
    const notes = [];
    const updates = [];
    let contexts = 0;
    const settings = settingsWith(opts.settings);
    const options = {
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
    const session = { sessionId: 's-1', rpc: fakeSessionRpc(mode, { optionsUpdates: updates }) };
    return { ctl, notes, updates, session, contexts: () => contexts };
}
describe('SessionSandboxController.decide/confirm', () => {
    it('supported: returns the config, which goes in at create (SDK v2), and confirms it as enforced', async () => {
        const t = setup('supported');
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        expect(config).not.toBeNull();
        expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'not confirmed yet', applied: 'none', cliVersion: '1.0.105', sdkVersion: '2.0.3', unsandboxedCalls: 0 });
        expect(t.ctl.atCreate(config)).toBe(true);
        expect(t.ctl.atCreate(null)).toBe(false);
        await t.ctl.confirm(t.session, config, true);
        expect(t.ctl.state).toMatchObject({ mode: 'enforced', applied: 'create', configSource: 'session_flag', enforcement: { required: false, blocked: false } });
        expect(t.ctl.state.reason).toBeUndefined();
        // Affirmative evidence after create: the same policy again through options.update (idempotent), then getState.
        expect(t.updates).toEqual([{ permissions: { sandbox: config, sandboxSource: 'session_flag' } }]);
        expect(t.notes).toEqual([]);
    });
    it('a session created without the config: confirm applies it through options.update (v2 patch shape)', async () => {
        const t = setup('supported');
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        await t.ctl.confirm(t.session, config, false);
        expect(t.ctl.state).toMatchObject({ mode: 'enforced', applied: 'options.update' });
        expect(t.updates).toEqual([{ permissions: { sandbox: config, sandboxSource: 'session_flag' } }]);
    });
    it('createFailed: the fail-closed mode with the create error, per profile and setting', async () => {
        const w = setup('update-fails');
        await w.ctl.decide(client('update-fails'), loadedSdk());
        w.ctl.createFailed('policy conflict');
        expect(w.ctl.state).toMatchObject({ mode: 'refused', applied: 'none', reason: 'createSession with the sandbox policy failed: policy conflict' });
        const r = setup('update-fails', { profile: 'review' });
        await r.ctl.decide(client('update-fails'), loadedSdk());
        r.ctl.createFailed('policy conflict');
        expect(r.ctl.state?.mode).toBe('read-only-no-shell');
        expect(r.notes).toEqual(['sandbox: not confirmed (createSession with the sandbox policy failed: policy conflict); the review runs read-only without a shell.']);
        expect(r.updates).toEqual([]);
        const d = setup('update-fails', { settings: { writeUnsandboxed: 'detect-only' } });
        await d.ctl.decide(client('update-fails'), loadedSdk());
        d.ctl.createFailed('policy conflict');
        expect(d.ctl.state?.mode).toBe('detect-only');
    });
    it.each([
        ['ignored', 'sandbox.getState: the effective sandbox config is not enabled (enabled: false)'],
        ['no-state', 'the SDK has no sandbox.getState RPC'],
        ['state-throws', 'sandbox.getState failed: state unavailable'],
        ['state-hangs', 'sandbox.getState failed: sandbox.getState() timed out after 1000 ms'],
        ['opted-out', 'sandbox.getState: the session holds a sandbox opt-out (disabledForSession: true)'],
    ])('policy at create, state not confirmed (%s): refused (write), read-only-no-shell (review), detect-only when allowed', async (mode, reason) => {
        const w = setup(mode);
        const config = await w.ctl.decide(client(mode), loadedSdk());
        await w.ctl.confirm(w.session, config, true);
        expect(w.ctl.state).toMatchObject({ mode: 'refused', applied: 'create', reason });
        expect(w.ctl.state.enforcement).toBeUndefined();
        const r = setup(mode, { profile: 'review' });
        await r.ctl.confirm(r.session, (await r.ctl.decide(client(mode), loadedSdk())), true);
        expect(r.ctl.state).toMatchObject({ mode: 'read-only-no-shell', reason });
        expect(r.updates.at(-1)).toEqual({ tools: { availableTools: [...REVIEW_READ_TOOLS] } });
        const d = setup(mode, { settings: { writeUnsandboxed: 'detect-only' } });
        await d.ctl.confirm(d.session, (await d.ctl.decide(client(mode), loadedSdk())), true);
        expect(d.ctl.state).toMatchObject({ mode: 'detect-only', reason });
    });
    it('ignored: a runtime that drops the create-time policy and reports enforcement { required: false, blocked: false } is not enforced', async () => {
        const t = setup('ignored');
        const config = await t.ctl.decide(client('ignored'), loadedSdk());
        // As job.ts creates it: the session took the policy at create, and the runtime dropped it.
        const session = { sessionId: 's-1', rpc: fakeSessionRpc('ignored', { optionsUpdates: [] }, config) };
        const rpc = session.rpc;
        expect(await rpc.sandbox.getEnforcementStatus()).toEqual({ required: false, blocked: false });
        await t.ctl.confirm(session, config, true);
        expect(t.ctl.state?.mode).toBe('refused');
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
        await t.ctl.confirm(t.session, config, false);
        expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'sandbox enforcement is blocked: managed policy', enforcement: { blocked: true, reason: 'managed policy' } });
        const r = setup('blocked', { profile: 'review' });
        const rc = await r.ctl.decide(client('blocked'), loadedSdk());
        expect(r.ctl.state?.mode).toBe('read-only-no-shell');
        await r.ctl.confirm(r.session, rc, false);
        expect(r.ctl.state?.mode).toBe('read-only-no-shell');
        expect(r.updates.at(-1)).toEqual({ tools: { availableTools: [...REVIEW_READ_TOOLS] } });
        expect(r.notes).toEqual(['sandbox: not confirmed (sandbox enforcement is blocked: managed policy); the review runs read-only without a shell.']);
    });
    it('update-fails: refused with the update error, applied stays none', async () => {
        const t = setup('update-fails');
        const config = await t.ctl.decide(client('update-fails'), loadedSdk());
        await t.ctl.confirm(t.session, config, false);
        expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: `options.update failed: ${POLICY_CONFLICT_MESSAGE}`, applied: 'none' });
    });
    it('no-rpc: the host probe fails closed', async () => {
        const t = setup('no-rpc');
        expect(await t.ctl.decide(client('no-rpc'), loadedSdk())).toBeNull();
        expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'the SDK has no sandbox.getHostSupport RPC' });
    });
    it('no-rpc on the session: a supported host still refuses when the config cannot be applied', async () => {
        const t = setup('no-rpc');
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        await t.ctl.confirm(t.session, config, false);
        expect(t.ctl.state).toMatchObject({ mode: 'refused', reason: 'the SDK has no options.update RPC' });
    });
    it('M-B: a write session records the writeNetwork it ran with; a review session records none', async () => {
        const w = setup('supported', { settings: { writeNetwork: 'registry' } });
        await w.ctl.decide(client('supported'), loadedSdk());
        expect(w.ctl.state.writeNetwork).toBe('registry');
        const off = setup('supported', { settings: { enabled: false } });
        await off.ctl.decide(client('supported'), loadedSdk());
        expect(off.ctl.state.writeNetwork).toBe('none');
        const r = setup('supported', { profile: 'review' });
        await r.ctl.decide(client('supported'), loadedSdk());
        expect(r.ctl.state).not.toHaveProperty('writeNetwork');
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
        const failing = { getStatus: async () => { throw new Error('down'); }, rpc: fakeClientRpc('supported') };
        await t.ctl.decide(failing, { ...loadedSdk(), version: null });
        expect(t.ctl.state).toMatchObject({ cliVersion: 'unknown', sdkVersion: 'unknown' });
    });
});
describe('SessionSandboxController attestation', () => {
    async function enforced() {
        const t = setup('supported');
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        await t.ctl.confirm(t.session, config, false);
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
describe('SessionSandboxController.stateChanged (session.sandbox_state_changed)', () => {
    const inForce = (over = {}, config = { enabled: true, allowBypass: false }) => ({ incarnation: 1, revision: 2, config, configSource: 'session_flag', disabledForSession: false, autoApproveBypass: false, sessionOverride: null, ...over });
    async function enforced() {
        const t = setup('supported');
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        await t.ctl.confirm(t.session, config, true);
        expect(t.ctl.state?.mode).toBe('enforced');
        return t.ctl;
    }
    it('a state that keeps the policy in force passes', async () => {
        const ctl = await enforced();
        expect(ctl.stateChanged(inForce())).toBeNull();
        expect(ctl.stateEscape).toBeNull();
    });
    it.each([
        ['disabledForSession', inForce({ disabledForSession: true }), 'the session holds a sandbox opt-out (disabledForSession: true)'],
        ['config.enabled false', inForce({}, { enabled: false }), 'the effective sandbox config is not enabled (enabled: false)'],
        ['autoApproveBypass', inForce({ autoApproveBypass: true }), 'the session auto-approves sandbox bypass requests (autoApproveBypass: true)'],
        ['allowBypass', inForce({}, { enabled: true, allowBypass: true }), 'the effective sandbox config allows bypass requests'],
        ['no config', inForce({ config: null }), 'the sandbox state has no effective config'],
    ])('%s in an enforced session is an escape', async (_label, data, problem) => {
        const ctl = await enforced();
        const why = `sandbox-escaped: the session's sandbox changed mid-session (${problem})`;
        expect(ctl.stateChanged(data)).toBe(why);
        expect(ctl.stateEscape).toBe(why);
        // Reported once.
        expect(ctl.stateChanged(data)).toBeNull();
    });
    it('before confirm or in a session that is not enforced it is ignored (confirm reads the state itself)', async () => {
        const t = setup('supported');
        await t.ctl.decide(client('supported'), loadedSdk());
        expect(t.ctl.stateChanged(inForce({ disabledForSession: true }))).toBeNull();
        const d = setup('unsupported', { settings: { writeUnsandboxed: 'detect-only' } });
        await d.ctl.decide(client('unsupported'), loadedSdk());
        expect(d.ctl.stateChanged(inForce({}, { enabled: false }))).toBeNull();
    });
});
describe('sandboxStateProblem', () => {
    it('needs config.enabled true, no bypass, no opt-out; wrong types count as not in force', () => {
        const ok = { config: { enabled: true, allowBypass: false }, disabledForSession: false, autoApproveBypass: false };
        expect(sandboxStateProblem(ok)).toBeNull();
        // allowBypass absent: the runtime's default offers no bypass.
        expect(sandboxStateProblem({ ...ok, config: { enabled: true } })).toBeNull();
        expect(sandboxStateProblem(null)).toBe('no sandbox state');
        expect(sandboxStateProblem({ ...ok, config: { enabled: 'true' } })).toMatch(/not enabled/);
        expect(sandboxStateProblem({ ...ok, disabledForSession: undefined })).toMatch(/opt-out/);
        expect(sandboxStateProblem({ ...ok, autoApproveBypass: 'no' })).toMatch(/auto-approves/);
    });
});
describe('isSandboxPolicyError', () => {
    it('a policy conflict, an invalid sandbox config or a JSON-RPC error naming the conflict code is a sandbox error', () => {
        expect(isSandboxPolicyError(new Error(POLICY_CONFLICT_MESSAGE))).toBe(true);
        expect(isSandboxPolicyError(new Error("invalid parameter 'sandboxConfig': userPolicy must be an object"))).toBe(true);
        expect(isSandboxPolicyError(Object.assign(new Error('Request failed'), { code: -32603, data: { code: 'managed_sandbox_policy_conflict' } }))).toBe(true);
    });
    it('auth, network and model errors are not', () => {
        expect(isSandboxPolicyError(new Error('authentication failed: 401 Unauthorized'))).toBe(false);
        expect(isSandboxPolicyError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(false);
        expect(isSandboxPolicyError(new Error('Model "gpt-x" is not available'))).toBe(false);
        expect(isSandboxPolicyError(new Error('You are not authorized to use this Copilot feature, it requires an enterprise or organization policy to be enabled.'))).toBe(false);
        expect(isSandboxPolicyError('socket hang up')).toBe(false);
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
//# sourceMappingURL=sandbox-session.test.js.map