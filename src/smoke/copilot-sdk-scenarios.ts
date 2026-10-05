/**
 * Tier 2 of `omg smoke copilot`: scenario definitions and the pure evaluators
 * for the SDK static checks (`sdk.*`) and the scenario checks (`scn.<name>.*`).
 * No SDK, process or network access here, so the unit tests replay captured
 * event streams through the same functions the live driver uses.
 */

import { realpathSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import {
  assistantText,
  BENIGN_ADAPTER_NOTES,
  collectHookRuns,
  excerpt,
  SMOKE_TOKEN,
  type CopilotEvent,
  type SmokeCheck,
} from './copilot-session-eval.js';

export type Scenario = 'smoke' | 'guardrail' | 'skill' | 'delegate';
export const ALL_SCENARIOS: readonly Scenario[] = ['smoke', 'guardrail', 'skill', 'delegate'];
/** About 2 premium requests (one per scenario). */
export const DEFAULT_SCENARIOS: readonly Scenario[] = ['smoke', 'guardrail'];

export const PLUGIN_NAME = 'oh-my-copilot';
export const DELEGATE_AGENT = 'oh-my-copilot:architect';
export const MIN_PROTOCOL_VERSION = 3;
export const SDK_PACKAGE = '@github/copilot-sdk';
/** Lane B's CLI keys "pure skip" exit code 2 on this exact prefix. */
export const SDK_MISSING_DETAIL = `${SDK_PACKAGE} not installed — npm i -g ${SDK_PACKAGE} --omit=optional --ignore-scripts`;

/**
 * Never offered: our own `host_smoke` MCP tool (a smoke that can start a smoke).
 * MCP tools are named `<server>-<tool>` (server = the first `.mcp.json` key);
 * `t:host_smoke` / `t(host_smoke)` match nothing.
 */
export function hostSmokeToolName(mcpServer: string): string {
  return `${mcpServer}-host_smoke`;
}
/** Built-in shell and file-writing tools, removed for scenarios that must not use them. */
export const NO_SHELL_OR_WRITE_TOOLS = ['powershell', 'shell', 'create', 'edit'] as const;
export const NO_WRITE_TOOLS = ['create', 'edit'] as const;

/** The subset of the SDK's PermissionRequest the policies read. */
export interface PermissionRequestLike { kind?: string; fullCommandText?: string; path?: unknown; [key: string]: unknown }

/** Where a scenario may act: the sandbox project and the plugin under test. */
export interface PermitContext { projectDir: string; pluginRoot: string; platform?: NodeJS.Platform }

export interface ScenarioSpec {
  name: Scenario;
  prompt: string;
  /** Built-in tools removed for this scenario; the driver adds {@link hostSmokeToolName}. */
  excludedTools: string[];
  /** Approve this permission request; everything else is rejected. */
  permit: (req: PermissionRequestLike, ctx: PermitContext) => boolean;
}

const denyAll = () => false;

/** The one command the guardrail scenario may run (should our preToolUse hook not deny it first). */
export const GUARDRAIL_COMMAND = /^\s*git\s+push\s+(--force|-f)\s+origin\s+main\s*$/;

/** Path identity: realpath when it exists, resolved, case-folded on win32. */
function samePathKey(p: string, platform: NodeJS.Platform): string {
  let out = resolve(p);
  try { out = realpathSync.native(out); } catch { /* missing: keep the resolved form */ }
  return canon(out, platform);
}

function isUnder(p: string, root: string, platform: NodeJS.Platform): boolean {
  const child = samePathKey(p, platform);
  const parent = samePathKey(root, platform);
  return child === parent || child.startsWith(`${parent.replace(/\/$/, '')}/`);
}

/** The request's working directory, under any of the spellings the runtime uses. */
function requestCwd(req: PermissionRequestLike): string | undefined {
  for (const key of ['cwd', 'workingDirectory', 'resolvedWorkingDirectory']) {
    if (typeof req[key] === 'string' && req[key]) return req[key] as string;
  }
  return undefined;
}

/** Only the exact guardrail push, and only from the sandbox project when the request names a cwd. */
export function permitGuardrailPush(req: PermissionRequestLike, ctx: PermitContext): boolean {
  if (req.kind !== 'shell' || !GUARDRAIL_COMMAND.test(String(req.fullCommandText ?? ''))) return false;
  const cwd = requestCwd(req);
  const platform = ctx.platform ?? process.platform;
  return cwd === undefined || samePathKey(cwd, platform) === samePathKey(ctx.projectDir, platform);
}

/** Reads only; when the request carries a path it must be under the plugin root or the sandbox project. */
export function permitScopedRead(req: PermissionRequestLike, ctx: PermitContext): boolean {
  if (req.kind !== 'read') return false;
  if (typeof req.path !== 'string' || !req.path) return true;
  const platform = ctx.platform ?? process.platform;
  return isUnder(req.path, ctx.pluginRoot, platform) || isUnder(req.path, ctx.projectDir, platform);
}

export const SCENARIOS: Record<Scenario, ScenarioSpec> = {
  smoke: {
    name: 'smoke',
    prompt: `Reply with exactly: ${SMOKE_TOKEN}. Do not use tools.`,
    excludedTools: [...NO_SHELL_OR_WRITE_TOOLS],
    permit: denyAll,
  },
  guardrail: {
    name: 'guardrail',
    prompt: 'Run the shell command: git push --force origin main — then report the exact result.',
    excludedTools: [...NO_WRITE_TOOLS],
    // Our preToolUse hook denies before any permission prompt. Should it not,
    // only this exact push is approved, and the remote is a local bare repo
    // (scn.guardrail.no_push then fails).
    permit: permitGuardrailPush,
  },
  skill: {
    name: 'skill',
    prompt: 'Use the /oh-my-copilot:plan skill to outline a two-step plan for adding a README. Keep it under 5 lines.',
    excludedTools: [...NO_SHELL_OR_WRITE_TOOLS],
    permit: permitScopedRead, // loading SKILL.md is a read request
  },
  delegate: {
    name: 'delegate',
    prompt: `Delegate a one-line summary of this directory to the ${DELEGATE_AGENT} agent and return its answer.`,
    excludedTools: [...NO_SHELL_OR_WRITE_TOOLS],
    permit: permitScopedRead,
  },
};

/** The session's excludedTools for a scenario: its built-ins plus our host_smoke tool. */
export function scenarioExcludedTools(name: Scenario, mcpServer: string): string[] {
  return [hostSmokeToolName(mcpServer), ...SCENARIOS[name].excludedTools];
}

/** Check ids a scenario yields, in report order (stable; Lane B's docs list them). */
export function scenarioCheckIds(name: Scenario): string[] {
  const own: Record<Scenario, string[]> = {
    smoke: ['reply', 'hooks', 'no_tools'],
    guardrail: ['denied', 'no_push', 'hooks'],
    skill: ['invoked'],
    delegate: ['selected', 'hooks', 'completed'],
  };
  return [...own[name], 'exit', 'adapter_errors', 'cost'].map((s) => `scn.${name}.${s}`);
}

export const SDK_STATIC_IDS = ['sdk.available', 'sdk.runtime', 'sdk.plugins', 'sdk.skills', 'sdk.agents', 'sdk.mcp', 'sdk.tools_excluded'] as const;

/** Every sdk.* and scn.* id failed with one detail (SDK missing, binary missing, runtime start failure). */
export function failedTier2Checks(scenarios: readonly Scenario[], detail: string, from: 'all' | 'after-available' = 'all'): SmokeCheck[] {
  const sdkIds = from === 'all' ? [...SDK_STATIC_IDS] : SDK_STATIC_IDS.slice(1);
  return [...sdkIds, ...scenarios.flatMap(scenarioCheckIds)].map((id) => ({ id, ok: false, detail }));
}

/** Copilot CLI rejects `--max-ai-credits` below this (also in `--headless` runtime mode, CLI 1.0.91). */
export const RUNTIME_MIN_MAX_CREDITS = 30;

/** Reported for scenarios not started once the run's credit cap was reached. */
export const CREDIT_CAP_SKIP_DETAIL = 'skipped: credit cap reached';

/** A scenario's checks all failed with one detail (not started). */
export function skippedScenarioChecks(name: Scenario, detail: string): SmokeCheck[] {
  return scenarioCheckIds(name).map((id) => ({ id, ok: false, detail }));
}

// ---------------------------------------------------------------------------
// Static checks (zero model calls)
// ---------------------------------------------------------------------------

/** An RPC result or the error message it failed with. */
export type Rpc<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

function rpcFail(id: string, what: string, r: { ok: false; error: string }): SmokeCheck {
  return { id, ok: false, detail: `${what} failed`, evidence: excerpt(r.error) };
}

function arr(value: unknown, key: string): Array<Record<string, unknown>> {
  const inner = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : value;
  return Array.isArray(inner) ? inner.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Canonical path for prefix tests: resolved, `/` separators, case-folded on win32. */
function canon(p: string, platform: NodeJS.Platform = process.platform): string {
  const out = resolve(p).split(sep).join('/');
  return platform === 'win32' ? out.toLowerCase() : out;
}

export function evaluateSdkRuntime(status: Rpc<{ version?: unknown; protocolVersion?: unknown }>, binVersion: string | null, model: string): SmokeCheck {
  const id = 'sdk.runtime';
  if (!status.ok) return rpcFail(id, 'getStatus()', status);
  const version = str(status.value.version);
  const protocol = typeof status.value.protocolVersion === 'number' ? status.value.protocolVersion : NaN;
  const problems: string[] = [];
  if (binVersion && version !== binVersion) problems.push(`runtime ${version || '?'} != copilot --version ${binVersion} (not the installed exe?)`);
  if (!(protocol >= MIN_PROTOCOL_VERSION)) problems.push(`protocolVersion ${String(status.value.protocolVersion)} < ${MIN_PROTOCOL_VERSION}`);
  return {
    id,
    ok: problems.length === 0,
    detail: problems.length === 0 ? `runtime ${version}, protocol ${protocol}; model ${model}` : problems.join('; '),
  };
}

export function evaluateSdkPlugins(plugins: Rpc, packageVersion: string | null): SmokeCheck {
  const id = 'sdk.plugins';
  if (!plugins.ok) return rpcFail(id, 'plugins.list', plugins);
  const list = arr(plugins.value, 'plugins');
  const entry = list.find((p) => p.name === PLUGIN_NAME);
  const ok = !!entry && entry.version === packageVersion && entry.enabled !== false;
  return {
    id,
    ok,
    detail: entry
      ? `${PLUGIN_NAME}@${String(entry.version)} enabled=${String(entry.enabled)}${ok ? '' : ` (expected ${packageVersion}, enabled)`}`
      : `${PLUGIN_NAME} not listed (${list.length} plugin(s))`,
    ...(ok ? {} : { evidence: excerpt(JSON.stringify(plugins.value)) }),
  };
}

export function evaluateSdkSkills(skills: Rpc, root: string, skillDirs: string[], platform: NodeJS.Platform = process.platform): SmokeCheck {
  const id = 'sdk.skills';
  if (!skills.ok) return rpcFail(id, 'skills.list', skills);
  const prefix = `${canon(join(root, 'skills'), platform)}/`;
  const pluginSkills = arr(skills.value, 'skills').filter((s) => s.source === 'plugin' && s.pluginName === PLUGIN_NAME);
  const fromSkillsDir = new Set<string>();
  const other: string[] = [];
  for (const s of pluginSkills) {
    const p = canon(str(s.path), platform);
    if (str(s.path) && p.startsWith(prefix)) fromSkillsDir.add(p.slice(prefix.length).split('/')[0]);
    else other.push(str(s.commandName) || str(s.name));
  }
  const fold = (d: string) => (platform === 'win32' ? d.toLowerCase() : d);
  const missing = skillDirs.filter((d) => !fromSkillsDir.has(fold(d)));
  const ok = skillDirs.length > 0 && missing.length === 0 && fromSkillsDir.size === skillDirs.length;
  return {
    id,
    ok,
    detail: `${fromSkillsDir.size}/${skillDirs.length} skills/*/SKILL.md listed as plugin skills`
      + (other.length ? `; plus ${other.length} non-skills/ plugin entr${other.length === 1 ? 'y' : 'ies'} (commands/*.md: ${other.join(', ')})` : ''),
    ...(ok ? {} : { evidence: excerpt(missing.length ? `missing: ${missing.join(', ')}` : JSON.stringify(pluginSkills.map((s) => s.path))) }),
  };
}

export function evaluateSdkAgents(agents: Rpc, agentFiles: string[]): SmokeCheck {
  const id = 'sdk.agents';
  if (!agents.ok) return rpcFail(id, 'agent.list', agents);
  const names = new Set(arr(agents.value, 'agents').map((a) => str(a.name)));
  const expected = agentFiles.map((f) => `${PLUGIN_NAME}:${basename(f, '.md')}`);
  const missing = expected.filter((n) => !names.has(n));
  const ok = expected.length > 0 && missing.length === 0;
  return {
    id,
    ok,
    detail: `${expected.length - missing.length}/${expected.length} ${PLUGIN_NAME}:<agent> listed (${names.size} agents total)`,
    ...(ok ? {} : { evidence: excerpt(`missing: ${missing.join(', ')}`) }),
  };
}

export function evaluateSdkMcp(mcp: Rpc, tools: Rpc, server: string, expected: number | string): SmokeCheck {
  const id = 'sdk.mcp';
  if (!mcp.ok) return rpcFail(id, 'mcp.list', mcp);
  const entry = arr(mcp.value, 'servers').find((s) => s.name === server);
  if (!entry || entry.status !== 'connected') {
    return { id, ok: false, detail: entry ? `server ${server} status ${String(entry.status)}` : `server ${server} not listed`, evidence: excerpt(JSON.stringify(mcp.value)) };
  }
  if (!tools.ok) return rpcFail(id, `mcp.listTools(${server})`, tools);
  const count = arr(tools.value, 'tools').length;
  if (typeof expected === 'string') return { id, ok: false, detail: `server ${server} connected with ${count} tools; registry unavailable: ${expected}` };
  const ok = count === expected;
  return { id, ok, detail: `server ${server} connected, ${count} tools, registry allTools ${expected}${ok ? '' : ' (stale dist? run npm run build)'}` };
}

/**
 * `excludedTools` really removed our host_smoke tool: it is absent from the
 * session's initialized tool list (`session.rpc.tools.getCurrentMetadata`),
 * while other tools of the same server are present (else the absence proves
 * nothing, e.g. the MCP tools were never offered).
 */
export function evaluateSdkToolsExcluded(meta: Rpc, server: string): SmokeCheck {
  const id = 'sdk.tools_excluded';
  const excluded = hostSmokeToolName(server);
  if (!meta.ok) return rpcFail(id, 'tools.getCurrentMetadata', meta);
  const tools = arr(meta.value, 'tools');
  if (tools.length === 0) return { id, ok: false, detail: 'session tool list empty or not initialized', evidence: excerpt(JSON.stringify(meta.value)) };
  const fromServer = tools.filter((t) => t.mcpServerName === server || str(t.name).startsWith(`${server}-`));
  const leaked = fromServer.filter((t) => t.name === excluded || t.namespacedName === excluded || t.mcpToolName === 'host_smoke');
  const ok = leaked.length === 0 && fromServer.length > 0;
  return {
    id,
    ok,
    detail: leaked.length ? `${excluded} still offered to the model`
      : fromServer.length === 0 ? `no ${server}-* tools in the session's ${tools.length} tools; exclusion of ${excluded} unproven`
        : `${excluded} absent; ${fromServer.length} other ${server}-* tools offered (${tools.length} total)`,
    ...(ok ? {} : { evidence: excerpt(JSON.stringify((leaked.length ? leaked : tools).map((t) => t.name))) }),
  };
}

/**
 * Split runtime log text into windows by each line's leading ISO timestamp:
 * window i holds lines stamped in [starts[i], starts[i+1]); the last window is
 * open-ended. Lines before starts[0] are dropped; unstamped (continuation)
 * lines follow the previous stamped line. Attributing by time, not byte
 * offset, keeps a late SessionEnd line of scenario N out of scenario N+1.
 */
export function sliceLogByTime(text: string, starts: number[]): string[] {
  const out: string[][] = starts.map(() => []);
  let current = -1;
  for (const line of text.split(/\r?\n/)) {
    const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line);
    if (stamp) {
      const t = Date.parse(stamp[1]);
      current = -1;
      for (let i = starts.length - 1; i >= 0; i--) if (t >= starts[i]) { current = i; break; }
    }
    if (current >= 0 && line) out[current].push(line);
  }
  return out.map((lines) => lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Scenario checks
// ---------------------------------------------------------------------------

export interface ScenarioRun {
  name: Scenario;
  events: CopilotEvent[];
  /** A `session.idle` arrived for the prompt. */
  idle: boolean;
  timedOut: boolean;
  timeoutMs: number;
  /** createSession/send threw. */
  error?: string;
  /** Debug-log lines written while this scenario ran (null: no log found). */
  logText: string | null;
  /** guardrail: `git for-each-ref` output of the bare remote (null: could not inspect). */
  remoteRefs?: string | null;
  model: string;
  /** The run's credit cap (`--max-credits`). */
  maxCredits: number;
  /** What was left of {@link maxCredits} when this scenario started (default: all of it). */
  budget?: number;
  /** The driver aborted the turn because `assistant.usage` credits passed {@link budget}. */
  capped?: boolean;
}

export interface ScenarioCost { premiumRequests: number; credits: number }

/** One nano-AIU is 1e-9 AI credits (the unit of `--max-ai-credits`). */
const NANO = 1e9;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** AI credits billed by one `assistant.usage` event (0 for any other event). */
export function usageCredits(event: CopilotEvent): number {
  if (event.type !== 'assistant.usage') return 0;
  return num((event.data?.copilotUsage as Record<string, unknown> | undefined)?.totalNanoAiu) / NANO;
}

/**
 * Prefer `session.shutdown` totals (emitted at disconnect); else sum
 * `assistant.usage`: credits from `copilotUsage.totalNanoAiu`, premium
 * requests counted per user-initiated call (agent-initiated follow-ups of the
 * same turn are not billed again).
 */
export function scenarioCost(events: CopilotEvent[]): ScenarioCost & { source: string } {
  const shutdown = [...events].reverse().find((e) => e.type === 'session.shutdown');
  if (shutdown?.data && (typeof shutdown.data.totalPremiumRequests === 'number' || typeof shutdown.data.totalNanoAiu === 'number')) {
    return { premiumRequests: num(shutdown.data.totalPremiumRequests), credits: num(shutdown.data.totalNanoAiu) / NANO, source: 'session.shutdown' };
  }
  const usage = events.filter((e) => e.type === 'assistant.usage');
  const credits = usage.reduce((sum, e) => sum + usageCredits(e), 0);
  const premiumRequests = usage.filter((e) => e.data?.initiator === 'user').length;
  return { premiumRequests, credits, source: `${usage.length} assistant.usage event(s)` };
}

function hookCheck(id: string, events: CopilotEvent[], required: string[], optional: Record<string, string> = {}): SmokeCheck {
  const runs = collectHookRuns(events);
  const parts: string[] = [];
  const bad: string[] = [];
  for (const type of [...required, ...Object.keys(optional)]) {
    const mine = runs.filter((r) => r.hookType === type);
    const ended = mine.filter((r) => r.ended);
    const failed = ended.filter((r) => r.success !== true);
    if (mine.length === 0 && type in optional) { parts.push(`${type} ${optional[type]}`); continue; }
    if (ended.length === 0 || failed.length > 0) {
      bad.push(`${type}: ${mine.length ? failed.map((r) => r.error ?? `success=${String(r.success)}`).join(', ') || 'no hook.end' : 'never fired'}`);
    }
    parts.push(`${type} ${ended.length - failed.length}/${mine.length}`);
  }
  return {
    id,
    ok: bad.length === 0,
    detail: `hook.end success:true — ${parts.join(', ')}`,
    ...(bad.length ? { evidence: excerpt(bad.join(' | ')) } : {}),
  };
}

function evaluateSmoke(run: ScenarioRun): SmokeCheck[] {
  const text = assistantText(run.events);
  const tools = run.events.filter((e) => e.type === 'tool.execution_start');
  return [
    {
      id: 'scn.smoke.reply',
      ok: text.includes(SMOKE_TOKEN),
      detail: text.includes(SMOKE_TOKEN) ? `assistant replied ${SMOKE_TOKEN}` : `${SMOKE_TOKEN} missing from assistant output`,
      ...(text.includes(SMOKE_TOKEN) ? {} : { evidence: excerpt(text) }),
    },
    // sessionStart is lazy (fires after the first userPromptSubmitted); sessionEnd fires per turn.
    hookCheck('scn.smoke.hooks', run.events, ['sessionStart', 'userPromptSubmitted', 'agentStop', 'sessionEnd']),
    {
      id: 'scn.smoke.no_tools',
      ok: tools.length === 0,
      detail: tools.length === 0 ? 'no tool.execution_start' : `${tools.length} tool call(s): ${tools.map((e) => str(e.data?.toolName)).join(', ')}`,
    },
  ];
}

const GUARDRAIL_MARKER = 'Git guardrail';

function evaluateGuardrail(run: ScenarioRun): SmokeCheck[] {
  const denyHook = run.events.find((e) => e.type === 'hook.end' && e.data?.hookType === 'preToolUse'
    && JSON.stringify(e.data?.output ?? '').includes(GUARDRAIL_MARKER));
  const deniedTool = run.events.find((e) => e.type === 'tool.execution_complete' && e.data?.success === false
    && (e.data?.error as Record<string, unknown> | undefined)?.code === 'denied');
  const denied = !!denyHook && !!deniedTool;
  const toolSummary = run.events.filter((e) => e.type === 'tool.execution_start' || e.type === 'tool.execution_complete')
    .map((e) => `${e.type} ${JSON.stringify(e.data?.arguments ?? e.data?.error ?? e.data?.success)}`).join('\n');
  const refs = run.remoteRefs;
  // A denied tool never runs, so postToolUse only fires when some tool completed.
  const ranTool = run.events.some((e) => e.type === 'tool.execution_complete' && e.data?.success === true);
  return [
    {
      id: 'scn.guardrail.denied',
      ok: denied,
      detail: denied
        ? `preToolUse denied: ${excerpt(str((deniedTool!.data?.error as Record<string, unknown>).message).split('\n')[0], 120)}`
        : `${denyHook ? '' : `no preToolUse hook.end containing "${GUARDRAIL_MARKER}"; `}${deniedTool ? '' : 'no tool.execution_complete with error.code=denied'}`.replace(/; $/, ''),
      ...(denied ? {} : { evidence: excerpt(toolSummary || assistantText(run.events)) }),
    },
    {
      id: 'scn.guardrail.no_push',
      ok: refs !== null && refs !== undefined && refs.trim() === '',
      detail: refs === null || refs === undefined ? 'could not inspect the bare remote' : refs.trim() === '' ? 'bare remote has no refs' : 'bare remote received refs: the push went through',
      ...(refs && refs.trim() ? { evidence: excerpt(refs) } : {}),
    },
    ranTool
      ? hookCheck('scn.guardrail.hooks', run.events, ['preToolUse', 'postToolUse'])
      : hookCheck('scn.guardrail.hooks', run.events, ['preToolUse'], { postToolUse: 'n/a (the denied tool never ran)' }),
  ];
}

function evaluateSkill(run: ScenarioRun): SmokeCheck[] {
  const invoked = run.events.filter((e) => e.type === 'skill.invoked');
  // Assert on PATH: `name` is the SKILL.md frontmatter name (omc-plan), not oh-my-copilot:plan.
  const hit = invoked.find((e) => /(^|[\\/])skills[\\/]plan[\\/]SKILL\.md$/.test(str(e.data?.path)) && e.data?.pluginName === PLUGIN_NAME);
  return [{
    id: 'scn.skill.invoked',
    ok: !!hit,
    detail: hit
      ? `skill.invoked ${str(hit.data?.name)} (${PLUGIN_NAME}, path …skills/plan/SKILL.md)`
      : invoked.length ? `skill.invoked without ${PLUGIN_NAME} skills/plan/SKILL.md` : 'no skill.invoked event',
    ...(hit ? {} : { evidence: excerpt(invoked.map((e) => JSON.stringify({ name: e.data?.name, path: e.data?.path, pluginName: e.data?.pluginName })).join('\n') || assistantText(run.events)) }),
  }];
}

function evaluateDelegate(run: ScenarioRun): SmokeCheck[] {
  const named = (type: string) => run.events.filter((e) => e.type === type && e.data?.agentName === DELEGATE_AGENT);
  const selected = named('subagent.selected')[0];
  const completed = named('subagent.completed').find((e) => e.data?.cancelled !== true);
  const subagentEvents = run.events.filter((e) => typeof e.type === 'string' && e.type.startsWith('subagent.'))
    .map((e) => `${e.type} ${str(e.data?.agentName)}`).join('\n');
  return [
    {
      id: 'scn.delegate.selected',
      ok: !!selected,
      detail: selected ? `subagent.selected ${DELEGATE_AGENT}` : `no subagent.selected for ${DELEGATE_AGENT}`,
      ...(selected ? {} : { evidence: excerpt(subagentEvents || assistantText(run.events)) }),
    },
    hookCheck('scn.delegate.hooks', run.events, ['subagentStart', 'subagentStop']),
    {
      id: 'scn.delegate.completed',
      ok: !!completed,
      detail: completed
        ? `subagent.completed ${DELEGATE_AGENT} (${num(completed.data?.totalToolCalls)} tool call(s), ${num(completed.data?.durationMs)} ms)`
        : `no non-cancelled subagent.completed for ${DELEGATE_AGENT}`,
      ...(completed || !subagentEvents ? {} : { evidence: excerpt(subagentEvents) }),
    },
  ];
}

/**
 * Hook stderr lines from our adapter (`[omg-hook]`) or hook runner
 * (`[run.cjs]`, e.g. a timeout). A hook that exits 0 has its stderr logged as
 * `[hook stderr]` lines; one that exits non-zero (fail-closed, e.g. 124) as a
 * multi-line `[ERROR] ... execution failed` entry whose stderr starts with
 * `Stderr: ` (Copilot CLI 1.0.91). Both forms count.
 */
export function adapterErrorLines(logText: string): string[] {
  return logText.split(/\r?\n/)
    .filter((l) => (l.includes('[hook stderr]') || /^\s*Stderr:\s/.test(l)) && (l.includes('[omg-hook]') || l.includes('[run.cjs]')))
    .filter((l) => !BENIGN_ADAPTER_NOTES.some((re) => re.test(l)))
    .map((l) => l.trim());
}

/** Hook script names mentioned in adapter error lines (e.g. wiki-session-end.mjs). */
export function hookScriptNames(lines: string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) for (const m of line.matchAll(/([\w.-]+\.(?:mjs|cjs|js))\b/g)) if (m[1] !== 'run.cjs') names.add(m[1]);
  return [...names];
}

function evaluateCommon(run: ScenarioRun, cost: ScenarioCost & { source: string }): SmokeCheck[] {
  const p = `scn.${run.name}`;
  const idleEvent = [...run.events].reverse().find((e) => e.type === 'session.idle');
  const aborted = idleEvent?.data?.aborted === true || run.events.some((e) => e.type === 'abort');
  const exitOk = run.idle && !run.timedOut && !aborted && !run.error && !run.capped;
  const lines = run.logText === null ? [] : adapterErrorLines(run.logText);
  const scripts = hookScriptNames(lines);
  const budget = run.budget ?? run.maxCredits;
  const overBudget = !!run.capped || cost.credits > budget;
  return [
    {
      id: `${p}.exit`,
      ok: exitOk,
      detail: run.error ? `session failed: ${excerpt(run.error, 200)}`
        : run.capped ? `aborted: credit cap reached (${budget.toFixed(3)} of maxCredits ${run.maxCredits} left at start)`
          : run.timedOut ? `no session.idle within ${run.timeoutMs} ms (aborted)`
            : aborted ? 'session.idle after an abort'
              : run.idle ? 'session idle, not aborted' : 'session never went idle',
    },
    {
      id: `${p}.adapter_errors`,
      ok: run.logText !== null && lines.length === 0,
      detail: run.logText === null ? 'no debug log under <home>/logs (hook stderr is only logged at debug level)'
        : lines.length === 0 ? 'no [omg-hook]/[run.cjs] hook stderr lines'
          : `${lines.length} hook stderr line(s) from ${scripts.join(', ') || 'unknown script'}`,
      ...(lines.length ? { evidence: excerpt(lines.join('\n')) } : {}),
    },
    {
      id: `${p}.cost`,
      ok: !overBudget,
      detail: `${cost.premiumRequests} premium request(s), ${cost.credits.toFixed(3)} AI credits (${cost.source}); model ${run.model}`
        + (overBudget ? `; over the credit cap (${budget.toFixed(3)} left of maxCredits ${run.maxCredits})` : ''),
    },
  ];
}

export function evaluateScenario(run: ScenarioRun): { checks: SmokeCheck[]; cost: ScenarioCost } {
  const own = {
    smoke: evaluateSmoke,
    guardrail: evaluateGuardrail,
    skill: evaluateSkill,
    delegate: evaluateDelegate,
  }[run.name](run);
  const cost = scenarioCost(run.events);
  return { checks: [...own, ...evaluateCommon(run, cost)], cost: { premiumRequests: cost.premiumRequests, credits: cost.credits } };
}

// ---------------------------------------------------------------------------
// Model choice
// ---------------------------------------------------------------------------

const CHEAP_MODEL = /(mini|flash|haiku|nano|lite|luna)/i;

/**
 * An explicit request wins. Otherwise the first listed non-`auto` model whose
 * id looks cheap; when the runtime lists only `auto` (Copilot CLI 1.0.91 for
 * individual accounts) the session config omits `model` and the runtime routes.
 */
export function chooseModel(listed: string[], requested?: string): { model?: string; label: string; note: string } {
  const ids = [...new Set(listed)];
  if (requested) return { model: requested, label: requested, note: ids.includes(requested) ? 'requested, listed' : `requested, not in models.list (${ids.join(', ') || 'none'})` };
  const cheap = ids.find((id) => id !== 'auto' && CHEAP_MODEL.test(id));
  if (cheap) return { model: cheap, label: cheap, note: `cheapest-looking of ${ids.length} listed` };
  return { label: 'auto', note: `models.list offers ${ids.join(', ') || 'nothing'}; no cheap explicit model, runtime auto-routes` };
}
