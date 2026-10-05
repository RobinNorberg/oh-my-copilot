import { EventEmitter } from 'events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCopilotBinary, parseCopilotVersion } from '../copilot-binary.js';
import {
  buildSessionEnv,
  DEFAULT_SMOKE_PROMPT,
  DELEGATE_SMOKE_PROMPT,
  extractJsonArray,
  LOGIN_SHADOWING_TOKENS,
  loginIdentity,
  resolveDefaultPluginRoot,
  resolvePackageRoot,
  runCopilotSmoke,
  SESSION_SET_ENV,
  sessionSandboxFlags,
  SMOKE_SET_ENV,
  STRIPPED_ENV_EXACT,
  STRIPPED_ENV_PREFIXES,
  type SmokeDeps,
  type SmokeReport,
} from '../copilot-smoke.js';
import { formatSmokeReport, smokeCopilotCommand, smokeExitCode, toSmokeOptions } from '../../cli/commands/smoke.js';
import { hasExited, killProcessTree, runAsync, type SpawnFn, type SpawnSyncFn } from '../process-utils.js';

const FIXTURES = join(__dirname, 'fixtures');
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

let root: string;
let fakeBin: string;
let userConfigDir: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smoke-root-'));
  write(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', version: '9.9.9' }));
  write(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-copilot', version: '9.9.9' }));
  write(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { t: { command: 'node' } } }));
  for (const s of ['alpha', 'beta']) write(join(root, 'skills', s, 'SKILL.md'), '# s');
  write(join(root, 'agents', 'architect.md'), '# a');
  write(join(root, 'copilot', 'agents', 'architect.md'), '# a');
  write(join(root, 'dist', 'mcp', 'standalone-server.js'), '// fake');
  fakeBin = join(root, 'bin', 'copilot.exe');
  write(fakeBin, '');
  userConfigDir = join(root, 'user-copilot');
  write(join(userConfigDir, 'config.json'), '// managed\n{"loggedInUsers":[{"host":"https://github.com","login":"me"}],"lastLoggedInUser":{"host":"https://github.com","login":"me"},"trustedFolders":["/secret"]}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface SpawnSyncCall { command: string; args: string[]; options: Record<string, unknown> }

/** spawnSync fake: node --verify scripts, copilot --version/plugin list/skill list, git, taskkill. */
function makeSpawnSync(
  calls: SpawnSyncCall[],
  overrides: { pluginList?: string; version?: string; skillRoot?: string; verifyStatus?: number; gitThrows?: boolean } = {},
): SpawnSyncFn {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '', pid: 1, output: [], signal: null });
    if (args.includes('--verify')) return { ...ok('verify out'), status: overrides.verifyStatus ?? 0 };
    if (args.includes('--version')) return ok(overrides.version ?? 'GitHub Copilot CLI 1.0.91.\n');
    if (args.includes('plugin')) {
      return ok(overrides.pluginList ?? JSON.stringify([{ name: 'oh-my-copilot', marketplace: '', version: '9.9.9', enabled: true, source: 'external' }]));
    }
    if (args.includes('skill')) {
      const skillRoot = overrides.skillRoot ?? root;
      return ok(JSON.stringify([
        { name: 'alpha', source: 'plugin', path: join(skillRoot, 'skills', 'alpha') },
        { name: 'beta', source: 'plugin', path: join(skillRoot, 'skills', 'beta') },
        { name: 'compact', source: 'plugin', path: join(root, 'commands') },
        { name: 'other', source: 'inherited', path: '/elsewhere/other' },
      ]));
    }
    if (command === 'git') {
      if (overrides.gitThrows) throw new Error('git exploded');
      mkdirSync(join(options.cwd as string, '.git'), { recursive: true });
      return ok('');
    }
    return ok('');
  }) as unknown as SpawnSyncFn;
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid?: number; kill: () => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.kill = () => true;
  return child;
}

interface SpawnCall { command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv }; stdin: string; configJson?: unknown }

/**
 * spawn fake: the standalone MCP server answers initialize/tools/list; the
 * copilot session replays the captured fixtures into COPILOT_HOME/--log-dir
 * and writes the SessionStart marker into the project, like the real run.
 */
