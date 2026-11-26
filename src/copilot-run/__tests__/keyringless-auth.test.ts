/**
 * Keyring-less hosts (Linux/macOS without Secret Service or a keychain): Copilot CLI keeps the login token in plain
 * text in `<copilot config dir>/config.json`. The token reaches the runtime over the session RPC (lanes, SDK team
 * workers) or the client option (no-session probes), never through the job home, the lane env, or its output.
 * Fixtures only: no real config is read.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { smokeStoredLogin, storedLoginToken } from '../../smoke/copilot-session-env.js';
import { scrubTokens, secretValues, sessionGitHubToken, triedCredentialNames, withCredentialHint } from '../sandbox.js';
import { fetchCopilotCatalogue } from '../model-catalogue.js';
import { probeLaneModel } from '../../factory/bench/model-probe.js';
import { workerGitHubToken } from '../../team/sdk-host.js';
import { CopilotRunManager, type CopilotRunDeps } from '../job.js';
import { DEFAULT_SANDBOX_SETTINGS } from '../sandbox.js';
import { fakeDeps, fakeSdk, newCalls, scratchRepo } from './fake-sdk.js';

// Not token-shaped, so the exact-value redaction (not the gh*_ pattern) is what scrubs it.
const STORED = 'stored-plaintext-credential-0001';
const OTHER = 'other-user-credential-0002';
const ENV_TOKEN = 'env-copilot-credential-0003';
const T = Date.parse('2026-11-21T12:00:00Z');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function configDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'omg-keyringless-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const me = { host: 'https://github.com', login: 'me' };
const loggedIn = (extra: Record<string, unknown>) => ({ loggedInUsers: [me], lastLoggedInUser: me, ...extra });

describe('smokeStoredLogin (the smoke harness)', () => {
  it('a keyring-less host without COPILOT_GITHUB_TOKEN: the real config dir and its stored token', () => {
    const dir = configDir(loggedIn({ authTokens: { 'https://github.com:me': STORED } }));
    expect(smokeStoredLogin({ PATH: '/usr/bin' }, dir, 'linux')).toEqual({ userConfigDir: dir, token: STORED });
    expect(smokeStoredLogin({ COPILOT_GITHUB_TOKEN: '  ' }, dir, 'darwin')).toEqual({ userConfigDir: dir, token: STORED });
  });

  it('nothing on Windows, with an exact-case COPILOT_GITHUB_TOKEN (the runtime reads it), or with a keyring (no plaintext token)', () => {
    const dir = configDir(loggedIn({ authTokens: { 'https://github.com:me': STORED } }));
    expect(smokeStoredLogin({}, dir, 'win32')).toBeUndefined();
    expect(smokeStoredLogin({ copilot_github_token: ENV_TOKEN }, dir, 'win32')).toBeUndefined();
    expect(smokeStoredLogin({ COPILOT_GITHUB_TOKEN: ENV_TOKEN }, dir, 'linux')).toBeUndefined();
    expect(smokeStoredLogin({}, configDir(loggedIn({})), 'linux')).toBeUndefined();
  });

  it('another letter case on Linux/macOS (not read by the runtime) wins over the stored token, as for lanes', () => {
    const dir = configDir(loggedIn({ authTokens: { 'https://github.com:me': STORED } }));
    expect(smokeStoredLogin({ copilot_github_token: ENV_TOKEN }, dir, 'linux')).toEqual({ userConfigDir: dir, token: ENV_TOKEN });
    const keyring = configDir(loggedIn({}));
    expect(smokeStoredLogin({ Copilot_GitHub_Token: ENV_TOKEN }, keyring, 'darwin')).toEqual({ userConfigDir: keyring, token: ENV_TOKEN });
    // The lane side resolves the same value (envValue, any case).
    expect(sessionGitHubToken({ copilot_github_token: ENV_TOKEN }, { userConfigDir: dir, platform: 'linux' })).toBe(ENV_TOKEN);
  });
});

describe('storedLoginToken (fixture configs)', () => {
  it('reads the lastLoggedInUser entry of authTokens: a credential object or a plain string', () => {
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:other': OTHER, 'https://github.com:me': { token: STORED } } })), 'linux', T)).toBe(STORED);
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:me': STORED } })), 'darwin', T)).toBe(STORED);
  });

  it('accepts the older copilotTokens map, a host without scheme, a provider prefix, and a provider-grouped map', () => {
    expect(storedLoginToken(configDir(loggedIn({ copilotTokens: { 'https://github.com:me': STORED } })), 'linux', T)).toBe(STORED);
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'github.com:me': STORED } })), 'linux', T)).toBe(STORED);
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'github:https://github.com:me': STORED } })), 'linux', T)).toBe(STORED);
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { github: { 'https://github.com:me': { token: STORED } } } })), 'linux', T)).toBe(STORED);
  });

  it('reads JSONC (a comment line) like loginIdentity', () => {
    expect(storedLoginToken(configDir(`// managed\n${JSON.stringify(loggedIn({ authTokens: { 'https://github.com:me': STORED } }))}`), 'linux', T)).toBe(STORED);
  });

  it('never takes another user\'s, another host\'s, an expired, an Entra or an empty entry', () => {
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:other': OTHER } })), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:someme': OTHER } })), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://corp.ghe.com:me': OTHER } })), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://notgithub.com:me': OTHER } })), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED, expiresAt: '2026-11-20T00:00:00Z' } } })), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED, expiresAt: '2026-11-22T00:00:00Z' } } })), 'linux', T)).toBe(STORED);
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED, accountType: 'entra' } } })), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:me': { token: ' ' } } })), 'linux', T)).toBeUndefined();
  });

  it('a GHE login reads its own host\'s entry', () => {
    const ghe = { host: 'https://corp.ghe.com', login: 'me' };
    expect(storedLoginToken(configDir({ lastLoggedInUser: ghe, authTokens: { 'https://github.com:me': OTHER, 'https://corp.ghe.com:me': STORED } }), 'linux', T)).toBe(STORED);
  });

  it('nothing without lastLoggedInUser, without a config, from bad JSON, and never on Windows (Credential Manager)', () => {
    expect(storedLoginToken(configDir({ authTokens: { 'https://github.com:me': STORED } }), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(join(tmpdir(), 'omg-keyringless-missing-dir'), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir('{not json'), 'linux', T)).toBeUndefined();
    expect(storedLoginToken(configDir(loggedIn({ authTokens: { 'https://github.com:me': STORED } })), 'win32', T)).toBeUndefined();
  });
});

describe('credential precedence and redaction', () => {
  const stored = () => configDir(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED } } }));

  it('session token: COPILOT_GITHUB_TOKEN wins, else the stored login token; none on Windows or in a replay', () => {
    const dir = stored();
    expect(sessionGitHubToken({ COPILOT_GITHUB_TOKEN: ENV_TOKEN }, { userConfigDir: dir, platform: 'linux' })).toBe(ENV_TOKEN);
    expect(sessionGitHubToken({}, { userConfigDir: dir, platform: 'linux' })).toBe(STORED);
    expect(sessionGitHubToken({ GH_TOKEN: OTHER, GITHUB_TOKEN: OTHER }, { userConfigDir: dir, platform: 'linux' })).toBe(STORED);
    expect(sessionGitHubToken({}, { userConfigDir: dir, platform: 'win32' })).toBeUndefined();
    expect(sessionGitHubToken({ OMG_COPILOT_CASSETTE_MODE: 'replay' }, { userConfigDir: dir, platform: 'linux' })).toBeUndefined();
    expect(sessionGitHubToken({})).toBeUndefined();
  });

  it('SDK team worker: COPILOT_GITHUB_TOKEN, then the stored token, then GH_TOKEN/GITHUB_TOKEN only without a login', () => {
    expect(workerGitHubToken({ COPILOT_GITHUB_TOKEN: ENV_TOKEN }, true, STORED)).toBe(ENV_TOKEN);
    expect(workerGitHubToken({ GH_TOKEN: OTHER }, true, STORED)).toBe(STORED);
    expect(workerGitHubToken({ GH_TOKEN: OTHER }, true)).toBeUndefined();
    expect(workerGitHubToken({ GH_TOKEN: OTHER }, false)).toBe(OTHER);
  });

  it('the stored token joins the redaction set and is scrubbed from lane output', () => {
    const source = { userConfigDir: stored(), platform: 'linux' as const };
    const secrets = secretValues({ COPILOT_GITHUB_TOKEN: ENV_TOKEN }, source);
    expect(secrets).toEqual([ENV_TOKEN, STORED]);
    expect(scrubTokens(`cat said ${STORED} and ${ENV_TOKEN}`, secrets)).toBe('cat said [redacted] and [redacted]');
    expect(secretValues({}, { ...source, platform: 'win32' })).toEqual([]);
  });

  it('a "Not authenticated" message names the credentials tried, never their values', () => {
    const source = { userConfigDir: stored(), platform: 'linux' as const };
    expect(triedCredentialNames({ COPILOT_GITHUB_TOKEN: ENV_TOKEN }, source, true)).toEqual(['COPILOT_GITHUB_TOKEN', 'the stored login (plaintext token in the Copilot config.json)']);
    expect(triedCredentialNames({ GH_TOKEN: OTHER }, { ...source, platform: 'win32' }, false)).toEqual(['GH_TOKEN']);
    const hint = withCredentialHint('Request models.list failed with message: Not authenticated', { COPILOT_GITHUB_TOKEN: ENV_TOKEN }, source, true);
    expect(hint).toContain('credentials tried: COPILOT_GITHUB_TOKEN, the stored login (plaintext token in the Copilot config.json)');
    expect(hint).toContain('`copilot login`');
    expect(hint).not.toContain(ENV_TOKEN);
    expect(hint).not.toContain(STORED);
    expect(withCredentialHint('Not authenticated', {}, { ...source, platform: 'win32' }, false)).toContain('credentials tried: none found');
    expect(withCredentialHint('timed out', {}, source, true)).toBe('timed out');
  });
});

/** A fake SDK that records the client options, the runtime env, and the job home config.json at start(). */
function recordingSdk(listModels: () => Promise<unknown[]>) {
  const seen: { clientOpts: Array<Record<string, unknown>>; envs: NodeJS.ProcessEnv[]; homeConfigs: string[]; sessions: Array<Record<string, unknown>> } = { clientOpts: [], envs: [], homeConfigs: [], sessions: [] };
  class CopilotClient {
    cliProcess = null;
    constructor(private readonly opts: Record<string, unknown>) { seen.clientOpts.push(opts); }
    async start() {
      const home = (this.opts.runtime as { baseDirectory: string }).baseDirectory;
      seen.homeConfigs.push(existsSync(join(home, 'config.json')) ? readFileSync(join(home, 'config.json'), 'utf8') : '');
    }
    async stop() { return []; }
    listModels() { return listModels(); }
    async createSession(cfg: Record<string, unknown>) { seen.sessions.push(cfg); return { sessionId: 's', rpc: { model: { getCurrent: async () => ({ modelId: 'm' }) } }, disconnect: async () => {} }; }
    async deleteSession() {}
  }
  const RuntimeConnection = { forSpawnedStdio: (o: { env?: NodeJS.ProcessEnv }) => { seen.envs.push(o.env ?? {}); return o; } };
  return { seen, loadSdk: async () => ({ module: { CopilotClient, RuntimeConnection } as never, version: '2.0.3', from: 'test' as const }) };
}

