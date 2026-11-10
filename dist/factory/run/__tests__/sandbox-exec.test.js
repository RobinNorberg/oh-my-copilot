/**
 * runSandboxed (sandbox-exec.ts) against a fake Copilot SDK: the policy it
 * applies, the env the runtime gets, when a result counts as a verdict, the
 * timeout path, the shell quoting per platform, and gateEnv. No Copilot
 * runtime, no network, no credits.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClientRpc, fakeSessionRpc } from '../../../copilot-run/__tests__/fake-sdk.js';
import { DEFAULT_SANDBOX_SETTINGS, resolveGatesSandboxMode } from '../../../copilot-run/sandbox.js';
import { defaultLocalGateRunner } from '../local-gate.js';
import { gateEnv, GATE_ENV_DROPPED, readMarker, runSandboxed, sandboxShellCommand } from '../sandbox-exec.js';
function fakeSdk(script, rec, sandbox = 'supported') {
    class Session {
        cfg;
        sessionId = 'sess-1';
        rpc;
        pending = null;
        constructor(cfg) {
            this.cfg = cfg;
            this.rpc = {
                ...fakeSessionRpc(sandbox, rec),
                shell: {
                    executeUserRequested: ({ requestId, command }) => {
                        rec.commands.push(command);
                        const marker = /omg-gate-exit-[0-9a-f]{16}/.exec(command)?.[0] ?? 'none';
                        const complete = () => {
                            if (script.stray !== undefined)
                                this.cfg.onEvent?.({ type: 'tool.execution_complete', data: { toolCallId: 'other', toolName: 'bash', sandboxed: script.stray } });
                            if ('sandboxed' in script)
                                this.cfg.onEvent?.({ type: 'tool.execution_complete', data: { toolCallId: 'call-1', sandboxed: script.sandboxed } });
                        };
                        const answer = () => ({ toolCallId: 'call-1', ...script.answer, output: (script.answer?.output ?? '').split('MARKER').join(marker) });
                        return new Promise((resolve) => {
                            const done = () => {
                                if (!script.late)
                                    complete();
                                resolve(answer());
                                if (script.late)
                                    setTimeout(complete, 1);
                            };
                            if (!script.answer)
                                return;
                            if (script.answerOnCancel)
                                this.pending = done;
                            else
                                done();
                            void requestId;
                        });
                    },
                    cancelUserRequested: async ({ requestId }) => {
                        rec.cancels.push(requestId);
                        this.pending?.();
                        return { cancelled: true };
                    },
                },
            };
        }
        async send() { throw new Error('a gate session never sends a prompt'); }
        async abort() { }
        async disconnect() { rec.disconnects += 1; }
    }
    class Client {
        cliProcess = { pid: 4321 };
        rpc = fakeClientRpc(sandbox);
        constructor(_o) { }
        async start() { }
        async stop() { rec.stops += 1; return []; }
        async getStatus() { return { version: '1.0.105' }; }
        async listModels() { return []; }
        async createSession(cfg) { rec.sessions.push(cfg); return new Session(cfg); }
        async deleteSession() { }
    }
    return {
        module: {
            CopilotClient: Client,
            RuntimeConnection: { forStdio: (o) => { rec.connections.push(o); return o; } },
        },
        version: '1.0.16',
        from: 'test',
    };
}
let dir;
let rec;
let killed;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-sandbox-exec-'));
    mkdirSync(join(dir, 'checkout'));
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'user-copilot'));
    writeFileSync(join(dir, 'user-copilot', 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'me' }] }));
    rec = { connections: [], sessions: [], optionsUpdates: [], commands: [], cancels: [], disconnects: 0, stops: 0 };
    killed = [];
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
const TOKENS = { GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', GITHUB_TOKEN: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', AZURE_DEVOPS_EXT_PAT: 'pat-secret', COPILOT_GITHUB_TOKEN: 'gho_cccccccccccccccccccccccccccccccc' };
function deps(script, sandbox = 'supported', over = {}) {
    return {
        env: { PATH: process.env.PATH ?? '', ...TOKENS },
        platform: 'linux',
        loadSdk: async () => fakeSdk(script, rec, sandbox),
        resolveBin: () => '/usr/bin/copilot',
        pluginRoot: () => join(dir, 'plugin'),
        userConfigDir: () => join(dir, 'user-copilot'),
        isAlive: (pid) => pid === 4321 && !killed.includes(pid),
        killTree: (pid) => { killed.push(pid); },
        realHome: () => join(dir, 'home'),
        toolPaths: () => [],
        sandboxTrialLaunch: () => null,
        sleep: async () => { },
        ...over,
    };
}
const opts = (over = {}) => ({
    cwd: join(dir, 'checkout'),
    commonGitDir: join(dir, 'repo', '.git'),
    timeoutMs: 60_000,
    network: 'none',
    settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] },
    jobRoot: join(dir, 'jobs'),
    ...over,
});
const ok = { answer: { success: true, exitCode: 0, output: 'tests passed\nMARKER 0\n' }, sandboxed: true };
describe('runSandboxed', () => {
    it('applies the write profile with host commits, on a token-free env, and counts an attested exit code', async () => {
        const r = await runSandboxed(['/usr/bin/node', 'node_modules/vitest/vitest.mjs', 'run'], opts(), deps({ ...ok, answer: { success: true, exitCode: 0, output: 'not ok 1\nMARKER 3\n' } }));
        expect(r).toEqual({ ran: true, status: 3, output: 'not ok 1', timedOut: false });
        // The policy: read-write the checkout (and the job's temp/profile) only; the git dir read-only, no git write grant; no network.
        const config = rec.optionsUpdates[0]?.sandboxConfig;
        expect(config.enabled).toBe(true);
        expect(config.userPolicy.filesystem.readwritePaths[0]).toBe(join(dir, 'checkout'));
        expect(config.userPolicy.filesystem.readwritePaths.some((p) => p.includes(join('repo', '.git')))).toBe(false);
        expect(config.userPolicy.filesystem.readonlyPaths).toContain(join(dir, 'repo', '.git'));
        expect(config.userPolicy.network.allowOutbound).toBe(false);
        // The runtime env (what the shell inherits) carries no credential.
        const env = rec.connections[0].env;
        for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'AZURE_DEVOPS_EXT_PAT', 'COPILOT_GITHUB_TOKEN'])
            expect(env[k]).toBeUndefined();
        expect(JSON.stringify(env)).not.toContain('ghp_');
        // The Copilot credential goes over the session RPC, no plugin (its hooks would run unsandboxed), no prompt.
        expect(rec.sessions[0]).toMatchObject({ gitHubToken: TOKENS.COPILOT_GITHUB_TOKEN, pluginDirectories: [], workingDirectory: join(dir, 'checkout') });
        // Teardown: the session, the runtime tree, the client; the job home is removed.
        expect(rec.disconnects).toBe(1);
        expect(killed).toContain(4321);
        expect(rec.stops).toBe(1);
        expect(existsSync(join(dir, 'jobs')) ? readdirSync(join(dir, 'jobs')) : []).toEqual([]);
    });
    it('network "registry" opens only the registry hosts', async () => {
        await runSandboxed(['/usr/bin/npm', 'ci'], opts({ network: 'registry' }), deps(ok));
        const config = rec.optionsUpdates[0]?.sandboxConfig;
        expect(config.userPolicy.network).toMatchObject({ allowOutbound: true, allowedHosts: ['registry.npmjs.org', '*.npmjs.org'] });
    });
    it('a call attested sandboxed: false, or not attested at all, is not started (never a pass or a failure)', async () => {
        const no = await runSandboxed(['/bin/true'], opts(), deps({ ...ok, sandboxed: false }));
        expect(no).toMatchObject({ ran: false, reason: expect.stringContaining('not attested sandboxed: true') });
        const missing = await runSandboxed(['/bin/true'], opts(), deps({ answer: ok.answer }));
        expect(missing).toMatchObject({ ran: false, reason: expect.stringContaining('not attested sandboxed') });
        const stray = await runSandboxed(['/bin/true'], opts(), deps({ ...ok, stray: false }));
        expect(stray).toMatchObject({ ran: false, reason: expect.stringContaining('not attested sandboxed: true') });
    });
    it('a trailing attestation is waited for', async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
        expect(await runSandboxed(['/bin/true'], opts(), deps({ ...ok, late: true }, 'supported', { sleep: wait }))).toMatchObject({ ran: true, status: 0 });
    });
    it('no exit-code marker, no success field, or a shell failure after the marker: not started', async () => {
        expect(await runSandboxed(['/bin/true'], opts(), deps({ answer: { success: false, exitCode: 1, output: 'denied', error: 'policy_validation' }, sandboxed: true }))).toMatchObject({ ran: false, reason: expect.stringContaining('policy_validation') });
        expect(await runSandboxed(['/bin/true'], opts(), deps({ answer: { exitCode: 0, output: 'MARKER 0' }, sandboxed: true }))).toMatchObject({ ran: false, reason: expect.stringContaining('no success field') });
        expect(await runSandboxed(['/bin/true'], opts(), deps({ answer: { success: false, exitCode: 1, output: 'MARKER 0' }, sandboxed: true }))).toMatchObject({ ran: false, reason: expect.stringContaining('reported failure') });
    });
    it('an unsupported host, a policy that is not applied or a blocked enforcement runs nothing', async () => {
        for (const sandbox of ['unsupported', 'update-fails', 'blocked', 'no-rpc']) {
            rec.commands = [];
            const r = await runSandboxed(['/bin/true'], opts(), deps(ok, sandbox));
            expect(r.ran, sandbox).toBe(false);
            expect(rec.commands, sandbox).toEqual([]);
        }
    });
    it('no SDK, or no copilot binary: not started', async () => {
        expect(await runSandboxed(['/bin/true'], opts(), deps(ok, 'supported', { loadSdk: async () => null }))).toMatchObject({ ran: false, reason: expect.stringContaining('copilot-sdk') });
        expect(await runSandboxed(['/bin/true'], opts(), deps(ok, 'supported', { resolveBin: () => null }))).toMatchObject({ ran: false, reason: expect.stringContaining('copilot CLI not found') });
    });
    it('the kill switch OMG_SANDBOX=off never runs the command unsandboxed here', async () => {
        const r = await runSandboxed(['/bin/true'], opts(), deps(ok, 'supported', { env: { PATH: '', OMG_SANDBOX: 'off' } }));
        expect(r.ran).toBe(false);
        expect(rec.commands).toEqual([]);
    });
    it('a timeout cancels the call by its request id and tears the runtime down', async () => {
        // Never answers, not even after the cancel.
        const hung = await runSandboxed(['/bin/sleep', '99'], opts({ timeoutMs: 20 }), deps({ sandboxed: true }));
        expect(hung).toMatchObject({ ran: false, reason: expect.stringContaining('timed out after 20 ms') });
        expect(rec.cancels).toHaveLength(1);
        expect(rec.disconnects).toBe(1);
        expect(killed).toContain(4321);
        // Answered after the cancel and attested: a timed-out verdict (exit 124).
        rec.cancels = [];
        const late = await runSandboxed(['/bin/sleep', '99'], opts({ timeoutMs: 20 }), deps({ answer: { success: false, exitCode: 130, output: 'partial' }, sandboxed: true, answerOnCancel: true }));
        expect(late).toMatchObject({ ran: true, status: 124, timedOut: true, output: expect.stringContaining('timed out after 20 ms') });
        expect(rec.cancels).toHaveLength(1);
    });
});
describe('sandboxShellCommand', () => {
    it('quotes every POSIX word literally and prints the exit code only after cd succeeded', () => {
        expect(sandboxShellCommand('linux', ['/usr/bin/node', "it's", 'a b', '$(x)'], "/w/it's", 'M')).toBe(`if cd -- '/w/it'\\''s'; then '/usr/bin/node' 'it'\\''s' 'a b' '$(x)'; printf '%s %s\\n' 'M' "$?"; fi`);
    });
    it('quotes PowerShell words literally and refuses words Windows PowerShell would change', () => {
        expect(sandboxShellCommand('win32', ['C:\\node\\node.exe', "it's", 'a b', '$env:X'], 'C:\\w', 'M')).toBe(`Set-Location -LiteralPath 'C:\\w' -ErrorAction Stop; $global:LASTEXITCODE = $null; & 'C:\\node\\node.exe' 'it''s' 'a b' '$env:X'; "M $LASTEXITCODE"`);
        expect(sandboxShellCommand('win32', ['node.exe', 'say "hi"'], 'C:\\w', 'M')).toBeNull();
        expect(sandboxShellCommand('win32', ['node.exe', ''], 'C:\\w', 'M')).toBeNull();
        expect(sandboxShellCommand('linux', [], '/w', 'M')).toBeNull();
    });
    it('readMarker takes the last marker line and removes it', () => {
        expect(readMarker('a\nM 0\nb\nM 2\r\n', 'M')).toEqual({ code: 2, output: 'a\nM 0\nb\n' });
        expect(readMarker('M x\n', 'M')).toEqual({ code: null, output: 'M x\n' });
        expect(readMarker('M -1073741502', 'M').code).toBe(-1073741502);
    });
});
describe('resolveGatesSandboxMode', () => {
    const at = (gates) => ({ factory: { run: { sandbox: { gates } } } });
    it('kill switch, then user config, then the base, then enforced; never "unsandboxed" from the base', () => {
        expect(resolveGatesSandboxMode({ user: null, base: undefined, env: {} })).toEqual({ mode: 'enforced', source: 'default' });
        expect(resolveGatesSandboxMode({ user: at('ack'), base: at('enforced'), env: {} })).toEqual({ mode: 'ack', source: 'user config' });
        expect(resolveGatesSandboxMode({ user: null, base: at('ack'), env: {} })).toEqual({ mode: 'ack', source: 'the base .copilot/omg.jsonc' });
        expect(resolveGatesSandboxMode({ user: at('unsandboxed'), base: undefined, env: {} }).mode).toBe('unsandboxed');
        expect(resolveGatesSandboxMode({ user: at('enforced'), base: undefined, env: { OMG_SANDBOX: 'off' } })).toEqual({ mode: 'unsandboxed', source: 'OMG_SANDBOX=off' });
        expect(() => resolveGatesSandboxMode({ user: at('enforced'), base: at('unsandboxed'), env: {} })).toThrow(/accepted from the user config only/);
        expect(() => resolveGatesSandboxMode({ user: at('off'), base: undefined, env: {} })).toThrow(/must be "enforced" or "ack" or "unsandboxed"/);
        // copilotRun.sandbox has no gates key: only factory.run.sandbox counts.
        expect(resolveGatesSandboxMode({ user: { copilotRun: { sandbox: { gates: 'ack' } } }, base: undefined, env: {} }).mode).toBe('enforced');
    });
});
describe('gateEnv', () => {
    it('drops every credential variable, empties the home and switches off the system and global git config', () => {
        const home = join(dir, 'gate-home');
        const env = gateEnv({ PATH: '/bin', ...TOKENS, gh_config_dir: '/x', SSH_AUTH_SOCK: '/s', GIT_ASKPASS: '/a', HOME: '/real', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', XDG_CONFIG_HOME: '/real/.config', GIT_DIR: '/evil' }, home);
        for (const k of [...GATE_ENV_DROPPED, 'gh_config_dir', 'GIT_DIR'])
            expect(env[k], k).toBeUndefined();
        expect(env).toMatchObject({
            PATH: '/bin', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'),
            LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_NO_REPLACE_OBJECTS: '1',
        });
        expect(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        // No APPDATA in, none out (POSIX).
        expect(gateEnv({ PATH: '/bin' }, home).APPDATA).toBeUndefined();
    });
    it('an unsandboxed `npm test` still runs with the empty home, and sees no token', async () => {
        const pkg = join(dir, 'pkg');
        mkdirSync(pkg);
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node probe.js' } }));
        writeFileSync(join(pkg, 'probe.js'), "console.log('TOKEN=' + (process.env.GH_TOKEN ?? 'none') + ' HOME=' + process.env.HOME);\n");
        const saved = process.env.GH_TOKEN;
        process.env.GH_TOKEN = TOKENS.GH_TOKEN;
        try {
            const r = await defaultLocalGateRunner(['npm', 'test'], pkg, 120_000);
            expect(r.startError).toBeUndefined();
            expect(r.status, r.stderr).toBe(0);
            expect(r.stdout).toContain('TOKEN=none');
            expect(r.stdout).toMatch(/HOME=\S*omg-gate-home-/);
        }
        finally {
            if (saved === undefined)
                delete process.env.GH_TOKEN;
            else
                process.env.GH_TOKEN = saved;
        }
    }, 150_000);
});
//# sourceMappingURL=sandbox-exec.test.js.map