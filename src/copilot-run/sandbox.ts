/**
 * OS sandbox plumbing for copilot_run sessions
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §3-§6).
 *
 * The Copilot runtime confines shell commands and local MCP/LSP servers in
 * Microsoft Execution Containers when a session carries a `sandboxConfig`.
 * SDK 1.0.16 has no createSession field for it, so the config goes through
 * `session.rpc.options.update` before the first turn; an SDK whose
 * createSession forwards the field gets it at create
 * (sdkCreateSessionAcceptsSandbox).
 *
 * Fail closed (§3): a review session without a confirmed sandbox runs with no
 * shell tool, a write session refuses with `sandbox-unavailable` unless
 * `writeUnsandboxed: "detect-only"` is set, and a shell call the runtime
 * reports as not sandboxed stops the session with `sandbox-escaped`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';

import { userConfigLayers } from '../ship/config.js';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import { SMOKE_SET_ENV } from '../smoke/copilot-session-env.js';
import { isUnderRoot } from '../team/sdk-policy.js';
import { parseJsonc } from '../utils/jsonc.js';

export type SandboxMode = 'enforced' | 'read-only-no-shell' | 'detect-only' | 'refused';
export type SandboxProfile = 'write' | 'review';

export interface SandboxHostRecord {
  supported: boolean;
  reason?: string;
  capabilities: Record<string, boolean>;
  /** The runtime reported support but the trial launch failed (Linux); `reason` says why. */
  launchFailed?: true;
}

/** `CopilotRunSnapshot.sandbox` (§5). */
export interface CopilotRunSandboxState {
  mode: SandboxMode;
  host: SandboxHostRecord;
  applied: 'create' | 'options.update' | 'none';
  enforcement?: { required: boolean; blocked: boolean; reason?: string };
  /** PR 1 runs no canary: confirmation rests on host support, the applied config, enforcement and the per-call attestation. */
  canary: 'passed' | 'failed' | 'skipped';
  /** Shell calls the runtime reported as not sandboxed. */
  unsandboxedCalls: number;
  cliVersion: string;
  sdkVersion: string;
  /** Why the mode is not `enforced`. */
  reason?: string;
}

/** Shell tools whose `tool.execution_complete` must carry `sandboxed: true` in an enforced session. */
export const SANDBOX_SHELL_TOOLS: ReadonlySet<string> = new Set(['powershell', 'bash', 'shell']);

/** The built-in tools a review session keeps: view, search, and the turn bookkeeping tools. */
export const REVIEW_READ_TOOLS: readonly string[] = ['view', 'grep', 'glob', 'rg', 'report_intent', 'task_complete', 'update_todo', 'think'];
/** The shell tools a review session adds when its sandbox is confirmed (no write_* input to a running shell). */
export const REVIEW_SHELL_TOOLS: readonly string[] = ['powershell', 'bash', 'read_powershell', 'read_bash', 'stop_powershell', 'stop_bash'];

// ---------------------------------------------------------------------------
// Config (§6): `copilotRun.sandbox`, overridden for lanes by `factory.run.sandbox`
// ---------------------------------------------------------------------------

export interface SandboxSettings {
  /** false = detect-only for every session (recorded, with a warning). */
  enabled: boolean;
  reviewUnsandboxed: 'no-shell' | 'refuse';
  writeUnsandboxed: 'refuse' | 'detect-only';
  writeNetwork: 'none' | 'registry';
  allowedHosts: string[];
  extraReadonlyPaths: string[];
  extraReadwritePaths: string[];
}

export const DEFAULT_SANDBOX_SETTINGS: Readonly<SandboxSettings> = Object.freeze({
  enabled: true,
  reviewUnsandboxed: 'no-shell',
  writeUnsandboxed: 'refuse',
  writeNetwork: 'none',
  allowedHosts: [],
  extraReadonlyPaths: [],
  extraReadwritePaths: [],
});

/** The env kill switch (§6): honoured from the MCP server's / engine's env only, never from repo config. */
export const SANDBOX_KILL_ENV = 'OMG_SANDBOX';