function probeDeps(userConfig: string, loadSdk: () => Promise<never>, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omg-keyringless-probe-'));
  dirs.push(root);
  return {
    root,
    deps: {
      env: { PATH: process.env.PATH, ...env },
      platform: 'linux' as NodeJS.Platform,
      loadSdk,
      resolveBin: () => join(root, 'copilot'),
      userConfigDir: () => userConfig,
      killTree: () => {},
      tmpRoot: root,
    },
  };
}

describe('no-session probes pass the credential through the client option', () => {
  const stored = () => configDir(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED } } }));

  it('the model catalogue read: client github.token is the stored token; the runtime env and the job home never hold it', async () => {
    const sdk = recordingSdk(async () => [{ id: 'mai-code-2' }]);
    const { deps } = probeDeps(stored(), sdk.loadSdk as never);
    let cleanup: Promise<void> | undefined;
    expect(await fetchCopilotCatalogue({ deps, onCleanup: (d) => { cleanup = d; } })).toEqual({ models: ['mai-code-2'] });
    await cleanup;
    expect((sdk.seen.clientOpts[0].github as { token?: string } | undefined)?.token).toBe(STORED);
    expect(JSON.stringify(sdk.seen.envs[0])).not.toContain(STORED);
    // The env that carries the client credential: no git root search past the job root, no auto-approved tool.
    expect(sdk.seen.envs[0]).toMatchObject({ GIT_CEILING_DIRECTORIES: resolve(join(deps.tmpRoot, 'omg-model-catalogue')), COPILOT_ALLOW_ALL: 'false' });
    expect(sdk.seen.homeConfigs[0]).toContain('"lastLoggedInUser"');
    expect(sdk.seen.homeConfigs[0]).not.toContain(STORED);
    expect(sdk.seen.homeConfigs[0]).not.toContain('authTokens');
  });

  it('the model catalogue read: COPILOT_GITHUB_TOKEN from the env reaches the client option (the env allowlist drops it)', async () => {
    const sdk = recordingSdk(async () => [{ id: 'x' }]);
    const { deps } = probeDeps(configDir(loggedIn({})), sdk.loadSdk as never, { COPILOT_GITHUB_TOKEN: ENV_TOKEN });
    let cleanup: Promise<void> | undefined;
    await fetchCopilotCatalogue({ deps, onCleanup: (d) => { cleanup = d; } });
    await cleanup;
    expect((sdk.seen.clientOpts[0].github as { token?: string } | undefined)?.token).toBe(ENV_TOKEN);
    expect(JSON.stringify(sdk.seen.envs[0])).not.toContain(ENV_TOKEN);
  });

  it('the model catalogue read: no credential, no option (the runtime then uses the OS credential store)', async () => {
    const sdk = recordingSdk(async () => [{ id: 'x' }]);
    const { deps } = probeDeps(configDir(loggedIn({})), sdk.loadSdk as never);
    let cleanup: Promise<void> | undefined;
    await fetchCopilotCatalogue({ deps, onCleanup: (d) => { cleanup = d; } });
    await cleanup;
    expect(sdk.seen.clientOpts[0]).not.toHaveProperty('github');
  });

  it('the model catalogue read: "Not authenticated" names what was tried', async () => {
    const sdk = recordingSdk(async () => { throw new Error(`Request models.list failed with message: Not authenticated ${STORED}`); });
    const { deps } = probeDeps(stored(), sdk.loadSdk as never);
    let cleanup: Promise<void> | undefined;
    const result = await fetchCopilotCatalogue({ deps, onCleanup: (d) => { cleanup = d; } });
    await cleanup;
    const error = (result as { error: string }).error;
    expect(error).toContain('credentials tried: the stored login (plaintext token in the Copilot config.json)');
    expect(error).not.toContain(STORED);
  });

  it('the bench model probe: client github.token before listModels(), never in the env or the job home', async () => {
    const sdk = recordingSdk(async () => [{ id: 'mai-code-2', billing: { multiplier: 1 } }]);
    const { root, deps } = probeDeps(stored(), sdk.loadSdk as never);
    const info = await probeLaneModel(join(root, 'probe'), deps as never, 'mai-code-2');
    expect(info).toMatchObject({ model: 'mai-code-2', multiplier: 1, offered: ['mai-code-2'] });
    expect((sdk.seen.clientOpts[0].github as { token?: string } | undefined)?.token).toBe(STORED);
    expect(JSON.stringify(sdk.seen.envs[0])).not.toContain(STORED);
    expect(sdk.seen.envs[0]).toMatchObject({ GIT_CEILING_DIRECTORIES: resolve(join(root, 'probe')), COPILOT_ALLOW_ALL: 'false' });
    expect(sdk.seen.homeConfigs[0]).not.toContain(STORED);
  });

  it('the bench model probe: "Not authenticated" names the credentials tried', async () => {
    const sdk = recordingSdk(async () => { throw new Error('Request models.list failed with message: Not authenticated'); });
    const { root, deps } = probeDeps(configDir(loggedIn({})), sdk.loadSdk as never, { COPILOT_GITHUB_TOKEN: ENV_TOKEN });
    const info = await probeLaneModel(join(root, 'probe'), deps as never, 'mai-code-2');
    expect(info.detail).toContain('the probe failed: Request models.list failed with message: Not authenticated (credentials tried: COPILOT_GITHUB_TOKEN, the stored login (OS credential store); run `copilot login` or set COPILOT_GITHUB_TOKEN)');
    expect(info.detail).not.toContain(ENV_TOKEN);
  });
});

