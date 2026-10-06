/**
 * `omg smoke copilot` — load-check the oh-my-copilot plugin inside the real
 * GitHub Copilot CLI.
 *
 * Tier 0 makes no model call: manifest/version, generated hooks/agents drift,
 * `plugin list`/`skill list` against `--plugin-dir`, and the standalone MCP
 * server's tools/list. Tier 1 adds one cheap non-interactive session in a
 * throwaway COPILOT_HOME and asserts on its persisted events, debug log and
 * the `.omg/` state our hooks write. Tier 2 replaces that session with
 * `@github/copilot-sdk` static checks and scripted scenarios
 * (src/smoke/copilot-sdk-driver.ts).
 */

import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { buildHostBinarySpawn } from '../cli/tmux-utils.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';
import { parseCopilotVersion, resolveCopilotBinary, type BinaryResolverDeps } from './copilot-binary.js';
import {
  EVIDENCE_MAX,
  evaluateAdapterErrors,
  evaluateEventsLog,
  evaluateHooks,
  evaluateMcpLoaded,
  evaluatePluginsLoaded,
  evaluateSessionExit,
  evaluateStateWritten,
  evaluateSubagent,
  excerpt,
  parseJsonl,
  REQUIRED_HOOK_TYPES,
  TOOL_HOOK_TYPES,
  type SmokeCheck,
} from './copilot-session-eval.js';
import { hasExited, killProcessTree, runAsync, useProcessGroup, type SpawnFn, type SpawnSyncFn } from './process-utils.js';
import { DEFAULT_SCENARIO_TIMEOUT_MS, loadCopilotSdk, runSdkTier, type LoadSdkFn } from './copilot-sdk-driver.js';
import { runChainScenario } from './copilot-chain-scenario.js';
import { DEFAULT_SCENARIOS, failedTier2Checks, KNOWN_SCENARIOS, RUNTIME_MIN_MAX_CREDITS, type Scenario, type ScenarioCost } from './copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity, resolveDefaultPluginRoot } from './copilot-session-env.js';

export {
  buildSessionEnv,
  isStrippedEnvKey,
  LOGIN_SHADOWING_TOKENS,
  loginIdentity,
  resolveDefaultPluginRoot,
  resolvePackageRoot,
  SESSION_SET_ENV,
  SMOKE_SET_ENV,
  STRIPPED_ENV_EXACT,
  STRIPPED_ENV_PREFIXES,
  type SessionEnvOptions,
} from './copilot-session-env.js';

export type { SmokeCheck } from './copilot-session-eval.js';
export type { Scenario } from './copilot-sdk-scenarios.js';
export { ALL_SCENARIOS, DEFAULT_SCENARIOS, KNOWN_SCENARIOS, OPT_IN_SCENARIOS } from './copilot-sdk-scenarios.js';

export type SmokeTier = 0 | 1 | 2;

export interface SmokeOptions {
  /** Default: OMC_PLUGIN_ROOT, else the package root of the running omg. */
  pluginRoot: string;
  /**
   * 0 = load check (no model call); 1 = tier 0 + one live session;
   * 2 = tier 0 + @github/copilot-sdk static checks + {@link SmokeOptions.scenarios}.
   */
  tier: SmokeTier;
  copilotBin?: string;
  /**
   * Tier 1 model. Default {@link DEFAULT_SMOKE_MODEL}. Tier 2: the session
   * model (default: a cheap explicit model from models.list, else auto).
   */
  model?: string;
  /**
   * Tier 1 `--max-ai-credits` (CLI minimum is {@link MIN_MAX_CREDITS}).
   * Tier 2: a cap for the whole run. A scenario whose `assistant.usage`
   * credits pass what is left is aborted, later scenarios are skipped, and the
   * runtime also gets `--max-ai-credits` (raised to the CLI minimum).
   */
  maxCredits?: number;
  /**
   * Per subprocess at tier 0 (default 60 s); the tier 1 session (default 180 s);
   * each tier 2 scenario (default 120 s, then abort). Tier 0 steps of a tier 1/2
   * run keep 60 s. The mcp.list_tools check is fixed at 10 s.
   */
  timeoutMs?: number;
  /** Keep the throwaway COPILOT_HOME and project dir for debugging. */
  keepHome?: boolean;
  /** Tier 1 prompt override. */
  prompt?: string;
  /** Tier 1: use the delegation prompt and add the `subagent.selected` check. */
  delegate?: boolean;
  /** Tier 2 scenarios (default {@link DEFAULT_SCENARIOS}); [] = SDK static checks only, zero model calls. */
  scenarios?: Scenario[];
  env?: NodeJS.ProcessEnv;
  /** Test seams; defaults are the real implementations. */
  deps?: SmokeDeps;
}

