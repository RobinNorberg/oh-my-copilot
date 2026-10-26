/**
 * `omg hooks doctor [--json] [--plugin-root <dir>] [--event <name>] [--no-dispatch]`:
 * check the Copilot hook wiring the way Copilot CLI runs it.
 *
 * - node on PATH: every copilot/hooks.json entry execs `node`;
 * - copilot/hooks.json in sync with scripts/copilot/build-hooks.mjs (read only);
 * - every script path an entry names exists;
 * - a dry dispatch of each entry with a recorded Copilot payload, timed, with
 *   its stderr. Copilot only writes hook stderr to its debug log, so this is
 *   where adapter errors (`[omg-hook]` lines) become visible;
 * - the installed Copilot CLI against the version the fork targets.
 *
 * The dry dispatch runs the real hooks in a throwaway project and home
 * (HOME, USERPROFILE and COPILOT_HOME point into it, the smoke env policy
 * strips OMC_* switches), so no user state or notification config is touched.
 * Exit codes: 0 no check failed (warnings allowed), 1 a check failed.
 */

import { spawnSync as nodeSpawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { Command } from 'commander';
import { buildHostBinarySpawn } from '../tmux-utils.js';
import { colors } from '../utils/formatting.js';
import {
  compareCopilotVersions,
  LATEST_DOCUMENTED_COPILOT_VERSION,
  parseCopilotVersion,
  resolveCopilotBinary,
  TARGET_COPILOT_VERSION,
  type BinaryResolverDeps,
} from '../../smoke/copilot-binary.js';
import {
  COPILOT_HOOKS_PATH,
  DEFAULT_ENTRY_TIMEOUT_SEC,
  dispatchHookEntry,
  entryMatches,
  PLUGIN_ROOT_TOKEN,
  readCopilotHookManifest,
  resolveEntryArgs,
  type CopilotHookEntry,
  type CopilotHookManifest,
} from '../../smoke/copilot-hook-manifest.js';
import { buildSessionEnv, resolveDefaultPluginRoot } from '../../smoke/copilot-session-env.js';
import type { SpawnSyncFn } from '../../smoke/process-utils.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface HooksDoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
  evidence?: string;
}

export interface HooksDoctorReport {
  ok: boolean;
  pluginRoot: string;
  checks: HooksDoctorCheck[];
}

export interface HooksDoctorOptions {
  pluginRoot?: string;
  /** false: skip the dry dispatch (no hook runs). */
  dispatch?: boolean;
  /** Dispatch only this event (PascalCase key of copilot/hooks.json). */
  event?: string;
  env?: NodeJS.ProcessEnv;
  deps?: HooksDoctorDeps;
}

export interface HooksDoctorDeps extends BinaryResolverDeps {
  spawnSync?: SpawnSyncFn;
  /** The generator's rendering of hooks/hooks.json (default: scripts/copilot/build-hooks.mjs). */
  renderHooks?: (root: string, sourceText: string) => Promise<string>;
  randomUUID?: () => string;
}

const EVIDENCE_MAX = 600;
/** A dry run slower than this share of its entry's timeout is a warning: a cold or busy host could time it out. */
const SLOW_FRACTION = 0.8;
const clip = (text: string) => (text.length > EVIDENCE_MAX ? `${text.slice(0, EVIDENCE_MAX)}…` : text);

/**
 * Hook payloads as Copilot CLI 1.0.91 sent them to our PascalCase
 * registrations (live probe 2026-10-23): snake_case Claude-format payloads,
 * except PermissionRequest and SubagentStart, which stay camelCase. `tool`
 * is the Claude tool name an entry matcher is tested against (Copilot maps
 * powershell to Bash before matching).
 */