function makeSpawn(calls: SpawnCall[], opts: { toolCount?: number; sessionExit?: number } = {}): SpawnFn {
  return ((command: string, args: string[], options: SpawnCall['options']) => {
    const child = fakeChild();
    const call: SpawnCall = { command, args, options, stdin: '' };
    calls.push(call);
    if (args.some((a) => a.endsWith('standalone-server.js'))) {
      let buf = '';
      child.stdin.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const msg = JSON.parse(buf.slice(0, nl)) as { id?: number };
          buf = buf.slice(nl + 1);
          if (msg.id === 1) child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })}\n`);
          if (msg.id === 2) {
            const tools = Array.from({ length: opts.toolCount ?? 3 }, (_, i) => ({ name: `t${i}` }));
            child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } })}\n`);
          }
        }
      });
      return child;
    }
    // copilot session
    child.stdin.on('data', (chunk: Buffer) => { call.stdin += chunk.toString(); });
    child.stdin.on('finish', () => {
      const home = options.env!.COPILOT_HOME!;
      call.configJson = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
      const logDir = args[args.indexOf('--log-dir') + 1];
      const sessionId = args[args.indexOf('--session-id') + 1];
      write(join(home, 'session-state', sessionId, 'events.jsonl'), readFileSync(join(FIXTURES, 'tier1-events.jsonl'), 'utf-8'));
      write(join(logDir, 'process-1-1.log'), readFileSync(join(FIXTURES, 'tier1-debug-excerpt.log'), 'utf-8'));
      write(join(options.cwd!, '.omg', 'state', 'sessions', sessionId, 'session-started.json'), '{}');
      child.stdout.end(readFileSync(join(FIXTURES, 'tier1-stdout.jsonl'), 'utf-8'));
      child.stderr.end();
      setImmediate(() => child.emit('close', opts.sessionExit ?? 0, null));
    });
    return child;
  }) as unknown as SpawnFn;
}

function deps(extra: Partial<SmokeDeps> = {}, spawnSyncCalls: SpawnSyncCall[] = [], spawnCalls: SpawnCall[] = []): SmokeDeps {
  return {
    spawnSync: makeSpawnSync(spawnSyncCalls),
    spawn: makeSpawn(spawnCalls),
    resolveExecutable: () => fakeBin,
    loadExpectedToolCount: async () => 3,
    randomUUID: () => SESSION_ID,
    userConfigDir,
    ...extra,
  };
}

