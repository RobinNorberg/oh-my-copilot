/** A fake @microsoft/copilot-sdk (v2) and a scratch git repository for copilot_run job tests (no live session). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** `config` with outbound network allowed: what the `weakened` runtime reports. */
export function withOutbound(config) {
    const c = structuredClone(config);
    c.userPolicy = { ...c.userPolicy, network: { ...c.userPolicy?.network, allowOutbound: true } };
    return c;
}
/** The runtime's refusal of a policy that conflicts with managed policy (Copilot CLI 1.0.116). */
export const POLICY_CONFLICT_MESSAGE = 'Sandbox configuration update violates managed policy. Contact your administrator for more information.';
export const newCalls = () => ({ connections: [], sessions: [], prompts: [], optionsUpdates: [], globalGitConfigs: [] });
/** The server `rpc` of a fake client with sandbox support `sandbox` (`deniedPaths`: the host reports denied_paths). */
export function fakeClientRpc(sandbox, deniedPaths = false) {
    if (sandbox === 'no-rpc')
        return undefined;
    const supported = sandbox !== 'unsupported';
    return {
        sandbox: {
            getHostSupport: async () => ({
                supported,
                ...(supported ? {} : { reason: 'MXC is not available on this host' }),
                capabilities: [{ name: 'shell', supported }, { name: 'network', supported }, { name: 'denied_paths', supported: supported && deniedPaths }],
            }),
        },
    };
}
/**
 * The session `rpc` of a fake session with sandbox support `sandbox`; `created`: the sandbox config createSession took;
 * `weaken`: how getState reports the applied config (default: as applied, `withOutbound` for `weakened`).
 */
export function fakeSessionRpc(sandbox, calls, created, weaken) {
    const report = weaken ?? (sandbox === 'weakened' ? withOutbound : (c) => c);
    if (sandbox === 'no-rpc')
        return {};
    // The effective config, as getState reports it: what create or options.update applied, unless the runtime drops it.
    let effective = sandbox === 'ignored' ? undefined : created;
    const state = () => ({
        incarnation: 1,
        revision: 1,
        config: effective ? report(effective) : { enabled: false },
        configSource: effective ? 'session_flag' : 'never_configured',
        disabledForSession: sandbox === 'opted-out',
        autoApproveBypass: false,
        sessionOverride: null,
    });
    return {
        options: {
            update: async (params) => {
                calls.optionsUpdates.push(params);
                if (sandbox === 'update-fails')
                    throw new Error(POLICY_CONFLICT_MESSAGE);
                const next = params.permissions?.sandbox;
                if (next !== undefined && sandbox !== 'ignored')
                    effective = next;
                return { success: true };
            },
        },
        sandbox: {
            getEnforcementStatus: async () => ({ required: false, blocked: sandbox === 'blocked', ...(sandbox === 'blocked' ? { reason: 'managed policy' } : {}) }),
            ...(sandbox === 'no-state' ? {} : {
                getState: async () => {
                    if (sandbox === 'state-throws')
                        throw new Error('state unavailable');
                    if (sandbox === 'state-hangs')
                        return new Promise(() => { });
                    return state();
                },
            }),
        },
    };
}
export const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
}).trim();
export function fakeSdk(behavior, calls, sandbox = 'supported', deniedPaths = false) {
    class Session {
        cfg;
        sessionId = `sess-${calls.sessions.length}`;
        rpc;
        constructor(cfg) {
            this.cfg = cfg;
            this.rpc = fakeSessionRpc(sandbox, calls, cfg.permissions.sandbox);
        }
        emit(type, data = {}) { this.cfg.events?.onEvent?.({ type, data }); }
        async send({ prompt }) {
            calls.prompts.push(prompt);
            setTimeout(() => {
                if (behavior === 'hang')
                    return;
                if (behavior === 'sandbox-off') {
                    this.emit('session.sandbox_state_changed', { incarnation: 1, revision: 2, config: this.cfg.permissions.sandbox ?? {}, configSource: 'session_flag', disabledForSession: true, autoApproveBypass: false, sessionOverride: false });
                }
                if (behavior === 'sandbox-weakened') {
                    this.emit('session.sandbox_state_changed', { incarnation: 1, revision: 2, config: withOutbound(this.cfg.permissions.sandbox ?? {}), configSource: 'session_flag', disabledForSession: false, autoApproveBypass: false, sessionOverride: true });
                }
                if (behavior === 'commit') {
                    writeFileSync(join(this.cfg.workingDirectory, 'lane.txt'), 'lane work\n');
                    gitIn(this.cfg.workingDirectory, 'add', 'lane.txt');
                    gitIn(this.cfg.workingDirectory, 'commit', '-q', '-m', 'lane commit');
                }
                this.emit('assistant.usage', { initiator: 'user', model: 'gpt-test', copilotUsage: { totalNanoAiu: 1e9 } });
                this.emit('assistant.message', { content: 'Done.' });
                this.emit('session.idle');
            }, 5);
        }
        async abort() { setTimeout(() => this.emit('session.idle'), 1); }
        async disconnect() { this.emit('session.shutdown', { totalPremiumRequests: 1, totalNanoAiu: 2e9, currentModel: 'gpt-test' }); }
    }
    class Client {
        cliProcess = null;
        rpc = fakeClientRpc(sandbox, deniedPaths);
        constructor(_opts) { }
        async start() { }
        async stop() { return []; }
        async getStatus() { return {}; }
        async listModels() { return []; }
        async createSession(cfg) {
            calls.sessions.push(cfg);
            if (sandbox === 'update-fails' && cfg.permissions.sandbox)
                throw new Error(POLICY_CONFLICT_MESSAGE);
            if (sandbox === 'create-fails')
                throw new Error('authentication failed: 401 Unauthorized');
            return new Session(cfg);
        }
        async deleteSession() { }
    }
    return {
        module: {
            CopilotClient: Client,
            RuntimeConnection: {
                forSpawnedStdio: (opts) => {
                    calls.connections.push(opts);
                    const globalConfig = opts.env?.GIT_CONFIG_GLOBAL;
                    calls.globalGitConfigs.push(globalConfig && existsSync(globalConfig) ? readFileSync(globalConfig, 'utf8') : null);
                    return opts;
                },
            },
        },
        version: '2.0.3',
        from: 'test',
    };
}
export function fakeDeps(root, behavior, calls, env, sandbox = 'supported') {
    return {
        env: { PATH: process.env.PATH ?? '', ...env },
        platform: 'linux',
        loadSdk: async () => fakeSdk(behavior, calls, sandbox),
        resolveBin: () => '/usr/bin/copilot',
        pluginRoot: () => '/plugin',
        userConfigDir: () => join(root, 'user-copilot'),
        isAlive: () => false,
        killTree: () => { },
        sandboxTrialLaunch: () => null,
    };
}
/** A temp root with a logged-in user config and a one-commit repository at `<root>/repo` (branch main). */
export function scratchRepo(prefix) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    mkdirSync(join(root, 'user-copilot'));
    writeFileSync(join(root, 'user-copilot', 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'me' }], lastLoggedInUser: { login: 'me' } }));
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    writeFileSync(join(repo, '.gitignore'), '.omg/\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'init');
    return { root, repo };
}
//# sourceMappingURL=fake-sdk.js.map