export function doctorPayloads(project: string, sessionId: string, now: Date = new Date()): Record<string, Array<{ tool?: string; payload: Record<string, unknown> }>> {
  const ts = now.toISOString();
  const base = { session_id: sessionId, timestamp: ts, cwd: project };
  const missing = join(project, 'omg-hooks-doctor-missing.txt');
  const readme = join(project, 'README.md');
  return {
    UserPromptSubmit: [{ payload: { hook_event_name: 'UserPromptSubmit', ...base, prompt: 'omg hooks doctor dry run: reply ok' } }],
    SessionStart: [{ payload: { hook_event_name: 'SessionStart', ...base, source: 'new', initial_prompt: 'omg hooks doctor dry run: reply ok' } }],
    PreToolUse: [{ tool: 'Bash', payload: { hook_event_name: 'PreToolUse', ...base, tool_name: 'Bash', tool_input: { command: 'echo omg-hooks-doctor', description: 'doctor dry run' } } }],
    PermissionRequest: [{ tool: 'Bash', payload: { hookName: 'permissionRequest', sessionId, timestamp: now.getTime(), cwd: project, toolName: 'powershell', toolInput: { command: 'echo omg-hooks-doctor' }, permissionSuggestions: [] } }],
    PostToolUse: [
      { tool: 'Bash', payload: { hook_event_name: 'PostToolUse', ...base, tool_name: 'Bash', tool_input: { command: 'echo omg-hooks-doctor', description: 'doctor dry run' }, tool_result: { result_type: 'success', text_result_for_llm: 'omg-hooks-doctor\n<shellId: 0 completed with exit code 0>' } } },
      { tool: 'Read', payload: { hook_event_name: 'PostToolUse', ...base, tool_name: 'Read', tool_input: { path: readme }, tool_result: { result_type: 'success', text_result_for_llm: '1. # omg hooks doctor' } } },
    ],
    PostToolUseFailure: [{ tool: 'Read', payload: { hook_event_name: 'PostToolUseFailure', ...base, tool_name: 'Read', tool_input: { path: missing }, error: 'Path does not exist' } }],
    SubagentStart: [{ payload: { sessionId, timestamp: now.getTime(), cwd: project, agentName: 'explore' } }],
    SubagentStop: [{ payload: { hook_event_name: 'SubagentStop', ...base, agent_id: `${sessionId}-child`, agent_type: 'explore', agent_name: 'explore', last_assistant_message: 'ok', stop_reason: 'end_turn' } }],
    PreCompact: [{ payload: { hook_event_name: 'PreCompact', ...base, trigger: 'manual', custom_instructions: '' } }],
    Stop: [{ payload: { hook_event_name: 'Stop', ...base, stop_reason: 'end_turn', stop_hook_active: false } }],
    SessionEnd: [{ payload: { hook_event_name: 'SessionEnd', ...base, reason: 'complete' } }],
    Notification: [{ payload: { hook_event_name: 'Notification', sessionId, timestamp: now.getTime(), cwd: project, title: 'Shell completed', message: 'omg hooks doctor', notification_type: 'shell_completed' } }],
  };
}

