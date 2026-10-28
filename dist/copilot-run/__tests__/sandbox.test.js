import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sdkCreateSessionAcceptsSandbox } from '../../smoke/copilot-sdk-driver.js';
import { BWRAP_TRIAL_ARGS, DEFAULT_SANDBOX_SETTINGS, allowlistSessionEnv, bwrapTrialLaunchError, buildSandboxConfig, findOnPath, gitForWindowsShell, laneGitWritePaths, laneToolPaths, loadSandboxSettings, missingSandboxEnv, MXC_REQUIRED_ENV, probeHostSupport, resolveSandboxSettings, scrubTokens, secretValues, sessionGitHubToken, unconfirmedMode, } from '../sandbox.js';
let root;
let ctx;
const host = (caps = { shell: true }) => ({ supported: true, capabilities: caps });
/** The job home's lane-writable dirs: the relocated temp and profile, nothing else of it. */
const laneHome = () => [join(ctx.jobHome, 'tmp'), join(ctx.jobHome, 'profile')];
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
                filesystem: { readonlyPaths: [ctx.worktree, ctx.commonGitDir, ctx.pluginRoot, join(ctx.jobHome, 'git')], readwritePaths: [...laneHome()] },
                network: { allowOutbound: false, allowLocalNetwork: false },
            },
        });
    });
    it('write makes the common git dir read-only except objects and its own admin dir, no ref at all; denies home paths only when supported', () => {
        const plain = buildSandboxConfig('write', ctx, host());
        expect(plain).toMatchObject({ enabled: true, addCurrentWorkingDirectory: true, allowBypass: false, allowDevToolAccess: false, auth: { git: false, gh: false } });
        // Without a linked worktree only objects/ is granted: config and hooks stay read-only.
        expect(plain.userPolicy.filesystem).toEqual({
            readwritePaths: [ctx.worktree, ...laneHome(), join(ctx.commonGitDir, 'objects')],
            readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, join(ctx.jobHome, 'git')],
        });
        const gitDir = join(ctx.commonGitDir, 'worktrees', 'cr-1');
        const linked = buildSandboxConfig('write', { ...ctx, gitDir }, host());
        expect(linked.userPolicy.filesystem.readwritePaths).toEqual([ctx.worktree, ...laneHome(), join(ctx.commonGitDir, 'objects'), gitDir]);
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
        expect(denied.userPolicy.filesystem.deniedPaths).toEqual(['.ssh', '.gitconfig', '.omg', '.copilot', '.azure'].map((p) => join(ctx.realHome, p)));
    });
    it('write with hostCommits (the factory engine commits) keeps the whole common git dir read-only (§4.3)', () => {
        const gitDir = join(ctx.commonGitDir, 'worktrees', 'cr-1');
        const cfg = buildSandboxConfig('write', { ...ctx, gitDir, hostCommits: true }, host());
        expect(cfg.userPolicy.filesystem).toEqual({
            readwritePaths: [ctx.worktree, ...laneHome()],
            readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, join(ctx.jobHome, 'git')],
        });
        expect(cfg.addCurrentWorkingDirectory).toBe(true);
    });
    it('grants only the job home\'s temp and profile dirs, never what the engine or the runtime reads back', () => {
        const env = allowlistSessionEnv({}, ctx.jobHome);
        // The engine's event log, the runtime's config, session state, policies and logs, and its package cache.
        const readBack = [
            join(ctx.jobDir, 'events.jsonl'),
            join(ctx.jobHome, 'config.json'),
            join(ctx.jobHome, 'session-state'),
            join(ctx.jobHome, 'policies'),
            join(ctx.jobHome, 'logs'),
            join(env.COPILOT_CACHE_HOME, 'pkg'),
            env.GIT_CONFIG_GLOBAL,
        ];
        for (const cfg of [buildSandboxConfig('review', ctx, host()), buildSandboxConfig('write', ctx, host()), buildSandboxConfig('write', { ...ctx, hostCommits: true }, host())]) {
            const { readwritePaths, readonlyPaths } = cfg.userPolicy.filesystem;
            expect(readwritePaths).toEqual(expect.arrayContaining(laneHome()));
            expect(readwritePaths).not.toContain(ctx.jobHome);
            expect(readwritePaths).not.toContain(ctx.jobDir);
            expect(readonlyPaths).not.toContain(ctx.jobDir);
            for (const p of readwritePaths) {
                for (const target of readBack)
                    expect(target === p || target.startsWith(`${p}${sep}`), `${target} under ${p}`).toBe(false);
            }
        }
        // The lane env's temp and profile are exactly the granted dirs.
        expect([env.TEMP, env.USERPROFILE]).toEqual(laneHome());
    });
    it('drops a tool dir that is a link to a filesystem root', () => {
        const link = join(root, 'rootlink');
        symlinkSync(resolve('/'), link, process.platform === 'win32' ? 'junction' : 'dir');
        try {
            for (const profile of ['review', 'write']) {
                const ro = buildSandboxConfig(profile, { ...ctx, platform: process.platform, toolPaths: [link, join(root, 'nodejs')] }, host()).userPolicy.filesystem.readonlyPaths;
                expect(ro).not.toContain(link);
                expect(ro).toContain(join(root, 'nodejs'));
            }
        }
        finally {
            // Removes the link itself, before afterAll's recursive rmSync could meet it.
            unlinkSync(link);
        }
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
    it('grants the tool dirs read-only in both profiles, never a filesystem root or a dir holding the real home', () => {
        const toolPaths = [join(root, 'nodejs'), join(root, 'git'), root, join(root, 'me', '..'), resolve('/')];
        for (const profile of ['review', 'write']) {
            const fs = buildSandboxConfig(profile, { ...ctx, toolPaths }, host()).userPolicy.filesystem;
            expect(fs.readonlyPaths.filter((p) => !Object.values(ctx).includes(p) && p !== join(ctx.jobHome, 'git'))).toEqual([join(root, 'nodejs'), join(root, 'git')]);
            expect(fs.readwritePaths).not.toContain(join(root, 'nodejs'));
        }
        expect(buildSandboxConfig('review', ctx, host()).allowDevToolAccess).toBe(false);
    });
    it('drops a tool dir that holds the worktree, the common git dir or the job dir', () => {
        const win = {
            ...ctx,
            platform: 'win32',
            worktree: 'D:\\dev\\wt',
            commonGitDir: 'D:\\src\\repo\\.git',
            jobDir: 'E:\\jobs\\cr-1',
            jobHome: 'E:\\jobs\\cr-1\\home',
            realHome: 'C:\\Users\\me',
            toolPaths: ['D:\\dev', 'd:\\SRC', 'E:\\jobs', 'C:\\Program Files\\nodejs', 'D:\\dev\\wt\\bin'],
        };
        for (const profile of ['review', 'write']) {
            const ro = buildSandboxConfig(profile, win, host()).userPolicy.filesystem.readonlyPaths;
            for (const p of ['D:\\dev', 'd:\\SRC', 'E:\\jobs'])
                expect(ro, p).not.toContain(p);
            expect(ro).toContain('C:\\Program Files\\nodejs');
            // A dir inside the worktree holds none of them: it stays.
            expect(ro).toContain('D:\\dev\\wt\\bin');
        }
    });
    it('refuses an extra read-write path outside the worktree', () => {
        const settings = { ...ctx.settings, extraReadwritePaths: [join(root, 'elsewhere')] };
        expect(() => buildSandboxConfig('write', { ...ctx, settings }, host())).toThrow(/not under the worktree/);
        const inside = { ...ctx.settings, extraReadwritePaths: [join(ctx.worktree, 'out')] };
        expect(buildSandboxConfig('write', { ...ctx, settings: inside }, host()).userPolicy.filesystem.readwritePaths).toContain(join(ctx.worktree, 'out'));
    });
    it('keeps the gitfile and the admin dir\'s link files read-only inside their read-write grants', () => {
        const base = mkdtempSync(join(tmpdir(), 'omg-sbx-links-'));
        try {
            const worktree = join(base, 'wt');
            const commonGitDir = join(base, 'repo', '.git');
            const gitDir = join(commonGitDir, 'worktrees', 'wt');
            mkdirSync(worktree, { recursive: true });
            mkdirSync(gitDir, { recursive: true });
            writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
            for (const f of ['commondir', 'gitdir', 'config.worktree'])
                writeFileSync(join(gitDir, f), 'x\n');
            const links = [join(worktree, '.git'), ...['commondir', 'gitdir', 'config.worktree'].map((f) => join(gitDir, f))];
            const c = { ...ctx, worktree, commonGitDir, gitDir };
            const write = buildSandboxConfig('write', c, host()).userPolicy.filesystem;
            expect(write.readonlyPaths).toEqual(expect.arrayContaining(links));
            expect(write.readwritePaths).toEqual(expect.arrayContaining([worktree, gitDir]));
            expect(buildSandboxConfig('review', c, host()).userPolicy.filesystem.readonlyPaths).toEqual(expect.arrayContaining(links));
            // hostCommits: the whole common git dir is read-only, so only the gitfile needs an entry.
            const factory = buildSandboxConfig('write', { ...c, hostCommits: true }, host()).userPolicy.filesystem.readonlyPaths;
            expect(factory).toContain(join(worktree, '.git'));
            expect(factory).not.toContain(join(gitDir, 'commondir'));
            // A missing file gets no entry (a read-only entry cannot protect a name that does not exist); a .git dir is the git dir.
            rmSync(join(gitDir, 'config.worktree'));
            rmSync(join(worktree, '.git'));
            mkdirSync(join(worktree, '.git'));
            const none = buildSandboxConfig('write', c, host()).userPolicy.filesystem.readonlyPaths;
            expect(none).not.toContain(join(gitDir, 'config.worktree'));
            expect(none).not.toContain(join(worktree, '.git'));
        }
        finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
    it('refuses a write policy whose job dir lies inside the worktree (isolation "none"); a review keeps it', () => {
        const jobDir = join(ctx.worktree, '.omg', 'state', 'copilot-run', 'cr-1');
        const none = { ...ctx, jobDir, jobHome: join(jobDir, 'home') };
        expect(() => buildSandboxConfig('write', none, host())).toThrow(/lies inside the lane-writable worktree/);
        expect(() => buildSandboxConfig('write', { ...none, hostCommits: true }, host())).toThrow(/lies inside the lane-writable worktree/);
        expect(buildSandboxConfig('review', none, host()).userPolicy.filesystem.readonlyPaths[0]).toBe(ctx.worktree);
    });
});
describe('laneToolPaths', () => {
    const probe = (p) => ({
        execPath: p.execPath ?? '/usr/bin/node',
        which: (name) => p.found?.[name] ?? null,
        gitExecPath: p.gitExecPath ?? (() => null),
        realpath: p.realpath ?? ((x) => x),
    });
    it('Windows: the node dirs and the Git for Windows install root, deduplicated case-insensitively', () => {
        const paths = laneToolPaths({}, 'win32', probe({
            execPath: 'C:\\Program Files\\nodejs\\node.exe',
            found: { node: 'c:\\program files\\nodejs\\node.exe', git: 'C:\\Program Files\\Git\\cmd\\git.exe' },
            gitExecPath: () => 'C:/Program Files/Git/mingw64/libexec/git-core',
        }));
        expect(paths).toEqual(['C:\\Program Files\\nodejs', 'C:\\Program Files\\Git']);
    });
    it('Windows: a git outside the exec-path root grants its own dir and exec path, not a guessed root', () => {
        const paths = laneToolPaths({}, 'win32', probe({
            execPath: 'D:\\tools\\node\\node.exe',
            found: { git: 'D:\\scoop\\shims\\git.exe' },
            gitExecPath: () => 'D:\\scoop\\apps\\git\\current\\mingw64\\libexec\\git-core',
        }));
        expect(paths).toEqual(['D:\\tools\\node', 'D:\\scoop\\shims', 'D:\\scoop\\apps\\git\\current\\mingw64\\libexec\\git-core']);
    });
    it("gitForWindowsShell: <root>\\usr\\bin\\sh.exe from git's exec path, or null without a Git for Windows layout or git", () => {
        const gitProbe = (execDir, git = 'C:\\Program Files\\Git\\cmd\\git.exe') => probe({ found: git ? { git } : {}, gitExecPath: () => execDir });
        expect(gitForWindowsShell({}, gitProbe('C:/Program Files/Git/mingw64/libexec/git-core'))).toBe('C:\\Program Files\\Git\\usr\\bin\\sh.exe');
        expect(gitForWindowsShell({}, gitProbe('C:\\tools\\git\\bin'))).toBeNull();
        expect(gitForWindowsShell({}, gitProbe(null))).toBeNull();
        expect(gitForWindowsShell({}, gitProbe('C:/Program Files/Git/mingw64/libexec/git-core', null))).toBeNull();
    });
    it('posix: the node and git binary dirs with their realpaths, and the git exec path', () => {
        const real = { '/home/u/.nvm/current/bin/node': '/home/u/.nvm/versions/node/v22/bin/node' };
        const paths = laneToolPaths({}, 'linux', probe({
            execPath: '/opt/hostedtoolcache/node/22/x64/bin/node',
            found: { node: '/home/u/.nvm/current/bin/node', git: '/usr/bin/git' },
            gitExecPath: () => '/usr/lib/git-core',
            realpath: (x) => real[x] ?? x,
        }));
        expect(paths).toEqual(['/opt/hostedtoolcache/node/22/x64/bin', '/home/u/.nvm/current/bin', '/home/u/.nvm/versions/node/v22/bin', '/usr/bin', '/usr/lib/git-core']);
    });
    it('no git on PATH: only the node dirs', () => {
        expect(laneToolPaths({}, 'darwin', probe({ execPath: '/opt/homebrew/bin/node', realpath: () => '/opt/homebrew/Cellar/node/25.0.0/bin/node' })))
            .toEqual(['/opt/homebrew/bin', '/opt/homebrew/Cellar/node/25.0.0/bin']);
    });
    it('findOnPath honours PATHEXT and skips relative and empty entries', () => {
        const files = new Set(['C:\\Git\\cmd\\git.EXE', '/usr/bin/git']);
        const exists = (p) => files.has(p);
        expect(findOnPath('git', { Path: '.;;"C:\\Git\\cmd"', PATHEXT: '.COM;.EXE' }, 'win32', exists)).toBe('C:\\Git\\cmd\\git.EXE');
        expect(findOnPath('git', { PATH: ':bin:/usr/bin' }, 'linux', exists)).toBe('/usr/bin/git');
        expect(findOnPath('git', {}, 'linux', exists)).toBeNull();
    });
    it('findOnPath skips PATH entries under a node_modules dir', () => {
        const files = new Set(['C:\\repo\\node_modules\\.bin\\git.CMD', 'C:\\Git\\cmd\\git.EXE', '/repo/node_modules/.bin/git', '/usr/bin/git']);
        const exists = (p) => files.has(p);
        expect(findOnPath('git', { PATH: 'C:\\repo\\Node_Modules\\.bin;C:\\repo\\node_modules\\.bin;C:\\Git\\cmd', PATHEXT: '.EXE;.CMD' }, 'win32', exists)).toBe('C:\\Git\\cmd\\git.EXE');
        expect(findOnPath('git', { PATH: '/repo/node_modules/.bin:/usr/bin' }, 'linux', exists)).toBe('/usr/bin/git');
        // Only a whole path segment counts.
        files.add('/opt/my_node_modules_tools/git');
        expect(findOnPath('git', { PATH: '/opt/my_node_modules_tools:/usr/bin' }, 'linux', exists)).toBe('/opt/my_node_modules_tools/git');
    });
    it('the default probe finds the real node of this process', () => {
        expect(laneToolPaths({ PATH: '' }, process.platform)).toContain(dirname(process.execPath));
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
        expect(await probeHostSupport(client({ supported: true, capabilities: [{ name: 'shell', supported: true }] }), 1000, { platform: 'win32' })).toEqual({ supported: true, capabilities: { shell: true } });
        expect(await probeHostSupport(client({ supported: true, capabilities: [{ name: 'shell', supported: false }] }), 1000)).toMatchObject({ supported: false, reason: expect.stringContaining('no shell') });
        expect(await probeHostSupport(client({ supported: false, reason: 'old build', capabilities: [] }), 1000)).toMatchObject({ supported: false, reason: 'old build' });
        expect(await probeHostSupport({ rpc: { sandbox: { getHostSupport: async () => { throw new Error('boom'); } } } }, 1000)).toMatchObject({ supported: false, reason: expect.stringContaining('boom') });
        expect(await probeHostSupport({}, 1000)).toMatchObject({ supported: false, reason: expect.stringContaining('no sandbox.getHostSupport') });
    });
    it('probeHostSupport on Linux also needs a trial launch, which only a runtime-supported host gets', async () => {
        const supported = { rpc: { sandbox: { getHostSupport: async () => ({ supported: true, capabilities: [{ name: 'shell', supported: true }] }) } } };
        let trials = 0;
        const trial = (err) => () => { trials++; return err; };
        expect(await probeHostSupport(supported, 1000, { platform: 'linux', trialLaunch: trial(null) })).toEqual({ supported: true, capabilities: { shell: true } });
        expect(await probeHostSupport(supported, 1000, { platform: 'linux', trialLaunch: trial('userns restricted') }))
            .toEqual({ supported: false, reason: 'userns restricted', capabilities: { shell: true }, launchFailed: true });
        expect(trials).toBe(2);
        const unsupported = { rpc: { sandbox: { getHostSupport: async () => ({ supported: false, reason: 'no bwrap', capabilities: [] }) } } };
        expect(await probeHostSupport(unsupported, 1000, { platform: 'linux', trialLaunch: trial(null) })).toMatchObject({ supported: false, reason: 'no bwrap' });
        expect(await probeHostSupport(supported, 1000, { platform: 'darwin', trialLaunch: trial('x') })).toMatchObject({ supported: true });
        expect(trials).toBe(2);
    });
    it('bwrapTrialLaunchError runs bwrap with the namespace and network flags and names the failure', () => {
        const calls = [];
        const spawner = (res) => (cmd, args) => { calls.push({ cmd, args }); return res; };
        expect(bwrapTrialLaunchError(spawner({ status: 0, stderr: '' }))).toBeNull();
        expect(calls[0]).toEqual({ cmd: 'bwrap', args: BWRAP_TRIAL_ARGS });
        expect(BWRAP_TRIAL_ARGS).toContain('--unshare-all');
        const restricted = bwrapTrialLaunchError(spawner({ status: 1, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' }));
        expect(restricted).toMatch(/^unprivileged user namespaces are restricted \(AppArmor kernel\.apparmor_restrict_unprivileged_userns=1\)/);
        expect(restricted).toContain('docs/REFERENCE.md');
        expect(restricted).toContain('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted)');
        const missing = Object.assign(new Error('spawnSync bwrap ENOENT'), { code: 'ENOENT' });
        expect(bwrapTrialLaunchError(spawner({ error: missing, status: null, stderr: '' }))).toMatch(/^bwrap \(bubblewrap\) is not on PATH/);
        expect(bwrapTrialLaunchError(spawner({ status: 2, stderr: 'bwrap: something else' }))).toBe('a trial bwrap launch failed (exit 2): bwrap: something else');
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
        const hostTemp = 'C:\\Users\\u\\AppData\\Local\\Temp';
        const env = allowlistSessionEnv({ Path: 'p', SystemRoot: 'C:\\Windows', npm_config_token: 't', LC_CTYPE: 'C', OMC_X: '1', APPDATA: 'a', LocalAppData: 'C:\\Users\\u\\AppData\\Local', Temp: hostTemp, tmp: hostTemp, TMPDIR: '/tmp' }, join(root, 'h'));
        expect(env).toEqual({
            Path: 'p', SystemRoot: 'C:\\Windows', LC_CTYPE: 'C', OMC_X: '1', LocalAppData: 'C:\\Users\\u\\AppData\\Local',
            // The runtime grants read-write on its TEMP: the caller's (any case) never passes, the job's own temp dir does.
            TEMP: join(root, 'h', 'tmp'), TMP: join(root, 'h', 'tmp'), TMPDIR: join(root, 'h', 'tmp'),
            USERPROFILE: join(root, 'h', 'profile'), HOME: join(root, 'h', 'profile'),
            XDG_CONFIG_HOME: join(root, 'h', 'profile', '.config'), GIT_CONFIG_GLOBAL: join(root, 'h', 'git', 'config'), NODE_DISABLE_COMPILE_CACHE: '1',
            // The host LOCALAPPDATA passes for MXC; the runtime's cache stays in the job home, outside the lane-writable profile.
            COPILOT_CACHE_HOME: join(root, 'h', '.cache', 'copilot'),
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