import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sdkCreateSessionAcceptsSandbox } from '../../smoke/copilot-sdk-driver.js';
import { DEFAULT_SANDBOX_SETTINGS, allowlistSessionEnv, buildSandboxConfig, laneGitWritePaths, loadSandboxSettings, missingSandboxEnv, MXC_REQUIRED_ENV, probeHostSupport, resolveSandboxSettings, scrubTokens, secretValues, sessionGitHubToken, unconfirmedMode, } from '../sandbox.js';
let root;
let ctx;
const host = (caps = { shell: true }) => ({ supported: true, capabilities: caps });
beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-sbx-cfg-'));
    ctx = {
        worktree: join(root, 'wt'),
        commonGitDir: join(root, 'repo', '.git'),
        pluginRoot: join(root, 'plugin'),
        jobHome: join(root, 'job', 'home'),
        jobDir: join(root, 'job'),
        realHome: join(root, 'me'),
        platform: 'linux',
        settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] },
    };
});
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});
describe('buildSandboxConfig', () => {
    it('review is the design §4.2 object', () => {
        expect(buildSandboxConfig('review', ctx, host())).toEqual({
            enabled: true,
            addCurrentWorkingDirectory: false,
            allowBypass: false,
            allowDevToolAccess: false,
            sandboxMcpServers: true,
            sandboxLspServers: true,
            auth: { git: false, gh: false },
            userPolicy: {
                filesystem: { readonlyPaths: [ctx.worktree, ctx.commonGitDir, ctx.pluginRoot, ctx.jobHome], readwritePaths: [ctx.jobDir] },
                network: { allowOutbound: false, allowLocalNetwork: false },
            },
        });
    });
    it('write makes the common git dir read-only except objects and its own admin dir, no ref at all; denies home paths only when supported', () => {
        const plain = buildSandboxConfig('write', ctx, host());
        expect(plain).toMatchObject({ enabled: true, addCurrentWorkingDirectory: true, allowBypass: false, allowDevToolAccess: false, auth: { git: false, gh: false } });
        // Without a linked worktree only objects/ is granted: config and hooks stay read-only.
        expect(plain.userPolicy.filesystem).toEqual({
            readwritePaths: [ctx.worktree, ctx.jobDir, join(ctx.commonGitDir, 'objects')],
            readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, ctx.jobHome],
        });
        const gitDir = join(ctx.commonGitDir, 'worktrees', 'cr-1');
        const linked = buildSandboxConfig('write', { ...ctx, gitDir }, host());
        expect(linked.userPolicy.filesystem.readwritePaths).toEqual([ctx.worktree, ctx.jobDir, join(ctx.commonGitDir, 'objects'), gitDir]);
        // No ref dir or reflog is writable: another job's branch omc-team/copilot-run/cr-2 stays read-only.
        const otherJob = ['refs', 'logs/refs'].map((d) => join(ctx.commonGitDir, ...d.split('/'), 'heads', 'omc-team', 'copilot-run', 'cr-2'));
        for (const p of ['config', 'hooks', 'info', 'packed-refs', 'refs', 'logs', ...otherJob]) {
            const carveOuts = linked.userPolicy.filesystem.readwritePaths.filter((rw) => rw.startsWith(ctx.commonGitDir));
            expect(carveOuts.some((rw) => (isAbsolute(p) ? p : join(ctx.commonGitDir, p)).startsWith(rw)), p).toBe(false);
        }
        // A git dir outside <common>/worktrees grants nothing more.
        expect(laneGitWritePaths({ ...ctx, gitDir: join(root, 'elsewhere') })).toEqual([join(ctx.commonGitDir, 'objects')]);
        expect(plain.userPolicy.network).toEqual({ allowOutbound: false, allowLocalNetwork: false });
        const denied = buildSandboxConfig('write', ctx, host({ shell: true, denied_paths: true }));
        expect(denied.userPolicy.filesystem.deniedPaths).toEqual(['.ssh', '.gitconfig', '.omg', '.copilot'].map((p) => join(ctx.realHome, p)));
    });
    it('write with hostCommits (the factory engine commits) keeps the whole common git dir read-only (§4.3)', () => {
        const gitDir = join(ctx.commonGitDir, 'worktrees', 'cr-1');
        const cfg = buildSandboxConfig('write', { ...ctx, gitDir, hostCommits: true }, host());
        expect(cfg.userPolicy.filesystem).toEqual({
            readwritePaths: [ctx.worktree, ctx.jobDir],
            readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, ctx.jobHome],
        });
        expect(cfg.addCurrentWorkingDirectory).toBe(true);
    });
    it('registry network: npm hosts plus extras, allowLocalNetwork only on Windows', () => {
        const settings = { ...ctx.settings, writeNetwork: 'registry', allowedHosts: ['npm.example.com'] };
        expect(buildSandboxConfig('write', { ...ctx, settings }, host()).userPolicy.network).toEqual({
            allowOutbound: true, allowedHosts: ['registry.npmjs.org', '*.npmjs.org', 'npm.example.com'], allowLocalNetwork: false,
        });
        expect(buildSandboxConfig('write', { ...ctx, settings, platform: 'win32' }, host()).userPolicy.network.allowLocalNetwork).toBe(true);
        // A review never gets the network.
        expect(buildSandboxConfig('review', { ...ctx, settings }, host()).userPolicy.network).toEqual({ allowOutbound: false, allowLocalNetwork: false });
    });
    it('refuses an extra read-write path outside the worktree', () => {
        const settings = { ...ctx.settings, extraReadwritePaths: [join(root, 'elsewhere')] };
        expect(() => buildSandboxConfig('write', { ...ctx, settings }, host())).toThrow(/not under the worktree/);
        const inside = { ...ctx.settings, extraReadwritePaths: [join(ctx.worktree, 'out')] };
        expect(buildSandboxConfig('write', { ...ctx, settings: inside }, host()).userPolicy.filesystem.readwritePaths).toContain(join(ctx.worktree, 'out'));
    });
});
describe('sandbox settings', () => {
    it('validates types and values', () => {
        expect(() => resolveSandboxSettings({ writeUnsandboxed: 'yes' })).toThrow(/writeUnsandboxed must be "refuse" or "detect-only"/);
        expect(() => resolveSandboxSettings({ enabled: 'no' })).toThrow(/enabled must be a boolean/);
        expect(() => resolveSandboxSettings({ extraReadonlyPaths: ['relative'] })).toThrow(/absolute paths/);
    });
    it('factory.run.sandbox overrides copilotRun.sandbox for lanes only', () => {
        const user = { copilotRun: { sandbox: { writeUnsandboxed: 'detect-only', writeNetwork: 'registry' } }, factory: { run: { sandbox: { writeUnsandboxed: 'refuse' } } } };
        expect(loadSandboxSettings(root, 'copilot-run', { user, project: undefined }).settings).toMatchObject({ writeUnsandboxed: 'detect-only', writeNetwork: 'registry' });
        expect(loadSandboxSettings(root, 'factory', { user, project: undefined }).settings).toMatchObject({ writeUnsandboxed: 'refuse', writeNetwork: 'registry' });
    });
    it('the project config may only tighten', () => {
        const user = { copilotRun: { sandbox: { enabled: false, writeUnsandboxed: 'detect-only', writeNetwork: 'registry' } } };
        const tighten = { copilotRun: { sandbox: { enabled: true, writeUnsandboxed: 'refuse', reviewUnsandboxed: 'refuse', writeNetwork: 'none' } } };
        expect(loadSandboxSettings(root, 'copilot-run', { user, project: tighten })).toEqual({
            settings: expect.objectContaining({ enabled: true, writeUnsandboxed: 'refuse', reviewUnsandboxed: 'refuse', writeNetwork: 'none' }),
            warnings: [],
        });
        const loosen = { copilotRun: { sandbox: { enabled: false, writeUnsandboxed: 'detect-only', writeNetwork: 'registry', allowedHosts: ['x'], extraReadwritePaths: [join(root, 'x')] } } };
        const out = loadSandboxSettings(root, 'copilot-run', { user: null, project: loosen });
        expect(out.settings).toEqual({ ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] });
        expect(out.warnings).toEqual(['sandbox: ignoring enabled, writeUnsandboxed, writeNetwork, allowedHosts, extraReadwritePaths from the project config; it may only tighten the sandbox']);
    });
    it('unconfirmedMode is the fail-closed table', () => {
        const s = { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] };
        expect(unconfirmedMode('review', s)).toBe('read-only-no-shell');
        expect(unconfirmedMode('review', { ...s, reviewUnsandboxed: 'refuse' })).toBe('refused');
        expect(unconfirmedMode('write', s)).toBe('refused');
        expect(unconfirmedMode('write', { ...s, writeUnsandboxed: 'detect-only' })).toBe('detect-only');
    });
});
describe('detection helpers', () => {
    it('probeHostSupport needs supported and the shell capability, and survives a throwing RPC', async () => {
        const client = (res) => ({ rpc: { sandbox: { getHostSupport: async () => res } } });
        expect(await probeHostSupport(client({ supported: true, capabilities: [{ name: 'shell', supported: true }] }), 1000)).toEqual({ supported: true, capabilities: { shell: true } });
        expect(await probeHostSupport(client({ supported: true, capabilities: [{ name: 'shell', supported: false }] }), 1000)).toMatchObject({ supported: false, reason: expect.stringContaining('no shell') });
        expect(await probeHostSupport(client({ supported: false, reason: 'old build', capabilities: [] }), 1000)).toMatchObject({ supported: false, reason: 'old build' });
        expect(await probeHostSupport({ rpc: { sandbox: { getHostSupport: async () => { throw new Error('boom'); } } } }, 1000)).toMatchObject({ supported: false, reason: expect.stringContaining('boom') });
        expect(await probeHostSupport({}, 1000)).toMatchObject({ supported: false, reason: expect.stringContaining('no sandbox.getHostSupport') });
    });
    it('sdkCreateSessionAcceptsSandbox reads the createSession source', () => {
        const sdk = (cls) => ({ module: { CopilotClient: cls, RuntimeConnection: { forStdio: () => ({}) } }, version: 'x', from: 'test' });
        class Old {
            async createSession(cfg) { return cfg.model; }
        }
        class New {
            async createSession(cfg) { return cfg.sandboxConfig; }
        }
        expect(sdkCreateSessionAcceptsSandbox(sdk(Old))).toBe(false);
        expect(sdkCreateSessionAcceptsSandbox(sdk(New))).toBe(true);
    });
    it('allowlistSessionEnv matches names case-insensitively and relocates the profile', () => {
        const env = allowlistSessionEnv({ Path: 'p', SystemRoot: 'C:\\Windows', npm_config_token: 't', LC_CTYPE: 'C', OMC_X: '1', APPDATA: 'a', LocalAppData: 'C:\\Users\\u\\AppData\\Local' }, join(root, 'h'));
        expect(env).toEqual({
            Path: 'p', SystemRoot: 'C:\\Windows', LC_CTYPE: 'C', OMC_X: '1', LocalAppData: 'C:\\Users\\u\\AppData\\Local',
            USERPROFILE: join(root, 'h', 'profile'), HOME: join(root, 'h', 'profile'),
            XDG_CONFIG_HOME: join(root, 'h', 'profile', '.config'), GIT_CONFIG_GLOBAL: join(root, 'h', 'profile', '.gitconfig'),
            // The host LOCALAPPDATA passes for MXC; the runtime's cache stays in the relocated profile all the same.
            COPILOT_CACHE_HOME: join(root, 'h', 'profile', '.cache', 'copilot'),
        });
    });
    it('every variable the Windows sandbox requires passes the allowlist with its host value', () => {
        const hostEnv = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', GH_TOKEN: 'ghp_x' };
        const env = allowlistSessionEnv(hostEnv, join(root, 'h'));
        expect(MXC_REQUIRED_ENV).toEqual(['SYSTEMROOT', 'LOCALAPPDATA']);
        expect(missingSandboxEnv(env, 'win32')).toEqual([]);
        expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
        expect(env.GH_TOKEN).toBeUndefined();
    });
    it('missingSandboxEnv names the absent or blank required variables on win32 only', () => {
        expect(missingSandboxEnv({ SystemRoot: 'C:\\Windows' }, 'win32')).toEqual(['LOCALAPPDATA']);
        expect(missingSandboxEnv({ systemroot: 'C:\\Windows', LOCALAPPDATA: ' ' }, 'win32')).toEqual(['LOCALAPPDATA']);
        expect(missingSandboxEnv({}, 'win32')).toEqual(['SYSTEMROOT', 'LOCALAPPDATA']);
        expect(missingSandboxEnv({}, 'linux')).toEqual([]);
        expect(missingSandboxEnv({}, 'darwin')).toEqual([]);
    });
    it('keeps every token out of the runtime env; the Copilot token goes to the session option instead', () => {
        const caller = { copilot_github_token: 'cop-secret', GH_TOKEN: 'gh-secret-1', GITHUB_TOKEN: 'ghs', PATH: 'p' };
        const env = allowlistSessionEnv(caller, join(root, 'h'));
        expect(Object.keys(env).map((k) => k.toUpperCase())).not.toEqual(expect.arrayContaining(['COPILOT_GITHUB_TOKEN']));
        expect(env.GH_TOKEN).toBeUndefined();
        expect(sessionGitHubToken(caller)).toBe('cop-secret');
        expect(sessionGitHubToken({ COPILOT_GITHUB_TOKEN: ' ' })).toBeUndefined();
        // Values shorter than 8 characters are not scrubbed verbatim (they would mangle ordinary words).
        expect(secretValues(caller)).toEqual(['cop-secret', 'gh-secret-1']);
    });
    it('scrubTokens redacts every GitHub token shape and the exact secret values', () => {
        const tokens = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'].map((p) => `${p}${'A1b2'.repeat(9)}`);
        const pat = `github_pat_11ABCDEFG0_${'x'.repeat(40)}`;
        const text = `found ${tokens.join(' and ')} plus ${pat}, then cop-secret in a log; ghp_short stays`;
        const out = scrubTokens(text, ['cop-secret']);
        for (const t of [...tokens, pat, 'cop-secret'])
            expect(out).not.toContain(t);
        expect(out).toContain('ghp_short stays');
        expect(out.match(/\[redacted\]/g)).toHaveLength(7);
    });
});
//# sourceMappingURL=sandbox.test.js.map