export type SandboxScope = 'copilot-run' | 'factory';

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The `sandbox` block of one config file for `scope` (factory: `copilotRun.sandbox` then `factory.run.sandbox`). */
function sandboxBlock(config: unknown, scope: SandboxScope, source: string): Record<string, unknown> {
  const pick = (value: unknown, name: string): Record<string, unknown> => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: ${name} must be an object`);
    return value as Record<string, unknown>;
  };
  const c = (config ?? {}) as { copilotRun?: { sandbox?: unknown }; factory?: { run?: { sandbox?: unknown } } };
  const base = pick(c.copilotRun?.sandbox, 'copilotRun.sandbox');
  return scope === 'factory' ? { ...base, ...pick(c.factory?.run?.sandbox, 'factory.run.sandbox') } : base;
}

/** Merge a block over the defaults; ill-typed fields are rejected, not ignored. */
export function resolveSandboxSettings(raw: Record<string, unknown>, source = 'sandbox'): SandboxSettings {
  const out: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] };
  const bad = (key: string, want: string): never => { throw new Error(`${source}.${key} must be ${want}`); };
  const oneOf = <T extends string>(key: string, values: readonly T[]): T =>
    (values as readonly unknown[]).includes(raw[key]) ? raw[key] as T : bad(key, values.map((v) => JSON.stringify(v)).join(' or '));
  if (raw.enabled !== undefined) out.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : bad('enabled', 'a boolean');
  if (raw.reviewUnsandboxed !== undefined) out.reviewUnsandboxed = oneOf('reviewUnsandboxed', ['no-shell', 'refuse'] as const);
  if (raw.writeUnsandboxed !== undefined) out.writeUnsandboxed = oneOf('writeUnsandboxed', ['refuse', 'detect-only'] as const);
  if (raw.writeNetwork !== undefined) out.writeNetwork = oneOf('writeNetwork', ['none', 'registry'] as const);
  for (const key of ['allowedHosts', 'extraReadonlyPaths', 'extraReadwritePaths'] as const) {
    if (raw[key] === undefined) continue;
    if (!isStringArray(raw[key])) bad(key, 'a string array');
    if (key !== 'allowedHosts' && !(raw[key] as string[]).every((p) => isAbsolute(p))) bad(key, 'an array of absolute paths');
    out[key] = [...(raw[key] as string[])];
  }
  return out;
}

export interface SandboxConfigLayers {
  /** The user config at its default location (userConfigLayers().trustedUser). */
  user: unknown;
  /** The working-tree project config (`.copilot/omg.jsonc`). */
  project: unknown;
}

function defaultLayers(root: string): SandboxConfigLayers {
  let user: unknown = null;
  try { user = userConfigLayers().trustedUser; } catch { /* unreadable: defaults */ }
  const path = resolveProjectConfigPath(root);
  const project = existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
  return { user, project };
}

/**
 * The settings for a session in `root`: the user config, then the project
 * config, which may only tighten (§6, the `ship.*` trust split): it can set
 * `enabled: true`, `reviewUnsandboxed: "refuse"`, `writeUnsandboxed:
 * "refuse"` and `writeNetwork: "none"`, never the looser values, hosts or
 * extra paths. A malformed block throws.
 */
export function loadSandboxSettings(root: string, scope: SandboxScope, layers: SandboxConfigLayers = defaultLayers(root)): { settings: SandboxSettings; warnings: string[] } {
  const settings = resolveSandboxSettings(sandboxBlock(layers.user, scope, 'user config'), 'user config sandbox');
  const projectRaw = sandboxBlock(layers.project, scope, 'project config');
  const project = resolveSandboxSettings(projectRaw, 'project config sandbox');
  const warnings: string[] = [];
  if (projectRaw.enabled === true) settings.enabled = true;
  if (projectRaw.reviewUnsandboxed === 'refuse') settings.reviewUnsandboxed = 'refuse';
  if (projectRaw.writeUnsandboxed === 'refuse') settings.writeUnsandboxed = 'refuse';
  if (projectRaw.writeNetwork === 'none') settings.writeNetwork = 'none';
  const loosening: string[] = [];
  if (projectRaw.enabled === false) loosening.push('enabled');
  if (project.reviewUnsandboxed !== 'refuse' && projectRaw.reviewUnsandboxed !== undefined) loosening.push('reviewUnsandboxed');
  if (project.writeUnsandboxed !== 'refuse' && projectRaw.writeUnsandboxed !== undefined) loosening.push('writeUnsandboxed');
  if (project.writeNetwork !== 'none' && projectRaw.writeNetwork !== undefined) loosening.push('writeNetwork');
  for (const key of ['allowedHosts', 'extraReadonlyPaths', 'extraReadwritePaths'] as const) if (projectRaw[key] !== undefined) loosening.push(key);
  if (loosening.length > 0) warnings.push(`sandbox: ignoring ${loosening.join(', ')} from the project config; it may only tighten the sandbox`);
  return { settings, warnings };
}

// ---------------------------------------------------------------------------
// Policy (§4.2 review, §4.3 write)
// ---------------------------------------------------------------------------

/** The SDK's SandboxConfig (rpc.d.ts), the fields this module sets. */
export interface SandboxConfig {
  enabled: boolean;
  addCurrentWorkingDirectory: boolean;
  allowBypass: false;
  allowDevToolAccess: false;
  sandboxMcpServers: true;
  sandboxLspServers: true;
  auth: { git: false; gh: false };
  userPolicy: {
    filesystem: { readwritePaths: string[]; readonlyPaths: string[]; deniedPaths?: string[] };
    network: { allowOutbound: boolean; allowLocalNetwork: boolean; allowedHosts?: string[] };
  };
}

export interface SandboxPolicyContext {
  worktree: string;
  commonGitDir: string;
  /** The session's own git dir (`<commonGitDir>/worktrees/<name>` for a linked worktree). */
  gitDir?: string;
  pluginRoot: string;
  /** The job's COPILOT_HOME (and relocated profile). */
  jobHome: string;
  /** The job's state directory (events, home). */
  jobDir: string;
  /** The account's real home (os.userInfo, not HOME / USERPROFILE). */
  realHome: string;
  platform: NodeJS.Platform;
  settings: SandboxSettings;
  /** The host commits for a write session (omg factory run): the common git dir is read-only as a whole (§4.3). */
  hostCommits?: boolean;
  /** The node and git install dirs a lane launches from (laneToolPaths), granted read-only. */
  toolPaths?: string[];
}

export const REGISTRY_HOSTS: readonly string[] = ['registry.npmjs.org', '*.npmjs.org'];

/** The target of `<worktree>/node_modules` when it is a junction or symlink (read-only for a write session). */
function nodeModulesLinkTarget(worktree: string): string | null {
  const nm = join(worktree, 'node_modules');
  try { return lstatSync(nm).isSymbolicLink() ? realpathSync.native(nm) : null; } catch { return null; }
}

/**
 * The read-write carve-outs of the read-only common git dir for a write
 * session: `objects/` and its own `worktrees/<name>` admin dir. No ref is
 * granted: the job worktree's HEAD is detached, so a commit writes only the
 * admin dir's HEAD, index and logs/HEAD, and the host moves the job's branch
 * after the session (job.ts syncJobBranch). One job cannot rewrite another
 * job's branch. Without a linked worktree (isolation "none") the git dir is
 * the common dir and only `objects/` is granted: the session cannot commit,
 * it fails closed.
 *
 * The grants are directories, and git writes by lock and rename (`index.lock`
 * then `index`, `HEAD.lock` then `HEAD`), which needs create and rename rights
 * in the directory itself, so the admin dir's `commondir`, `gitdir` and
 * `config.worktree` files (and the worktree's `.git` file) cannot be kept
 * read-only inside it: a lane can create or rename over any of them. The
 * host records them at creation (config.worktree as a hash, absent counts)
 * and runs no git in the worktree once they differ (git-worktree.ts
 * worktreeGitLinksIntact, and runHostGit before every command), with every host git call
 * hardened (hostGitHardeningArgs) and pointed at the recorded git dir.
 * `objects/info/alternates` is writable for the same reason: it only adds
 * places to look objects up, runs no code, and cannot forge an object,
 * because git names every object by the hash of its content.
 */
export function laneGitWritePaths(ctx: Pick<SandboxPolicyContext, 'commonGitDir' | 'gitDir' | 'platform'>): string[] {
  const out = [join(ctx.commonGitDir, 'objects')];
  const own = ctx.gitDir && resolve(ctx.gitDir) !== resolve(ctx.commonGitDir) && isUnderRoot(ctx.gitDir, join(ctx.commonGitDir, 'worktrees'), ctx.platform) ? ctx.gitDir : null;
  if (own) out.push(own);
  return out;
}

/**
 * The sandboxConfig for a session. `review` is §4.2 exactly. `write` with
 * `hostCommits` (omg factory run, whose engine commits after the lane) is
 * §4.3: the common git dir is read-only as a whole, so the session cannot
 * stage, commit or write any git file. `write` without it (a copilot_run job
 * that commits in its worktree) keeps the common git dir read-only except
 * what a commit on its detached HEAD writes (laneGitWritePaths). Either way
 * config, hooks, info, packed-refs and every ref stay read-only: the session
 * cannot plant core.hooksPath, core.fsmonitor or a hook for host-side git.
 * `deniedPaths` is sent only when the host reports `denied_paths`. An extra
 * read-write path outside the worktree throws. The tool dirs (`toolPaths`)
 * are read-only in both profiles; one that holds the real home, the worktree,
 * the common git dir or the job dir (a `D:\dev\node.exe` with every repo
 * beside it), or is a filesystem root, is dropped.
 */
export function buildSandboxConfig(profile: SandboxProfile, ctx: SandboxPolicyContext, host: SandboxHostRecord): SandboxConfig {
  const { settings } = ctx;
  for (const p of settings.extraReadwritePaths) {
    if (!isUnderRoot(p, ctx.worktree, ctx.platform)) throw new Error(`sandbox.extraReadwritePaths: ${p} is not under the worktree ${ctx.worktree}`);
  }
  const P = ctx.platform === 'win32' ? win32 : posix;
  const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };
  const tools = (ctx.toolPaths ?? []).filter((p) => P.dirname(P.resolve(real(p))) !== P.resolve(real(p)) && ![ctx.realHome, ctx.worktree, ctx.commonGitDir, ctx.jobDir].some((x) => x && isUnderRoot(x, p, ctx.platform)));
  // Of the job home only the relocated temp and profile dirs: the runtime reads config.json, its session
  // state, policies and logs from the rest, and loads code from the package cache (relocatedProfileEnv).
  const relocated = relocatedProfileEnv(ctx.jobHome);
  const laneHome = [relocated.TEMP!, relocated.USERPROFILE!];
  const common = {
    allowBypass: false as const,
    allowDevToolAccess: false as const,
    sandboxMcpServers: true as const,
    sandboxLspServers: true as const,
    auth: { git: false as const, gh: false as const },
  };
  if (profile === 'review') {
    return {
      enabled: true,
      addCurrentWorkingDirectory: false,
      ...common,
      userPolicy: {
        filesystem: {
          readonlyPaths: [ctx.worktree, ctx.commonGitDir, ctx.pluginRoot, ...tools, ...settings.extraReadonlyPaths],
          readwritePaths: [...laneHome, ...settings.extraReadwritePaths],
        },
        network: { allowOutbound: false, allowLocalNetwork: false },
      },
    };
  }
  const nm = nodeModulesLinkTarget(ctx.worktree);
  const filesystem: SandboxConfig['userPolicy']['filesystem'] = {
    readwritePaths: [ctx.worktree, ...laneHome, ...(ctx.hostCommits ? [] : laneGitWritePaths(ctx)), ...settings.extraReadwritePaths],
    readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, ...(nm ? [nm] : []), ...tools, ...settings.extraReadonlyPaths],
  };
  if (host.capabilities.denied_paths === true) {
    filesystem.deniedPaths = ['.ssh', '.gitconfig', '.omg', '.copilot'].map((p) => join(ctx.realHome, p));
  }
  const network: SandboxConfig['userPolicy']['network'] = settings.writeNetwork === 'registry'
    ? { allowOutbound: true, allowedHosts: [...REGISTRY_HOSTS, ...settings.allowedHosts], allowLocalNetwork: ctx.platform === 'win32' }
    : { allowOutbound: false, allowLocalNetwork: false };
  return { enabled: true, addCurrentWorkingDirectory: true, ...common, userPolicy: { filesystem, network } };
}

// ---------------------------------------------------------------------------
// Tool dirs (allowDevToolAccess stays off)
// ---------------------------------------------------------------------------

/** The host lookups behind laneToolPaths (a test seam). */
export interface ToolPathProbe {
  /** The engine's own node binary (process.execPath). */
  execPath: string;
  /** `name` resolved on the lane's PATH, or null. */
  which: (name: string) => string | null;
  /** `<git> --exec-path`, or null. */
  gitExecPath: (git: string) => string | null;
  realpath: (p: string) => string;
}

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * `name` on `env`'s PATH (PATHEXT on win32), or null. Empty and relative
 * entries are skipped, and so is any entry under a `node_modules` dir (npx
 * and npm scripts put `node_modules/.bin` first, so a package's shim would
 * stand in for the host git that `git --exec-path` runs).
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean = isFile): string | null {
  const P = platform === 'win32' ? win32 : posix;
  const exts = platform === 'win32' ? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const inNodeModules = platform === 'win32' ? /(^|[\\/])node_modules([\\/]|$)/i : /(^|\/)node_modules(\/|$)/;
  for (const raw of (envValue(env, 'PATH') ?? '').split(P.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !P.isAbsolute(dir) || inNodeModules.test(dir)) continue;
    for (const ext of exts) if (exists(P.join(dir, name + ext))) return P.join(dir, name + ext);
  }
  return null;
}

function defaultToolPathProbe(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ToolPathProbe {
  return {
    execPath: process.execPath,
    which: (name) => findOnPath(name, env, platform),
    gitExecPath: (git) => {
      const r = spawnSync(git, ['--exec-path'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const out = r.status === 0 ? (r.stdout ?? '').trim() : '';
      return out || null;
    },
    realpath: (p) => realpathSync.native(p),
  };
}

/**
 * The install dirs of the programs every lane starts: node (the plugin
 * hooks and the `t` MCP server run `node`) and git. With
 * `allowDevToolAccess` off the runtime grants no PATH entry, and on Windows
 * MXC then denies launching `C:\Program Files\nodejs\node.exe`; on Linux
 * and macOS the system dirs stay granted, so this matters there for a
 * toolchain outside them (nvm, the runner's tool cache, Homebrew's Cellar).
 * They are granted read-only, never read-write, and by name rather than all
 * of PATH (allowDevToolAccess): PATH entries can be per-user dirs that hold
 * config or credentials, and a lane needs only these two programs.
 *
 * node: the dir of the engine's own binary and of the `node` the lane's
 * PATH resolves to (both, realpath and link). git: Git for Windows's install
 * root (`<root>\cmd\git.exe` launches `<root>\mingw64\bin\git.exe`, which
 * runs `<root>\usr\bin\sh.exe` for hooks), found from `git --exec-path`
 * (`<root>\mingw64\libexec\git-core`) and kept only when the PATH git lies
 * under it; elsewhere the git binary's dir and its exec path.
 */
export function laneToolPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, probe: ToolPathProbe = defaultToolPathProbe(env, platform)): string[] {
  const P = platform === 'win32' ? win32 : posix;
  const out: string[] = [];
  const real = (p: string) => { try { return probe.realpath(p); } catch { return p; } };
  const binDirs = (p: string | null) => (p ? [P.dirname(p), P.dirname(real(p))] : []);
  out.push(...binDirs(probe.execPath), ...binDirs(probe.which('node')));
  const git = probe.which('git');
  if (git) {
    const execDir = probe.gitExecPath(git);
    const root = platform === 'win32' ? gitForWindowsRoot(execDir) : null;
    const under = (p: string, dir: string) => { const rel = P.relative(dir, p); return !!rel && !rel.startsWith('..') && !P.isAbsolute(rel); };
    if (root && under(real(git), root)) out.push(root);
    else out.push(...binDirs(git), ...(execDir ? [execDir] : []));
  }
  const seen = new Set<string>();
  return out.map((p) => P.resolve(p)).filter((p) => {
    const key = platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Git for Windows's install root from its `--exec-path` (`<root>\mingw64\libexec\git-core`), or null. */
function gitForWindowsRoot(execDir: string | null): string | null {
  return execDir && /[\\/]libexec[\\/]git-core[\\/]?$/i.test(execDir) ? win32.resolve(execDir, '..', '..', '..') : null;
}

/** `<root>\usr\bin\sh.exe`, the shell Git for Windows runs hooks with, for the git on `env`'s PATH; or null. */
export function gitForWindowsShell(env: NodeJS.ProcessEnv, probe: ToolPathProbe = defaultToolPathProbe(env, 'win32')): string | null {
  const git = probe.which('git');
  const root = git ? gitForWindowsRoot(probe.gitExecPath(git)) : null;
  return root ? win32.join(root, 'usr', 'bin', 'sh.exe') : null;
}

// ---------------------------------------------------------------------------
// Detection (§5)
// ---------------------------------------------------------------------------

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** A method `name` on `obj.<path>` bound to its owner, or null (getters that throw count as missing). */
function rpcMethod(root: unknown, path: string[], name: string): (() => Promise<unknown>) | ((p: unknown) => Promise<unknown>) | null {
  try {
    let owner = root as Record<string, unknown> | undefined;
    for (const key of path) owner = owner?.[key] as Record<string, unknown> | undefined;
    const fn = owner?.[name];
    return typeof fn === 'function' ? (fn as (p?: unknown) => Promise<unknown>).bind(owner) : null;
  } catch {
    return null;
  }
}

/** Runs `cmd args` to completion, shaped like spawnSync's result. */
export type SandboxTrialSpawner = (cmd: string, args: readonly string[], timeoutMs: number) => { error?: Error; status: number | null; stderr: string };

/**
 * The trial launch: bwrap with the namespaces the runtime's Linux sandbox
 * creates, network included (`--unshare-all`; policies without outbound
 * access get an empty net namespace), around `true`.
 */
export const BWRAP_TRIAL_ARGS: readonly string[] = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--die-with-parent', '--', 'true'];

const defaultTrialSpawner: SandboxTrialSpawner = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'ignore', 'pipe'] });
  return { ...(r.error ? { error: r.error } : {}), status: r.status, stderr: r.stderr ?? '' };
};

/**
 * Whether bwrap can launch a process here: null when it can, else why not.
 * `sandbox.getHostSupport` reports a host with bwrap installed as supported
 * even where unprivileged user namespaces lack capabilities (Ubuntu 24.04's
 * AppArmor default), and there every sandboxed launch fails.
 */
export function bwrapTrialLaunchError(spawn: SandboxTrialSpawner = defaultTrialSpawner, timeoutMs = 10_000): string | null {
  const r = spawn('bwrap', BWRAP_TRIAL_ARGS, timeoutMs);
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'bwrap (bubblewrap) is not on PATH, and the Linux sandbox runs every shell under it: install bubblewrap';
  if (r.error) return `a trial bwrap launch failed: ${errText(r.error)}`;
  if (r.status === 0) return null;
  const stderr = r.stderr.trim().slice(0, 200);
  if (/RTM_NEWADDR|uid map|new namespace/i.test(stderr)) {
    return 'unprivileged user namespaces are restricted (AppArmor kernel.apparmor_restrict_unprivileged_userns=1), so bwrap cannot launch the sandbox; '
      + `see "Linux: restricted user namespaces" in docs/REFERENCE.md (bwrap: ${stderr})`;
  }
  return `a trial bwrap launch failed (exit ${String(r.status)})${stderr ? `: ${stderr}` : ''}`;
}

let cachedBwrapTrial: string | null | undefined;
/** bwrapTrialLaunchError with the real bwrap, run once per process. */
export function cachedBwrapTrialLaunchError(): string | null {
  if (cachedBwrapTrial === undefined) cachedBwrapTrial = bwrapTrialLaunchError();
  return cachedBwrapTrial;
}

export interface HostLaunchCheck {
  /** Default process.platform; the trial launch runs on linux only. */
  platform?: NodeJS.Platform;
  /** Test seam: the trial launch (default cachedBwrapTrialLaunchError). */
  trialLaunch?: () => string | null;
}

/**
 * `client.rpc.sandbox.getHostSupport()`; supported only with the `shell`
 * capability and, on Linux, a trial bwrap launch that succeeds.
 */
export async function probeHostSupport(client: unknown, timeoutMs: number, launch: HostLaunchCheck = {}): Promise<SandboxHostRecord> {
  const host = await askHostSupport(client, timeoutMs);
  if (!host.supported || (launch.platform ?? process.platform) !== 'linux') return host;
  const launchError = (launch.trialLaunch ?? cachedBwrapTrialLaunchError)();
  return launchError ? { supported: false, reason: launchError, capabilities: host.capabilities, launchFailed: true } : host;
}

async function askHostSupport(client: unknown, timeoutMs: number): Promise<SandboxHostRecord> {
  const call = rpcMethod(client, ['rpc', 'sandbox'], 'getHostSupport') as (() => Promise<unknown>) | null;
  if (!call) return { supported: false, reason: 'the SDK has no sandbox.getHostSupport RPC', capabilities: {} };
  try {
    const res = (await withTimeout(call(), timeoutMs, 'sandbox.getHostSupport()')) as { supported?: unknown; reason?: unknown; capabilities?: unknown } | null;
    const capabilities: Record<string, boolean> = {};
    for (const c of Array.isArray(res?.capabilities) ? res!.capabilities as Array<{ name?: unknown; supported?: unknown }> : []) {
      if (typeof c?.name === 'string') capabilities[c.name] = c.supported === true;
    }
    const reason = typeof res?.reason === 'string' ? res.reason : undefined;
    if (res?.supported !== true) return { supported: false, reason: reason ?? 'the host does not support the sandbox', capabilities };
    if (capabilities.shell !== true) return { supported: false, reason: 'the host reports no shell sandbox capability', capabilities };
    return { supported: true, ...(reason ? { reason } : {}), capabilities };
  } catch (err) {
    return { supported: false, reason: `sandbox.getHostSupport failed: ${errText(err)}`, capabilities: {} };
  }
}

/** `session.rpc.options.update({ sandboxConfig })`; null when applied, else why not. */
export async function applySandboxConfig(session: unknown, config: SandboxConfig, timeoutMs: number): Promise<string | null> {
  const update = rpcMethod(session, ['rpc', 'options'], 'update') as ((p: unknown) => Promise<unknown>) | null;
  if (!update) return 'the SDK has no options.update RPC';
  try {
    const res = (await withTimeout(update({ sandboxConfig: config, sandboxConfigSource: 'session_flag' }), timeoutMs, 'options.update()')) as { success?: unknown } | null;
    return res?.success === true ? null : 'options.update did not report success';
  } catch (err) {
    return `options.update failed: ${errText(err)}`;
  }
}

/** `session.rpc.sandbox.getEnforcementStatus()`, or why it could not be read. */
export async function readEnforcement(session: unknown, timeoutMs: number): Promise<NonNullable<CopilotRunSandboxState['enforcement']> | string> {
  const call = rpcMethod(session, ['rpc', 'sandbox'], 'getEnforcementStatus') as (() => Promise<unknown>) | null;
  if (!call) return 'the SDK has no sandbox.getEnforcementStatus RPC';
  try {
    const res = (await withTimeout(call(), timeoutMs, 'sandbox.getEnforcementStatus()')) as { required?: unknown; blocked?: unknown; reason?: unknown } | null;
    return {
      required: res?.required === true,
      blocked: res?.blocked !== false,
      ...(typeof res?.reason === 'string' ? { reason: res.reason } : {}),
    };
  } catch (err) {
    return `sandbox.getEnforcementStatus failed: ${errText(err)}`;
  }
}

/**
 * What a session runs as when its sandbox is not confirmed (§3):
 * review -> `read-only-no-shell` (or `refused` with reviewUnsandboxed
 * "refuse"), write -> `refused` (or `detect-only` with writeUnsandboxed
 * "detect-only").
 */
export function unconfirmedMode(profile: SandboxProfile, settings: SandboxSettings): SandboxMode {
  if (profile === 'review') return settings.reviewUnsandboxed === 'refuse' ? 'refused' : 'read-only-no-shell';
  return settings.writeUnsandboxed === 'detect-only' ? 'detect-only' : 'refused';
}

// ---------------------------------------------------------------------------
// Environment (§4.3 L4)
// ---------------------------------------------------------------------------

/**
 * Caller variables the runtime keeps (case-insensitive); everything else,
 * secrets included, is dropped. No credential passes: the runtime's env is
 * what its shell children inherit, so COPILOT_GITHUB_TOKEN goes to the
 * session over RPC instead (sessionGitHubToken).
 */
export const SESSION_ENV_ALLOWLIST: readonly string[] = [
  // TEMP, TMP and TMPDIR are not passed: relocatedProfileEnv points them at the job's own temp dir.
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'LANG',
  // Non-secret OS variables shells and git expect.
  'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER', 'LOGNAME', 'TERM', 'TZ',
  // A path, not a secret: the Windows sandbox needs it (MXC_REQUIRED_ENV) and grants %LOCALAPPDATA%\Programs read-only from it.
  // The HOST value is kept on purpose: per-user tools on PATH live under Programs. Lane-launched code that resolves host
  // paths from it (python-repl/paths.ts, utils/paths.ts getDataDir/getStateDir) finds them, but sandboxed writes there
  // are denied, so the effect is breakage or shared read state, never escalation.
  'LOCALAPPDATA',
];

/**
 * The variables the Windows sandbox (MXC) needs to launch any process,
 * hook or shell, with the runtime's env taken verbatim
 * (`inheritDefaultEnv` false): presence only, the value is not checked.
 * Copilot CLI 1.0.105 rejects a launch without them ("policy_validation:
 * ... missing the required variable(s)"). In runtime.node 1.0.105 only
 * SYSTEMROOT sits next to that message; LOCALAPPDATA comes from separate MXC
 * strings ("LOCALAPPDATA and USERPROFILE both unset", "no user-profile
 * grants: %LOCALAPPDATA% is unset ... Programs") and from the live error.
 * SystemRoot locates the system DLLs, LOCALAPPDATA the container's profile.
 */
export const MXC_REQUIRED_ENV: readonly string[] = ['SYSTEMROOT', 'LOCALAPPDATA'];

/** The {@link MXC_REQUIRED_ENV} names `env` lacks (or holds blank) on win32; none elsewhere. */
export function missingSandboxEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? MXC_REQUIRED_ENV.filter((n) => envValue(env, n) === undefined) : [];
}

/** The caller's env value for `name`, looked up case-insensitively (Windows env keys). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  const value = key === undefined ? undefined : env[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The explicit Copilot credential for the session's `gitHubToken` option
 * (SDK 1.0.16 SessionConfig: sent over the session RPC, never put in the
 * runtime's env, unlike the client-level option).
 */
export function sessionGitHubToken(env: NodeJS.ProcessEnv): string | undefined {
  return envValue(env, 'COPILOT_GITHUB_TOKEN');
}

/** GitHub token shapes: classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_. */
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

/** The token values in the caller's env that lane output must never carry. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
    .map((n) => envValue(env, n))
    .filter((v): v is string => v !== undefined && v.length >= 8);
}

/**
 * `text` with every GitHub token shape and every exact `secrets` value
 * replaced by `[redacted]`. It matches literal text only: a token that is
 * base64-encoded, URL-encoded, split across lines or events, or otherwise
 * transformed passes through unredacted.
 */
export function scrubTokens(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.replace(TOKEN_PATTERN, '[redacted]');
}

/**
 * The relocated profile variables, all under `<jobHome>/profile`, and the
 * temp variables, `<jobHome>/tmp` (the caller creates it). The runtime
 * grants the sandbox read-write on the dir its own TEMP names ("temporary
 * storage" in the SDK's allowDevToolAccess doc; the host value was the
 * user's whole %TEMP%, other jobs' homes and repositories included), and
 * no temp dir at all when that dir is missing.
 */
export function relocatedProfileEnv(jobHome: string): Record<string, string> {
  const profile = join(jobHome, 'profile');
  const tmp = join(jobHome, 'tmp');
  return {
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    USERPROFILE: profile,
    HOME: profile,
    XDG_CONFIG_HOME: join(profile, '.config'),
    GIT_CONFIG_GLOBAL: join(profile, '.gitconfig'),
    // The runtime's cache would follow the host LOCALAPPDATA (allowlisted for MXC): keep it, and the sandboxed MCP cache grant
    // anchored on it, in the job home but outside the lane-writable profile: the runtime loads code from its pkg dir.
    COPILOT_CACHE_HOME: join(jobHome, '.cache', 'copilot'),
  };
}

/**
 * The runtime env from buildSessionEnv's output: allowlisted caller
 * variables, `LC_*`, the variables the job sets (COPILOT_HOME, the
 * SMOKE_SET_ENV flags, OMC_* — buildSessionEnv already stripped the
 * caller's), and the relocated profile. NODE_OPTIONS, GH_TOKEN, GITHUB_TOKEN,
 * cloud and npm tokens never pass.
 */
export function allowlistSessionEnv(env: NodeJS.ProcessEnv, jobHome: string): NodeJS.ProcessEnv {
  const allow = new Set([...SESSION_ENV_ALLOWLIST, ...Object.keys(SMOKE_SET_ENV), 'COPILOT_HOME'].map((k) => k.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (allow.has(upper) || upper.startsWith('LC_') || upper.startsWith('OMC_')) out[key] = value;
  }
  return { ...out, ...relocatedProfileEnv(jobHome) };
}