function checkNode(spawnSync: SpawnSyncFn, env: NodeJS.ProcessEnv): HooksDoctorCheck {
  const res = spawnSync('node', ['--version'], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const version = String(res.stdout ?? '').trim();
  if (res.status === 0 && /^v\d+/.test(version)) return { id: 'node.path', status: 'ok', detail: `node ${version} on PATH` };
  return {
    id: 'node.path',
    status: 'fail',
    detail: `\`node\` is not runnable from PATH (${res.error?.message ?? `exit ${String(res.status)}`}); every copilot/hooks.json entry execs node, so no hook runs`,
  };
}

function checkCopilotVersion(env: NodeJS.ProcessEnv, deps: HooksDoctorDeps, spawnSync: SpawnSyncFn): HooksDoctorCheck {
  const id = 'copilot.version';
  const { bin, source } = resolveCopilotBinary(undefined, env, deps);
  if (!bin) return { id, status: 'warn', detail: `copilot not found (PATH, COPILOT_CLI_PATH, WinGet); the fork targets ${TARGET_COPILOT_VERSION}` };
  const plan = buildHostBinarySpawn(bin, ['--version']);
  const res = spawnSync(plan.command, plan.args, { env, encoding: 'utf8', timeout: 30_000, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments });
  const version = parseCopilotVersion(String(res.stdout ?? ''));
  if (!version) return { id, status: 'warn', detail: `${bin} (${source}) --version gave no version`, evidence: clip(`${res.stdout ?? ''}${res.stderr ?? ''}`) };
  const cmp = compareCopilotVersions(version, TARGET_COPILOT_VERSION);
  const target = `target ${TARGET_COPILOT_VERSION}, latest documented ${LATEST_DOCUMENTED_COPILOT_VERSION}`;
  if (cmp === 0) return { id, status: 'ok', detail: `copilot ${version} (${target})` };
  return {
    id,
    status: 'warn',
    detail: cmp > 0
      ? `copilot ${version} is newer than the verified target (${target}); hook behaviour past ${TARGET_COPILOT_VERSION} is unverified`
      : `copilot ${version} is older than the verified target (${target})`,
  };
}

async function defaultRenderHooks(root: string, sourceText: string): Promise<string> {
  const mod = await import(pathToFileURL(join(root, 'scripts', 'copilot', 'build-hooks.mjs')).href) as { renderCopilotHooks: (text: string) => string };
  return mod.renderCopilotHooks(sourceText);
}

async function checkManifestSync(root: string, deps: HooksDoctorDeps): Promise<HooksDoctorCheck> {
  const id = 'manifest.sync';
  const generated = join(root, COPILOT_HOOKS_PATH);
  let onDisk: string;
  let source: string;
  try { onDisk = readFileSync(generated, 'utf-8'); } catch { return { id, status: 'fail', detail: `${generated} missing` }; }
  try { source = readFileSync(join(root, 'hooks', 'hooks.json'), 'utf-8'); } catch { return { id, status: 'warn', detail: 'hooks/hooks.json missing; sync not checked' }; }
  let rendered: string;
  try {
    rendered = await (deps.renderHooks ?? defaultRenderHooks)(root, source);
  } catch (err) {
    return { id, status: 'fail', detail: `scripts/copilot/build-hooks.mjs failed: ${(err as Error).message}` };
  }
  if (rendered === onDisk) return { id, status: 'ok', detail: `${COPILOT_HOOKS_PATH} matches scripts/copilot/build-hooks.mjs output` };
  return { id, status: 'fail', detail: `${COPILOT_HOOKS_PATH} differs from scripts/copilot/build-hooks.mjs output (a stale or edited install; regenerate with node scripts/copilot/build-hooks.mjs --write)` };
}

function checkScripts(manifest: CopilotHookManifest, root: string): HooksDoctorCheck {
  const missing = new Set<string>();
  let count = 0;
  for (const entries of Object.values(manifest.hooks)) {
    for (const entry of entries) {
      entry.args.forEach((arg, i) => {
        if (!arg.includes(PLUGIN_ROOT_TOKEN)) return;
        count++;
        const path = resolveEntryArgs(entry, root)[i];
        if (!existsSync(path)) missing.add(path);
      });
    }
  }
  return missing.size === 0
    ? { id: 'scripts.exist', status: 'ok', detail: `all ${count} script paths in ${COPILOT_HOOKS_PATH} exist` }
    : { id: 'scripts.exist', status: 'fail', detail: `${missing.size} script path(s) missing`, evidence: clip([...missing].join('\n')) };
}

/** Verdict for one dispatched entry: a failure, a hook that wrote stderr (warn), or clean. */
function dispatchCheck(event: string, entry: CopilotHookEntry, result: ReturnType<typeof dispatchHookEntry>): HooksDoctorCheck {
  const id = `dispatch.${event}${entry.matcher ? `[${entry.matcher}]` : ''}`;
  const limit = `${entry.timeoutSec ?? 'default'} s timeout`;
  const stdout = result.stdout.trim();
  let keys = '';
  let badJson = false;
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).join(', ') : typeof parsed;
    } catch { badJson = true; }
  }
  const stderr = result.stderr.trim();
  const timing = `${result.durationMs} ms (${limit})`;
  if (result.error) return { id, status: 'fail', detail: `could not start ${entry.exec}: ${result.error}` };
  if (result.timedOut) return { id, status: 'fail', detail: `timed out after ${timing}`, ...(stderr ? { evidence: clip(stderr) } : {}) };
  if (result.status !== 0) return { id, status: 'fail', detail: `exit ${String(result.status)} in ${timing}`, ...(stderr ? { evidence: clip(stderr) } : {}) };
  if (badJson) return { id, status: 'fail', detail: `stdout is not JSON (Copilot would drop it) in ${timing}`, evidence: clip(stdout) };
  const out = stdout ? `output {${keys}}` : 'no output';
  if (stderr) return { id, status: 'warn', detail: `exit 0 in ${timing}, ${out}; stderr (only in Copilot's debug log):`, evidence: clip(stderr) };
  const budgetMs = (entry.timeoutSec ?? DEFAULT_ENTRY_TIMEOUT_SEC) * 1000;
  if (result.durationMs > budgetMs * SLOW_FRACTION) return { id, status: 'warn', detail: `exit 0 in ${timing}, ${out}; used over ${SLOW_FRACTION * 100}% of the timeout` };
  return { id, status: 'ok', detail: `exit 0 in ${timing}, ${out}` };
}