describe('runCopilotSmoke tier 0 (mocked spawn)', () => {
  it('passes every static and copilot check', async () => {
    const syncCalls: SpawnSyncCall[] = [];
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 0, env: {}, deps: deps({}, syncCalls) });
    expect(report.checks.map((c) => c.id)).toEqual([
      'plugin.manifest', 'plugin.hooks', 'copilot.binary', 'copilot.plugin_list', 'copilot.skill_list', 'copilot.agents', 'mcp.list_tools',
    ]);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report).toMatchObject({ ok: true, tier: 0, pluginVersion: '9.9.9', copilot: { bin: fakeBin, version: '1.0.91' } });
    expect(report.checks.find((c) => c.id === 'copilot.skill_list')?.detail).toMatch(/^2\/2 .*\(3 plugin entries/);
    // list commands run in an isolated COPILOT_HOME with trust not forced
    const list = syncCalls.find((c) => c.args.includes('plugin'))!;
    expect((list.options.env as NodeJS.ProcessEnv).COPILOT_HOME).toMatch(/omg-smoke-list-/);
    expect((list.options.env as NodeJS.ProcessEnv).COPILOT_ALLOW_ALL).toBe('false');
    expect(list.args).toEqual(['--plugin-dir', root, '--no-auto-update', 'plugin', 'list', '--json']);
    // the --version probe never runs inside the (possibly missing) plugin root
    expect(syncCalls.find((c) => c.args.includes('--version'))!.options.cwd).toBe(tmpdir());
    expect(smokeExitCode(report)).toBe(0);
    expect(report.artifacts).toEqual({});
    expect(existsSync((list.options.env as NodeJS.ProcessEnv).COPILOT_HOME!)).toBe(false);
  });

  it('reports and keeps the tier 0 list home with keepHome', async () => {
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 0, env: {}, keepHome: true, deps: deps() });
    expect(basename(report.artifacts.listHome!)).toMatch(/^omg-smoke-list-/);
    expect(existsSync(report.artifacts.listHome!)).toBe(true);
    expect(report.artifacts.copilotHome).toBeUndefined();
    rmSync(report.artifacts.listHome!, { recursive: true, force: true });
  });

  it('matches skill paths by realpath when the plugin root is a symlink/junction', async () => {
    const link = join(mkdtempSync(join(tmpdir(), 'smoke-link-')), 'root-link');
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const real = realpathSync.native(root);
      const report = await runCopilotSmoke({
        pluginRoot: link, tier: 0, env: {}, deps: deps({ spawnSync: makeSpawnSync([], { skillRoot: real }) }),
      });
      expect(report.checks.find((c) => c.id === 'copilot.skill_list')).toMatchObject({ ok: true });
    } finally {
      // Drop the link itself before the recursive delete so nothing is traversed through it.
      try { unlinkSync(link); } catch { rmdirSync(link); }
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });

  it('fails plugin_list on the empty list a bad --plugin-dir yields (exit 0)', async () => {
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 0, env: {}, deps: deps({ spawnSync: makeSpawnSync([], { pluginList: 'Warning: no plugin.json\n[]' }) }) });
    expect(report.checks.find((c) => c.id === 'copilot.plugin_list')).toMatchObject({ ok: false, detail: 'oh-my-copilot not listed (0 plugin(s))' });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('flags a stale dist when tools/list disagrees with the registry', async () => {
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 0, env: {}, deps: deps({ loadExpectedToolCount: async () => 4 }) });
    expect(report.checks.find((c) => c.id === 'mcp.list_tools')?.detail).toBe('tools/list returned 3, registry allTools 4 (stale dist? run npm run build)');
  });

  it('asks for a build when dist/mcp/standalone-server.js is missing', async () => {
    rmSync(join(root, 'dist'), { recursive: true });
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 0, env: {}, deps: deps() });
    expect(report.checks.find((c) => c.id === 'mcp.list_tools')?.detail).toMatch(/run npm run build$/);
  });

  it('fails the manifest on a version mismatch', async () => {
    write(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 0, env: {}, deps: deps() });
    expect(report.checks[0]).toMatchObject({ id: 'plugin.manifest', ok: false, detail: 'version 9.9.9 != package.json 1.0.0' });
  });

  it('reports skipped (exit 2) when the binary is missing, keeping static checks', async () => {
    const report = await runCopilotSmoke({
      pluginRoot: root, tier: 1, env: {}, deps: deps({ resolveExecutable: () => undefined, platform: 'linux' }),
    });
    expect(report.skipped).toMatch(/not found/);
    expect(report.copilot.bin).toBeNull();
    expect(report.checks.find((c) => c.id === 'plugin.manifest')?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'copilot.plugin_list')).toMatchObject({ ok: false, detail: 'skipped' });
    expect(report.checks.find((c) => c.id === 'session.exit')).toMatchObject({ ok: false, detail: 'skipped' });
    expect(report.checks.find((c) => c.id === 'hooks.adapter_errors')).toMatchObject({ ok: false, detail: 'skipped' });
    expect(smokeExitCode(report)).toBe(2);
  });

  it('exits 1, not 2, when the binary is missing AND a static check failed', async () => {
    const report = await runCopilotSmoke({
      pluginRoot: root, tier: 0, env: {},
      deps: deps({ resolveExecutable: () => undefined, platform: 'linux', spawnSync: makeSpawnSync([], { verifyStatus: 1 }) }),
    });
    expect(report.skipped).toMatch(/not found/);
    expect(report.checks.find((c) => c.id === 'plugin.hooks')?.ok).toBe(false);
    expect(smokeExitCode(report)).toBe(1);
  });
});