export interface SmokeDeps extends BinaryResolverDeps {
  spawn?: SpawnFn;
  spawnSync?: SpawnSyncFn;
  /** Expected standalone MCP tool count (default: tool-registry `allTools.length`). */
  loadExpectedToolCount?: () => Promise<number>;
  randomUUID?: () => string;
  /** Real Copilot config dir to copy the login identity from (default getCopilotConfigDir()). */
  userConfigDir?: string;
  /** Tier 2: resolve @github/copilot-sdk (default {@link loadCopilotSdk}); null = not installed. */
  loadSdk?: LoadSdkFn;
}

export interface SmokeReport {
  ok: boolean;
  tier: SmokeTier;
  pluginRoot: string;
  pluginVersion: string | null;
  copilot: { bin: string | null; version: string | null };
  checks: SmokeCheck[];
  artifacts: SmokeArtifacts;
  durationMs: number;
  skipped?: string;
  /** Tier 2: SDK package and runtime it drove; `model` is the scenario model or `auto`. */
  sdk?: { version: string | null; runtimeVersion: string | null; protocolVersion: number | null; model?: string };
  /** Tier 2: summed over the scenarios (AI credits = nano-AIU / 1e9). */
  cost?: ScenarioCost;
}

/**
 * Paths kept with keepHome (else deleted and omitted). `listHome` is the tier 0
 * COPILOT_HOME used for `plugin list`/`skill list`; `copilotHome` is the tier 1
 * session's COPILOT_HOME (its parent also holds the temp project).
 */
export interface SmokeArtifacts {
  listHome?: string;
  copilotHome?: string;
  eventsLog?: string;
  debugLog?: string;
  stdout?: string;
  /** Tier 2: per-scenario SDK event stream (JSONL) under copilotHome. */
  events?: Partial<Record<Scenario, string>>;
}

/**
 * No default model id: on Copilot CLI 1.0.91 every explicit `--model` tried
 * (gpt-5-mini, gpt-6-luna, claude-sonnet-5) failed with `Model "<id>" from
 * --model flag is not available` before any model call, while omitting the
 * flag lets the CLI auto-pick (it chose mai-code-1.1-flash, a low-price flash
 * model). Cost stays bounded by --max-ai-credits. Pass --model to pin one.
 */
export const DEFAULT_SMOKE_MODEL: string | undefined = undefined;
export const DEFAULT_MAX_CREDITS = 30;
/** Copilot CLI rejects `--max-ai-credits` below this. */
export const MIN_MAX_CREDITS = RUNTIME_MIN_MAX_CREDITS;
export const DEFAULT_TIER0_TIMEOUT_MS = 60_000;
export const DEFAULT_TIER1_TIMEOUT_MS = 180_000;
export const MCP_LIST_TIMEOUT_MS = 10_000;
export const PLUGIN_NAME = 'oh-my-copilot';
export const DELEGATE_AGENT = 'oh-my-copilot:architect';

export const DEFAULT_SMOKE_PROMPT = 'Reply with exactly: SMOKE_OK. Do not use tools.';
export const DELEGATE_SMOKE_PROMPT =
  `Delegate one task to the ${DELEGATE_AGENT} agent: ask it to reply with one line. `
  + 'Then reply with exactly: SMOKE_OK. Do not edit any files.';

/**
 * Copy of the non-interactive permission flags from COPILOT_WORKER_BASE_FLAGS
 * (src/team/model-contract.ts), minus the path/url grants the smoke does not
 * need. Copied rather than imported so the smoke does not pull in team code.
 */
const SMOKE_PERMISSION_FLAGS = ['--allow-all-tools', '--no-ask-user'] as const;

/**
 * Tier 1 session sandboxing (spellings verified against `copilot --help` and
 * `copilot help permissions`, CLI 1.0.91; deny rules beat --allow-all-tools):
 * - never let the model call our own `host_smoke` tool (server `t`) recursively;
 * - no built-in MCP servers (github-mcp-server, githubiq) in the smoke;
 * - the default prompt forbids tools, so also deny shell and file writes.
 *   `--delegate` keeps them, because the subagent hand-off is a tool call.
 */
