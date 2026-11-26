import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_SETTINGS } from '../../copilot-run/sandbox.js';
import type { Exec } from '../../ship/exec.js';
import type { LoadedSdk } from '../../smoke/copilot-sdk-driver.js';
import { NODE_ENGINE_RANGE, SDK_MIGRATE_COMMAND, nodeSatisfiesEngines, runFactoryHostCheck, runHostCheck, type HostCheckDeps, type HostCheckItem } from '../host-check.js';
import { COPILOT_UPDATE_COMMAND } from '../../smoke/copilot-sdk-driver.js';
import { SDK_INSTALL_COMMAND } from '../../smoke/copilot-sdk-scenarios.js';

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

const sdk = { version: '2.0.3', from: 'global npm root', module: {} } as unknown as LoadedSdk;

function deps(over: Partial<HostCheckDeps> = {}): HostCheckDeps {
  return {
    platform: 'linux',
    env: {},
    nodeVersion: '22.23.5',
    userConfigDir: configDir({ ...login, authTokens: { 'https://github.com:octo': TOKEN } }),
    exec: execFor({ git: 'git version 2.50.1\n', bwrap: 'bubblewrap 0.10.0\n' }),
    bwrapTrial: () => null,
    sandboxSettings: () => ({ ...DEFAULT_SANDBOX_SETTINGS }),
    resolveBin: () => '/usr/bin/copilot',
    copilotVersion: () => 'GitHub Copilot CLI 1.0.116.\n',
    loadSdk: async () => sdk,
    legacySdkVersion: () => null,
    probeRuntime: async () => ({ started: true, mismatch: null, status: { version: '1.0.116', protocolVersion: 4 } }),
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
    expect(items.map((i) => i.id)).toEqual(['node', 'git', 'sandbox', 'copilot', 'sdk', 'sdk.protocol', 'login']);
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
    // 2.38 to 2.40 run merge-tree --write-tree but ignore GIT_ATTR_SOURCE: a fail, not a warn.
    expect(byId(await runHostCheck(deps({ exec: execFor({ git: 'git version 2.40.1\n', bwrap: 'bubblewrap 0.10.0' }) })), 'git')).toMatchObject({ status: 'fail', detail: expect.stringContaining('>= 2.41') });
    expect(byId(await runHostCheck(deps({ exec: execFor({ git: 'git version 2.41.0\n', bwrap: 'bubblewrap 0.10.0' }) })), 'git')).toMatchObject({ status: 'warn' });
    expect(byId(await runHostCheck(deps({ exec: execFor({ git: 'git version 2.43.0\n', bwrap: 'bubblewrap 0.10.0' }) })), 'git')).toMatchObject({ status: 'warn', detail: expect.stringContaining('2.44') });
  });

  it('fails the Linux sandbox with the trial launch reason and a fix', async () => {
    const tooOld = 'bubblewrap 0.4.0 is too old for the Copilot sandbox: it needs bwrap >= 0.5.0 (--clearenv).';
    expect(byId(await runHostCheck(deps({ bwrapTrial: () => tooOld })), 'sandbox')).toMatchObject({ status: 'fail', detail: tooOld, fix: expect.stringContaining('from source') });
    const missing = 'bwrap (bubblewrap) is not on PATH, and the Linux sandbox runs every shell under it: install bubblewrap';
    expect(byId(await runHostCheck(deps({ bwrapTrial: () => missing })), 'sandbox')!.fix).toContain('apt-get install bubblewrap');
  });

  it.each([
    ['sandbox disabled', { sandboxSettings: () => ({ ...DEFAULT_SANDBOX_SETTINGS, enabled: false }) }],
    ['writeUnsandboxed detect-only', { sandboxSettings: () => ({ ...DEFAULT_SANDBOX_SETTINGS, writeUnsandboxed: 'detect-only' as const }) }],
    ['OMG_SANDBOX=off', { env: { OMG_SANDBOX: 'off' } }],
  ])('downgrades a failing sandbox to warn when %s', async (_name, over) => {
    const problem = 'bubblewrap 0.4.0 is too old for the Copilot sandbox: it needs bwrap >= 0.5.0 (--clearenv).';
    const items = await runHostCheck(deps({ bwrapTrial: () => problem, ...over }));
    expect(byId(items, 'sandbox')).toMatchObject({ status: 'warn', detail: expect.stringContaining('lanes run unsandboxed') });
    const lines: string[] = [];
    expect(await runFactoryHostCheck({}, deps({ bwrapTrial: () => problem, ...over }), (l) => lines.push(l))).toBe(0);
  });

  it('reports ok on macOS with the token in the keychain', async () => {
    const mac = deps({ platform: 'darwin', userConfigDir: configDir(login), probeRuntime: async () => ({ started: true, mismatch: null, host: { supported: true, capabilities: {} } }) });
    expect(byId(await runHostCheck(mac), 'login')).toMatchObject({ status: 'ok', detail: expect.stringContaining('keychain') });
  });

  it('scrubs a token-shaped string from probe and sandbox messages in text and JSON', async () => {
    const leak = 'ghp_' + 'B'.repeat(36);
    const d = deps({ bwrapTrial: () => `bwrap failed: ${leak}`, probeRuntime: async () => ({ started: false, mismatch: `protocol mismatch ${leak}` }) });
    const text: string[] = [];
    await runFactoryHostCheck({}, d, (l) => text.push(l));
    const json: string[] = [];
    await runFactoryHostCheck({ json: true }, d, (l) => json.push(l));
    expect(text.join('\n')).not.toContain(leak);
    expect(json.join('\n')).not.toContain(leak);
    expect(text.join('\n')).toContain('protocol mismatch');
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
    expect(byId(items, 'copilot')).toMatchObject({ status: 'fail', fix: COPILOT_UPDATE_COMMAND });
    expect(byId(items, 'sdk')).toMatchObject({ status: 'fail', detail: expect.stringContaining('@microsoft/copilot-sdk is not installed'), fix: SDK_INSTALL_COMMAND });
    expect(byId(items, 'sdk.protocol')!.status).toBe('warn');
    expect(probed).toBe(false);
  });

  it('reads the version as factory launches run it: a protocol-3 CLI fails, 1.0.113..1.0.115 warn, 1.0.116 is ok', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const at = async (v: string) => byId(await runHostCheck(deps({ copilotVersion: (_b, env) => { envs.push(env); return `GitHub Copilot CLI ${v}.`; } })), 'copilot')!;
    const old = await at('1.0.112');
    expect(envs[0].COPILOT_AUTO_UPDATE).toBe('false');
    expect(old).toMatchObject({ status: 'fail', detail: expect.stringContaining('protocol 3'), fix: expect.stringContaining(COPILOT_UPDATE_COMMAND) });
    expect(old.fix).toContain('copilot update');
    expect(await at('1.0.114')).toMatchObject({ status: 'warn', detail: expect.stringContaining('1.0.116'), fix: expect.stringContaining(COPILOT_UPDATE_COMMAND) });
    expect(await at('1.0.116')).toMatchObject({ status: 'ok', detail: expect.stringContaining('copilot 1.0.116') });
    expect(await at('1.0.120')).toMatchObject({ status: 'ok' });
  });

  it('fails with the migrate command when only SDK v1 is installed, and notes a leftover v1 next to v2', async () => {
    const only = byId(await runHostCheck(deps({ loadSdk: async () => null, legacySdkVersion: () => '1.0.34' })), 'sdk')!;
    expect(only).toMatchObject({ status: 'fail', fix: SDK_MIGRATE_COMMAND });
    expect(only.detail).toContain('@github/copilot-sdk 1.0.34');
    expect(only.detail).toContain('@microsoft/copilot-sdk');
    expect(SDK_MIGRATE_COMMAND).toBe(`npm uninstall -g @github/copilot-sdk && ${SDK_INSTALL_COMMAND}`);
    const both = byId(await runHostCheck(deps({ legacySdkVersion: () => '1.0.34' })), 'sdk')!;
    expect(both.status).toBe('ok');
    expect(both.detail).toContain('npm uninstall -g @github/copilot-sdk');
    const old = byId(await runHostCheck(deps({ loadSdk: async () => ({ ...sdk, version: '2.0.2' }) as LoadedSdk })), 'sdk')!;
    expect(old).toMatchObject({ status: 'fail', detail: expect.stringContaining('outside ^2.0.3'), fix: SDK_INSTALL_COMMAND });
  });

  it('reports the runtime version and protocol of the handshake', async () => {
    expect(byId(await runHostCheck(deps()), 'sdk.protocol')).toMatchObject({ status: 'ok', detail: expect.stringContaining('runtime 1.0.116, protocol 4') });
    expect(byId(await runHostCheck(deps({ probeRuntime: async () => ({ started: true, mismatch: null }) })), 'sdk.protocol')!.detail).toContain('runtime status unread');
  });

  it('fails a protocol mismatch with the fix for the side that is behind and exits 1', async () => {
    const oldCli = 'Copilot SDK/CLI protocol mismatch: @microsoft/copilot-sdk speaks protocol 4, the Copilot CLI speaks protocol 3. The Copilot CLI is too old for SDK v2: update it to >= 1.0.116.';
    const d = deps({ probeRuntime: async () => ({ started: false, mismatch: oldCli }) });
    expect(byId(await runHostCheck(d), 'sdk.protocol')).toMatchObject({ status: 'fail', detail: oldCli, fix: COPILOT_UPDATE_COMMAND });
    const lines: string[] = [];
    expect(await runFactoryHostCheck({}, d, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain(`fix: ${COPILOT_UPDATE_COMMAND}`);
    expect(lines.at(-1)).toContain('not ready');
    const newCli = 'Copilot SDK/CLI protocol mismatch: @microsoft/copilot-sdk speaks protocol 4, the Copilot CLI speaks protocol 5. Update @microsoft/copilot-sdk when a version supporting protocol 5 is available.';
    expect(byId(await runHostCheck(deps({ probeRuntime: async () => ({ started: false, mismatch: newCli }) })), 'sdk.protocol')).toMatchObject({ status: 'fail', fix: SDK_INSTALL_COMMAND });
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

  it('prints schemaVersion 1 JSON', async () => {
    const lines: string[] = [];
    expect(await runFactoryHostCheck({ json: true }, deps({ resolveBin: () => null }), (l) => lines.push(l))).toBe(1);
    const parsed = JSON.parse(lines.join('\n')) as { schemaVersion: number; ok: boolean; host: HostCheckItem[] };
    expect(parsed).toMatchObject({ schemaVersion: 1, kind: 'host', ok: false });
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

  it('rejects --host combined with intake options', async () => {
    const { factoryCheckCommand } = await import('../../cli/commands/factory-check.js');
    const lines: string[] = [];
    const checkDeps = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } as unknown as Parameters<typeof factoryCheckCommand>[0];
    const before = process.exitCode;
    try {
      await factoryCheckCommand(checkDeps, () => deps()).parseAsync(['--host', '--mark', '--yes', '--source', 'label:x', '12'], { from: 'user' });
      expect(process.exitCode).toBe(2);
      expect(lines.join('\n')).toContain('item ids');
      expect(lines.join('\n')).not.toContain('host: ready');
    } finally {
      process.exitCode = before;
    }
  });
});