describe('runCopilotSmoke tier 1 (mocked spawn, fixture replay)', () => {
  it('delivers the prompt on stdin, isolates the home, and passes on the captured run', async () => {
    const spawnCalls: SpawnCall[] = [];
    const syncCalls: SpawnSyncCall[] = [];
    const report = await runCopilotSmoke({
      pluginRoot: root,
      tier: 1,
      env: {
        COPILOT_ALLOW_ALL: 'true', OMC_STATE_DIR: '/elsewhere', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', COPILOT_GITHUB_TOKEN: 'z',
        OMC_HOOK_FAIL_CLOSED: '0', NODE_OPTIONS: '--require evil', CLAUDECODE: '1', PATH: '/bin',
      },
      deps: deps({}, syncCalls, spawnCalls),
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'hooks.adapter_errors')?.ok).toBe(true);

    const session = spawnCalls.find((c) => c.args.includes('--session-id'))!;
    expect(session.stdin).toBe(`${DEFAULT_SMOKE_PROMPT}\n`);
    expect(session.args.join(' ')).not.toContain('SMOKE_OK');
    expect(session.args).not.toContain('-p');
    expect(session.args).not.toContain('--model');
    expect(session.args).toEqual(expect.arrayContaining([
      '--plugin-dir', root, '--session-id', SESSION_ID, '--output-format', 'json', '--allow-all-tools',
      '--no-ask-user', '--no-auto-update', '--log-level', 'debug', '--max-ai-credits', '30',
      '--deny-tool', 't(host_smoke)', '--disable-builtin-mcps', 'shell', 'write',
    ]));
    // a stored login was copied: GH_TOKEN/GITHUB_TOKEN would shadow it and are dropped
    expect(session.options.env).toMatchObject({
      COPILOT_ALLOW_ALL: 'false', OMC_HOOK_FAIL_CLOSED: '1', COPILOT_GITHUB_TOKEN: 'z', PATH: '/bin',
    });
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OMC_STATE_DIR', 'NODE_OPTIONS', 'CLAUDECODE']) {
      expect(session.options.env?.[key]).toBeUndefined();
    }
    expect(basename(session.options.cwd!)).toBe('project');
    expect(session.configJson).toEqual({
      loggedInUsers: [{ host: 'https://github.com', login: 'me' }],
      lastLoggedInUser: { host: 'https://github.com', login: 'me' },
      trustedFolders: [session.options.cwd],
    });
    expect(syncCalls.some((c) => c.command === 'git' && c.args[0] === 'init')).toBe(true);
    // cleaned up without keepHome
    expect(existsSync(session.options.env!.COPILOT_HOME!)).toBe(false);
    expect(report.artifacts).toEqual({});
  });

  it('keeps the home and reports artifact paths with keepHome; passes model/credits through', async () => {
    const spawnCalls: SpawnCall[] = [];
    const report = await runCopilotSmoke({
      pluginRoot: root, tier: 1, env: {}, keepHome: true, model: 'some-model', maxCredits: 45,
      deps: deps({}, [], spawnCalls),
    });
    const session = spawnCalls.find((c) => c.args.includes('--session-id'))!;
    expect(session.args).toEqual(expect.arrayContaining(['--model', 'some-model', '--max-ai-credits', '45']));
    const home = session.options.env!.COPILOT_HOME!;
    expect(report.artifacts.copilotHome).toBe(home);
    expect(basename(report.artifacts.listHome!)).toMatch(/^omg-smoke-list-/);
    expect(report.artifacts.listHome).not.toBe(home);
    expect(existsSync(report.artifacts.eventsLog!)).toBe(true);
    expect(existsSync(report.artifacts.stdout!)).toBe(true);
    expect(report.artifacts.debugLog).toMatch(/process-1-1\.log$/);
    rmSync(join(home, '..'), { recursive: true, force: true });
    rmSync(report.artifacts.listHome!, { recursive: true, force: true });
  });

  it('keeps GH_TOKEN/GITHUB_TOKEN when there is no stored login (CI)', async () => {
    const spawnCalls: SpawnCall[] = [];
    await runCopilotSmoke({
      pluginRoot: root, tier: 1, env: { GH_TOKEN: 'x', GITHUB_TOKEN: 'y' },
      deps: deps({ userConfigDir: join(root, 'no-login') }, [], spawnCalls),
    });
    const session = spawnCalls.find((c) => c.args.includes('--session-id'))!;
    expect(session.options.env).toMatchObject({ GH_TOKEN: 'x', GITHUB_TOKEN: 'y' });
    expect(session.configJson).toEqual({ trustedFolders: [session.options.cwd] });
  });

  it('uses the delegate prompt and adds subagent.selected (fails on a non-delegating replay)', async () => {
    const spawnCalls: SpawnCall[] = [];
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 1, env: {}, delegate: true, deps: deps({}, [], spawnCalls) });
    const session = spawnCalls.find((c) => c.args.includes('--session-id'))!;
    expect(session.stdin).toBe(`${DELEGATE_SMOKE_PROMPT}\n`);
    // delegation is a tool call: shell/write stay allowed, host_smoke stays denied
    expect(session.args).toEqual(expect.arrayContaining(['--deny-tool', 't(host_smoke)', '--disable-builtin-mcps']));
    expect(session.args).not.toContain('shell');
    expect(session.args).not.toContain('write');
    expect(report.checks.at(-1)).toMatchObject({ id: 'subagent.selected', ok: false });
  });

  it('removes its temp dirs when tier 1 throws midway', async () => {
    const syncCalls: SpawnSyncCall[] = [];
    await expect(runCopilotSmoke({
      pluginRoot: root, tier: 1, env: {}, deps: deps({ spawnSync: makeSpawnSync(syncCalls, { gitThrows: true }) }),
    })).rejects.toThrow(/git exploded/);
    const projectDir = syncCalls.find((c) => c.command === 'git')!.options.cwd as string;
    const listHome = (syncCalls.find((c) => c.args.includes('plugin'))!.options.env as NodeJS.ProcessEnv).COPILOT_HOME!;
    expect(existsSync(dirname(projectDir))).toBe(false);
    expect(existsSync(listHome)).toBe(false);
  });

  it('fails session.exit on a non-zero exit', async () => {
    const report = await runCopilotSmoke({ pluginRoot: root, tier: 1, env: {}, deps: deps({ spawn: makeSpawn([], { sessionExit: 1 }) }) });
    expect(report.checks.find((c) => c.id === 'session.exit')?.ok).toBe(false);
  });

  it('rejects a prompt containing NUL', async () => {
    await expect(runCopilotSmoke({ pluginRoot: root, tier: 1, env: {}, prompt: 'a\0b', deps: deps() })).rejects.toThrow(/NUL/);
  });
});