describe('a copilot_run lane on a keyring-less host', () => {
  it('gets the stored token over the session RPC only: not in the client option, the runtime env, or the job home', async () => {
    const { root, repo } = scratchRepo('omg-keyringless-lane-');
    dirs.push(root);
    writeFileSync(join(root, 'user-copilot', 'config.json'), JSON.stringify(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED } } })));
    const calls = newCalls();
    const homeConfigs: string[] = [];
    const clientOpts: Array<Record<string, unknown>> = [];
    const deps = fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1' });
    deps.loadSdk = async () => {
      const sdk = fakeSdk('idle', calls);
      const Base = sdk.module.CopilotClient as unknown as new (o: Record<string, unknown>) => object;
      class Recording extends (Base as new (o: Record<string, unknown>) => object) {
        constructor(o: Record<string, unknown>) {
          super(o);
          clientOpts.push(o);
          const home = (o.runtime as { baseDirectory: string }).baseDirectory;
          homeConfigs.push(readFileSync(join(home, 'config.json'), 'utf8'));
        }
      }
      return { ...sdk, module: { ...sdk.module, CopilotClient: Recording as never } };
    };
    const m = new CopilotRunManager(deps);
    const done = await m.wait(m.start({ prompt: 'x', cwd: repo }).jobId as string, 10_000);
    expect(done.status).toBe('completed');
    expect(calls.sessions[0].github?.token).toBe(STORED);
    expect(clientOpts[0]).not.toHaveProperty('github');
    expect(JSON.stringify(calls.connections[0].env)).not.toContain(STORED);
    expect(homeConfigs[0]).not.toContain(STORED);
    expect(homeConfigs[0]).not.toContain('authTokens');
    expect(JSON.stringify(done)).not.toContain(STORED);
  });

  it('a Windows host is unchanged: no session token from config.json', async () => {
    const { root, repo } = scratchRepo('omg-keyringless-win-');
    dirs.push(root);
    writeFileSync(join(root, 'user-copilot', 'config.json'), JSON.stringify(loggedIn({ authTokens: { 'https://github.com:me': { token: STORED } } })));
    mkdirSync(join(root, 'unused'), { recursive: true });
    const calls = newCalls();
    const deps = { ...fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1', SYSTEMROOT: 'C:\\Windows', LOCALAPPDATA: join(root, 'unused') }), platform: 'win32' as NodeJS.Platform };
    const m = new CopilotRunManager(deps);
    await m.wait(m.start({ prompt: 'x', cwd: repo }).jobId as string, 10_000);
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]).not.toHaveProperty('github');
  });
});

