/**
 * runSandboxed (sandbox-exec.ts) against a fake Copilot SDK: the policy it
 * applies, the env the runtime gets, when a result counts as a verdict, the
 * timeout path, the shell command per platform (run for real in the shells
 * this host has), and gateEnv. No Copilot runtime, no network, no credits.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClientRpc, fakeSessionRpc } from '../../../copilot-run/__tests__/fake-sdk.js';
import { buildSandboxConfig, DEFAULT_SANDBOX_SETTINGS, resolveGatesSandboxMode, resolveRequireDeniedPaths } from '../../../copilot-run/sandbox.js';
import { findOnPath } from '../../../utils/windows-search.js';
import { defaultLocalGateRunner } from '../local-gate.js';
import { createSandboxRunner, gateEnv, readMarker, redactGateOutput, runSandboxed, sandboxCommandMaxChars, sandboxCommandTooLong, sandboxShellCommand, SHELL_OUTPUT_BYTES, SHELL_OUTPUT_LINES, splitFileListArgs, } from '../sandbox-exec.js';
import { fileListParts } from '../engine.js';
import { VITEST_SCRIPT } from '../../../ship/prepare.js';
/** The marker a command carries (the fake shell substitutes it for MARKER in its answer). */
const markerOf = (command) => /omg-gate-exit-[0-9a-f]{16}/.exec(command)?.[0] ?? 'none';
function fakeSdk(script, rec, sandbox = 'supported', deniedPaths = true) {
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
                        const marker = markerOf(command);
                        const complete = () => {
                            if (script.stray !== undefined)
                                this.cfg.onEvent?.({ type: 'tool.execution_complete', data: { toolCallId: 'other', toolName: 'bash', sandboxed: script.stray } });
                            if ('sandboxed' in script)
                                this.cfg.onEvent?.({ type: 'tool.execution_complete', data: { toolCallId: 'call-1', sandboxed: script.sandboxed } });
                        };
                        const answer = () => ({ toolCallId: 'call-1', ...script.answer, output: (script.answer?.output ?? '').split('MARKER').join(marker) });
                        if (script.reject)
                            return Promise.reject(new Error(script.reject));
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
        o;
        cliProcess = { pid: 4321 };
        rpc = fakeClientRpc(sandbox, deniedPaths);
        constructor(o) {
            this.o = o;
        }
        async start() {
            // The runtime reads its config.json at start: what it trusts.
            const file = this.o.baseDirectory ? join(this.o.baseDirectory, 'config.json') : '';
            rec.clients.push({ ...this.o, ...(file && existsSync(file) ? { config: JSON.parse(readFileSync(file, 'utf8')) } : {}) });
        }
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
let savedOmcHome;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-sandbox-exec-'));
    mkdirSync(join(dir, 'checkout'));
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'user-copilot'));
    writeFileSync(join(dir, 'user-copilot', 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'me' }] }));
    rec = { clients: [], connections: [], sessions: [], optionsUpdates: [], commands: [], cancels: [], disconnects: 0, stops: 0 };
    killed = [];
    // The deny list names the OMC global state root's forge dir and creates it: never the real one.
    savedOmcHome = process.env.OMC_HOME;
    process.env.OMC_HOME = join(dir, 'omc-home');
});
afterEach(() => {
    if (savedOmcHome === undefined)
        delete process.env.OMC_HOME;
    else
        process.env.OMC_HOME = savedOmcHome;
    rmSync(dir, { recursive: true, force: true });
});
const TOKENS = { GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', GITHUB_TOKEN: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', AZURE_DEVOPS_EXT_PAT: 'pat-secret', COPILOT_GITHUB_TOKEN: 'gho_cccccccccccccccccccccccccccccccc' };
function deps(script, sandbox = 'supported', over = {}, deniedPaths = true) {
    return {
        env: { PATH: process.env.PATH ?? '', ...TOKENS },
        platform: 'linux',
        loadSdk: async () => fakeSdk(script, rec, sandbox, deniedPaths),
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
/** An answer with this output, success and exit, attested. */
const said = (output, success = true, exitCode = 0) => ({ answer: { success, exitCode, output }, sandboxed: true });
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
        expect(config.userPolicy.filesystem.deniedPaths).toContain(join(dir, 'home', '.npmrc'));
        expect(config.userPolicy.network.allowOutbound).toBe(false);
        // The runtime env (what the shell inherits) carries no credential.
        const env = rec.connections[0].env;
        for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'AZURE_DEVOPS_EXT_PAT', 'COPILOT_GITHUB_TOKEN'])
            expect(env[k]).toBeUndefined();
        expect(JSON.stringify(env)).not.toContain('ghp_');
        // The Copilot credential goes over the session RPC, no plugin (its hooks would run unsandboxed), no prompt.
        expect(rec.sessions[0]).toMatchObject({ gitHubToken: TOKENS.COPILOT_GITHUB_TOKEN, pluginDirectories: [] });
        // Teardown: the session, the runtime tree, the client; the job home is removed.
        expect(rec.disconnects).toBe(1);
        expect(killed).toContain(4321);
        expect(rec.stops).toBe(1);
        expect(existsSync(join(dir, 'jobs')) ? readdirSync(join(dir, 'jobs')) : []).toEqual([]);
    });
    it('H2: the runtime works in and trusts only an empty dir of its own job home, never the checkout', async () => {
        await runSandboxed(['/usr/bin/node', 'x.js'], opts(), deps(ok));
        const checkout = join(dir, 'checkout');
        const work = rec.clients[0].workingDirectory;
        expect(work.startsWith(join(dir, 'jobs'))).toBe(true);
        expect(work).not.toBe(checkout);
        expect(rec.clients[0].config?.trustedFolders).toEqual([work]);
        expect(rec.sessions[0].workingDirectory).toBe(work);
        // A git root search from the working dir stops at the job root (under the root repository's .omg/).
        expect(rec.connections[0].env.GIT_CEILING_DIRECTORIES).toBe(resolve(join(dir, 'jobs')));
        // The checkout stays an explicit read-write path, and the command itself changes into it.
        const config = rec.optionsUpdates[0]?.sandboxConfig;
        expect(config.userPolicy.filesystem.readwritePaths).toContain(checkout);
        expect(Buffer.from(/'([A-Za-z0-9+/=]+)'/.exec(rec.commands[0])[1], 'base64').toString('utf8').split('\0')[0]).toBe(checkout);
    });
    it('network "registry" opens only the registry hosts', async () => {
        await runSandboxed(['/usr/bin/npm', 'ci'], opts({ network: 'registry' }), deps(ok));
        const config = rec.optionsUpdates[0]?.sandboxConfig;
        expect(config.userPolicy.network).toMatchObject({ allowOutbound: true, allowedHosts: ['registry.npmjs.org', '*.npmjs.org'] });
    });
    it('a host without denied_paths runs the command and its verdict counts, marked credential files readable', async () => {
        const r = await runSandboxed(['/bin/false'], opts(), deps(said('not ok\nMARKER 1\n'), 'supported', {}, false));
        expect(r).toEqual({ ran: true, status: 1, output: 'not ok', timedOut: false, credentialFilesReadable: true });
        const config = rec.optionsUpdates[0]?.sandboxConfig;
        expect(config.userPolicy.filesystem.deniedPaths).toBeUndefined();
        // With denied_paths the verdict carries no mark.
        expect(await runSandboxed(['/bin/true'], opts(), deps(ok))).toEqual({ ran: true, status: 0, output: 'tests passed', timedOut: false });
    });
    it('requireDeniedPaths: a host without denied_paths runs nothing (not started: the gates-unsandboxed park), naming the key', async () => {
        const r = await runSandboxed(['/bin/true'], opts({ requireDeniedPaths: true }), deps(ok, 'supported', {}, false));
        expect(r).toEqual({ ran: false, reason: expect.stringContaining('factory.run.sandbox.requireDeniedPaths is true') });
        expect(rec.commands).toEqual([]);
        expect(rec.sessions).toEqual([]);
        // A host that reports denied_paths runs as before.
        expect(await runSandboxed(['/bin/true'], opts({ requireDeniedPaths: true }), deps(ok))).toMatchObject({ ran: true, status: 0 });
    });
    it('redaction applies on a host without denied_paths too', async () => {
        const r = await runSandboxed(['/bin/false'], opts(), deps(said('token ghp_abcdefghijklmnopqrstuvwxyz0123456789\nMARKER 1\n'), 'supported', {}, false));
        expect(r).toMatchObject({ ran: true, credentialFilesReadable: true });
        expect(r.output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });
    it('a call attested sandboxed: false, or not attested at all, gives no verdict after the command started', async () => {
        const no = await runSandboxed(['/bin/true'], opts(), deps({ ...ok, sandboxed: false }));
        expect(no).toMatchObject({ ran: false, started: true, reason: expect.stringContaining('not attested sandboxed') });
        const missing = await runSandboxed(['/bin/true'], opts(), deps({ answer: ok.answer }));
        expect(missing).toMatchObject({ ran: false, started: true, reason: expect.stringContaining('not attested sandboxed') });
        const stray = await runSandboxed(['/bin/true'], opts(), deps({ ...ok, stray: false }));
        expect(stray).toMatchObject({ ran: false, started: true, reason: expect.stringContaining('not attested sandboxed: true') });
    });
    it('a trailing attestation is waited for', async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
        expect(await runSandboxed(['/bin/true'], opts(), deps({ ...ok, late: true }, 'supported', { sleep: wait }))).toMatchObject({ ran: true, status: 0 });
    });
    it('M1: after the command started, a missing marker, no success field or a contradiction is no verdict with fixed text only', async () => {
        const leak = 'SECRET-OUTPUT-ghp_dddddddddddddddddddddddddddddddddddd';
        const cases = [
            { answer: { success: false, exitCode: 1, output: leak, error: `policy_validation ${leak}` }, sandboxed: true },
            { answer: { exitCode: 0, output: 'MARKER 0' }, sandboxed: true },
            // A shell killed after a forged `<marker> 0`: the runtime's own result says it failed.
            said('MARKER 0\n', false, 137),
            said('MARKER 0\n', true, 1),
            { reject: `rpc failed: ${leak}`, sandboxed: true },
        ];
        for (const script of cases) {
            const r = await runSandboxed(['/bin/true'], opts(), deps(script));
            expect(r, JSON.stringify(script)).toMatchObject({ ran: false, started: true });
            expect(r.reason, JSON.stringify(script)).not.toMatch(/SECRET|ghp_|policy_validation/);
        }
    });
    it('M1: an exit code equal to the marker\'s, or a failed success with a non-zero marker, is consistent', async () => {
        expect(await runSandboxed(['/bin/false'], opts(), deps(said('not ok\nMARKER 3\n', true, 3)))).toEqual({ ran: true, status: 3, output: 'not ok', timedOut: false });
        expect(await runSandboxed(['/bin/false'], opts(), deps(said('not ok\nMARKER 3\n', false, 3)))).toEqual({ ran: true, status: 3, output: 'not ok', timedOut: false });
        expect(await runSandboxed(['/bin/false'], opts(), deps(said('MARKER 1\n', false, undefined)))).toMatchObject({ ran: true, status: 1 });
        // A zero marker with a failed success contradicts.
        expect(await runSandboxed(['/bin/true'], opts(), deps(said('MARKER 0\n', false, undefined)))).toMatchObject({ ran: false, started: true });
    });
    it('M2: a forged early marker, a forged late marker, a duplicate or any other omg-gate-exit- text is no verdict', async () => {
        const forged = 'omg-gate-exit-0000000000000000';
        for (const output of [
            `MARKER 0\nreal failure\nMARKER 1\n`,
            `MARKER 1\nMARKER 0\n`,
            `MARKER 1\n${forged} 0\n`,
            `${forged} 0\nMARKER 0\n`,
            `printed ${forged}\nMARKER 0\n`,
            // A last line without a newline glued to the marker: not at the start of a line.
            `partialMARKER 0\n`,
        ]) {
            const r = await runSandboxed(['/bin/true'], opts(), deps(said(output)));
            expect(r, output).toMatchObject({ ran: false, started: true, reason: expect.stringContaining('one exit-code marker line') });
        }
        // Trailing blank lines after the one marker are fine.
        expect(await runSandboxed(['/bin/true'], opts(), deps(said('ok\nMARKER 0\n\n\r\n')))).toMatchObject({ ran: true, status: 0, output: 'ok' });
    });
    it('M3: token-shaped text in the output is redacted before it is kept', async () => {
        const secrets = [
            'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', 'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
            'ghs_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
            'AKIAABCDEFGHIJKLMNOP', 'Bearer abcdefghijklmnopqrstuvwxyz.0123456789',
        ];
        const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n-----END OPENSSH PRIVATE KEY-----';
        const r = await runSandboxed(['/bin/true'], opts(), deps(said(`${secrets.join('\n')}\n${pem}\nMARKER 1\n`)));
        expect(r.ran).toBe(true);
        const out = r.output;
        for (const s of secrets)
            expect(out, s).not.toContain(s.replace(/^Bearer /, ''));
        expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
        // A key block whose BEGIN line an output bound cut off.
        expect(redactGateOutput('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n-----END OPENSSH PRIVATE KEY-----')).toBe('[redacted]');
    });
    it('L-d: JWTs, .npmrc credentials and sk- / sk-ant- keys are redacted; shas and base64 test output are not', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        // Built at run time: a literal token-shaped value in the source would trip secret scanners.
        const uuid = ['0f1e2d3c', '4b5a', '6978', '8796', 'a5b4c3d2e1f0'].join('-');
        const secrets = [
            [`token ${jwt} end`, jwt],
            [`//registry.npmjs.org/:_authToken=${uuid}`, uuid],
            ['_auth = dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
            ['//npm.pkg.example/:_password=c2VjcmV0LXBhc3N3b3Jk', 'c2VjcmV0LXBhc3N3b3Jk'],
            [`key ${['sk', 'proj', 'AbCdEf0123456789GhIjKlMnOp'].join('-')}`, 'AbCdEf0123456789'],
            [`ANTHROPIC_API_KEY=${['sk', 'ant', 'api03', 'AbCdEf0123456789_GhIjKlMnOpQrStUv', 'wxyz'].join('-')}`, 'api03-AbCdEf0123456789'],
        ];
        for (const [text, secret] of secrets) {
            const out = redactGateOutput(text);
            expect(out, text).not.toContain(secret);
            expect(out, text).toContain('[redacted]');
        }
        expect(redactGateOutput('//registry.npmjs.org/:_authToken=abc')).toBe('//registry.npmjs.org/:_authToken=[redacted]');
        const ordinary = [
            'HEAD is 9fb7e347addff4cac28206858ca6f58aec2792cc',
            'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            'expected "dGhpcyBpcyBhIHRlc3Qgb3V0cHV0IHdpdGggbm8gc2VjcmV0cyBpbiBpdA==" to equal "SGVsbG8gd29ybGQ="',
            'eyJhbGciOiJIUzI1NiJ9 is a header only', 'uses sk-learn-compatible-estimators', 'task-0123456789abcdefghij-done',
            '✓ src/a.test.ts (12 tests) 340ms',
        ];
        for (const text of ordinary)
            expect(redactGateOutput(text), text).toBe(text);
    });
    it('an unsupported host, a policy that is not applied or a blocked enforcement runs nothing (not started)', async () => {
        for (const sandbox of ['unsupported', 'update-fails', 'blocked', 'no-rpc']) {
            rec.commands = [];
            const r = await runSandboxed(['/bin/true'], opts(), deps(ok, sandbox));
            expect(r.ran, sandbox).toBe(false);
            expect(r.started, sandbox).toBeUndefined();
            expect(rec.commands, sandbox).toEqual([]);
        }
    });
    it('no SDK, or no copilot binary: not started', async () => {
        expect(await runSandboxed(['/bin/true'], opts(), deps(ok, 'supported', { loadSdk: async () => null }))).toMatchObject({ ran: false, reason: expect.stringContaining('copilot-sdk') });
        expect(await runSandboxed(['/bin/true'], opts(), deps(ok, 'supported', { resolveBin: () => null }))).toMatchObject({ ran: false, reason: expect.stringContaining('copilot CLI not found') });
    });
    it('an argv the shell cannot carry is refused before anything starts, without its text in the reason', async () => {
        const r = await runSandboxed(['/usr/bin/node', 'a\0b'], opts(), deps(ok));
        expect(r).toEqual({ ran: false, reason: expect.not.stringContaining('a\0b') });
        expect(rec.connections).toEqual([]);
    });
    it('L-b: a single command too long for the sandbox shell is not started, with a fixed reason that says so', async () => {
        for (const platform of ['linux', 'win32']) {
            rec.connections = [];
            const long = 'x'.repeat(sandboxCommandMaxChars(platform));
            const r = await runSandboxed(['/usr/bin/node', long], opts(), deps(ok, 'supported', { platform }));
            expect(r, platform).toEqual({ ran: false, reason: expect.stringContaining('the command is too long for the sandbox shell') });
            expect(r.reason, platform).not.toContain('xxxx');
            expect(rec.connections, platform).toEqual([]);
        }
    });
    it('the kill switch OMG_SANDBOX=off never runs the command unsandboxed here', async () => {
        const r = await runSandboxed(['/bin/true'], opts(), deps(ok, 'supported', { env: { PATH: '', OMG_SANDBOX: 'off' } }));
        expect(r.ran).toBe(false);
        expect(rec.commands).toEqual([]);
    });
    it('M1: a timeout with no answer is no verdict after the start; an attested late answer is a timed-out verdict', async () => {
        // Never answers, not even after the cancel.
        const hung = await runSandboxed(['/bin/sleep', '99'], opts({ timeoutMs: 20 }), deps({ sandboxed: true }));
        expect(hung).toMatchObject({ ran: false, started: true, reason: expect.stringContaining('timed out after 20 ms') });
        expect(rec.cancels).toHaveLength(1);
        expect(rec.disconnects).toBe(1);
        expect(killed).toContain(4321);
        // Answered after the cancel and attested: a timed-out verdict (exit 124).
        rec.cancels = [];
        const late = await runSandboxed(['/bin/sleep', '99'], opts({ timeoutMs: 20 }), deps({ answer: { success: false, exitCode: 130, output: 'partial' }, sandboxed: true, answerOnCancel: true }));
        expect(late).toMatchObject({ ran: true, status: 124, timedOut: true, output: expect.stringContaining('timed out after 20 ms') });
        expect(rec.cancels).toHaveLength(1);
    });
    it('createSandboxRunner: a working-tree omg.jsonc cannot open the network or switch the gates', async () => {
        const root = join(dir, 'root');
        mkdirSync(root);
        const project = { factory: { run: { sandbox: { writeNetwork: 'registry', allowedHosts: ['evil.example'], gates: 'unsandboxed' } } } };
        const run = createSandboxRunner(root, deps(ok), { user: null, project });
        const r = await run({ purpose: 'gate', argv: ['node', 'x'], exe: '/usr/bin/node', args: ['x'], cwd: join(dir, 'checkout'), commonGitDir: join(dir, 'repo', '.git'), timeoutMs: 60_000 });
        expect(r.ran).toBe(true);
        const config = rec.optionsUpdates[0]?.sandboxConfig;
        expect(config.userPolicy.network).toEqual({ allowOutbound: false, allowLocalNetwork: false });
    });
});
describe('createSandboxRunner and requireDeniedPaths', () => {
    it('passes the request\'s requireDeniedPaths to the sandbox: a host without denied_paths then runs nothing', async () => {
        const run = createSandboxRunner(join(dir, 'checkout'), deps(ok, 'supported', {}, false), { user: null, project: undefined });
        const req = { purpose: 'gate', argv: ['node', 'x'], exe: '/usr/bin/node', args: ['x'], cwd: join(dir, 'checkout'), commonGitDir: join(dir, 'repo', '.git'), timeoutMs: 60_000 };
        expect(await run({ ...req, requireDeniedPaths: true })).toMatchObject({ ran: false, reason: expect.stringContaining('requireDeniedPaths') });
        expect(rec.commands).toEqual([]);
        expect(await run(req)).toMatchObject({ ran: true, credentialFilesReadable: true });
    });
});
describe('buildSandboxConfig deny list (Windows)', () => {
    it('adds gh\'s %APPDATA%\\GitHub CLI and the GCM/MSAL %LOCALAPPDATA%\\.IdentityService under the real home', () => {
        const home = 'C:\\Users\\me';
        const config = buildSandboxConfig('write', {
            worktree: 'C:\\w\\checkout', commonGitDir: 'C:\\w\\repo\\.git', pluginRoot: 'C:\\p', jobHome: 'C:\\j\\home', jobDir: 'C:\\j', realHome: home,
            platform: 'win32', settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] }, hostCommits: true,
            omcStateRoot: join(dir, 'omc-state'),
        }, { supported: true, capabilities: { denied_paths: true } });
        const denied = (config.userPolicy.filesystem.deniedPaths ?? []).map((p) => p.replace(/\//g, '\\'));
        expect(denied).toContain('C:\\Users\\me\\AppData\\Roaming\\GitHub CLI');
        expect(denied).toContain('C:\\Users\\me\\AppData\\Local\\.IdentityService');
    });
});
/** bash: /bin/bash, or on Windows Git for Windows' own (never System32's WSL launcher). */
function posixShell() {
    if (process.platform !== 'win32')
        return '/bin/bash';
    const git = findOnPath('git.exe', process.env, 'win32');
    // <Git>/cmd/git.exe or <Git>/mingw64/bin/git.exe: bash is <Git>/bin/bash.exe.
    const found = git ? [join(git, '..', '..', 'bin', 'bash.exe'), join(git, '..', '..', '..', 'bin', 'bash.exe')].find((b) => existsSync(b)) : undefined;
    return found ?? null;
}
/** An ASCII-only probe: prints base64(JSON(argv)) and exits 3, so the codepage of a shell cannot mangle what it reports. */
function probeScript() {
    const file = join(dir, 'probe.js');
    writeFileSync(file, "process.stdout.write(Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64') + '\\n'); process.exitCode = 3;\n");
    return file;
}
const MARKER = 'omg-gate-exit-0123456789abcdef';
/** Lane-chosen file names that would break out of a quoted shell literal. */
const HOSTILE = [
    'src/a\u2018;Write-Output omg-gate-exit-0123456789abcdef 0;return;\u2019.ts', 'src/b\u2019 \u201a \u201b.ts', "src/it's.ts", 'src/semi;colon.ts',
    'src/$(touch pwned).ts', 'src/`whoami`.ts', 'src/new\nline.ts', 'src/two  spaces .ts', "x'; printf 'omg-gate-exit-0123456789abcdef 0\\n'; exit 0; '",
];
/** A word that is exactly an ISO-8601 date-time (pwsh 7's ConvertFrom-Json would make it a DateTime). */
const ISO_DATE_WORD = '2026-11-10T12:34:56Z';
/** Run `command` in `shell`; the decoded argv and the marker's exit code. */
function runIn(shell, args, command) {
    const r = spawnSync(shell, [...args, command], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' }, timeout: 120_000, windowsHide: true });
    const out = `${r.stdout ?? ''}`;
    const read = readMarker(out, MARKER);
    const line = read.output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
    let argv = null;
    try {
        argv = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    }
    catch {
        argv = `unparsed: ${out}\n${r.stderr}`;
    }
    return { argv, code: read.code, out };
}
describe('sandboxShellCommand', () => {
    it('H1: no argv or cwd text is ever in the shell source, only a base64 literal (POSIX and PowerShell)', () => {
        for (const platform of ['linux', 'win32']) {
            const argv = ['/usr/bin/node', ...HOSTILE.filter((a) => platform !== 'win32' || !a.includes('"'))];
            const command = sandboxShellCommand(platform, argv, "/w/it's \u2019dir", MARKER);
            expect(command, platform).not.toBeNull();
            // Printable ASCII only: no smart quote, newline or backtick from a name reaches the shell's parser.
            expect(command, platform).toMatch(/^[\x20-\x7e]+$/);
            for (const word of ['touch pwned', 'whoami', 'semi;colon', "it's", 'Write-Output'])
                expect(command, `${platform} ${word}`).not.toContain(word);
            const payload = /'([A-Za-z0-9+/=]+)'\)?/.exec(command.replace(MARKER, ''))[1];
            const decoded = Buffer.from(payload, 'base64').toString('utf8');
            if (platform === 'win32')
                expect(decoded.split('\0')).toEqual(["/w/it's \u2019dir", ...argv]);
            else
                expect(decoded.split('\0').slice(0, -1)).toEqual(["/w/it's \u2019dir", ...argv]);
        }
    });
    it('refuses a NUL anywhere, an empty argv, a bad marker, and on Windows an empty word or a double quote', () => {
        expect(sandboxShellCommand('win32', ['node.exe', 'say "hi"'], 'C:\\w', MARKER)).toBeNull();
        expect(sandboxShellCommand('win32', ['node.exe', ''], 'C:\\w', MARKER)).toBeNull();
        expect(sandboxShellCommand('linux', [], '/w', MARKER)).toBeNull();
        expect(sandboxShellCommand('linux', ['/bin/x', 'a\0b'], '/w', MARKER)).toBeNull();
        expect(sandboxShellCommand('linux', ['/bin/x'], '/w\0', MARKER)).toBeNull();
        expect(sandboxShellCommand('linux', ['/bin/x'], '/w', "m'; x")).toBeNull();
        // POSIX keeps a double quote and an empty word.
        expect(sandboxShellCommand('linux', ['/bin/x', '"', ''], '/w', MARKER)).not.toBeNull();
    });
    it('H1 live: bash hands every hostile word to the command verbatim and reports the command\'s own exit code', () => {
        const bash = posixShell();
        // Git for Windows' bash is on PATH on every Windows CI runner; without it this host has nothing to run.
        if (!bash) {
            // Only a Windows host without Git for Windows has no bash to run it in.
            expect(findOnPath('git.exe', process.env, 'win32')).toBeNull();
            return;
        }
        const argv = [process.execPath, probeScript(), ...HOSTILE];
        const r = runIn(bash, ['-c'], sandboxShellCommand('linux', argv, dir, MARKER));
        expect(r.argv, r.out).toEqual(HOSTILE);
        expect(r.code, r.out).toBe(3);
    }, 150_000);
    it('H1 live: PowerShell hands every hostile word (smart quotes included) to the command verbatim', () => {
        const ps = process.platform === 'win32' ? 'powershell.exe' : findOnPath('pwsh', process.env, process.platform);
        if (!ps) {
            // Linux and macOS without pwsh: the static checks above cover the form.
            expect(process.platform).not.toBe('win32');
            return;
        }
        const words = [...HOSTILE.filter((a) => !a.includes('"')), ISO_DATE_WORD];
        const argv = [process.execPath, probeScript(), ...words];
        const r = runIn(ps, ['-NoProfile', '-NonInteractive', '-Command'], sandboxShellCommand('win32', argv, dir, MARKER));
        expect(r.argv, r.out).toEqual(words);
        expect(r.code, r.out).toBe(3);
    }, 150_000);
    // L-a: pwsh 7 (the runtime's likely shell) retypes an ISO-8601 string that passes through ConvertFrom-Json.
    const pwsh7 = process.platform === 'win32' ? findOnPath('pwsh', process.env, 'win32') : null;
    it.runIf(pwsh7 !== null)('H1 live: pwsh 7 hands every hostile word and an ISO-8601 date word to the command verbatim (only where pwsh 7 is on PATH; skipped otherwise)', () => {
        const words = [...HOSTILE.filter((a) => !a.includes('"')), ISO_DATE_WORD];
        const argv = [process.execPath, probeScript(), ...words];
        const r = runIn(pwsh7, ['-NoProfile', '-NonInteractive', '-Command'], sandboxShellCommand('win32', argv, dir, MARKER));
        expect(r.argv, r.out).toEqual(words);
        expect(r.code, r.out).toBe(3);
    }, 150_000);
    it('M2 live: the command\'s output is bounded inside the shell, the marker stays the last line', () => {
        const big = join(dir, 'big.js');
        writeFileSync(big, "for (let i = 0; i < 3000; i++) console.log('line ' + i + ' ' + 'x'.repeat(60));\n");
        const bash = posixShell();
        expect(bash !== null || findOnPath('git.exe', process.env, 'win32') === null).toBe(true);
        if (bash) {
            const r = spawnSync(bash, ['-c', sandboxShellCommand('linux', [process.execPath, big], dir, MARKER)], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, timeout: 120_000 });
            const read = readMarker(r.stdout, MARKER);
            expect(read.code, r.stderr).toBe(0);
            const lines = read.output.split('\n');
            expect(Buffer.byteLength(read.output), `${bash}: ${lines.length} lines, first ${JSON.stringify(lines.slice(0, 3))}, stderr ${r.stderr.slice(0, 500)}`).toBeLessThanOrEqual(SHELL_OUTPUT_BYTES + 2);
            expect(read.output).toContain('line 2999');
        }
        const ps = process.platform === 'win32' ? 'powershell.exe' : findOnPath('pwsh', process.env, process.platform);
        if (ps) {
            const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', sandboxShellCommand('win32', [process.execPath, big], dir, MARKER)], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
            const read = readMarker(r.stdout, MARKER);
            expect(read.code, r.stderr).toBe(0);
            expect(read.output.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(SHELL_OUTPUT_LINES);
            expect(read.output).toContain('line 2999');
        }
    }, 150_000);
    it('L-b: a built-in file list too long for the Windows command line is split into calls that each fit, in order, none lost', () => {
        const exe = 'C:\\Program Files\\nodejs\\node.exe';
        const cwd = 'C:\\Users\\me\\repo\\.omg\\state\\factory-checkouts\\issue-1';
        const files = Array.from({ length: 900 }, (_, i) => `src/features/some-area/deeply/nested/module-${i}/index.test.ts`);
        for (const [script, fixed] of [['node_modules/vitest/vitest.mjs', 2], ['node_modules/eslint/bin/eslint.js', 1]]) {
            const args = fixed === 2 ? [script, 'run', ...files] : [script, ...files];
            expect(sandboxCommandTooLong('win32', [exe, ...args], cwd)).toBe(true);
            const parts = splitFileListArgs('win32', exe, args, fixed, cwd);
            expect(parts.length, script).toBeGreaterThan(1);
            for (const p of parts) {
                expect(p.slice(0, fixed)).toEqual(args.slice(0, fixed));
                expect(p.length).toBeGreaterThan(fixed);
                expect(sandboxCommandTooLong('win32', [exe, ...p], cwd)).toBe(false);
            }
            expect(parts.flatMap((p) => p.slice(fixed))).toEqual(files);
            // Off Windows the same list fits one shell argument: one call.
            expect(splitFileListArgs('linux', '/usr/bin/node', args, fixed, '/w')).toEqual([args]);
        }
        // A list that fits stays one call; a single file that alone is too long stays a call of its own (refused at run time).
        expect(splitFileListArgs('win32', exe, ['node_modules/eslint/bin/eslint.js', 'src/a.ts'], 1, cwd)).toEqual([['node_modules/eslint/bin/eslint.js', 'src/a.ts']]);
        const huge = `src/${'y'.repeat(30_000)}.ts`;
        expect(splitFileListArgs('win32', exe, ['eslint.js', 'src/a.ts', huge, 'src/b.ts'], 1, cwd)).toEqual([['eslint.js', 'src/a.ts'], ['eslint.js', huge], ['eslint.js', 'src/b.ts']]);
    });
    it('L-b: fileListParts splits only the built-in eslint and vitest checks', () => {
        const files = Array.from({ length: 900 }, (_, i) => `src/features/some-area/deeply/nested/module-${i}/index.test.ts`);
        const exe = 'C:\\node.exe';
        const vitest = { step: 'tests', kind: 'built-in', exe, args: [VITEST_SCRIPT, 'run', ...files], argv: [exe, VITEST_SCRIPT, 'run', ...files] };
        const parts = fileListParts(vitest, 'C:\\w', 'win32');
        expect(parts.length).toBeGreaterThan(1);
        for (const p of parts)
            expect(p).toMatchObject({ step: 'tests', kind: 'built-in', exe, argv: [exe, ...p.args] });
        const configured = { step: 'x', kind: 'configured', exe, args: ['x.js', ...files], argv: ['node', 'x.js', ...files] };
        expect(fileListParts(configured, 'C:\\w', 'win32')).toEqual([configured]);
    });
    it('readMarker: exactly one marker, as the last non-empty line, no other omg-gate-exit- text', () => {
        expect(readMarker(`a\nb\n${MARKER} 2\r\n`, MARKER)).toEqual({ code: 2, output: 'a\nb' });
        expect(readMarker(`a\n${MARKER} 0\nb\n${MARKER} 2\n`, MARKER).code).toBeNull();
        expect(readMarker(`${MARKER} 2\nafter\n`, MARKER).code).toBeNull();
        expect(readMarker(`${MARKER} x\n`, MARKER).code).toBeNull();
        expect(readMarker(`omg-gate-exit-ffff\n${MARKER} 0\n`, MARKER).code).toBeNull();
        expect(readMarker(`${MARKER} -1073741502`, MARKER).code).toBe(-1073741502);
    });
});
describe('resolveRequireDeniedPaths', () => {
    const at = (requireDeniedPaths) => ({ factory: { run: { sandbox: { requireDeniedPaths } } } });
    it('default false; the user config or the base can turn it on, and neither can turn it off over the other\'s true', () => {
        expect(resolveRequireDeniedPaths({ user: null, base: undefined })).toEqual({ require: false, source: 'default' });
        expect(resolveRequireDeniedPaths({ user: at(true), base: undefined })).toEqual({ require: true, source: 'user config' });
        expect(resolveRequireDeniedPaths({ user: null, base: at(true) })).toEqual({ require: true, source: 'the base .copilot/omg.jsonc' });
        expect(resolveRequireDeniedPaths({ user: at(false), base: at(true) }).require).toBe(true);
        expect(resolveRequireDeniedPaths({ user: at(true), base: at(false) }).require).toBe(true);
        expect(() => resolveRequireDeniedPaths({ user: at('yes'), base: undefined })).toThrow(/requireDeniedPaths must be a boolean/);
    });
});
describe('resolveGatesSandboxMode', () => {
    const at = (gates) => ({ factory: { run: { sandbox: { gates } } } });
    it('kill switch (as "ack"), then user config, then the base, then enforced; never "unsandboxed" from the base', () => {
        expect(resolveGatesSandboxMode({ user: null, base: undefined, env: {} })).toEqual({ mode: 'enforced', source: 'default' });
        expect(resolveGatesSandboxMode({ user: at('ack'), base: at('enforced'), env: {} })).toEqual({ mode: 'ack', source: 'user config' });
        expect(resolveGatesSandboxMode({ user: null, base: at('ack'), env: {} })).toEqual({ mode: 'ack', source: 'the base .copilot/omg.jsonc' });
        expect(resolveGatesSandboxMode({ user: at('unsandboxed'), base: undefined, env: {} }).mode).toBe('unsandboxed');
        // L1: the kill switch parks per head; it never runs the PR's code unsandboxed by itself.
        expect(resolveGatesSandboxMode({ user: at('unsandboxed'), base: undefined, env: { OMG_SANDBOX: 'off' } })).toEqual({ mode: 'ack', source: 'OMG_SANDBOX=off' });
        expect(() => resolveGatesSandboxMode({ user: at('enforced'), base: at('unsandboxed'), env: {} })).toThrow(/accepted from the user config only/);
        expect(() => resolveGatesSandboxMode({ user: at('off'), base: undefined, env: {} })).toThrow(/must be "enforced" or "ack" or "unsandboxed"/);
        // copilotRun.sandbox has no gates key: only factory.run.sandbox counts.
        expect(resolveGatesSandboxMode({ user: { copilotRun: { sandbox: { gates: 'ack' } } }, base: undefined, env: {} }).mode).toBe('enforced');
    });
});
describe('gateEnv', () => {
    it('M4: an allowlist: no token, npm config, cloud or LLM key passes; the home, temp and app dirs are redirected', () => {
        const home = join(dir, 'gate-home');
        const credentials = {
            ...TOKENS, gh_config_dir: '/x', SSH_AUTH_SOCK: '/s', GIT_ASKPASS: '/a', SSH_ASKPASS: '/a', GIT_DIR: '/evil',
            NPM_TOKEN: 'npm_x', NODE_AUTH_TOKEN: 'npm_y', npm_config_userconfig: 'C:\\Users\\me\\.npmrc', 'npm_config_//registry.npmjs.org/:_authToken': 'npm_z',
            NPM_CONFIG__AUTH: 'x', GITHUB_PAT: 'ghp_x', SYSTEM_ACCESSTOKEN: 'ado', ACTIONS_RUNTIME_TOKEN: 'a', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'b',
            AZURE_CLIENT_SECRET: 'c', ARM_CLIENT_SECRET: 'd', AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'e', AWS_SESSION_TOKEN: 'f',
            GOOGLE_APPLICATION_CREDENTIALS: '/g.json', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x', NODE_OPTIONS: '--require /evil.js',
        };
        const env = gateEnv({
            Path: '/bin', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', CI: 'true',
            NODE_ENV: 'test', npm_config_cache: '/cache', HOME: '/real', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', XDG_CONFIG_HOME: '/real/.config', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', ...credentials,
        }, home);
        for (const k of Object.keys(credentials))
            expect(env[k], k).toBeUndefined();
        expect(JSON.stringify(env)).not.toMatch(/ghp_|npm_[xyz]|sk-|AKIA|\.npmrc|evil/);
        expect(env).toMatchObject({
            Path: '/bin', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', CI: 'true',
            NODE_ENV: 'test', npm_config_cache: '/cache',
            HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
            TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp'),
            GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_NO_REPLACE_OBJECTS: '1',
        });
        expect(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        // No APPDATA in, none out (POSIX).
        expect(gateEnv({ PATH: '/bin' }, home).APPDATA).toBeUndefined();
    });
    it('an unsandboxed `npm test` still runs with the allowlisted env and the empty home, and sees no token', async () => {
        const pkg = join(dir, 'pkg');
        mkdirSync(pkg);
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node probe.js' } }));
        writeFileSync(join(pkg, 'probe.js'), "console.log('TOKEN=' + (process.env.GH_TOKEN ?? 'none') + ' NPM=' + (process.env.NPM_TOKEN ?? 'none') + ' HOME=' + process.env.HOME);\n");
        const saved = { GH_TOKEN: process.env.GH_TOKEN, NPM_TOKEN: process.env.NPM_TOKEN };
        process.env.GH_TOKEN = TOKENS.GH_TOKEN;
        process.env.NPM_TOKEN = 'npm_abcdefghijklmnopqrstuvwxyz0123456789';
        try {
            const r = await defaultLocalGateRunner(['npm', 'test'], pkg, 120_000);
            expect(r.startError).toBeUndefined();
            expect(r.status, r.stderr).toBe(0);
            expect(r.stdout).toContain('TOKEN=none NPM=none');
            expect(r.stdout).toMatch(/HOME=\S*omg-gate-home-/);
        }
        finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined)
                    delete process.env[k];
                else
                    process.env[k] = v;
            }
        }
    }, 150_000);
});
//# sourceMappingURL=sandbox-exec.test.js.map