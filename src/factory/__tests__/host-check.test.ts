import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../../ship/exec.js';
import type { LoadedSdk } from '../../smoke/copilot-sdk-driver.js';
import { NODE_ENGINE_RANGE, newerCachedRuntimes, nodeSatisfiesEngines, runFactoryHostCheck, runHostCheck, type HostCheckDeps, type HostCheckItem } from '../host-check.js';

const TOKEN = 'ghu_' + 'A'.repeat(36);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function configDir(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'omg-host-check-'));
  dirs.push(dir);
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const login = { loggedInUsers: [{ host: 'https://github.com', login: 'octo' }], lastLoggedInUser: { host: 'https://github.com', login: 'octo' } };

function execFor(versions: Record<string, string>): Exec {
  return (cmd) => (versions[cmd] !== undefined ? { status: 0, stdout: versions[cmd], stderr: '' } : { status: 127, stdout: '', stderr: `${cmd}: not found` });
}

const sdk = { version: '1.0.16', from: 'global npm root', module: {} } as unknown as LoadedSdk;

function deps(over: Partial<HostCheckDeps> = {}): HostCheckDeps {
  return {
    platform: 'linux',
    arch: 'x64',
    env: {},
    nodeVersion: '22.23.5',
    homedir: '/home/u',
    userConfigDir: configDir({ ...login, authTokens: { 'https://github.com:octo': TOKEN } }),
    exec: execFor({ git: 'git version 2.50.1\n', bwrap: 'bubblewrap 0.10.0\n' }),
    bwrapTrial: () => null,
    resolveBin: () => '/usr/bin/copilot',
    copilotVersion: () => 'GitHub Copilot CLI 1.0.112.\n',
    loadSdk: async () => sdk,
    probeRuntime: async () => ({ started: true, mismatch: null }),
    listDir: () => { throw new Error('ENOENT'); },
    exists: () => false,
    ...over,
  };
}

const byId = (items: HostCheckItem[], id: string) => items.find((i) => i.id === id);

