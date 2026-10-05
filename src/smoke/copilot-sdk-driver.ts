/**
 * Tier 2 of `omg smoke copilot`: drive the installed Copilot CLI through
 * `@github/copilot-sdk` (an optional peer dependency, never bundled).
 *
 * SDK resolution ({@link loadCopilotSdk}), first hit wins:
 * 1. `import('@github/copilot-sdk')` from this module: a local or project
 *    install, or a global install next to a global oh-my-copilot (parent
 *    `node_modules` lookup);
 * 2. a global install: `%APPDATA%/npm/node_modules` (win32), then
 *    `npm root -g`. This covers a repo checkout (`npx tsx`, `node dist/...`)
 *    with the SDK installed by
 *    `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`.
 *    A global hit must be named {@link SDK_PACKAGE}, satisfy
 *    `^`{@link SDK_MIN_VERSION}, and have its entry files inside its own dir.
 * Not found: every sdk.* and scn.* check fails with {@link SDK_MISSING_DETAIL}
 * and the report is `skipped`.
 *
 * The runtime is always the installed exe the earlier tiers resolved
 * (`RuntimeConnection.forStdio({ path })`), never the SDK's bundled runtime.
 */

import { spawnSync as nodeSpawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { excerpt, type CopilotEvent, type SmokeCheck } from './copilot-session-eval.js';
import {
  chooseModel,
  CREDIT_CAP_SKIP_DETAIL,
  evaluateScenario,
  evaluateSdkAgents,
  evaluateSdkMcp,
  evaluateSdkPlugins,
  evaluateSdkRuntime,
  evaluateSdkSkills,
  evaluateSdkToolsExcluded,
  failedTier2Checks,
  hostSmokeToolName,
  RUNTIME_MIN_MAX_CREDITS,
  SCENARIOS,
  scenarioCost,
  scenarioExcludedTools,
  SDK_MISSING_DETAIL,
  SDK_PACKAGE,
  skippedScenarioChecks,
  sliceLogByTime,
  usageCredits,
  type PermissionRequestLike,
  type Rpc,
  type Scenario,
  type ScenarioCost,
  type ScenarioRun,
} from './copilot-sdk-scenarios.js';
import { killProcessTree, type SpawnSyncFn } from './process-utils.js';

// ---------------------------------------------------------------------------
// The slice of the SDK surface the driver uses (SDK 1.0.16, protocol 3)
// ---------------------------------------------------------------------------

export type PermissionResult = { kind: 'approve-once' } | { kind: 'reject'; feedback?: string };

export interface SdkSessionConfig {
  onPermissionRequest: (req: PermissionRequestLike, ctx: { sessionId: string }) => PermissionResult | Promise<PermissionResult>;
  onEvent?: (event: CopilotEvent) => void;
  pluginDirectories: string[];
  workingDirectory: string;
  disabledMcpServers: string[];
  excludedTools: string[];
  model?: string;
}

export interface SdkSessionLike {
  sessionId: string;
  send(opts: { prompt: string }): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: {
    plugins: { list(): Promise<unknown> };
    skills: { list(): Promise<unknown> };
    agent: { list(): Promise<unknown> };
    mcp: { list(): Promise<unknown>; listTools(params: { serverName: string }): Promise<unknown> };
    /** Experimental in SDK 1.0.16; no model call. */
    tools?: { initializeAndValidate?(): Promise<unknown>; getCurrentMetadata?(): Promise<unknown> };
  };
}

export interface SdkClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop?(): Promise<void>;
  getStatus(): Promise<{ version?: unknown; protocolVersion?: unknown }>;
  listModels(): Promise<Array<{ id?: unknown }>>;
  createSession(config: SdkSessionConfig): Promise<SdkSessionLike>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface SdkClientOptions {
  connection: unknown;
  baseDirectory: string;
  workingDirectory: string;
}

export interface CopilotSdkModule {
  CopilotClient: new (opts: SdkClientOptions) => SdkClientLike;
  RuntimeConnection: { forStdio(opts: { path?: string; args?: string[]; env?: NodeJS.ProcessEnv }): unknown };
}

export interface LoadedSdk {
  module: CopilotSdkModule;
  version: string | null;
  /** Where it resolved from: `node resolution` or the package dir under a global prefix. */
  from: string;
}

/** Resolves the SDK, or null when it is not installed. */
export type LoadSdkFn = () => Promise<LoadedSdk | null>;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function isSdkModule(mod: unknown): mod is CopilotSdkModule {
  const m = mod as Partial<CopilotSdkModule> | null;
  return !!m && typeof m.CopilotClient === 'function' && typeof m.RuntimeConnection?.forStdio === 'function';
}

function readPkg(dir: string): { name?: string; version?: string; main?: string; exports?: unknown } | null {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')); } catch { return null; }
}

/** Walk up from a resolved entry file to the SDK's package.json version. */
function versionAbove(file: string): string | null {
  let dir = dirname(file);
  for (let i = 0; i < 6; i++) {
    const pkg = readPkg(dir);
    if (pkg?.name === SDK_PACKAGE) return pkg.version ?? null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function nodeResolvedVersion(): string | null {
  const bases: string[] = [];
  try { bases.push(import.meta.url); } catch { /* CJS bundle */ }
  if (typeof __filename !== 'undefined') bases.push(__filename);
  for (const base of bases) {
    try { return versionAbove(createRequire(base).resolve(SDK_PACKAGE)); } catch { /* next */ }
  }
  return null;
}

/**
 * Candidate global `node_modules` dirs before `npm root -g`: only the npm
 * default on win32. Env-steerable prefixes (`npm_config_prefix`) and the
 * running node's dir are not probed: they could load an arbitrary package.
 */
export function globalModuleRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' && env.APPDATA ? [join(env.APPDATA, 'npm', 'node_modules')] : [];
}

/** Lowest SDK release the driver is written against (protocol 3). */
export const SDK_MIN_VERSION = '1.0.16';

/** `^1.0.16` without a semver dependency: same major 1, >= 1.0.16, no prerelease. */
export function satisfiesSdkRange(version: string | undefined | null): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  const min = SDK_MIN_VERSION.split('.').map(Number);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== min[0]) return false;
  return minor > min[1] || (minor === min[1] && patch >= min[2]);
}