describe('resolveCopilotBinary', () => {
  const none = () => undefined;
  it('prefers the override, then PATH, then COPILOT_CLI_PATH, then WinGet', () => {
    expect(resolveCopilotBinary(fakeBin, {}, { resolveExecutable: none })).toEqual({ bin: fakeBin, source: 'override' });
    expect(resolveCopilotBinary(undefined, {}, { resolveExecutable: () => '/usr/bin/copilot' })).toEqual({ bin: '/usr/bin/copilot', source: 'path' });
    expect(resolveCopilotBinary(undefined, { COPILOT_CLI_PATH: fakeBin }, { resolveExecutable: none })).toEqual({ bin: fakeBin, source: 'COPILOT_CLI_PATH' });
    const local = join(root, 'local');
    const pkg = join(local, 'Microsoft', 'WinGet', 'Packages', 'GitHub.Copilot_Microsoft.Winget.Source_x');
    write(join(pkg, 'copilot.exe'), '');
    expect(resolveCopilotBinary(undefined, { LOCALAPPDATA: local }, { resolveExecutable: none, platform: 'win32' }))
      .toEqual({ bin: join(pkg, 'copilot.exe'), source: 'winget' });
    expect(resolveCopilotBinary(undefined, { LOCALAPPDATA: local }, { resolveExecutable: none, platform: 'linux' }))
      .toEqual({ bin: null, source: null });
  });

  it('parses the --version banner', () => {
    expect(parseCopilotVersion('GitHub Copilot CLI 1.0.91.\nRun ...')).toBe('1.0.91');
    expect(parseCopilotVersion('nope')).toBeNull();
  });
});

