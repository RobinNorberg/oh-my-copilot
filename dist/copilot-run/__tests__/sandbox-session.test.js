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
        platform: opts.platform ?? process.platform,
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
    let sent;
    const inForce = (over = {}, config = sent) => ({ incarnation: 1, revision: 2, config, configSource: 'session_flag', disabledForSession: false, autoApproveBypass: false, sessionOverride: null, ...over });
    async function enforced() {
        const t = setup('supported');
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        await t.ctl.confirm(t.session, config, true);
        expect(t.ctl.state?.mode).toBe('enforced');
        sent = config;
        return t.ctl;
    }
    it('a state that keeps the policy in force passes', async () => {
        const ctl = await enforced();
        expect(ctl.stateChanged(inForce())).toBeNull();
        expect(ctl.stateEscape).toBeNull();
        expect(ctl.state.stateEscaped).toBeUndefined();
    });
    it.each([
        ['disabledForSession', () => inForce({ disabledForSession: true }), 'the session holds a sandbox opt-out (disabledForSession: true)'],
        ['config.enabled false', () => inForce({}, { enabled: false }), 'the effective sandbox config is not enabled (enabled: false)'],
        ['autoApproveBypass', () => inForce({ autoApproveBypass: true }), 'the session auto-approves sandbox bypass requests (autoApproveBypass: true)'],
        ['allowBypass', (c) => inForce({}, { ...c, allowBypass: true }), 'the effective sandbox config allows bypass requests'],
        ['no config', () => inForce({ config: null }), 'the sandbox state has no effective config'],
        ['a weaker config', (c) => inForce({}, { ...c, sandboxMcpServers: false }), 'the effective sandbox config is weaker than the policy sent: sandboxMcpServers is false, the policy did not opt out'],
    ])('%s in an enforced session is an escape, recorded in the sandbox record', async (_label, data, problem) => {
        const ctl = await enforced();
        const why = `sandbox-escaped: the session's sandbox changed mid-session (${problem})`;
        expect(ctl.stateChanged(data(sent))).toBe(why);
        expect(ctl.stateEscape).toBe(why);
        expect(ctl.state).toMatchObject({ mode: 'enforced', unsandboxedCalls: 0, stateEscaped: why });
        // Reported once.
        expect(ctl.stateChanged(data(sent))).toBeNull();
    });
    it('before confirm or in a session that is not enforced it is ignored (confirm reads the state itself)', async () => {
        const t = setup('supported');
        await t.ctl.decide(client('supported'), loadedSdk());
        expect(t.ctl.stateChanged(inForce({ disabledForSession: true }))).toBeNull();
        const d = setup('unsupported', { settings: { writeUnsandboxed: 'detect-only' } });
        await d.ctl.decide(client('unsupported'), loadedSdk());
        expect(d.ctl.stateChanged(inForce({}, { enabled: false }))).toBeNull();
        expect(d.ctl.state.stateEscaped).toBeUndefined();
    });
});
/** Each way an effective config can be weaker than the sent one, with the reason sandboxStateProblem gives. */
const WEAKENINGS = [
    ['addCurrentWorkingDirectory on where the policy sent false', (c) => { c.addCurrentWorkingDirectory = true; }, /addCurrentWorkingDirectory is true, the policy sent false/],
    ['allowDevToolAccess absent (its default is on)', (c) => { delete c.allowDevToolAccess; }, /allowDevToolAccess is undefined, the policy sent false/],
    ['sandboxMcpServers off', (c) => { c.sandboxMcpServers = false; }, /sandboxMcpServers is false/],
    ['sandboxLspServers off', (c) => { c.sandboxLspServers = false; }, /sandboxLspServers is false/],
    ['sandboxExtensions off', (c) => { c.sandboxExtensions = false; }, /sandboxExtensions is false/],
    ['auth.git granted', (c) => { c.auth = { ...c.auth, git: true }; }, /auth\.git is true/],
    ['auth.gh granted', (c) => { c.auth = { ...c.auth, gh: true }; }, /auth\.gh is true/],
    ['outbound network on', (c) => { c.userPolicy.network.allowOutbound = true; }, /network\.allowOutbound is true/],
    ['local network on', (c) => { c.userPolicy.network.allowLocalNetwork = true; }, /network\.allowLocalNetwork is true/],
    ['a read-write root', (c) => { c.userPolicy.filesystem.readwritePaths.push('C:/'); }, /readwritePaths grants C:\//],
    ['a read-only path outside the policy', (c) => { c.userPolicy.filesystem.readonlyPaths.push('/elsewhere'); }, /readonlyPaths grants \/elsewhere/],
    ['an enumerate path outside the policy', (c) => { c.userPolicy.filesystem.enumeratePaths = ['/elsewhere']; }, /enumeratePaths grants \/elsewhere/],
    ['a denied path dropped', (c) => { c.userPolicy.filesystem.deniedPaths = []; }, /deniedPaths lost/],
    ['keychain access on', (c) => { c.userPolicy.seatbelt = { keychainAccess: true }; }, /keychainAccess is true/],
    ['experimental keychain access on (a governance path outside the SDK types)', (c) => { c.userPolicy.experimental = { seatbelt: { keychainAccess: true } }; }, /experimental\.seatbelt\.keychainAccess is true/],
    ['a proxy the policy did not send', (c) => { c.userPolicy.network.proxy = 'http://proxy.example:3128'; }, /network\.proxy is set, the policy sent none/],
    ['an extra Mach lookup', (c) => { c.userPolicy.seatbelt = { extraMachLookups: ['com.apple.x'] }; }, /extraMachLookups grants com\.apple\.x/],
    ['a read-write list of the wrong type', (c) => { c.userPolicy.filesystem.readwritePaths = 'C:/'; }, /readwritePaths is not a string list/],
];
/** A write policy with a denied path, as buildSandboxConfig builds one (addCurrentWorkingDirectory false as for a review). */
const sentWrite = () => ({
    enabled: true, addCurrentWorkingDirectory: false, allowBypass: false, allowDevToolAccess: false, sandboxMcpServers: true, sandboxLspServers: true, auth: { git: false, gh: false },
    userPolicy: {
        filesystem: { readwritePaths: ['C:\\work\\wt', 'C:\\work\\job\\home\\tmp'], readonlyPaths: ['C:\\work\\repo\\.git', 'C:\\Program Files\\nodejs'], deniedPaths: ['C:\\Users\\me\\.ssh', 'C:\\Users\\me\\.npmrc'] },
        network: { allowOutbound: false, allowLocalNetwork: false },
    },
});
const stateOf = (config) => ({ revision: 3, config, configSource: 'session_flag', disabledForSession: false, autoApproveBypass: false, sessionOverride: true, incarnation: 1 });
describe('sandboxStateProblem', () => {
    it('needs config.enabled true, no bypass, no opt-out; wrong types count as not in force', () => {
        const sent = sentWrite();
        const ok = stateOf(sent);
        expect(sandboxStateProblem(ok, sent, 'win32')).toBeNull();
        expect(sandboxStateProblem(null, sent)).toBe('no sandbox state');
        expect(sandboxStateProblem({ ...ok, config: { ...sent, enabled: 'true' } }, sent)).toMatch(/not enabled/);
        expect(sandboxStateProblem({ ...ok, disabledForSession: undefined }, sent)).toMatch(/opt-out/);
        expect(sandboxStateProblem({ ...ok, autoApproveBypass: 'no' }, sent)).toMatch(/auto-approves/);
    });
    it('passes the effective config as Copilot CLI 1.0.116 reports it: runtime-added fields, sorted lists, other separators and case, and added restrictions', () => {
        const sent = sentWrite();
        sent.userPolicy.network = { allowOutbound: true, allowLocalNetwork: true, allowedHosts: ['api.nuget.org', '*.nuget.org'] };
        const effective = {
            enabled: true,
            userPolicy: {
                filesystem: {
                    // Sorted, one entry dropped (a managed floor may narrow), other separators, case and a trailing separator.
                    readwritePaths: ['c:/work/job/home/tmp/'],
                    // A read-write path of ours as read-only is narrower.
                    readonlyPaths: ['C:\\Program Files\\nodejs', 'C:\\work\\repo\\.git', 'C:\\work\\wt'],
                    deniedPaths: ['C:\\Users\\me\\.npmrc', 'c:\\users\\me\\.ssh', 'C:\\Users\\me\\.aws'],
                    enumeratePaths: [],
                },
                // The runtime adds the loopback names with the local network on; a managed floor adds a blocked host.
                network: { allowOutbound: true, allowLocalNetwork: true, allowedHosts: ['API.nuget.org', '*.nuget.org', 'localhost', '127.0.0.1', '::1'], blockedHosts: ['evil.example'] },
                seatbelt: { keychainAccess: false },
                capabilities: ['packageQuery'],
            },
            addCurrentWorkingDirectory: false,
            sandboxMcpServers: true,
            sandboxLspServers: true,
            sandboxExtensions: true,
            allowBypass: false,
            auth: { git: false, gh: false },
            allowDevToolAccess: false,
            allowTempStorage: false,
        };
        expect(sandboxStateProblem(stateOf(effective), sent, 'win32')).toBeNull();
        // Case folds only on Windows.
        expect(sandboxStateProblem(stateOf(effective), sent, 'linux')).toMatch(/readwritePaths grants c:\/work\/job\/home\/tmp\//);
    });
    it('a review policy (no deny list sent) passes the runtime-added deniedPaths: []', () => {
        const sent = sentWrite();
        const review = { ...sent, userPolicy: { ...sent.userPolicy, filesystem: { readwritePaths: ['C:\\work\\job\\home\\tmp'], readonlyPaths: ['C:\\work\\wt'] } } };
        const effective = { ...structuredClone(review), userPolicy: { ...structuredClone(review.userPolicy), filesystem: { ...review.userPolicy.filesystem, deniedPaths: [] }, seatbelt: { keychainAccess: false } }, sandboxExtensions: true };
        expect(sandboxStateProblem(stateOf(effective), review, 'win32')).toBeNull();
    });
    it('allowTempStorage is compared only when the policy sent false', () => {
        const sent = { ...sentWrite(), allowTempStorage: false };
        expect(sandboxStateProblem(stateOf({ ...structuredClone(sent), allowTempStorage: true }), sent, 'win32')).toMatch(/allowTempStorage is true, the policy sent false/);
        expect(sandboxStateProblem(stateOf({ ...structuredClone(sentWrite()), allowTempStorage: true }), sentWrite(), 'win32')).toBeNull();
    });
    it.each(WEAKENINGS)('a config weaker than the one sent: %s', (_label, weaken, why) => {
        const sent = sentWrite();
        const effective = structuredClone(sent);
        weaken(effective);
        expect(sandboxStateProblem(stateOf(effective), sent, 'win32')).toMatch(why);
    });
    it('a proxy the policy sent, and experimental keychain access off or granted, pass', () => {
        const sent = sentWrite();
        sent.userPolicy.network.proxy = 'http://proxy.example:3128';
        sent.userPolicy.experimental = { seatbelt: { keychainAccess: true } };
        expect(sandboxStateProblem(stateOf(structuredClone(sent)), sent, 'win32')).toBeNull();
        const plain = sentWrite();
        const off = structuredClone(plain);
        off.userPolicy.experimental = { seatbelt: { keychainAccess: false } };
        expect(sandboxStateProblem(stateOf(off), plain, 'win32')).toBeNull();
    });
    it('a UNC path never equals a rooted path of the same name', () => {
        const sent = sentWrite();
        sent.userPolicy.filesystem.readwritePaths = ['\\\\server\\share\\wt'];
        const unc = structuredClone(sent);
        unc.userPolicy.filesystem.readwritePaths = ['//SERVER/share/wt/'];
        expect(sandboxStateProblem(stateOf(unc), sent, 'win32')).toBeNull();
        // A rooted \server\share\wt (the current drive's root) is another path.
        const rooted = structuredClone(sent);
        rooted.userPolicy.filesystem.readwritePaths = ['\\server\\share\\wt'];
        expect(sandboxStateProblem(stateOf(rooted), sent, 'win32')).toMatch(/readwritePaths grants \\server\\share\\wt, the policy did not/);
        // The other way round: a rooted path sent, a UNC path in force.
        const sentRooted = sentWrite();
        sentRooted.userPolicy.filesystem.readwritePaths = ['/server/share/wt'];
        const uncEff = structuredClone(sentRooted);
        uncEff.userPolicy.filesystem.readwritePaths = ['//server/share/wt'];
        expect(sandboxStateProblem(stateOf(uncEff), sentRooted, 'linux')).toMatch(/readwritePaths grants \/\/server\/share\/wt, the policy did not/);
    });
    it('host lists: an empty or missing allowed list, a host outside ours, loopback without the local network, or a lost blocked host is weaker', () => {
        const sent = sentWrite();
        sent.userPolicy.network = { allowOutbound: true, allowLocalNetwork: false, allowedHosts: ['registry.npmjs.org'] };
        sent.userPolicy.network.blockedHosts = ['evil.example'];
        const withNet = (network) => stateOf({ ...structuredClone(sent), userPolicy: { ...structuredClone(sent.userPolicy), network } });
        const base = { allowOutbound: true, allowLocalNetwork: false, blockedHosts: ['evil.example'] };
        expect(sandboxStateProblem(withNet({ ...base, allowedHosts: ['registry.npmjs.org'] }), sent)).toBeNull();
        expect(sandboxStateProblem(withNet({ ...base, allowedHosts: [] }), sent)).toMatch(/allowedHosts is empty/);
        expect(sandboxStateProblem(withNet({ ...base }), sent)).toMatch(/allowedHosts is empty/);
        expect(sandboxStateProblem(withNet({ ...base, allowedHosts: ['registry.npmjs.org', 'example.com'] }), sent)).toMatch(/allows example\.com/);
        expect(sandboxStateProblem(withNet({ ...base, allowedHosts: ['registry.npmjs.org', 'localhost'] }), sent)).toMatch(/allows localhost/);
        expect(sandboxStateProblem(withNet({ ...base, allowedHosts: ['registry.npmjs.org'], blockedHosts: [] }), sent)).toMatch(/blockedHosts lost evil\.example/);
    });
});
describe('the weaker-config check through confirm', () => {
    it.each(WEAKENINGS)('%s: a write session refuses, a review downgrades to read-only without a shell', async (_label, weaken) => {
        const weakened = (c) => { const w = structuredClone(c); weaken(w); return w; };
        for (const profile of ['write', 'review']) {
            const t = setup('supported', { profile });
            const updates = [];
            const session = { sessionId: 's-1', rpc: fakeSessionRpc('supported', { optionsUpdates: updates }, undefined, weakened) };
            const config = await t.ctl.decide(client('supported'), loadedSdk());
            // Every dimension needs something to lose: a deny list and an opted-out working directory.
            config.userPolicy.filesystem.deniedPaths = ['/denied'];
            config.addCurrentWorkingDirectory = false;
            await t.ctl.confirm(session, config, false);
            expect(t.ctl.state.mode).toBe(profile === 'write' ? 'refused' : 'read-only-no-shell');
            expect(t.ctl.state.reason).toMatch(/^sandbox\.getState: the effective sandbox config is weaker than the policy sent: /);
            if (profile === 'review')
                expect(updates.at(-1)).toEqual({ tools: { availableTools: [...REVIEW_READ_TOOLS] } });
        }
    });
});
describe('the controller compares paths for its own platform, not the host', () => {
    /** The effective config with every path upper-cased: the same paths on Windows, other paths elsewhere. */
    const upper = (c) => {
        const w = structuredClone(c);
        const fs = w.userPolicy.filesystem;
        for (const k of ['readwritePaths', 'readonlyPaths'])
            fs[k] = (fs[k] ?? []).map((p) => p.toUpperCase());
        return w;
    };
    it.each([['win32', 'enforced'], ['linux', 'refused'], ['darwin', 'refused']])('confirm (sandbox.getState) on %s: %s', async (platform, mode) => {
        const t = setup('supported', { platform });
        const session = { sessionId: 's-1', rpc: fakeSessionRpc('supported', { optionsUpdates: [] }, undefined, upper) };
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        expect(config).not.toBeNull();
        await t.ctl.confirm(session, config, false);
        expect(t.ctl.state.mode).toBe(mode);
        if (mode === 'refused')
            expect(t.ctl.state.reason).toMatch(/weaker than the policy sent: userPolicy\.filesystem\.readwritePaths grants /);
    });
    it.each([['win32', false], ['linux', true]])('stateChanged on %s: an upper-cased config is an escape: %s', async (platform, escaped) => {
        const t = setup('supported', { platform });
        const config = await t.ctl.decide(client('supported'), loadedSdk());
        await t.ctl.confirm(t.session, config, false);
        expect(t.ctl.state.mode).toBe('enforced');
        const data = { incarnation: 1, revision: 2, config: upper(config), configSource: 'session_flag', disabledForSession: false, autoApproveBypass: false, sessionOverride: null };
        if (escaped)
            expect(t.ctl.stateChanged(data)).toMatch(/^sandbox-escaped: .*grants /);
        else
            expect(t.ctl.stateChanged(data)).toBeNull();
    });
});
describe('isSandboxPolicyError', () => {
    it('each known phrase is a sandbox error, in the message, a string code or the data', () => {
        expect(isSandboxPolicyError(new Error(POLICY_CONFLICT_MESSAGE))).toBe(true);
        expect(isSandboxPolicyError(new Error("invalid parameter 'sandboxConfig': userPolicy must be an object"))).toBe(true);
        expect(isSandboxPolicyError(new Error('session sandbox policy could not be resolved: no home'))).toBe(true);
        expect(isSandboxPolicyError(Object.assign(new Error('Request failed'), { code: -32603, data: { code: 'managed_sandbox_policy_conflict' } }))).toBe(true);
        expect(isSandboxPolicyError(Object.assign(new Error('Request failed'), { code: 'managed_sandbox_policy_conflict' }))).toBe(true);
    });
    it('auth, network, model and path errors are not, even when a path or model name says "sandbox"', () => {
        expect(isSandboxPolicyError(new Error('authentication failed: 401 Unauthorized'))).toBe(false);
        expect(isSandboxPolicyError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(false);
        expect(isSandboxPolicyError(new Error('Model "gpt-x" is not available'))).toBe(false);
        expect(isSandboxPolicyError(new Error('You are not authorized to use this Copilot feature, it requires an enterprise or organization policy to be enabled.'))).toBe(false);
        expect(isSandboxPolicyError('socket hang up')).toBe(false);
        expect(isSandboxPolicyError(Object.assign(new Error('session construction failed: Directory does not exist or cannot be accessed: C:\\runs\\sandbox\\repo'), { code: -32603 }))).toBe(false);
        expect(isSandboxPolicyError(Object.assign(new Error('Model "sandbox-x" is not available'), { code: -32603 }))).toBe(false);
        expect(isSandboxPolicyError(new Error('the managed policy server is unreachable'))).toBe(false);
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