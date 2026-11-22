/**
 * `omg factory check --host`: the host prerequisites of the factory in one
 * free pass (no model request, no session): node, git, the OS sandbox, the
 * Copilot CLI and SDK and their protocol, the login, and a newer Copilot
 * runtime in the package cache. Each item is ok / warn / fail with the
 * command that fixes it; any fail exits non-zero. Token values never appear:
 * the login item names credentials only, and every line is scrubbed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultExec, type Exec } from '../ship/exec.js';
import { FACTORY_GIT_MIN_VERSION, factoryGitProblem, gitVersionAtLeast, parseGitVersion } from './git-preflight.js';
import { PRIVATE_GIT_MIN_VERSION } from './run/private-store.js';
import { cachedBwrapTrialLaunchError, linuxSandboxProblem, parseBwrapVersion, probeHostSupport, scrubTokens, secretValues, type SandboxHostRecord } from '../copilot-run/sandbox.js';
import { compareCopilotVersions, parseCopilotVersion, resolveCopilotBinary } from '../smoke/copilot-binary.js';
import { LAST_PROTOCOL3_CLI, PROBE_TIMEOUT_REASON, SDK_MIN_VERSION, loadCopilotSdk, probeSdkProtocol, satisfiesSdkRange, type LoadedSdk } from '../smoke/copilot-sdk-driver.js';
import { SDK_INSTALL_COMMAND } from '../smoke/copilot-sdk-scenarios.js';
import { SMOKE_SET_ENV, loginIdentity, storedLoginToken } from '../smoke/copilot-session-env.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';
import { buildHostBinarySpawn } from '../cli/tmux-utils.js';

export type HostCheckStatus = 'ok' | 'warn' | 'fail';

export interface HostCheckItem {
  id: string;
  status: HostCheckStatus;
  detail: string;
  /** The command (or step) that fixes a warn or fail. */
  fix?: string;
}

/** package.json `engines.node` (a test pins the two equal). */
export const NODE_ENGINE_RANGE = '^22.13.0 || ^23.4.0 || 24.x || 25.x || 26.x';

/** Whether `version` ("22.23.5") satisfies {@link NODE_ENGINE_RANGE}. */
export function nodeSatisfiesEngines(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major >= 24 && major <= 26;
}

/** The pin the factory's SDK speaks to: the last protocol-3 CLI. */
export const COPILOT_INSTALL_COMMAND = `npm i -g @github/copilot@${LAST_PROTOCOL3_CLI}`;

export interface HostCheckDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  homedir: string;
  userConfigDir: string;
  exec: Exec;
  /** Linux: why a trial bwrap launch fails, or null. */
  bwrapTrial: () => string | null;
  resolveBin: () => string | null;
  /** `copilot --version` output of `bin` under `env`. */
  copilotVersion: (bin: string, env: NodeJS.ProcessEnv) => string;
  loadSdk: () => Promise<LoadedSdk | null>;
  /**
   * The no-session runtime start: the protocol mismatch text, or null; with
   * `host`, the sandbox.getHostSupport record when the start succeeded.
   */
  probeRuntime: (loaded: LoadedSdk, bin: string, withHost: boolean) => Promise<{ started: boolean; mismatch: string | null; host?: SandboxHostRecord }>;
  listDir: (dir: string) => string[];
  exists: (path: string) => boolean;
}

export function defaultHostCheckDeps(env: NodeJS.ProcessEnv = process.env): HostCheckDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env,
    nodeVersion: process.versions.node,
    homedir: homedir(),
    userConfigDir: getCopilotConfigDir(),
    exec: defaultExec,
    bwrapTrial: cachedBwrapTrialLaunchError,
    resolveBin: () => resolveCopilotBinary(undefined, env).bin,
    copilotVersion: (bin, childEnv) => {
      const plan = buildHostBinarySpawn(bin, ['--version']);
      const r = spawnSync(plan.command, plan.args, { env: childEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments });
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    },
    loadSdk: () => loadCopilotSdk(env),
    probeRuntime: async (loaded, bin, withHost) => {
      let started = false;
      let host: SandboxHostRecord | undefined;
      const mismatch = await probeSdkProtocol(loaded, bin, {
        env,
        onStarted: async (client) => {
          started = true;
          if (withHost) host = await probeHostSupport(client, 15_000, { platform: process.platform });
        },
      });
      return { started, mismatch, ...(host ? { host } : {}) };
    },
    listDir: (dir) => readdirSync(dir),
    exists: existsSync,
  };
}