describe('helpers', () => {
  it('extractJsonArray tolerates warnings around the array', () => {
    expect(extractJsonArray('Warning: x\n[{"a":1}]\n')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('no array')).toBeNull();
  });

  it('loginIdentity copies only the login keys from JSONC config', () => {
    expect(loginIdentity(userConfigDir)).toEqual({
      loggedInUsers: [{ host: 'https://github.com', login: 'me' }],
      lastLoggedInUser: { host: 'https://github.com', login: 'me' },
    });
    expect(loginIdentity(join(root, 'missing'))).toEqual({});
  });

  it('resolveDefaultPluginRoot honours OMC_PLUGIN_ROOT, else finds this repo', () => {
    expect(resolveDefaultPluginRoot({ OMC_PLUGIN_ROOT: root })).toBe(root);
    const found = resolveDefaultPluginRoot({});
    expect(JSON.parse(readFileSync(join(found, 'plugin.json'), 'utf-8')).name).toBe('oh-my-copilot');
    expect(resolvePackageRoot()).toBe(found);
  });
});

describe('session env policy', () => {
  it('pins the documented strip/set lists', () => {
    expect(STRIPPED_ENV_EXACT).toEqual([
      'DISABLE_OMC', 'CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'NODE_OPTIONS',
      'COPILOT_HOME', 'COPILOT_OFFLINE', 'COPILOT_MODEL',
    ]);
    expect(STRIPPED_ENV_PREFIXES).toEqual(['OMC_', 'CLAUDE_CODE_', 'COPILOT_PROVIDER_']);
    expect(LOGIN_SHADOWING_TOKENS).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
    expect(SMOKE_SET_ENV).toEqual({ COPILOT_ALLOW_ALL: 'false', COPILOT_AUTO_UPDATE: 'false', NO_COLOR: '1' });
    expect(SESSION_SET_ENV).toEqual({ OMC_HOOK_FAIL_CLOSED: '1' });
  });

  it('strips host markers and overrides, keeps PATH/home/auth vars', () => {
    const base = {
      PATH: '/bin', HOME: '/h', USERPROFILE: 'C:/u', APPDATA: 'C:/a', LOCALAPPDATA: 'C:/l', TEMP: '/t',
      COPILOT_GITHUB_TOKEN: 'c', GH_TOKEN: 'g', GITHUB_TOKEN: 'h', COPILOT_CLI_PATH: '/copilot',
      OMC_STATE_DIR: 's', OMC_PLUGIN_ROOT: 'p', OMC_SKIP_HOOKS: '*', OMC_HOOK_FAIL_CLOSED: '0', DISABLE_OMC: '1',
      CLAUDECODE: '1', CLAUDE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'y', CLAUDE_PLUGIN_ROOT: 'r',
      NODE_OPTIONS: '--require x', COPILOT_HOME: '/real', COPILOT_OFFLINE: '1', COPILOT_MODEL: 'm',
      COPILOT_PROVIDER_BASE_URL: 'http://x', COPILOT_PROVIDER_API_KEY: 'k', COPILOT_ALLOW_ALL: 'true',
    };
    const list = buildSessionEnv(base, '/home');
    expect(list).toEqual({
      PATH: '/bin', HOME: '/h', USERPROFILE: 'C:/u', APPDATA: 'C:/a', LOCALAPPDATA: 'C:/l', TEMP: '/t',
      COPILOT_GITHUB_TOKEN: 'c', GH_TOKEN: 'g', GITHUB_TOKEN: 'h', COPILOT_CLI_PATH: '/copilot',
      COPILOT_HOME: '/home', COPILOT_ALLOW_ALL: 'false', COPILOT_AUTO_UPDATE: 'false', NO_COLOR: '1',
    });
    const session = buildSessionEnv(base, '/home', { session: true, hasLogin: true });
    expect(session.OMC_HOOK_FAIL_CLOSED).toBe('1');
    expect(session.GH_TOKEN).toBeUndefined();
    expect(session.GITHUB_TOKEN).toBeUndefined();
    expect(session.COPILOT_GITHUB_TOKEN).toBe('c');
  });

  it('sandbox flags deny host_smoke and builtin MCPs; shell/write only without --delegate', () => {
    expect(sessionSandboxFlags(false)).toEqual([
      '--deny-tool', 't(host_smoke)', '--disable-builtin-mcps', '--deny-tool', 'shell', '--deny-tool', 'write',
    ]);
    expect(sessionSandboxFlags(true)).toEqual(['--deny-tool', 't(host_smoke)', '--disable-builtin-mcps']);
  });
});