describe('the lane sandbox on a keyring-less host with COPILOT_HOME outside the real home', () => {
  let savedOmcHome: string | undefined;
  beforeEach(() => {
    // The deny list names the OMC global state root's forge dir and creates it: never the real one.
    savedOmcHome = process.env.OMC_HOME;
    const omcHome = mkdtempSync(join(tmpdir(), 'omg-keyringless-omc-'));
    dirs.push(omcHome);
    process.env.OMC_HOME = omcHome;
  });
  afterEach(() => {
    if (savedOmcHome === undefined) delete process.env.OMC_HOME;
    else process.env.OMC_HOME = savedOmcHome;
  });

  /** One write lane on a host that reports denied_paths; its sandbox config's deniedPaths. */
  async function laneDenied(over: (root: string) => Partial<CopilotRunDeps> = () => ({}), env: NodeJS.ProcessEnv = {}) {
    const { root, repo } = scratchRepo('omg-keyringless-deny-');
    dirs.push(root);
    const calls = newCalls();
    const deps: CopilotRunDeps = {
      ...fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1', ...env }),
      loadSdk: async () => fakeSdk('idle', calls, 'supported', true),
      realHome: () => join(root, 'home'),
      sandboxSettings: () => ({ settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] }, warnings: [] }),
      ...over(root),
    };
    const m = new CopilotRunManager(deps);
    const done = await m.wait(m.start({ prompt: 'x', cwd: repo }).jobId as string, 10_000);
    const sandbox = calls.sessions[0]?.permissions.sandbox as { userPolicy: { filesystem: { deniedPaths?: string[] } } } | undefined;
    return { root, done, denied: sandbox?.userPolicy.filesystem.deniedPaths };
  }

  it('linux: the whole config dir is denied', async () => {
    const { root, done, denied } = await laneDenied();
    expect(done.status).toBe('completed');
    expect(denied).toContain(join(root, 'user-copilot'));
  });

  it('linux: with a grant inside the config dir, only its config.json is denied', async () => {
    const { root, done, denied } = await laneDenied((r) => {
      writeFileSync(join(r, 'config.json'), JSON.stringify(loggedIn({})));
      return { userConfigDir: () => r };
    });
    expect(done.status).toBe('completed');
    expect(denied).toContain(join(root, 'config.json'));
    expect(denied).not.toContain(root);
  });

  it('win32: no config dir deny', async () => {
    const { root, denied } = await laneDenied((r) => {
      mkdirSync(join(r, 'localappdata'), { recursive: true });
      return { platform: 'win32' as NodeJS.Platform, env: { PATH: process.env.PATH ?? '', OMG_COPILOT_RUN_ALLOW: '1', SYSTEMROOT: 'C:\\Windows', LOCALAPPDATA: join(r, 'localappdata') } };
    });
    expect(denied).toBeDefined();
    expect(denied).not.toContain(join(root, 'user-copilot'));
    expect(denied).not.toContain(join(root, 'user-copilot', 'config.json'));
  });
});