export function sessionSandboxFlags(delegate: boolean): string[] {
  return [
    '--deny-tool', 't(host_smoke)',
    '--disable-builtin-mcps',
    ...(delegate ? [] : ['--deny-tool', 'shell', '--deny-tool', 'write']),
  ];
}

const TIER0_COPILOT_IDS = ['copilot.binary', 'copilot.plugin_list', 'copilot.skill_list'] as const;

function tier1Ids(delegate: boolean): string[] {
  return [
    'session.exit',
    'session.events',
    ...REQUIRED_HOOK_TYPES.map((t) => `hooks.${t}`),
    ...TOOL_HOOK_TYPES.map((t) => `hooks.${t}`),
    'hooks.adapter_errors',
    'plugins.loaded',
    'mcp.server_loaded',
    'state.written',
    ...(delegate ? ['subagent.selected'] : []),
  ];
}

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function countDirsWith(dir: string, file: string): string[] {
  try {
    return readdirSync(dir).filter((name) => existsSync(join(dir, name, file))).sort();
  } catch {
    return [];
  }
}

function countFiles(dir: string, ext: string): number {
  try { return readdirSync(dir).filter((name) => name.endsWith(ext)).length; } catch { return -1; }
}

/** Extract the first JSON array from CLI output that may carry warnings around it. */
export function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeDir(path: string | undefined): void {
  if (!path) return;
  try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* best effort */ }
}