function checkNode(d: HostCheckDeps): HostCheckItem {
  const v = d.nodeVersion.replace(/^v/, '');
  if (nodeSatisfiesEngines(v)) return { id: 'node', status: 'ok', detail: `node ${v} (engines ${NODE_ENGINE_RANGE})` };
  return {
    id: 'node',
    status: 'fail',
    detail: `node ${v} does not satisfy engines ${NODE_ENGINE_RANGE}`,
    fix: d.platform === 'win32' ? 'winget install OpenJS.NodeJS.LTS' : 'install Node 22 LTS or newer (e.g. nvm install 22, or the NodeSource node_22.x apt repository)',
  };
}

function checkGit(d: HostCheckDeps): HostCheckItem {
  const problem = factoryGitProblem(d.exec, d.platform);
  const fix = d.platform === 'linux' ? 'sudo add-apt-repository ppa:git-core/ppa && sudo apt-get update && sudo apt-get install git' : 'install a current git (https://git-scm.com/downloads)';
  if (problem) return { id: 'git', status: 'fail', detail: problem, fix };
  const v = parseGitVersion(d.exec('git', ['--version'], {}).stdout) ?? [0, 0];
  const want = `${PRIVATE_GIT_MIN_VERSION[0]}.${PRIVATE_GIT_MIN_VERSION[1]}`;
  if (!gitVersionAtLeast(v, PRIVATE_GIT_MIN_VERSION)) {
    return { id: 'git', status: 'warn', detail: `git ${v[0]}.${v[1]} runs the factory (>= ${FACTORY_GIT_MIN_VERSION.join('.')}), but the private layout needs git >= ${want} (GIT_NO_LAZY_FETCH)`, fix };
  }
  return { id: 'git', status: 'ok', detail: `git ${v[0]}.${v[1]} (factory >= ${FACTORY_GIT_MIN_VERSION.join('.')}, private layout >= ${want})` };
}

function checkLinuxSandbox(d: HostCheckDeps): HostCheckItem {
  const problem = linuxSandboxProblem(d.platform, d.bwrapTrial);
  if (problem) {
    const fix = /not on PATH/.test(problem)
      ? 'sudo apt-get install bubblewrap (Ubuntu 20.04 ships 0.4.0: build >= 0.5.0 from source, see "Linux setup" in docs/REFERENCE.md)'
      : /too old/.test(problem)
        ? 'build bubblewrap >= 0.5.0 from source or move to Ubuntu 22.04+ (see "Linux setup" in docs/REFERENCE.md)'
        : 'see "Linux: restricted user namespaces" in docs/REFERENCE.md';
    return { id: 'sandbox', status: 'fail', detail: problem, fix };
  }
  const r = d.exec('bwrap', ['--version'], {});
  const v = r.status === 0 ? parseBwrapVersion(r.stdout) : null;
  return { id: 'sandbox', status: 'ok', detail: `bubblewrap ${v?.text ?? '(version unread)'}: a trial launch succeeded` };
}

/** A version dir name ("1.0.114") with an index.js, newer than {@link LAST_PROTOCOL3_CLI}, under each package cache the CLI searches. */
export function newerCachedRuntimes(d: Pick<HostCheckDeps, 'platform' | 'arch' | 'env' | 'homedir' | 'listDir' | 'exists'>): string[] {
  const { env, platform, homedir: home } = d;
  const xdg = env.XDG_CACHE_HOME || join(home, '.cache');
  const platformCache = platform === 'darwin' ? join(home, 'Library', 'Caches', 'copilot')
    : platform === 'win32' ? join(env.LOCALAPPDATA || join(home, '.cache'), 'copilot')
      : join(xdg, 'copilot');
  // The candidate order of the CLI's own package-cache search (1.0.112).
  const roots = [
    env.COPILOT_PKG_CACHE_HOME && join(env.COPILOT_PKG_CACHE_HOME, 'pkg'),
    env.COPILOT_CACHE_HOME && join(env.COPILOT_CACHE_HOME, 'pkg'),
    join(platformCache, 'pkg'),
    join(xdg, 'copilot', 'pkg'),
    env.COPILOT_HOME && join(env.COPILOT_HOME, 'pkg'),
    join(home, '.copilot', 'pkg'),
  ].filter((p): p is string => Boolean(p));
  const out: string[] = [];
  for (const root of [...new Set(roots)]) {
    for (const sub of ['universal', `${platform}-${d.arch}`]) {
      const dir = join(root, sub);
      let names: string[];
      try { names = d.listDir(dir); } catch { continue; }
      for (const name of names) {
        if (!/^\d+\.\d+\.\d+$/.test(name) || compareCopilotVersions(name, LAST_PROTOCOL3_CLI) <= 0) continue;
        if (d.exists(join(dir, name, 'index.js'))) out.push(join(dir, name));
      }
    }
  }
  return out;
}