describe('process-utils', () => {
  it('killProcessTree uses taskkill /T /F on win32 and skips without a pid', () => {
    const calls: unknown[][] = [];
    const sync = ((...args: unknown[]) => { calls.push(args); return { status: 0 }; }) as unknown as SpawnSyncFn;
    killProcessTree(1234, sync, 'win32');
    killProcessTree(undefined, sync, 'win32');
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['taskkill', ['/PID', '1234', '/T', '/F']]);
  });

  it('killProcessTree signals the process group on POSIX, falling back to the pid', () => {
    const kills: Array<[number, string]> = [];
    killProcessTree(42, (() => ({})) as unknown as SpawnSyncFn, 'linux', (pid, sig) => { kills.push([pid, sig]); });
    expect(kills).toEqual([[-42, 'SIGKILL']]);
    kills.length = 0;
    killProcessTree(42, (() => ({})) as unknown as SpawnSyncFn, 'linux', (pid, sig) => {
      kills.push([pid, sig]);
      if (pid < 0) throw new Error('ESRCH');
    });
    expect(kills).toEqual([[-42, 'SIGKILL'], [42, 'SIGKILL']]);
  });

  it('hasExited is true only once an exit code or signal is set', () => {
    expect(hasExited({ exitCode: null, signalCode: null })).toBe(false);
    expect(hasExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: 'SIGTERM' })).toBe(true);
  });

  it('runAsync does not tree-kill a child that already exited', async () => {
    const child = fakeChild() as FakeChild & { exitCode: number | null };
    child.exitCode = 0;
    child.pid = 999;
    const sync = vi.fn(() => ({ status: 0 }));
    const res = await runAsync((() => child) as unknown as SpawnFn, sync as unknown as SpawnSyncFn, 'x', [], { timeoutMs: 10 });
    expect(res.timedOut).toBe(true);
    expect(sync).not.toHaveBeenCalled();
  });

  it('runAsync times out a hung child', async () => {
    const hung = (() => fakeChild()) as unknown as SpawnFn;
    const res = await runAsync(hung, (() => ({ status: 0 })) as unknown as SpawnSyncFn, 'x', [], { timeoutMs: 20, input: 'hi' });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull();
  });
});

describe('CLI option mapping and output', () => {
  it('maps flags and validates tier/numbers', () => {
    expect(toSmokeOptions({ tier: '1', maxCredits: '40', timeout: '5000', keepHome: true, delegate: true, model: 'm' }))
      .toEqual({ tier: 1, maxCredits: 40, timeoutMs: 5000, keepHome: true, delegate: true, model: 'm' });
    expect(toSmokeOptions({})).toEqual({ tier: 0, keepHome: false, delegate: false });
    expect(() => toSmokeOptions({ tier: '3' })).toThrow(/--tier/);
    expect(() => toSmokeOptions({ maxCredits: 'abc' })).toThrow(/--max-credits/);
    expect(() => toSmokeOptions({ maxCredits: '10' })).toThrow(/at least 30/);
  });

  it('--json always prints a SmokeReport, also for option errors (exit 1, cli.error)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // An invalid tier (never 2: that would run a real, billed tier 2 smoke).
      for (const cli of [{ tier: '3', json: true }, { maxCredits: '10', json: true }]) {
        log.mockClear();
        expect(await smokeCopilotCommand(cli)).toBe(1);
        const report = JSON.parse(String(log.mock.calls[0][0])) as SmokeReport;
        expect(report).toMatchObject({ ok: false, checks: [{ id: 'cli.error', ok: false }] });
      }
      expect(err).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('formats one line per check plus a summary', () => {
    const text = formatSmokeReport({
      ok: false, tier: 0, pluginRoot: '/r', pluginVersion: '1', copilot: { bin: null, version: null },
      checks: [{ id: 'a', ok: true, detail: 'fine' }, { id: 'b', ok: false, detail: 'bad', evidence: 'why' }],
      artifacts: {}, durationMs: 5,
    });
    expect(text).toMatch(/✓.* a — fine/);
    expect(text).toMatch(/✗.* b — bad/);
    expect(text).toContain('why');
    expect(text).toMatch(/FAIL: 1\/2 checks failed/);
  });
});