interface Ctx {
  root: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  spawnSyncFn: SpawnSyncFn;
  deps: SmokeDeps;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Tier 0
// ---------------------------------------------------------------------------

function checkManifest(root: string): { check: SmokeCheck; pluginVersion: string | null; packageVersion: string | null } {
  const manifest = readJson(join(root, 'plugin.json'));
  const pkg = readJson(join(root, 'package.json'));
  const pluginVersion = typeof manifest?.version === 'string' ? manifest.version : null;
  const packageVersion = typeof pkg?.version === 'string' ? pkg.version : null;
  const problems: string[] = [];
  if (!manifest) problems.push('plugin.json missing or not JSON');
  else {
    if (manifest.name !== PLUGIN_NAME) problems.push(`name is ${JSON.stringify(manifest.name)}, expected ${PLUGIN_NAME}`);
    if (!packageVersion) problems.push('package.json version missing');
    else if (pluginVersion !== packageVersion) problems.push(`version ${pluginVersion} != package.json ${packageVersion}`);
  }
  return {
    check: {
      id: 'plugin.manifest',
      ok: problems.length === 0,
      detail: problems.length === 0 ? `${PLUGIN_NAME}@${pluginVersion}` : problems.join('; '),
    },
    pluginVersion,
    packageVersion,
  };
}

function checkGeneratedHooks(ctx: Ctx): SmokeCheck {
  const scripts = ['scripts/copilot/build-hooks.mjs', 'scripts/copilot/build-agents.mjs'];
  const failures: string[] = [];
  const evidence: string[] = [];
  for (const script of scripts) {
    const res = ctx.spawnSyncFn(process.execPath, [script, '--verify'], {
      cwd: ctx.root,
      env: ctx.env,
      encoding: 'utf8',
      timeout: ctx.timeoutMs,
      windowsHide: true,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    if (res.status !== 0) {
      failures.push(`${script} --verify exit ${res.status ?? res.error?.message ?? 'null'}`);
      evidence.push(out);
    }
  }
  return {
    id: 'plugin.hooks',
    ok: failures.length === 0,
    detail: failures.length === 0 ? 'build-hooks and build-agents --verify pass' : failures.join('; '),
    ...(failures.length ? { evidence: excerpt(evidence.join('\n')) } : {}),
  };
}

function checkAgents(root: string): SmokeCheck {
  const source = countFiles(join(root, 'agents'), '.md');
  const generated = countFiles(join(root, 'copilot', 'agents'), '.md');
  const ok = source > 0 && source === generated;
  return {
    id: 'copilot.agents',
    ok,
    detail: `copilot/agents ${generated} vs agents ${source} *.md`,
  };
}

function runCopilotSync(ctx: Ctx, bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const plan = buildHostBinarySpawn(bin, args);
  return ctx.spawnSyncFn(plan.command, plan.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: ctx.timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function checkPluginList(ctx: Ctx, bin: string, env: NodeJS.ProcessEnv, cwd: string, packageVersion: string | null): SmokeCheck {
  const res = runCopilotSync(ctx, bin, ['--plugin-dir', ctx.root, '--no-auto-update', 'plugin', 'list', '--json'], env, cwd);
  const stdout = String(res.stdout ?? '');
  const list = extractJsonArray(stdout);
  if (res.status !== 0 || !list) {
    return { id: 'copilot.plugin_list', ok: false, detail: `plugin list exit ${res.status}${list ? '' : ', no JSON array'}`, evidence: excerpt(`${stdout}${res.stderr ?? ''}`) };
  }
  // A bad --plugin-dir only warns and returns [] with exit 0: assert the exact entry.
  const entry = list.find((p) => (p as { name?: unknown }).name === PLUGIN_NAME) as { version?: unknown; source?: unknown } | undefined;
  const ok = !!entry && entry.version === packageVersion && entry.source === 'external';
  return {
    id: 'copilot.plugin_list',
    ok,
    detail: entry
      ? `${PLUGIN_NAME}@${String(entry.version)} source=${String(entry.source)}${ok ? '' : ` (expected ${packageVersion}, external)`}`
      : `${PLUGIN_NAME} not listed (${list.length} plugin(s))`,
    ...(ok ? {} : { evidence: excerpt(`${stdout}${res.stderr ?? ''}`) }),
  };
}

/** Canonical path for comparisons: realpath (symlinked roots), case-folded on win32. */
function normalizePath(p: string): string {
  let out = resolve(p);
  try { out = realpathSync.native(out); } catch { /* missing path: keep the resolved form */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function checkSkillList(ctx: Ctx, bin: string, env: NodeJS.ProcessEnv, cwd: string): SmokeCheck {
  const expected = countDirsWith(join(ctx.root, 'skills'), 'SKILL.md');
  const res = runCopilotSync(ctx, bin, ['--plugin-dir', ctx.root, '--no-auto-update', 'skill', 'list', '--json'], env, cwd);
  const stdout = String(res.stdout ?? '');
  const list = extractJsonArray(stdout) as Array<{ name?: unknown; source?: unknown; path?: unknown }> | null;
  if (res.status !== 0 || !list) {
    return { id: 'copilot.skill_list', ok: false, detail: `skill list exit ${res.status}${list ? '' : ', no JSON array'}`, evidence: excerpt(`${stdout}${res.stderr ?? ''}`) };
  }
  // Copilot also surfaces plugin `commands/*.md` as plugin skills, so count only
  // plugin-sourced entries whose path is a skills/<dir>.
  const skillsDir = normalizePath(join(ctx.root, 'skills')) + sep;
  const pluginSkills = list.filter((s) => s.source === 'plugin');
  const fromSkillsDir = new Set(pluginSkills
    .filter((s) => typeof s.path === 'string' && normalizePath(s.path).startsWith(skillsDir))
    .map((s) => normalizePath(s.path as string).slice(skillsDir.length).split(/[\\/]/)[0]));
  const missing = expected.filter((d) => !fromSkillsDir.has(process.platform === 'win32' ? d.toLowerCase() : d));
  const ok = expected.length > 0 && missing.length === 0 && fromSkillsDir.size === expected.length;
  return {
    id: 'copilot.skill_list',
    ok,
    detail: `${fromSkillsDir.size}/${expected.length} skills/*/SKILL.md loaded as source=plugin (${pluginSkills.length} plugin entries incl. commands)`,
    ...(ok ? {} : { evidence: excerpt(missing.length ? `missing: ${missing.join(', ')}` : stdout) }),
  };
}

async function defaultExpectedToolCount(): Promise<number> {
  const registry = await import('../mcp/tool-registry.js');
  return registry.allTools.length;
}

async function checkMcpListTools(ctx: Ctx): Promise<SmokeCheck> {
  const id = 'mcp.list_tools';
  const server = join(ctx.root, 'dist', 'mcp', 'standalone-server.js');
  if (!existsSync(server)) return { id, ok: false, detail: `${server} missing; run npm run build` };
  let expected: number;
  try {
    expected = await (ctx.deps.loadExpectedToolCount ?? defaultExpectedToolCount)();
  } catch (err) {
    return { id, ok: false, detail: `could not load tool registry: ${(err as Error).message}` };
  }
  const env = { ...ctx.env };
  delete env.OMC_DISABLE_TOOLS; // compare against the full registry

  return new Promise<SmokeCheck>((resolveCheck) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    const child = ctx.spawnFn(process.execPath, [server], {
      cwd: ctx.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: useProcessGroup(),
    });
    const done = (check: SmokeCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* closed */ }
      if (!hasExited(child)) killProcessTree(child.pid, ctx.spawnSyncFn);
      resolveCheck(check);
    };
    const timer = setTimeout(() => done({ id, ok: false, detail: `no tools/list response within ${MCP_LIST_TIMEOUT_MS} ms`, evidence: excerpt(stderr) }), MCP_LIST_TIMEOUT_MS);
    const send = (msg: unknown) => { try { child.stdin?.write(`${JSON.stringify(msg)}\n`); } catch { /* closed */ } };

    child.on('error', (err) => done({ id, ok: false, detail: `spawn failed: ${err.message}` }));
    child.on('close', (code) => done({ id, ok: false, detail: `server exited (${code}) before tools/list`, evidence: excerpt(stderr) }));
    child.stdin?.on('error', () => { /* server gone */ });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => { if (stderr.length < 64_000) stderr += c; });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: { tools?: unknown[] }; error?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { done({ id, ok: false, detail: 'initialize failed', evidence: excerpt(JSON.stringify(msg.error)) }); return; }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          const tools = msg.result?.tools;
          if (!Array.isArray(tools)) { done({ id, ok: false, detail: 'tools/list returned no tools array', evidence: excerpt(line) }); return; }
          const ok = tools.length === expected;
          done({ id, ok, detail: `tools/list returned ${tools.length}, registry allTools ${expected}${ok ? '' : ' (stale dist? run npm run build)'}` });
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'omg-smoke', version: '1' } },
    });
  });
}