function checkPkgCache(d: HostCheckDeps): HostCheckItem {
  const found = newerCachedRuntimes(d);
  if (found.length === 0) return { id: 'copilot.pkg-cache', status: 'ok', detail: `no cached Copilot runtime newer than ${LAST_PROTOCOL3_CLI}` };
  const move = found.map((p) => `mv "${p}" "${p}.parked"`).join(' && ');
  return {
    id: 'copilot.pkg-cache',
    status: 'warn',
    detail: `the Copilot package cache holds a runtime newer than ${LAST_PROTOCOL3_CLI} (${found.join(', ')}): copilot launched with auto-update on prefers it, and it speaks SDK protocol 4. `
      + 'Factory launches set COPILOT_AUTO_UPDATE=false and a job-private cache, so lanes keep the installed runtime; an interactive `copilot` (which self-updates into this cache) and anything launched without that flag do not',
    fix: `${move}; then run copilot with COPILOT_AUTO_UPDATE=false (or --no-auto-update) so it does not download again`,
  };
}

function checkLogin(d: HostCheckDeps): HostCheckItem {
  const has = (n: string) => Object.keys(d.env).some((k) => k.toUpperCase() === n && (d.env[k] ?? '').trim() !== '');
  const identity = loginIdentity(d.userConfigDir).loggedInUsers !== undefined;
  const envToken = has('COPILOT_GITHUB_TOKEN');
  if (d.platform === 'win32') {
    if (identity) return { id: 'login', status: 'ok', detail: 'stored login identity present (token in Windows Credential Manager)' };
    if (envToken) return { id: 'login', status: 'ok', detail: 'no stored login; COPILOT_GITHUB_TOKEN is set' };
    return { id: 'login', status: 'fail', detail: 'no stored Copilot login and no COPILOT_GITHUB_TOKEN', fix: 'copilot login' };
  }
  const plaintext = identity && storedLoginToken(d.userConfigDir, d.platform) !== undefined;
  if (envToken) return { id: 'login', status: 'ok', detail: `COPILOT_GITHUB_TOKEN is set${identity ? '; stored login identity present' : ''}` };
  if (plaintext) return { id: 'login', status: 'ok', detail: 'stored login identity present; its token is in the Copilot config.json (keyring-less host), which lanes pass over the session RPC' };
  if (identity) {
    return {
      id: 'login',
      status: 'warn',
      detail: 'stored login identity present, but no token in the Copilot config.json and no COPILOT_GITHUB_TOKEN: fine when an OS keyring (Secret Service / keychain) holds it; on a keyring-less host lanes have no credential',
      fix: 'on a keyring-less host: copilot login (it stores the token in config.json), or export COPILOT_GITHUB_TOKEN',
    };
  }
  const generic = ['GH_TOKEN', 'GITHUB_TOKEN'].filter(has);
  if (generic.length) {
    return { id: 'login', status: 'warn', detail: `no stored Copilot login; only ${generic.join(', ')} is set, which may not be entitled to Copilot models`, fix: 'copilot login, or export COPILOT_GITHUB_TOKEN' };
  }
  return { id: 'login', status: 'fail', detail: 'no stored Copilot login and no COPILOT_GITHUB_TOKEN', fix: 'copilot login, or export COPILOT_GITHUB_TOKEN' };
}