/** True when `file` (resolved through symlinks) lies inside `dir`. */
function insideDir(dir: string, file: string): boolean {
  const real = (p: string) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const rel = relative(real(dir), real(resolve(dir, file)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

type ExportTarget = string | { default?: unknown; import?: unknown; require?: unknown } | undefined;

function exportPath(target: ExportTarget, condition: 'import' | 'require'): string | undefined {
  if (typeof target === 'string') return target;
  const cond = target?.[condition] as ExportTarget;
  if (typeof cond === 'string') return cond;
  return typeof cond?.default === 'string' ? cond.default : undefined;
}

function npmRootG(env: NodeJS.ProcessEnv, spawnSync: SpawnSyncFn): string | null {
  // A fixed command line: npm is a .cmd shim on win32 and needs a shell (no args array, see DEP0190).
  const res = process.platform === 'win32'
    ? spawnSync('npm root -g', { env, encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: true })
    : spawnSync('npm', ['root', '-g'], { env, encoding: 'utf8', timeout: 15_000 });
  const out = String(res.stdout ?? '').trim();
  return res.status === 0 && out ? out : null;
}

/**
 * Import the SDK from a package dir found under a global root. Refuses a
 * package with another name, a version outside `^`{@link SDK_MIN_VERSION},
 * or an `exports`/`main` entry that resolves outside the package dir.
 */
export async function importFromDir(dir: string): Promise<LoadedSdk | null> {
  const pkg = readPkg(dir);
  if (pkg?.name !== SDK_PACKAGE || !satisfiesSdkRange(pkg.version)) return null;
  const exp = (pkg.exports && typeof pkg.exports === 'object' ? (pkg.exports as Record<string, ExportTarget>)['.'] : pkg.exports as ExportTarget);
  const esmEntry = exportPath(exp, 'import') ?? pkg.main ?? 'dist/index.js';
  const cjsEntry = exportPath(exp, 'require') ?? pkg.main ?? 'index.js';
  if (!insideDir(dir, esmEntry) || !insideDir(dir, cjsEntry)) return null;
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(resolve(dir, esmEntry)).href);
  } catch {
    // CJS-transpiled callers (e.g. `tsx -e`) rewrite import() into a require
    // that cannot take a file URL; the SDK also ships a CJS build.
    mod = createRequire(join(dir, 'package.json'))(resolve(dir, cjsEntry));
  }
  return isSdkModule(mod) ? { module: mod, version: pkg.version ?? null, from: dir } : null;
}

/**
 * Resolve a Windows npm shim (`copilot.cmd` / `.ps1`) to the `.js` or `.exe`
 * it launches, so the SDK (which spawns `path` without a shell) can drive it.
 * Null when the shim cannot be read or names no existing target.
 */
export function resolveShimTarget(
  shim: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf-8'),
  exists: (p: string) => boolean = existsSync,
): string | null {
  let text: string;
  try { text = read(shim); } catch { return null; }
  const patterns = [
    /"%~?dp0%\\?([^"%*]+?\.(?:js|exe))"/i, // cmd-shim: "%dp0%\node_modules\...\loader.js"
    /\$basedir[\\/]([^"$*]+?\.(?:js|exe))"/i, // ps1 shim: "$basedir/node_modules/.../loader.js"
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const target = resolve(dirname(shim), m[1].replace(/\\/g, '/'));
    if (exists(target)) return target;
  }
  return null;
}

/** See the module comment for the resolution order. */
export async function loadCopilotSdk(env: NodeJS.ProcessEnv = process.env, spawnSync: SpawnSyncFn = nodeSpawnSync): Promise<LoadedSdk | null> {
  const spec = SDK_PACKAGE; // a variable keeps tsc from resolving the optional peer at build time
  try {
    const mod = await import(spec) as unknown;
    if (isSdkModule(mod)) return { module: mod, version: nodeResolvedVersion(), from: 'node resolution' };
  } catch { /* not resolvable from here */ }
  const tried = new Set<string>();
  const tryRoot = async (root: string | null) => {
    if (!root || tried.has(root)) return null;
    tried.add(root);
    const dir = join(root, ...SDK_PACKAGE.split('/'));
    if (!existsSync(join(dir, 'package.json'))) return null;
    try { return await importFromDir(dir); } catch { return null; }
  };
  for (const root of globalModuleRoots(env)) {
    const hit = await tryRoot(root);
    if (hit) return hit;
  }
  return tryRoot(npmRootG(env, spawnSync));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_SCENARIO_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const MCP_CONNECT_WAIT_MS = 20_000;
const ABORT_GRACE_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STOP_TIMEOUT_MS = 15_000;

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function rpc<T>(fn: () => Promise<T>, label: string): Promise<Rpc<T>> {
  try { return { ok: true, value: await withTimeout(fn(), RPC_TIMEOUT_MS, label) }; } catch (err) { return { ok: false, error: errText(err) }; }
}

/** Every runtime process log, joined (null: no log dir or no `.log` file). */
function readAllLogs(logDir: string): string | null {
  let files: string[];
  try { files = readdirSync(logDir).filter((f) => f.endsWith('.log')); } catch { return null; }
  if (files.length === 0) return null;
  return files.map((f) => { try { return readFileSync(join(logDir, f), 'utf-8'); } catch { return ''; } }).join('\n');
}

/** The runtime child's pid: the SDK keeps it on the private `cliProcess` (SDK 1.0.16). */
export function runtimePid(client: SdkClientLike): number | undefined {
  const pid = (client as unknown as { cliProcess?: { pid?: unknown } | null }).cliProcess?.pid;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

const reject = (feedback: string): PermissionResult => ({ kind: 'reject', feedback });

// ---------------------------------------------------------------------------
// Sandbox project: a git repo on `main` with one commit and a local bare remote
// ---------------------------------------------------------------------------

export function prepareSdkProject(spawnSync: SpawnSyncFn, projectDir: string, remoteDir: string, env: NodeJS.ProcessEnv): string | null {
  const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'hello.txt'), 'omg smoke fixture\n');
  const steps: Array<[string[], string]> = [
    [['-c', 'init.defaultBranch=main', 'init', '-q'], projectDir],
    [['checkout', '-q', '-B', 'main'], projectDir],
    [['add', 'hello.txt'], projectDir],
    [['-c', 'user.name=omg-smoke', '-c', 'user.email=omg-smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], projectDir],
    [['init', '-q', '--bare', remoteDir], dirname(remoteDir)],
    [['remote', 'add', 'origin', remoteDir], projectDir],
  ];
  for (const [args, cwd] of steps) {
    const res = git(args, cwd);
    if (res.status !== 0) return `git ${args.join(' ')}: ${excerpt(`${res.stderr ?? ''}${res.error?.message ?? ''}`, 200) || `exit ${res.status}`}`;
  }
  return null;
}

function remoteRefs(spawnSync: SpawnSyncFn, remoteDir: string, env: NodeJS.ProcessEnv): string | null {
  const res = spawnSync('git', ['--git-dir', remoteDir, 'for-each-ref'], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return res.status === 0 ? String(res.stdout ?? '') : null;
}

// ---------------------------------------------------------------------------
// Tier 2 run
// ---------------------------------------------------------------------------

export interface SdkTierInput {
  root: string;
  bin: string;
  binVersion: string | null;
  packageVersion: string | null;
  /** Isolated COPILOT_HOME (config.json with login identity + trustedFolders already written). */
  home: string;
  projectDir: string;
  remoteDir: string;
  /** Client env (buildSessionEnv + scenario switches); per runtime process, not per session. */
  env: NodeJS.ProcessEnv;
  scenarios: Scenario[];
  model?: string;
  timeoutMs: number;
  /**
   * Credit cap for the whole run: a scenario is aborted once its
   * `assistant.usage` credits pass what is left, and later scenarios are
   * skipped once the run total passes it. The runtime also gets
   * `--max-ai-credits max(30, maxCredits)` (30 is the CLI minimum).
   */
  maxCredits: number;
  keepHome: boolean;
  loadSdk: LoadSdkFn;
  loadExpectedToolCount: () => Promise<number>;
  spawnSync: SpawnSyncFn;
  skillDirs: string[];
  agentFiles: string[];
  mcpServer: string;
  /** Test seams: platform (default process.platform), pid liveness and the runtime tree kill. */
  platform?: NodeJS.Platform;
  isAlive?: (pid: number) => boolean;
  killTree?: (pid: number) => void;
}

export interface SdkTierResult {
  checks: SmokeCheck[];
  sdk?: { version: string | null; runtimeVersion: string | null; protocolVersion: number | null; model: string };
  cost?: ScenarioCost;
  /** Per scenario JSONL event capture, under the home dir. */
  events: Partial<Record<Scenario, string>>;
  skipped?: string;
}

/** `--max-ai-credits` for the runtime: the run cap, raised to the CLI minimum. */
export function runtimeCreditCap(maxCredits: number): number {
  return Math.max(RUNTIME_MIN_MAX_CREDITS, Math.ceil(maxCredits));
}

export const RUNTIME_WEDGED_DETAIL = 'skipped: runtime unresponsive after a scenario timeout';

type ScenarioEntry =
  | { name: Scenario; skip: string }
  | { name: Scenario; run: Omit<ScenarioRun, 'logText'>; start: number };

export async function runSdkTier(input: SdkTierInput): Promise<SdkTierResult> {
  const events: SdkTierResult['events'] = {};
  let loaded: LoadedSdk | null;
  try {
    loaded = await input.loadSdk();
  } catch {
    loaded = null; // a broken install counts as missing
  }
  if (!loaded) {
    return { checks: failedTier2Checks(input.scenarios, SDK_MISSING_DETAIL), events, skipped: SDK_MISSING_DETAIL };
  }

  const checks: SmokeCheck[] = [{
    id: 'sdk.available',
    ok: true,
    detail: `${SDK_PACKAGE}@${loaded.version ?? '?'} (${loaded.from})`,
  }];
  // The SDK spawns `path` without a shell: drive the .js/.exe a Windows npm shim launches.
  let bin = input.bin;
  if ((input.platform ?? process.platform) === 'win32' && /\.(cmd|bat|ps1)$/i.test(bin)) {
    const target = resolveShimTarget(bin);
    if (!target) {
      checks.push(...failedTier2Checks(input.scenarios, `${bin} is a shell shim whose .js/.exe target could not be resolved; pass --copilot-bin <copilot.exe or the package's .js entry>`, 'after-available'));
      return { checks, events };
    }
    bin = target;
  }
  const projectError = prepareSdkProject(input.spawnSync, input.projectDir, input.remoteDir, input.env);
  const { CopilotClient, RuntimeConnection } = loaded.module;
  const client = new CopilotClient({
    // Debug level for the runtime (hook stderr is only logged there) via args,
    // not the client's logLevel, which would also echo SDK timing lines to our stderr.
    connection: RuntimeConnection.forStdio({
      path: bin,
      args: ['--log-level', 'debug', '--max-ai-credits', String(runtimeCreditCap(input.maxCredits))],
      env: input.env,
    }),
    baseDirectory: input.home,
    workingDirectory: input.projectDir,
  });
  const logDir = join(input.home, 'logs');
  const sdkInfo: NonNullable<SdkTierResult['sdk']> = { version: loaded.version, runtimeVersion: null, protocolVersion: null, model: 'auto' };
  const total: ScenarioCost = { premiumRequests: 0, credits: 0 };
  const entries: ScenarioEntry[] = [];
  const isAlive = input.isAlive ?? pidAlive;
  const killTree = input.killTree ?? ((pid: number) => killProcessTree(pid, input.spawnSync));
  let pid: number | undefined;
  let wedged = false;

  try {
    try {
      await withTimeout(client.start(), START_TIMEOUT_MS, 'client.start()');
    } catch (err) {
      checks.push(...failedTier2Checks(input.scenarios, `runtime did not start (${bin}): ${excerpt(errText(err), 200)}`, 'after-available'));
      return { checks, sdk: sdkInfo, events };
    }
    pid = runtimePid(client);

    const status = await rpc(() => client.getStatus(), 'getStatus()');
    if (status.ok) {
      sdkInfo.runtimeVersion = typeof status.value.version === 'string' ? status.value.version : null;
      sdkInfo.protocolVersion = typeof status.value.protocolVersion === 'number' ? status.value.protocolVersion : null;
    }
    const models = await rpc(() => client.listModels(), 'listModels()');
    const choice = chooseModel(models.ok ? models.value.map((m) => String(m.id)) : [], input.model);
    sdkInfo.model = choice.label;
    const modelLabel = `${choice.label} (${choice.note})`;
    checks.push(evaluateSdkRuntime(status, input.binVersion, modelLabel));

    checks.push(...await staticChecks(client, input));

    let stopReason: string | undefined;
    for (const name of input.scenarios) {
      if (projectError) { entries.push({ name, skip: `sandbox project setup failed: ${projectError}` }); continue; }
      if (stopReason) { entries.push({ name, skip: stopReason }); continue; }
      const path = join(input.home, `events-${name}.jsonl`);
      events[name] = path;
      const start = Date.now();
      const { wedged: stuck, ...run } = await runScenario(client, input, name, choice.model, modelLabel, path, input.maxCredits - total.credits);
      entries.push({ name, run, start });
      const cost = scenarioCost(run.events);
      total.premiumRequests += cost.premiumRequests;
      total.credits += cost.credits;
      if (run.capped || total.credits > input.maxCredits) stopReason = CREDIT_CAP_SKIP_DETAIL;
      if (stuck) { wedged = true; stopReason ??= RUNTIME_WEDGED_DETAIL; }
    }
  } finally {
    pid ??= runtimePid(client);
    // A wedged runtime would only lose its direct process to stop(): take the
    // tree (hook and MCP children) while the parent still lives.
    if (wedged && pid && isAlive(pid)) killTree(pid);
    let stopped = false;
    try {
      await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()');
      stopped = true;
    } catch { /* fall through to the tree kill and forceStop */ }
    if (!stopped) {
      if (pid && isAlive(pid)) killTree(pid);
      try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'client.forceStop()'); } catch { /* already gone */ }
    }
    if (pid && isAlive(pid)) killTree(pid);
  }

  // Attribute runtime log lines to scenarios by their timestamps, after the
  // runtime stopped: a late SessionEnd line still lands in its own scenario.
  const logText = readAllLogs(logDir);
  const ran = entries.filter((e): e is Extract<ScenarioEntry, { run: unknown }> => 'run' in e);
  const slices = logText === null ? [] : sliceLogByTime(logText, ran.map((e) => e.start));
  for (const entry of entries) {
    if ('skip' in entry) { checks.push(...skippedScenarioChecks(entry.name, entry.skip)); continue; }
    const logSlice = logText === null ? null : slices[ran.indexOf(entry)];
    checks.push(...evaluateScenario({ ...entry.run, logText: logSlice }).checks);
  }
  return { checks, sdk: sdkInfo, cost: total, events };
}

async function staticChecks(client: SdkClientLike, input: SdkTierInput): Promise<SmokeCheck[]> {
  let session: SdkSessionLike | undefined;
  const failAll = (detail: string): SmokeCheck[] => ['sdk.plugins', 'sdk.skills', 'sdk.agents', 'sdk.mcp', 'sdk.tools_excluded'].map((id) => ({ id, ok: false, detail }));
  try {
    try {
      session = await withTimeout(client.createSession({
        onPermissionRequest: () => reject('omg smoke: static checks grant nothing'),
        pluginDirectories: [input.root],
        workingDirectory: input.projectDir,
        disabledMcpServers: ['github-mcp-server'],
        excludedTools: [hostSmokeToolName(input.mcpServer)],
      }), RPC_TIMEOUT_MS, 'createSession()');
    } catch (err) {
      return failAll(`static session not created: ${excerpt(errText(err), 200)}`);
    }
    const s = session;
    // The plugin MCP server connects asynchronously after createSession.
    let mcp = await rpc(() => s.rpc.mcp.list(), 'mcp.list');
    const deadline = Date.now() + MCP_CONNECT_WAIT_MS;
    const status = () => (mcp.ok ? (mcp.value as { servers?: Array<{ name?: string; status?: string }> }).servers?.find((x) => x.name === input.mcpServer)?.status : undefined);
    while (mcp.ok && status() !== 'connected' && status() !== 'failed' && Date.now() < deadline) {
      await sleep(500);
      mcp = await rpc(() => s.rpc.mcp.list(), 'mcp.list');
    }
    const [plugins, skills, agents, tools, toolMeta] = [
      await rpc(() => s.rpc.plugins.list(), 'plugins.list'),
      await rpc(() => s.rpc.skills.list(), 'skills.list'),
      await rpc(() => s.rpc.agent.list(), 'agent.list'),
      await rpc(() => s.rpc.mcp.listTools({ serverName: input.mcpServer }), 'mcp.listTools'),
      await rpc(() => currentToolMetadata(s), 'tools.getCurrentMetadata'),
    ];
    let expected: number | string;
    try { expected = await input.loadExpectedToolCount(); } catch (err) { expected = errText(err); }
    return [
      evaluateSdkPlugins(plugins, input.packageVersion),
      evaluateSdkSkills(skills, input.root, input.skillDirs),
      evaluateSdkAgents(agents, input.agentFiles),
      evaluateSdkMcp(mcp, tools, input.mcpServer, expected),
      evaluateSdkToolsExcluded(toolMeta, input.mcpServer),
    ];
  } finally {
    if (session) await closeSession(client, session, input.keepHome);
  }
}

/** The session's offered tools (no model call); initializes the tool set first when it is not built yet. */
async function currentToolMetadata(session: SdkSessionLike): Promise<unknown> {
  const tools = session.rpc.tools;
  if (!tools?.getCurrentMetadata) throw new Error('session.rpc.tools.getCurrentMetadata is not available in this SDK');
  let meta = await tools.getCurrentMetadata();
  const list = (meta as { tools?: unknown } | null)?.tools;
  // Before the first turn the runtime reports `tools: []` (CLI 1.0.91), not null.
  if ((!Array.isArray(list) || list.length === 0) && tools.initializeAndValidate) {
    await tools.initializeAndValidate();
    meta = await tools.getCurrentMetadata();
  }
  return meta;
}

async function closeSession(client: SdkClientLike, session: SdkSessionLike, keepHome: boolean): Promise<void> {
  try { await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()'); } catch { /* runtime gone */ }
  // deleteSession is an RPC, so it runs before client.stop(); with keepHome the on-disk session state stays for debugging.
  if (!keepHome) {
    try { await withTimeout(client.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()'); } catch { /* best effort */ }
  }
}

/**
 * One scenario session. Ends at session.idle, at the timeout, or when its
 * `assistant.usage` credits pass `budget` (the run cap minus what earlier
 * scenarios spent); the last two abort the turn. `wedged`: no idle even after
 * the abort grace, so the caller stops driving this runtime.
 */
async function runScenario(
  client: SdkClientLike,
  input: SdkTierInput,
  name: Scenario,
  model: string | undefined,
  modelLabel: string,
  eventsPath: string,
  budget: number,
): Promise<Omit<ScenarioRun, 'logText'> & { wedged: boolean }> {
  const spec = SCENARIOS[name];
  const permitCtx = { projectDir: input.projectDir, pluginRoot: input.root, ...(input.platform ? { platform: input.platform } : {}) };
  const recorded: CopilotEvent[] = [];
  let sent = false;
  let onIdle: () => void = () => {};
  let onShutdown: () => void = () => {};
  let onCap: () => void = () => {};
  const idle = new Promise<void>((r) => { onIdle = r; });
  const shutdown = new Promise<void>((r) => { onShutdown = r; });
  const capHit = new Promise<void>((r) => { onCap = r; });
  let session: SdkSessionLike | undefined;
  let idleSeen = false;
  let timedOut = false;
  let capped = false;
  let wedged = false;
  let spent = 0;
  let error: string | undefined;

  try {
    session = await withTimeout(client.createSession({
      onPermissionRequest: (req) => (spec.permit(req, permitCtx) ? { kind: 'approve-once' } : reject(`omg smoke ${name}: ${req.kind ?? 'request'} not permitted`)),
      onEvent: (event) => {
        recorded.push(event);
        if (event.type === 'session.idle' && sent) onIdle();
        if (event.type === 'session.shutdown') onShutdown();
        spent += usageCredits(event);
        if (!capped && spent > budget) { capped = true; onCap(); }
      },
      pluginDirectories: [input.root],
      workingDirectory: input.projectDir,
      disabledMcpServers: ['github-mcp-server'],
      excludedTools: scenarioExcludedTools(name, input.mcpServer),
      ...(model ? { model } : {}),
    }), RPC_TIMEOUT_MS, 'createSession()');
    sent = true;
    await withTimeout(session.send({ prompt: spec.prompt }), RPC_TIMEOUT_MS, 'send()');
    const winner = await Promise.race([
      idle.then(() => 'idle' as const),
      capHit.then(() => 'cap' as const),
      sleep(input.timeoutMs).then(() => 'timeout' as const),
    ]);
    if (winner === 'idle') {
      idleSeen = true;
    } else {
      if (winner === 'timeout') timedOut = true;
      const s = session;
      try { await withTimeout(s.abort(), RPC_TIMEOUT_MS, 'abort()'); } catch { /* best effort */ }
      const settled = await Promise.race([idle.then(() => true), sleep(ABORT_GRACE_MS).then(() => false)]);
      wedged = !settled;
    }
  } catch (err) {
    error = errText(err);
  } finally {
    if (session) {
      try { await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()'); } catch { /* runtime gone */ }
      // session.shutdown (the billing totals) is emitted while the session closes.
      await Promise.race([shutdown, sleep(SHUTDOWN_GRACE_MS)]);
      if (!input.keepHome) {
        try { await withTimeout(client.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()'); } catch { /* best effort */ }
      }
    }
    try { writeFileSync(eventsPath, recorded.map((e) => JSON.stringify(e)).join('\n') + (recorded.length ? '\n' : '')); } catch { /* best effort */ }
  }

  return {
    name,
    events: recorded,
    idle: idleSeen,
    timedOut,
    timeoutMs: input.timeoutMs,
    ...(error ? { error } : {}),
    ...(name === 'guardrail' ? { remoteRefs: remoteRefs(input.spawnSync, input.remoteDir, input.env) } : {}),
    model: modelLabel,
    maxCredits: input.maxCredits,
    budget,
    capped,
    wedged,
  };
}