describe('factory host check', () => {
  it('reports every item ok on a ready Linux host and exits 0', async () => {
    const lines: string[] = [];
    const code = await runFactoryHostCheck({}, deps(), (l) => lines.push(l));
    expect(code).toBe(0);
    const items = await runHostCheck(deps());
    expect(items.map((i) => i.id)).toEqual(['node', 'git', 'sandbox', 'copilot', 'sdk', 'sdk.protocol', 'login', 'copilot.pkg-cache']);
    expect(items.every((i) => i.status === 'ok')).toBe(true);
    expect(byId(items, 'sandbox')!.detail).toContain('bubblewrap 0.10.0');
    expect(lines.at(-1)).toBe('host: ready for the factory');
  });

  it('pins NODE_ENGINE_RANGE to package.json engines and checks it', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    expect(NODE_ENGINE_RANGE).toBe(pkg.engines.node);
    expect(nodeSatisfiesEngines('22.13.0')).toBe(true);
    expect(nodeSatisfiesEngines('22.12.9')).toBe(false);
    expect(nodeSatisfiesEngines('23.3.0')).toBe(false);
    expect(nodeSatisfiesEngines('24.1.0')).toBe(true);
    expect(nodeSatisfiesEngines('20.18.0')).toBe(false);
    expect(byId(await runHostCheck(deps({ nodeVersion: '20.18.0' })), 'node')).toMatchObject({ status: 'fail', fix: expect.stringContaining('nvm install 22') });
  });

  it('fails an old git with the PPA fix and warns below the private layout minimum', async () => {
    const old = byId(await runHostCheck(deps({ exec: execFor({ git: 'git version 2.25.1\n', bwrap: 'bubblewrap 0.10.0' }) })), 'git')!;
    expect(old).toMatchObject({ status: 'fail', fix: expect.stringContaining('ppa:git-core/ppa') });
    expect(old.detail).toContain('2.25.1');
    expect(byId(await runHostCheck(deps({ exec: execFor({ git: 'git version 2.43.0\n', bwrap: 'bubblewrap 0.10.0' }) })), 'git')).toMatchObject({ status: 'warn', detail: expect.stringContaining('2.44') });
  });

  it('fails the Linux sandbox with the trial launch reason and a fix', async () => {
    const tooOld = 'bubblewrap 0.4.0 is too old for the Copilot sandbox: it needs bwrap >= 0.5.0 (--clearenv).';
    expect(byId(await runHostCheck(deps({ bwrapTrial: () => tooOld })), 'sandbox')).toMatchObject({ status: 'fail', detail: tooOld, fix: expect.stringContaining('from source') });
    const missing = 'bwrap (bubblewrap) is not on PATH, and the Linux sandbox runs every shell under it: install bubblewrap';
    expect(byId(await runHostCheck(deps({ bwrapTrial: () => missing })), 'sandbox')!.fix).toContain('apt-get install bubblewrap');
  });

  it('uses the runtime host probe off Linux', async () => {
    const seen: boolean[] = [];
    const win = deps({
      platform: 'win32',
      userConfigDir: configDir(login),
      probeRuntime: async (_l, _b, withHost) => { seen.push(withHost); return { started: true, mismatch: null, host: { supported: false, reason: 'no MXC', capabilities: {} } }; },
    });
    const items = await runHostCheck(win);
    expect(seen).toEqual([true]);
    expect(byId(items, 'sandbox')).toMatchObject({ status: 'fail', detail: expect.stringContaining('no MXC') });
    expect(byId(items, 'login')!.status).toBe('ok');
  });

  it('fails a missing copilot and SDK with the install commands and skips the protocol probe', async () => {
    let probed = false;
    const items = await runHostCheck(deps({ resolveBin: () => null, loadSdk: async () => null, probeRuntime: async () => { probed = true; return { started: true, mismatch: null }; } }));
    expect(byId(items, 'copilot')).toMatchObject({ status: 'fail', fix: 'npm i -g @github/copilot@1.0.112' });
    expect(byId(items, 'sdk')).toMatchObject({ status: 'fail', fix: expect.stringContaining('npm i -g @github/copilot-sdk') });
    expect(byId(items, 'sdk.protocol')!.status).toBe('warn');
    expect(probed).toBe(false);
  });

  it('reads the version as factory launches run it and warns past the protocol-3 CLI', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const items = await runHostCheck(deps({ copilotVersion: (_b, env) => { envs.push(env); return 'GitHub Copilot CLI 1.0.114.'; } }));
    expect(envs[0].COPILOT_AUTO_UPDATE).toBe('false');
    expect(byId(items, 'copilot')).toMatchObject({ status: 'warn', fix: 'npm i -g @github/copilot@1.0.112' });
  });

  it('fails a protocol mismatch and exits 1', async () => {
    const mismatch = 'Copilot SDK/CLI protocol mismatch: @github/copilot-sdk speaks protocol 3, the Copilot CLI speaks protocol 4.';
    const d = deps({ probeRuntime: async () => ({ started: false, mismatch }) });
    expect(byId(await runHostCheck(d), 'sdk.protocol')).toMatchObject({ status: 'fail', detail: mismatch });
    const lines: string[] = [];
    expect(await runFactoryHostCheck({}, d, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('fix: npm i -g @github/copilot@1.0.112');
    expect(lines.at(-1)).toContain('not ready');
  });

  it('judges the login by credential names only and never prints a token', async () => {
    const env = { COPILOT_GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN };
    for (const d of [deps(), deps({ env }), deps({ env, userConfigDir: configDir() })]) {
      const lines: string[] = [];
      await runFactoryHostCheck({ json: true }, d, (l) => lines.push(l));
      await runFactoryHostCheck({}, d, (l) => lines.push(l));
      expect(lines.join('\n')).not.toContain(TOKEN);
    }
    expect(byId(await runHostCheck(deps()), 'login')!.detail).toContain('config.json');
    expect(byId(await runHostCheck(deps({ userConfigDir: configDir(login) })), 'login')!.status).toBe('warn');
    expect(byId(await runHostCheck(deps({ userConfigDir: configDir(), env: { GH_TOKEN: TOKEN } })), 'login')!.status).toBe('warn');
    expect(byId(await runHostCheck(deps({ userConfigDir: configDir() })), 'login')).toMatchObject({ status: 'fail', fix: expect.stringContaining('copilot login') });
  });

  it('warns about a cached runtime newer than the protocol-3 CLI, with the move-aside remedy', async () => {
    const tree: Record<string, string[]> = { [join('/home/u', '.cache', 'copilot', 'pkg', 'linux-x64')]: ['1.0.112', '1.0.114', 'tmp'] };
    const fs = { listDir: (dir: string) => { if (tree[dir]) return tree[dir]; throw new Error('ENOENT'); }, exists: (p: string) => p.endsWith('index.js') };
    const newer = join('/home/u', '.cache', 'copilot', 'pkg', 'linux-x64', '1.0.114');
    expect(newerCachedRuntimes({ ...deps(), ...fs })).toEqual([newer]);
    const item = byId(await runHostCheck(deps(fs)), 'copilot.pkg-cache')!;
    expect(item.status).toBe('warn');
    expect(item.fix).toContain(`mv "${newer}" "${newer}.parked"`);
    expect(item.fix).toContain('COPILOT_AUTO_UPDATE=false');
    // COPILOT_PKG_CACHE_HOME is searched first.
    const relocated = { [join('/x', 'pkg', 'linux-x64')]: ['2.0.0'] };
    expect(newerCachedRuntimes({ ...deps(), env: { COPILOT_PKG_CACHE_HOME: '/x' }, listDir: (d) => { if (relocated[d]) return relocated[d]; throw new Error('ENOENT'); }, exists: () => true })).toEqual([join('/x', 'pkg', 'linux-x64', '2.0.0')]);
  });

  it('prints schemaVersion 1 JSON', async () => {
    const lines: string[] = [];
    expect(await runFactoryHostCheck({ json: true }, deps({ resolveBin: () => null }), (l) => lines.push(l))).toBe(1);
    const parsed = JSON.parse(lines.join('\n')) as { schemaVersion: number; ok: boolean; host: HostCheckItem[] };
    expect(parsed).toMatchObject({ schemaVersion: 1, ok: false });
    expect(parsed.host.find((i) => i.id === 'copilot')!.status).toBe('fail');
  });
});

describe('omg factory check --host', () => {
  it('runs the host check instead of the intake and sets the exit code', async () => {
    const { factoryCheckCommand } = await import('../../cli/commands/factory-check.js');
    const lines: string[] = [];
    const checkDeps = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } as unknown as Parameters<typeof factoryCheckCommand>[0];
    const before = process.exitCode;
    try {
      await factoryCheckCommand(checkDeps, () => deps({ loadSdk: async () => null })).parseAsync(['--host', '--json'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ schemaVersion: 1, ok: false });
    } finally {
      process.exitCode = before;
    }
  });
});