/** Every host item, in order. */
export async function runHostCheck(d: HostCheckDeps): Promise<HostCheckItem[]> {
  const items: HostCheckItem[] = [checkNode(d), checkGit(d)];
  if (d.platform === 'linux') items.push(checkLinuxSandbox(d));

  // Copilot CLI, as factory launches run it (COPILOT_AUTO_UPDATE=false: the installed runtime, never a cached newer one).
  const bin = d.resolveBin();
  if (!bin) {
    items.push({ id: 'copilot', status: 'fail', detail: 'copilot not found (PATH, COPILOT_CLI_PATH, WinGet)', fix: COPILOT_INSTALL_COMMAND });
  } else {
    const version = parseCopilotVersion(d.copilotVersion(bin, { ...d.env, ...SMOKE_SET_ENV }));
    if (!version) items.push({ id: 'copilot', status: 'warn', detail: `${bin}: --version gave no version` });
    else if (compareCopilotVersions(version, LAST_PROTOCOL3_CLI) > 0) {
      items.push({ id: 'copilot', status: 'warn', detail: `copilot ${version} (${bin}) is newer than ${LAST_PROTOCOL3_CLI}, the last CLI speaking SDK protocol 3`, fix: COPILOT_INSTALL_COMMAND });
    } else items.push({ id: 'copilot', status: 'ok', detail: `copilot ${version} (${bin})` });
  }

  const loaded = await d.loadSdk().catch(() => null);
  if (!loaded) items.push({ id: 'sdk', status: 'fail', detail: '@github/copilot-sdk is not installed (global npm root)', fix: SDK_INSTALL_COMMAND });
  else if (!satisfiesSdkRange(loaded.version)) {
    items.push({ id: 'sdk', status: 'fail', detail: `@github/copilot-sdk ${loaded.version ?? 'unknown'} is outside ^${SDK_MIN_VERSION}`, fix: SDK_INSTALL_COMMAND });
  } else items.push({ id: 'sdk', status: 'ok', detail: `@github/copilot-sdk ${loaded.version} (${loaded.from})` });

  const withHost = d.platform !== 'linux';
  if (!bin || !loaded) {
    items.push({ id: 'sdk.protocol', status: 'warn', detail: 'not checked: needs both the Copilot CLI and the SDK' });
    if (withHost) items.push({ id: 'sandbox', status: 'warn', detail: 'not checked: the host sandbox probe needs both the Copilot CLI and the SDK' });
  } else {
    const r = await d.probeRuntime(loaded, bin, withHost);
    if (r.mismatch?.startsWith(PROBE_TIMEOUT_REASON)) items.push({ id: 'sdk.protocol', status: 'warn', detail: r.mismatch });
    else if (r.mismatch) items.push({ id: 'sdk.protocol', status: 'fail', detail: r.mismatch, fix: COPILOT_INSTALL_COMMAND });
    else if (!r.started) items.push({ id: 'sdk.protocol', status: 'warn', detail: 'the no-session runtime start failed for a reason other than the protocol; a real launch reports it' });
    else items.push({ id: 'sdk.protocol', status: 'ok', detail: 'the SDK and the CLI completed the protocol handshake (no session, no request)' });
    if (withHost) {
      if (!r.host) items.push({ id: 'sandbox', status: 'warn', detail: 'not checked: the runtime did not start' });
      else if (r.host.supported) items.push({ id: 'sandbox', status: 'ok', detail: `the Copilot runtime reports the OS sandbox supported (${Object.entries(r.host.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no capabilities listed'})` });
      else items.push({ id: 'sandbox', status: 'fail', detail: `the Copilot runtime reports no usable OS sandbox: ${r.host.reason ?? 'unsupported'}`, fix: 'see "Sandboxed lanes" in docs/REFERENCE.md' });
    }
  }

  items.push(checkLogin(d), checkPkgCache(d));
  const secrets = secretValues(d.env, { userConfigDir: d.userConfigDir, platform: d.platform });
  return items.map((i) => ({ ...i, detail: scrubTokens(i.detail, secrets), ...(i.fix ? { fix: scrubTokens(i.fix, secrets) } : {}) }));
}

/** Prints the items (text or JSON); 0 when none failed, else 1. */
export async function runFactoryHostCheck(opts: { json?: boolean }, d: HostCheckDeps, out: (line: string) => void): Promise<number> {
  const items = await runHostCheck(d);
  const ok = !items.some((i) => i.status === 'fail');
  if (opts.json) out(JSON.stringify({ schemaVersion: 1, ok, host: items }, null, 2));
  else {
    for (const i of items) {
      out(`${i.status.padEnd(4)}  ${i.id.padEnd(18)} ${i.detail}`);
      if (i.fix && i.status !== 'ok') out(`      ${''.padEnd(18)} fix: ${i.fix}`);
    }
    out(ok ? 'host: ready for the factory' : 'host: not ready (fix the fail items above)');
  }
  return ok ? 0 : 1;
}