// ---------------------------------------------------------------------------
// Tier 1
// ---------------------------------------------------------------------------

function initProject(ctx: Ctx, projectDir: string, env: NodeJS.ProcessEnv): void {
  const res = ctx.spawnSyncFn('git', ['init', '-q'], { cwd: projectDir, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (res.status !== 0 || !existsSync(join(projectDir, '.git'))) mkdirSync(join(projectDir, '.git'), { recursive: true });
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

/** All process logs under the log dir, newest last, joined; plus the newest path. */
function readDebugLogs(logDir: string): { text: string | null; path?: string } {
  let files: string[];
  try {
    files = readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => join(logDir, f));
  } catch {
    return { text: null };
  }
  if (files.length === 0) return { text: null };
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return { text: files.map((f) => readText(f) ?? '').join('\n'), path: files[files.length - 1] };
}

function mcpServerNames(root: string): string[] {
  const mcp = readJson(join(root, '.mcp.json'));
  const servers = mcp?.mcpServers;
  return servers && typeof servers === 'object' ? Object.keys(servers) : [];
}

/**
 * Run the live session. Registers its temp dir in `cleanup` and its paths in
 * `artifacts` as soon as they exist, so the caller's `finally` removes them
 * even when this throws midway.
 */
async function runTier1(ctx: Ctx, bin: string, opts: SmokeOptions, cleanup: string[], artifacts: SmokeArtifacts): Promise<SmokeCheck[]> {
  // One parent so --keep-home leaves home/ and project/ side by side.
  const parent = makeTempDir('omg-smoke-');
  cleanup.push(parent);
  const home = join(parent, 'home');
  artifacts.copilotHome = home;
  const projectDir = join(parent, 'project');
  mkdirSync(home);
  mkdirSync(projectDir);
  const logDir = join(home, 'logs');
  const sessionId = (ctx.deps.randomUUID ?? randomUUID)();
  const identity = loginIdentity(ctx.deps.userConfigDir ?? getCopilotConfigDir());
  const env = buildSessionEnv(ctx.env, home, { session: true, hasLogin: identity.loggedInUsers !== undefined });
  const config = { ...identity, trustedFolders: [projectDir] };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  initProject(ctx, projectDir, env);

  const prompt = opts.prompt ?? (opts.delegate ? DELEGATE_SMOKE_PROMPT : DEFAULT_SMOKE_PROMPT);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIER1_TIMEOUT_MS;
  const args = [
    '--plugin-dir', ctx.root,
    '--session-id', sessionId,
    '--output-format', 'json',
    ...SMOKE_PERMISSION_FLAGS,
    ...sessionSandboxFlags(!!opts.delegate),
    '--no-auto-update',
    '--log-level', 'debug',
    '--log-dir', logDir,
    ...((opts.model ?? DEFAULT_SMOKE_MODEL) ? ['--model', (opts.model ?? DEFAULT_SMOKE_MODEL) as string] : []),
    '--max-ai-credits', String(opts.maxCredits ?? DEFAULT_MAX_CREDITS),
  ];
  // No -p: `-p <text>` would put the prompt on argv. Piped stdin is the
  // CLI's other non-interactive entry (verified on 1.0.91).
  const plan = buildHostBinarySpawn(bin, args);
  const run = await runAsync(ctx.spawnFn, ctx.spawnSyncFn, plan.command, plan.args, {
    cwd: projectDir,
    env,
    input: `${prompt}\n`,
    timeoutMs,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });

  const stdoutPath = join(home, 'smoke-stdout.jsonl');
  try { writeFileSync(stdoutPath, run.stdout); } catch { /* best effort */ }

  const eventsPath = join(home, 'session-state', sessionId, 'events.jsonl');
  const logs = readDebugLogs(logDir);
  Object.assign(artifacts, { eventsLog: eventsPath, debugLog: logs.path, stdout: stdoutPath });
  return evaluateTier1({
    exitCode: run.code,
    timedOut: run.timedOut,
    error: run.error,
    stdout: run.stdout,
    stderr: run.stderr,
    timeoutMs,
    eventsPath,
    eventsText: readText(eventsPath),
    logText: logs.text,
    projectDir,
    mcpServerNames: mcpServerNames(ctx.root),
    delegate: !!opts.delegate,
  });
}

export interface Tier1Inputs {
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  stdout: string;
  stderr: string;
  timeoutMs: number;
  eventsPath: string;
  eventsText: string | null;
  logText: string | null;
  projectDir: string;
  mcpServerNames: string[];
  delegate: boolean;
}

/** Evaluate captured Tier 1 artifacts (exported for fixture-driven tests). */
export function evaluateTier1(input: Tier1Inputs): SmokeCheck[] {
  const checks: SmokeCheck[] = [];
  checks.push(evaluateSessionExit(input));
  const { check: eventsCheck, events } = evaluateEventsLog(input.eventsPath, input.eventsText);
  checks.push(eventsCheck);
  // Ephemeral events (e.g. MCP status changes) only reach stdout, so evaluate both streams.
  const stdoutEvents = parseJsonl(input.stdout).events;
  const allEvents = [...events, ...stdoutEvents.filter((e) => !e.id || !events.some((p) => p.id === e.id))];
  checks.push(...evaluateHooks(events.length ? events : stdoutEvents));
  checks.push(evaluateAdapterErrors([
    { name: 'debug log', text: input.logText },
    { name: 'session stderr', text: input.stderr },
    { name: 'events.jsonl', text: input.eventsText },
    { name: 'stdout', text: input.stdout },
  ]));
  checks.push(evaluatePluginsLoaded(input.logText));
  checks.push(evaluateMcpLoaded(allEvents, input.logText, input.mcpServerNames.length ? input.mcpServerNames : ['t']));
  checks.push(evaluateStateWritten(input.projectDir));
  if (input.delegate) checks.push(evaluateSubagent(allEvents, DELEGATE_AGENT));
  return checks.map((c) => (c.evidence && c.evidence.length > EVIDENCE_MAX ? { ...c, evidence: excerpt(c.evidence) } : c));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const LIVE_RUN_REFUSED_DETAIL = 'live run refused under vitest — set OMC_LIVE_SMOKE=1 (tier 1) / =2 (tier 2 scenarios)';

/**
 * Hard no-billing guard: under a test runner (`VITEST` or `NODE_ENV=test` in
 * the real process env) a run that would call a model (tier 1; tier 2 with
 * any scenario, the default included) is refused before any subprocess or SDK
 * client, unless `OMC_LIVE_SMOKE` names that tier or the test injected the
 * seam that would otherwise bill (`deps.spawn` at tier 1, `deps.loadSdk` at
 * tier 2). Returns the refusal detail, or null to proceed.
 */
export function liveRunRefusal(tier: SmokeTier, scenarios: Scenario[] | undefined, deps: SmokeDeps, env: NodeJS.ProcessEnv = process.env): string | null {
  const underTest = !!env.VITEST || env.NODE_ENV === 'test';
  if (!underTest) return null;
  const billable = tier === 1 || (tier === 2 && (scenarios ?? DEFAULT_SCENARIOS).length > 0);
  if (!billable) return null;
  if (env.OMC_LIVE_SMOKE === String(tier)) return null;
  if ((tier === 1 && deps.spawn) || (tier === 2 && deps.loadSdk)) return null;
  return LIVE_RUN_REFUSED_DETAIL;
}

export async function runCopilotSmoke(input: Partial<SmokeOptions> = {}): Promise<SmokeReport> {
  const started = Date.now();
  const env = input.env ?? process.env;
  const deps = input.deps ?? {};
  const tier: SmokeTier = input.tier === 1 || input.tier === 2 ? input.tier : 0;
  const root = resolve(input.pluginRoot ?? resolveDefaultPluginRoot(env));
  const opts: SmokeOptions = { ...input, pluginRoot: root, tier };

  if (opts.prompt !== undefined && /\0/.test(opts.prompt)) throw new Error('smoke prompt must not contain NUL');
  const unknown = (opts.scenarios ?? []).filter((s) => !KNOWN_SCENARIOS.includes(s));
  if (unknown.length) throw new Error(`unknown smoke scenario(s): ${unknown.join(', ')} (known: ${KNOWN_SCENARIOS.join(', ')})`);

  const refusal = liveRunRefusal(tier, opts.scenarios, deps);
  if (refusal) {
    return {
      ok: false,
      tier,
      pluginRoot: root,
      pluginVersion: null,
      copilot: { bin: null, version: null },
      checks: [{ id: 'cli.guard', ok: false, detail: refusal }],
      artifacts: {},
      durationMs: Date.now() - started,
      skipped: refusal,
    };
  }

  const ctx: Ctx = {
    root,
    env: { ...env },
    spawnFn: deps.spawn ?? spawn,
    spawnSyncFn: deps.spawnSync ?? spawnSync,
    deps,
    timeoutMs: tier === 0 ? (opts.timeoutMs ?? DEFAULT_TIER0_TIMEOUT_MS) : DEFAULT_TIER0_TIMEOUT_MS,
  };

  const checks: SmokeCheck[] = [];
  const artifacts: SmokeArtifacts = {};
  const cleanup: string[] = [];
  try {
    return await runChecks(ctx, opts, started, checks, artifacts, cleanup);
  } finally {
    if (!opts.keepHome) {
      for (const dir of cleanup) removeDir(dir);
      for (const key of Object.keys(artifacts) as Array<keyof SmokeArtifacts>) delete artifacts[key];
    }
  }
}

async function runChecks(
  ctx: Ctx,
  opts: SmokeOptions,
  started: number,
  checks: SmokeCheck[],
  artifacts: SmokeArtifacts,
  cleanup: string[],
): Promise<SmokeReport> {
  const { root, deps, env } = ctx;
  const tier = opts.tier;
  let skipped: string | undefined;

  const manifest = checkManifest(root);
  checks.push(manifest.check);
  checks.push(checkGeneratedHooks(ctx));

  const resolution = resolveCopilotBinary(opts.copilotBin, env, deps);
  let version: string | null = null;
  if (!resolution.bin) {
    skipped = opts.copilotBin
      ? `copilot binary not found: ${opts.copilotBin}`
      : (deps.platform ?? process.platform) === 'win32'
        ? 'copilot binary not found on PATH, COPILOT_CLI_PATH, or the WinGet package dir'
        : 'copilot binary not found on PATH or COPILOT_CLI_PATH (npm i -g @github/copilot)';
    checks.push({ id: 'copilot.binary', ok: false, detail: skipped });
    for (const id of TIER0_COPILOT_IDS.slice(1)) checks.push({ id, ok: false, detail: 'skipped' });
  } else {
    const bin = resolution.bin;
    // cwd is tmpdir, not the plugin root: a missing --plugin-root must not
    // surface as an ENOENT on the binary probe.
    const res = runCopilotSync(ctx, bin, ['--version'], ctx.env, tmpdir());
    version = parseCopilotVersion(String(res.stdout ?? ''));
    const binaryOk = res.status === 0 && version !== null;
    checks.push({
      id: 'copilot.binary',
      ok: binaryOk,
      detail: binaryOk ? `${bin} (${resolution.source}) v${version}` : `${bin} --version exit ${res.status ?? res.error?.message}`,
      ...(binaryOk ? {} : { evidence: excerpt(`${res.stdout ?? ''}${res.stderr ?? ''}`) }),
    });

    const listHome = makeTempDir('omg-smoke-list-');
    cleanup.push(listHome);
    artifacts.listHome = listHome;
    const listEnv = buildSessionEnv(ctx.env, listHome);
    checks.push(checkPluginList(ctx, bin, listEnv, listHome, manifest.packageVersion));
    checks.push(checkSkillList(ctx, bin, listEnv, listHome));
  }

  checks.push(checkAgents(root));
  checks.push(await checkMcpListTools(ctx));

  if (tier === 1) {
    if (!resolution.bin) {
      for (const id of tier1Ids(!!opts.delegate)) checks.push({ id, ok: false, detail: 'skipped' });
    } else {
      checks.push(...await runTier1(ctx, resolution.bin, opts, cleanup, artifacts));
    }
  }

  let tier2: Awaited<ReturnType<typeof runTier2>> | undefined;
  if (tier === 2) {
    const scenarios = [...new Set(opts.scenarios ?? DEFAULT_SCENARIOS)];
    if (!resolution.bin) {
      checks.push(...failedTier2Checks(scenarios, 'skipped'));
    } else {
      tier2 = await runTier2(ctx, resolution.bin, version, manifest.packageVersion, opts, scenarios, cleanup, artifacts);
      checks.push(...tier2.checks);
      skipped ??= tier2.skipped;
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    tier,
    pluginRoot: root,
    pluginVersion: manifest.pluginVersion,
    copilot: { bin: resolution.bin, version },
    checks,
    artifacts,
    durationMs: Date.now() - started,
    ...(skipped ? { skipped } : {}),
    ...(tier2?.sdk ? { sdk: tier2.sdk } : {}),
    ...(tier2?.cost ? { cost: tier2.cost } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

/**
 * Same isolation as tier 1 (throwaway COPILOT_HOME with the copied login
 * identity and trustedFolders, {@link buildSessionEnv} with
 * OMC_HOOK_FAIL_CLOSED=1), driven through one SDK client. Env is per client,
 * so OMC_GIT_GUARDRAILS=1 holds for every scenario; only the guardrail
 * scenario is permitted a shell, so the others never reach the guardrail.
 */
async function runTier2(
  ctx: Ctx,
  bin: string,
  binVersion: string | null,
  packageVersion: string | null,
  opts: SmokeOptions,
  scenarios: Scenario[],
  cleanup: string[],
  artifacts: SmokeArtifacts,
) {
  const parent = makeTempDir('omg-smoke-sdk-');
  cleanup.push(parent);
  const home = join(parent, 'home');
  const projectDir = join(parent, 'project');
  mkdirSync(home);
  artifacts.copilotHome = home;
  const identity = loginIdentity(ctx.deps.userConfigDir ?? getCopilotConfigDir());
  const env = buildSessionEnv(ctx.env, home, { session: true, hasLogin: identity.loggedInUsers !== undefined });
  env.OMC_GIT_GUARDRAILS = '1';
  writeFileSync(join(home, 'config.json'), `${JSON.stringify({ ...identity, trustedFolders: [projectDir] }, null, 2)}\n`);

  let agentFiles: string[] = [];
  try { agentFiles = readdirSync(join(ctx.root, 'agents')).filter((f) => f.endsWith('.md')).sort(); } catch { /* evaluated as 0 */ }
  const result = await runSdkTier({
    root: ctx.root,
    bin,
    binVersion,
    packageVersion,
    home,
    projectDir,
    remoteDir: join(parent, 'remote.git'),
    env,
    scenarios,
    model: opts.model,
    timeoutMs: opts.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
    maxCredits: opts.maxCredits ?? DEFAULT_MAX_CREDITS,
    keepHome: !!opts.keepHome,
    loadSdk: ctx.deps.loadSdk ?? (() => loadCopilotSdk(ctx.env, ctx.spawnSyncFn)),
    loadExpectedToolCount: ctx.deps.loadExpectedToolCount ?? defaultExpectedToolCount,
    spawnSync: ctx.spawnSyncFn,
    skillDirs: countDirsWith(join(ctx.root, 'skills'), 'SKILL.md'),
    agentFiles,
    mcpServer: mcpServerNames(ctx.root)[0] ?? 't',
    runChain: runChainScenario,
  });
  if (Object.keys(result.events).length) artifacts.events = result.events;
  const logs = readDebugLogs(join(home, 'logs'));
  if (logs.path) artifacts.debugLog = logs.path;
  return result;
}