function dispatchChecks(manifest: CopilotHookManifest, root: string, env: NodeJS.ProcessEnv, spawnSync: SpawnSyncFn, deps: HooksDoctorDeps, only?: string): HooksDoctorCheck[] {
  const events = Object.keys(manifest.hooks).filter((e) => !only || e === only);
  if (only && events.length === 0) return [{ id: `dispatch.${only}`, status: 'fail', detail: `${COPILOT_HOOKS_PATH} registers no ${only} (events: ${Object.keys(manifest.hooks).join(', ')})` }];
  const parent = mkdtempSync(join(tmpdir(), 'omg-hooks-doctor-'));
  const checks: HooksDoctorCheck[] = [];
  try {
    const home = join(parent, 'home');
    const project = join(parent, 'project');
    mkdirSync(home);
    mkdirSync(project);
    spawnSync('git', ['init', '-q'], { cwd: project, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    writeFileSync(join(project, 'README.md'), '# omg hooks doctor\n');
    const sandboxEnv = { ...buildSessionEnv(env, join(home, '.copilot')), HOME: home, USERPROFILE: home };
    const payloads = doctorPayloads(project, `omg-hooks-doctor-${(deps.randomUUID ?? randomUUID)()}`);
    for (const event of events) {
      for (const entry of manifest.hooks[event]) {
        const variants = payloads[event] ?? [];
        const variant = variants.find((v) => entryMatches(entry, v.tool)) ?? variants[0];
        if (!variant) {
          checks.push({ id: `dispatch.${event}`, status: 'warn', detail: 'no recorded payload for this event; not dispatched' });
          continue;
        }
        checks.push(dispatchCheck(event, entry, dispatchHookEntry(event, entry, root, variant.payload, { cwd: project, env: sandboxEnv, spawnSync })));
      }
    }
    return checks;
  } finally {
    // Hook sqlite DBs or a detached SessionEnd worker may still hold the dir on win32: retry
    // with a linear backoff (~5 s in total), then report the leftover instead of hiding it.
    try {
      rmSync(parent, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch (err) {
      checks.push({ id: 'dispatch.cleanup', status: 'warn', detail: `could not remove the sandbox ${parent}: ${(err as Error).message}` });
    }
  }
}

export async function runHooksDoctor(opts: HooksDoctorOptions = {}): Promise<HooksDoctorReport> {
  const env = opts.env ?? process.env;
  const deps = opts.deps ?? {};
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const root = resolve(opts.pluginRoot ?? resolveDefaultPluginRoot(env));
  const checks: HooksDoctorCheck[] = [];

  const node = checkNode(spawnSync, env);
  checks.push(node);
  checks.push(checkCopilotVersion(env, deps, spawnSync));
  checks.push(await checkManifestSync(root, deps));
  let manifest: CopilotHookManifest | null = null;
  try {
    manifest = readCopilotHookManifest(root);
  } catch (err) {
    checks.push({ id: 'scripts.exist', status: 'fail', detail: `cannot read ${COPILOT_HOOKS_PATH}: ${(err as Error).message}` });
  }
  if (manifest) {
    checks.push(checkScripts(manifest, root));
    if (opts.dispatch !== false) {
      if (node.status === 'fail') checks.push({ id: 'dispatch', status: 'fail', detail: 'skipped: node is not on PATH' });
      else checks.push(...dispatchChecks(manifest, root, env, spawnSync, deps, opts.event));
    }
  }
  return { ok: checks.every((c) => c.status !== 'fail'), pluginRoot: root, checks };
}

const MARK: Record<DoctorStatus, string> = { ok: colors.green('ok  '), warn: colors.yellow('WARN'), fail: colors.red('FAIL') };

export function formatHooksDoctorReport(report: HooksDoctorReport): string {
  const lines = [`omg hooks doctor — plugin at ${report.pluginRoot}`];
  for (const c of report.checks) {
    lines.push(`${MARK[c.status]} ${c.id}: ${c.detail}`);
    if (c.evidence) for (const l of c.evidence.split(/\r?\n/)) lines.push(`       ${l}`);
  }
  const counts = (s: DoctorStatus) => report.checks.filter((c) => c.status === s).length;
  lines.push(`${counts('ok')} ok, ${counts('warn')} warning(s), ${counts('fail')} failure(s)`);
  return lines.join('\n');
}

export interface HooksDoctorCliOptions {
  json?: boolean;
  pluginRoot?: string;
  event?: string;
  /** Commander's --no-dispatch. */
  dispatch?: boolean;
}

export async function hooksDoctorCommand(cli: HooksDoctorCliOptions): Promise<number> {
  const report = await runHooksDoctor({
    ...(cli.pluginRoot ? { pluginRoot: cli.pluginRoot } : {}),
    ...(cli.event ? { event: cli.event } : {}),
    dispatch: cli.dispatch !== false,
  });
  console.log(cli.json ? JSON.stringify(report, null, 2) : formatHooksDoctorReport(report));
  return report.ok ? 0 : 1;
}

export function hooksCommand(program: Command): Command {
  const cmd = program
    .command('hooks')
    .description('Copilot hook diagnostics');
  cmd
    .command('doctor')
    .description('Check node on PATH, copilot/hooks.json against its generator, the hook scripts, a dry dispatch of every entry (timing + stderr), and the Copilot CLI version')
    .option('--plugin-root <dir>', 'Plugin directory to check (default: this omg package root)')
    .option('--event <name>', 'Dry-dispatch only this event (e.g. Stop, PreToolUse)')
    .option('--no-dispatch', 'Skip the dry dispatch (no hook runs)')
    .option('--json', 'Print the report as JSON')
    .addHelpText('after', `
Copilot CLI writes hook stderr only to its debug log; the dry dispatch shows it.
The hooks run in a throwaway project and home, never against your own state.
Exit codes: 0 no check failed (warnings allowed), 1 a check failed.

Examples:
  $ omg hooks doctor
  $ omg hooks doctor --event Stop
  $ omg hooks doctor --no-dispatch --json`)
    .action(async (options: HooksDoctorCliOptions) => {
      process.exit(await hooksDoctorCommand(options));
    });
  return cmd;
}
