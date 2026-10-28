/**
 * Tier 2 of `omg smoke copilot`: scenario definitions and the pure evaluators
 * for the SDK static checks (`sdk.*`) and the scenario checks (`scn.<name>.*`).
 * No SDK, process or network access here, so the unit tests replay captured
 * event streams through the same functions the live driver uses.
 */

import { realpathSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { NANO_AIU_PER_CREDIT } from '../budget/ledger.js';
import {
  assistantText,
  BENIGN_ADAPTER_NOTES,
  collectHookRuns,
  excerpt,
  SMOKE_TOKEN,
  type CopilotEvent,
  type SmokeCheck,
} from './copilot-session-eval.js';

export type Scenario = 'smoke' | 'guardrail' | 'skill' | 'delegate' | 'filetools' | 'chain' | 'team' | FactoryRunScenario | 'sandbox-lane' | CliScenario;
/** `omg factory run` end to end, in-process, with real lanes (copilot-factory-run-scenario.ts). */
export type FactoryRunScenario = 'factory-run' | 'factory-run-fix';
export const FACTORY_RUN_SCENARIOS: readonly FactoryRunScenario[] = ['factory-run', 'factory-run-fix'];
/** Sandboxed copilot_run lanes against the OS sandbox, in-process (copilot-sandbox-lane-scenario.ts). */
export const SANDBOX_LANE_SCENARIO = 'sandbox-lane' as const;
/**
 * Headless `copilot` CLI sessions (copilot-cli-scenarios.ts), not SDK
 * sessions: a stub plugin next to ours, a resumed session, or a seeded state.
 */
export type CliScenario = 'continuation' | 'prompt-context' | 'events' | 'ultragoal';
export const CLI_SCENARIOS: readonly CliScenario[] = ['continuation', 'prompt-context', 'events', 'ultragoal'];
/** What `--scenario all` runs: the SDK-session scenarios (one prompt each, about 0.3 to 0.9 AI credits measured). */
export const ALL_SCENARIOS: readonly Scenario[] = ['smoke', 'guardrail', 'skill', 'delegate'];
/**
 * Named explicitly only, never in `all` or the default: `filetools` (one
 * prompt) lets the model write files and loads a second, probe plugin;
 * `chain` spawns two real headless `copilot -p` factory links (one prompt
 * each) outside the SDK runtime's credit cap; `team` starts a real 2-worker
 * `omg team` with sdk workers (one prompt per worker); `factory-run` runs
 * `omg factory run` with a real implement and review lane (two lanes, about
 * 2 AI credits estimated) and `factory-run-fix` adds a fix round (four lanes,
 * about 4); `sandbox-lane` runs a review, a write and a canary lane in the
 * OS sandbox (three lanes, about 3 AI credits estimated). Lane scenarios pin
 * their lanes to the session's cheap model ({@link chooseModel}). The
 * {@link CLI_SCENARIOS}, AI credits measured on Copilot CLI 1.0.91 (legacy
 * premium requests in brackets): `continuation` 0.31 [2] (the prompt plus one
 * Stop-hook continuation, an extra model turn), `prompt-context` 0.29 [1],
 * `events` 0.76 [1] (the `/compact` of the resumed session bills credits),
 * `ultragoal` 0.65 [2] (the prompt plus one reinforcement continuation).
 */
export const OPT_IN_SCENARIOS: readonly Scenario[] = ['filetools', 'chain', 'team', ...FACTORY_RUN_SCENARIOS, SANDBOX_LANE_SCENARIO, ...CLI_SCENARIOS];
/**
 * Scenarios written to the behaviour another lane delivers: their failing
 * checks carry this note, so a red run reads as expected until it lands.
 * Remove the entry once the scenario passes on dev.
 */
export const PENDING_SCENARIOS: Partial<Record<Scenario, string>> = {
  ultragoal: 'PENDING lane g-cont (ultragoal tool gate past the confirmation TTL on Copilot): expected to fail until it lands',
};
export const KNOWN_SCENARIOS: readonly Scenario[] = [...ALL_SCENARIOS, ...OPT_IN_SCENARIOS];
/**
 * Two prompts (one per scenario), about 0.6 AI credits measured: the
 * tier2-smoke (0.34) and tier2-guardrail (0.29) fixtures' `session.shutdown`
 * totals on small auto-picked models; other models cost more.
 */
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

/** filetools fixture, relative to the sandbox project (forward slashes, as the model is told). */
export const FILETOOLS_DIR = 'filetools';
export const FILETOOLS_FILES = {
  notes: `${FILETOOLS_DIR}/notes.txt`,
  created: `${FILETOOLS_DIR}/new/created.txt`,
  /**
   * Picked up by post-tool-directory-context-injector.mjs (README.md, not
   * AGENTS.md: Copilot loads AGENTS.md itself). The injector sends each
   * README once per session, so the read (view of notes.txt) and the write
   * (creating created.txt) each get their own.
   */
  context: `${FILETOOLS_DIR}/README.md`,
  writeContext: `${FILETOOLS_DIR}/new/README.md`,
} as const;
export const FILETOOLS_MARKER = 'Context marker:';
/** The PostToolUse matcher of our rules + directory-context injector entry in copilot/hooks.json. */
export const FILE_TOOL_MATCHER = 'Read|Write|Edit|MultiEdit';

/** File reads and writes, only under the sandbox project. */
export function permitProjectFiles(req: PermissionRequestLike, ctx: PermitContext): boolean {
  const platform = ctx.platform ?? process.platform;
  const target = req.kind === 'read' ? req.path : req.kind === 'write' ? (req.resolvedPath ?? req.fileName) : undefined;
  return typeof target === 'string' && !!target && isUnder(resolve(ctx.projectDir, target), ctx.projectDir, platform);
}

/** CLI scenario fixtures named in their prompts. */
export const PROMPT_CONTEXT_PREFIX = 'OMG-PROMPT-CONTEXT:';
export const EVENTS_MISSING_FILE = 'omg-missing-probe.txt';
export const EVENTS_SHELL_TOKEN = 'omg-events-probe';

/** factory-run fixture: the scripted GitHub repository, issue, PR and base, and the one file the issue asks for. */
export const FACTORY_RUN_REPO_URL = 'https://github.com/omg-smoke/factory-run';
export const FACTORY_RUN_ISSUE = 1;
export const FACTORY_RUN_PR = 2;
export const FACTORY_RUN_BASE = 'dev';
export const FACTORY_RUN_FILE = 'greet.txt';
export const FACTORY_RUN_ISSUE_BODY = [
  `Add a file ${FACTORY_RUN_FILE} at the repository root.`,
  '',
  '## Acceptance criteria',
  '',
  `- ${FACTORY_RUN_FILE} exists at the repository root and its first line is exactly: hi`,
  '- One commit, no other file changed. There is no test suite in this repository: do not add one.',
].join('\n');

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
  // The fixture (FILETOOLS_FILES) and the probe plugin are written by the driver.
  filetools: {
    name: 'filetools',
    prompt: [
      `Use only your file tools, never a shell, and touch no file outside the ${FILETOOLS_DIR} directory.`,
      `1. View ${FILETOOLS_FILES.notes}.`,
      `2. Edit ${FILETOOLS_FILES.notes} so that the line "status: draft" reads "status: done".`,
      `3. Create ${FILETOOLS_FILES.created} containing exactly the line "created".`,
      `Do not open any other file. Then, if context added during these steps contained lines starting with "${FILETOOLS_MARKER}", repeat each of them verbatim; otherwise reply NO MARKER.`,
    ].join('\n'),
    excludedTools: ['powershell', 'shell'],
    permit: permitProjectFiles,
  },
  // Not an SDK session: the prompt is link 1's, spawned as a real `copilot -p`
  // factory link (copilot-chain-scenario.ts) under the AFK profile.
  chain: {
    name: 'chain',
    prompt: 'Reply with exactly: CHAIN_LINK_1. Do not use tools.',
    excludedTools: [],
    permit: denyAll,
  },
  // Not an SDK session of the driver: the prompt is the `omg team` task, a
  // numbered list that decomposes into one task per worker
  // (copilot-team-scenario.ts). The sdk hosts apply their own policy.
  team: {
    name: 'team',
    prompt: [
      '1. Create the file team-alpha.txt containing exactly the line alpha in your working directory, then commit only that file with git (message: smoke team alpha). Do nothing else.',
      '2. Create the file team-beta.txt containing exactly the line beta in your working directory, then commit only that file with git (message: smoke team beta). Do nothing else.',
    ].join('\n'),
    excludedTools: [],
    permit: denyAll,
  },
  // Not an SDK session: the prompt is the scripted issue's body, which the
  // engine turns into the lane prompts (copilot-factory-run-scenario.ts).
  'factory-run': {
    name: 'factory-run',
    prompt: FACTORY_RUN_ISSUE_BODY,
    excludedTools: [],
    permit: denyAll,
  },
  'factory-run-fix': {
    name: 'factory-run-fix',
    prompt: FACTORY_RUN_ISSUE_BODY,
    excludedTools: [],
    permit: denyAll,
  },
  // Not an SDK session of the driver: copilot_run lanes with their own policy
  // and per-lane prompts (copilot-sandbox-lane-scenario.ts); this is the write lane's.
  'sandbox-lane': {
    name: 'sandbox-lane',
    prompt: 'Run the sandbox probe command you are given, once, then reply with its last output line.',
    excludedTools: [],
    permit: denyAll,
  },
  // The CLI scenarios are headless `copilot` sessions (copilot-cli-scenarios.ts);
  // their permissions are CLI flags (CLI_SCENARIO_PERMISSIONS), not `permit`.
  continuation: {
    name: 'continuation',
    prompt: 'Reply with exactly the word started and nothing else. Do not call any tools.',
    excludedTools: [],
    permit: denyAll,
  },
  'prompt-context': {
    name: 'prompt-context',
    prompt: `If your context contains a line that starts with "${PROMPT_CONTEXT_PREFIX}", reply with exactly the token that follows it on that line and nothing else; otherwise reply NO MARKER. Do not call any tools.`,
    excludedTools: [],
    permit: denyAll,
  },
  events: {
    name: 'events',
    prompt: [
      'Do these two steps in order, then answer with one short line:',
      `1. Use the view tool to read the file ${EVENTS_MISSING_FILE} in the current directory (it does not exist; that is expected).`,
      `2. Run the shell command: echo ${EVENTS_SHELL_TOKEN}`,
    ].join('\n'),
    excludedTools: [],
    permit: denyAll,
  },
  ultragoal: {
    name: 'ultragoal',
    prompt: 'Use the view tool once to read the file README.md in the current directory. Then answer with one short line. If you later receive any message that starts with "[", reply with exactly the word acknowledged and nothing else, and do not call any tool.',
    excludedTools: [],
    permit: denyAll,
  },
};

// ---------------------------------------------------------------------------
// CLI scenarios (headless copilot sessions: continuation, prompt-context,
// events, ultragoal)
// ---------------------------------------------------------------------------

/** The prompt the `events` scenario resumes its session with: preCompact, no user prompt (the summary still bills AI credits). */
export const COMPACT_PROMPT = '/compact';
/** The ultragoal activation prompt the seed sends through our UserPromptSubmit hook group. */
export const ULTRAGOAL_ACTIVATION_PROMPT = 'use ultragoal to write a hello.txt file containing hi';
/** keyword-detector's confirmation window; the seed backdates the state past it. */
export const ULTRAGOAL_CONFIRM_TTL_MS = 120_000;

/** The Stop-hook reason the continuation stub blocks with (once). */
export function continuationReason(nonce: string): string {
  return `[OMG-SMOKE-CONT ${nonce}] Stop hook continuation. Reply with exactly ${continuationToken(nonce)} and nothing else. Do not call tools.`;
}
export function continuationToken(nonce: string): string {
  return `CONTINUED_${nonce}`;
}
export function promptContextLine(nonce: string): string {
  return `${PROMPT_CONTEXT_PREFIX} ${nonce}`;
}

/** One headless `copilot` process of a CLI scenario. */
export interface CliStepRecord { label: string; code: number | null; timedOut: boolean; durationMs: number; error?: string }

export interface CliEvidence {
  sessionId: string;
  /** Random token in the stub plugin's output, never in the prompt. */
  nonce: string;
  steps: CliStepRecord[];
  /** Stub plugin records: what each stub run read on stdin and printed. */
  stub: Array<{ kind: string; payload: Record<string, unknown> | null; out: Record<string, unknown> }>;
  /** ultragoal: the activation seed (our UserPromptSubmit group, then the TTL backdate). */
  seed?: { ok: boolean; detail: string; state?: Record<string, unknown> | null };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function hookEnds(events: CopilotEvent[], hookType: string): CopilotEvent[] {
  return events.filter((e) => e.type === 'hook.end' && e.data?.hookType === hookType);
}

function userMessages(events: CopilotEvent[]): string[] {
  return events.filter((e) => e.type === 'user.message').map((e) => str(e.data?.content));
}

function noCliEvidence(name: CliScenario, count: number, run: ScenarioRun): SmokeCheck[] {
  return scenarioCheckIds(name).slice(0, count).map((id) => ({ id, ok: false, detail: run.error ? `no CLI evidence: ${excerpt(run.error, 200)}` : 'no CLI evidence collected' }));
}

function evaluateContinuation(run: ScenarioRun): SmokeCheck[] {
  const cli = run.cli;
  if (!cli) return noCliEvidence('continuation', 4, run);
  const reason = continuationReason(cli.nonce);
  const token = continuationToken(cli.nonce);
  const stopStarts = run.events.filter((e) => e.type === 'hook.start' && e.data?.hookType === 'agentStop');
  const blockIdx = run.events.findIndex((e) => e.type === 'hook.end' && e.data?.hookType === 'agentStop'
    && isRecord(e.data?.output) && e.data.output.decision === 'block' && str(e.data.output.reason).includes(cli.nonce));
  const after = blockIdx === -1 ? [] : run.events.slice(blockIdx + 1);
  const injected = userMessages(after).some((m) => m.includes(reason));
  const nextStop = after.find((e) => e.type === 'hook.start' && e.data?.hookType === 'agentStop');
  const nextInput = isRecord(nextStop?.data?.input) ? nextStop.data.input : {};
  const activeOk = nextInput.stop_hook_active === true;
  const text = assistantText(after);
  const echoed = text.includes(token);
  return [
    {
      id: 'scn.continuation.blocked',
      ok: blockIdx !== -1,
      detail: blockIdx !== -1 ? 'agentStop hook.end carried the stub decision:block with its reason' : `no agentStop block with the stub reason (${stopStarts.length} agentStop run(s))`,
      ...(blockIdx !== -1 ? {} : { evidence: excerpt(JSON.stringify(hookEnds(run.events, 'agentStop').map((e) => e.data?.output))) }),
    },
    {
      id: 'scn.continuation.reason_injected',
      ok: injected,
      detail: injected ? 'the block reason arrived as the next user.message' : 'no user.message with the block reason after the block',
      ...(injected ? {} : { evidence: excerpt(userMessages(run.events).join('\n')) }),
    },
    {
      id: 'scn.continuation.stop_hook_active',
      ok: activeOk,
      detail: !nextStop ? 'no agentStop after the continuation' : `next agentStop input stop_hook_active=${JSON.stringify(nextInput.stop_hook_active)}`,
    },
    {
      id: 'scn.continuation.echo',
      ok: echoed,
      detail: echoed ? `the continuation turn replied ${token}` : `${token} missing from the continuation turn`,
      ...(echoed ? {} : { evidence: excerpt(text || assistantText(run.events)) }),
    },
  ];
}

function evaluatePromptContext(run: ScenarioRun): SmokeCheck[] {
  const cli = run.cli;
  if (!cli) return noCliEvidence('prompt-context', 2, run);
  const line = promptContextLine(cli.nonce);
  const ends = hookEnds(run.events, 'userPromptSubmitted');
  const accepted = ends.some((e) => isRecord(e.data?.output) && str(e.data.output.additionalContext).includes(line));
  const text = assistantText(run.events);
  const echoed = text.includes(cli.nonce);
  return [
    {
      id: 'scn.prompt-context.accepted',
      ok: accepted,
      detail: accepted ? 'userPromptSubmitted hook.end output carried the stub additionalContext' : 'stub additionalContext missing from every userPromptSubmitted hook.end output',
      ...(accepted ? {} : { evidence: excerpt(JSON.stringify(ends.map((e) => e.data?.output))) }),
    },
    {
      id: 'scn.prompt-context.reached_model',
      ok: echoed,
      // docs-audit #4: the current docs say config-file userPromptSubmitted output is dropped.
      detail: echoed ? 'the model echoed the additionalContext nonce' : 'the model did not echo the nonce: UserPromptSubmit additionalContext did not reach it (keyword and skill injection are lost on this CLI; consider userPromptTransformed)',
      ...(echoed ? {} : { evidence: excerpt(text) }),
    },
  ];
}

function evaluateEvents(run: ScenarioRun): SmokeCheck[] {
  const compacted = run.events.some((e) => e.type === 'session.compaction_start');
  const pre = hookCheck('scn.events.pre_compact', run.events, ['preCompact']);
  return [
    hookCheck('scn.events.post_tool_use_failure', run.events, ['postToolUseFailure']),
    hookCheck('scn.events.permission_request', run.events, ['permissionRequest']),
    {
      ...pre,
      ok: pre.ok && compacted,
      detail: `${pre.detail}; session.compaction_start ${compacted ? 'seen' : 'missing'} after ${COMPACT_PROMPT}`,
    },
  ];
}

/** A tool call our preToolUse hook denied for the ultragoal gate. */
export const ULTRAGOAL_DENY = /Denied by preToolUse hook:.*ULTRAGOAL/s;

function evaluateUltragoal(run: ScenarioRun): SmokeCheck[] {
  const cli = run.cli;
  if (!cli) return noCliEvidence('ultragoal', 2, run);
  const seed = cli.seed;
  const done = run.events.filter((e) => e.type === 'tool.execution_complete');
  const denied = done.filter((e) => ULTRAGOAL_DENY.test(JSON.stringify(e.data?.error ?? '')));
  const succeeded = done.filter((e) => e.data?.success === true);
  const allowed = denied.length === 0 && succeeded.length > 0;
  return [
    {
      id: 'scn.ultragoal.seeded',
      ok: !!seed?.ok,
      detail: seed ? seed.detail : 'no seed ran',
      ...(seed?.ok || !seed?.state ? {} : { evidence: excerpt(JSON.stringify(seed.state)) }),
    },
    {
      id: 'scn.ultragoal.tools_allowed',
      ok: allowed,
      detail: allowed ? `${succeeded.length} tool call(s) ran, none denied by the ultragoal gate`
        : denied.length ? `${denied.length} of ${done.length} tool call(s) denied by the ultragoal gate` : 'no tool call completed',
      ...(denied.length ? { evidence: excerpt(str(isRecord(denied[0].data?.error) ? denied[0].data.error.message : '')) } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// Team scenario (a real 2-worker `omg team` on the sdk transport)
// ---------------------------------------------------------------------------

/** The file each task commits; a task's subject names its file. */
export const TEAM_FILES: readonly string[] = ['team-alpha.txt', 'team-beta.txt'];
const TEAM_WORKERS = ['worker-1', 'worker-2'];
/**
 * AI credits ceiling of the team scenario: one user prompt per worker plus its
 * tool turns. A generous ceiling (single smoke prompts measured 0.3 to 0.9
 * credits), not a measured figure; it catches runaway continuations.
 */
export const TEAM_MAX_CREDITS = 10;
/** Wall-clock budget for start → both tasks completed → clean shutdown. */
export const TEAM_BUDGET_MS = 300_000;

/** What the team run left behind, gathered by the runner before and during shutdown. */
export interface TeamEvidence {
  teamName: string | null;
  start: { code: number | null; ok: boolean | null; ms: number; launchMs: number | null; stderr: string };
  /** The last `omg team status --json` before shutdown (null: none parsed). */
  status: Record<string, unknown> | null;
  /** `omg team api list-tasks` after the tasks settled. */
  tasks: Array<{ id: string; subject: string; status: string; owner: string | null }>;
  /**
   * Commits each worker added on top of the leader HEAD in its worktree, its
   * HEAD then, and how that HEAD fared at shutdown: `merged` into the leader
   * HEAD, `preserved` (the worktree kept at that HEAD and listed in
   * `preserved_worktrees`), `lost`, or null when there was nothing to keep.
   */
  commits: Array<{ worker: string; worktree: string | null; subjects: string[]; files: string[]; head?: string | null; survived?: 'merged' | 'preserved' | 'lost' | null }>;
  shutdown: { code: number | null; ms: number; stdout: string; stderr: string; forced: boolean } | null;
  /** Host and runtime pids still alive after shutdown. */
  orphans: number[];
  /** Instance reservations left for the team after shutdown. */
  reservationsLeft: string[];
  stateLeft: boolean;
  durationMs: number;
  budgetMs: number;
  cost: ScenarioCost & { source: string };
}

function evaluateTeam(run: ScenarioRun): SmokeCheck[] {
  const team = run.team;
  if (!team) return scenarioCheckIds('team').slice(0, 8).map((id) => ({ id, ok: false, detail: run.error ? `no team evidence: ${excerpt(run.error, 200)}` : 'no team evidence collected' }));
  const status = team.status;
  const transport = str(status?.transport);
  const sdkWorkers = Array.isArray((status?.workers as { sdk?: unknown } | undefined)?.sdk)
    ? (status!.workers as { sdk: Array<Record<string, unknown>> }).sdk : [];
  const statusTasks = (status?.tasks ?? {}) as Record<string, unknown>;
  const startedOk = team.start.code === 0 && team.start.ok === true && transport === 'sdk';
  const owners = team.tasks.map((t) => t.owner).filter((o): o is string => !!o).sort();
  const completedOk = team.tasks.length === 2 && team.tasks.every((t) => t.status === 'completed')
    && JSON.stringify(owners) === JSON.stringify(TEAM_WORKERS);
  // Each task's file must be among the commits its owner added in its own worktree.
  const expected = team.tasks.map((t) => ({ owner: t.owner, file: TEAM_FILES.find((f) => t.subject.includes(f)) }));
  const commitFor = (worker: string | null) => team.commits.find((c) => c.worker === worker);
  const committedOk = expected.length === 2 && expected.every(({ owner, file }) => !!file && !!commitFor(owner)?.files.includes(file));
  const statusOk = status?.ok === true && transport === 'sdk' && sdkWorkers.length === 2
    && sdkWorkers.every((w) => num(w.host_pid) > 0 && typeof w.session_id === 'string' && w.session_id !== '' && w.provider === 'alive')
    && num(statusTasks.total) === 2 && num(statusTasks.completed) === 2;
  const shutdownOk = !!team.shutdown && team.shutdown.code === 0 && !team.shutdown.forced
    && team.orphans.length === 0 && team.reservationsLeft.length === 0 && !team.stateLeft;
  // Every worker commit must outlive the shutdown: merged, or kept in a preserved worktree.
  const withWork = team.commits.filter((c) => c.subjects.length > 0);
  const retainedOk = withWork.length > 0 && withWork.every((c) => c.survived === 'merged' || c.survived === 'preserved');
  const durationOk = team.durationMs <= team.budgetMs;
  const creditsOk = team.cost.credits > 0 && team.cost.credits <= TEAM_MAX_CREDITS;
  const launch = team.start.launchMs === null ? '' : `, sdk hosts launched in ${team.start.launchMs} ms`;
  return [
    {
      id: 'scn.team.started',
      ok: startedOk,
      detail: startedOk
        ? `omg team started ${team.teamName} on the sdk transport (default, no --transport) in ${team.start.ms} ms${launch}`
        : `start exit ${String(team.start.code)}, ok ${String(team.start.ok)}, transport ${transport || 'unknown'}`,
      ...(startedOk ? {} : { evidence: excerpt(team.start.stderr) }),
    },
    {
      id: 'scn.team.completed',
      ok: completedOk,
      detail: completedOk
        ? 'both tasks completed through omg team api, one per worker'
        : `tasks: ${team.tasks.map((t) => `${t.id}:${t.status}@${t.owner ?? 'none'}`).join(', ') || 'none listed'}`,
    },
    {
      id: 'scn.team.committed',
      ok: committedOk,
      detail: committedOk
        ? expected.map(({ owner, file }) => `${owner} committed ${file} ("${commitFor(owner)!.subjects[0] ?? ''}")`).join('; ')
        : team.commits.map((c) => `${c.worker}: ${c.files.join(',') || 'no new files'} in ${c.worktree ?? 'no worktree'}`).join('; ') || 'no worktree commits found',
    },
    {
      id: 'scn.team.status',
      ok: statusOk,
      detail: statusOk
        ? `status --json: transport sdk, 2 sdk workers alive with host pid + session id, tasks 2/2 completed`
        : `status --json: ok ${String(status?.ok)}, transport ${transport || 'unknown'}, ${sdkWorkers.length} sdk worker(s), tasks ${num(statusTasks.completed)}/${num(statusTasks.total)}`,
      ...(statusOk || !status ? {} : { evidence: excerpt(JSON.stringify(status)) }),
    },
    {
      id: 'scn.team.shutdown',
      ok: shutdownOk,
      detail: shutdownOk
        ? `clean shutdown in ${team.shutdown!.ms} ms: no host or runtime left, reservation released, team state disposed`
        : !team.shutdown ? 'shutdown never ran'
          : `shutdown exit ${String(team.shutdown.code)}${team.shutdown.forced ? ' (forced after a timeout)' : ''}; `
            + `orphans ${team.orphans.join(',') || 'none'}; reservations left ${team.reservationsLeft.length}; state ${team.stateLeft ? 'left' : 'disposed'}`,
      // The end of the output names the preserved workers and the reason; the start is banners.
      ...(shutdownOk || !team.shutdown ? {} : { evidence: excerpt(`${team.shutdown.stdout}\n${team.shutdown.stderr}`.trim().slice(-480)) }),
    },
    {
      id: 'scn.team.retained',
      ok: retainedOk,
      detail: withWork.length === 0
        ? 'no worker commits to check'
        : withWork.map((c) => `${c.worker} ${(c.head ?? 'no head').slice(0, 8)} ${c.survived ?? 'unchecked'}`).join('; '),
    },
    {
      id: 'scn.team.duration',
      ok: durationOk,
      detail: `start to closeout ${team.durationMs} ms (budget ${team.budgetMs} ms)`,
    },
    {
      id: 'scn.team.credits',
      ok: creditsOk,
      detail: `${Number(team.cost.credits.toFixed(3))} AI credits (legacy ${team.cost.premiumRequests} premium request(s)) over ${team.cost.source} (max ${TEAM_MAX_CREDITS} credits)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Chain scenario (two real factory links)
// ---------------------------------------------------------------------------

/** Intent id of the smoke chain; its stop marker is `chain-<id>.stopped.json`. */
export const CHAIN_INTENT_ID = 'omg-smoke-chain';
/** Project skill link 2 is routed to (`/chain-ack ...`); it replies with one token. */
export const CHAIN_SKILL = 'chain-ack';
export const CHAIN_LINK1_STAGE = 'link-1';
export const CHAIN_LINK2_STAGE = 'link-2';
/**
 * AI credits ceiling of the chain scenario: two links, one user prompt each.
 * A generous ceiling (single smoke prompts measured 0.3 to 0.9 credits), not a
 * measured figure; it catches a runaway link.
 */
export const CHAIN_MAX_CREDITS = 6;

/** One link ledger as found on disk (`chain-<file>.json`). */
export interface ChainLedgerRecord { file: string; [key: string]: unknown }

/** What the chain left behind, read after it stopped (or timed out). */
export interface ChainEvidence {
  /** Link id of the first link (pre-written by the scenario). */
  firstLink: string;
  ledgers: ChainLedgerRecord[];
  decisions: Array<Record<string, unknown>>;
  stopped: { reason?: unknown } | null;
  /** Each closed link's host session and its persisted events (null: no events.jsonl). */
  sessions: Array<{ hostSessionId: string; events: CopilotEvent[] | null }>;
}

const ledgerStr = (ledger: ChainLedgerRecord | undefined, key: string): string => str(ledger?.[key]);

export function chainCost(chain: ChainEvidence): ScenarioCost & { source: string } {
  let premiumRequests = 0;
  let credits = 0;
  for (const s of chain.sessions) {
    const c = scenarioCost(s.events ?? []);
    premiumRequests += c.premiumRequests;
    credits += c.credits;
  }
  const found = chain.sessions.filter((s) => s.events !== null).length;
  return { premiumRequests, credits, source: `${found}/${chain.sessions.length} link session(s) events.jsonl` };
}

function evaluateChain(run: ScenarioRun): SmokeCheck[] {
  const chain = run.chain;
  if (!chain) return scenarioCheckIds('chain').slice(0, 5).map((id) => ({ id, ok: false, detail: 'no chain evidence collected' }));
  const link1 = chain.ledgers.find((l) => l.file === chain.firstLink);
  const children = chain.ledgers.filter((l) => ledgerStr(l, 'parentLink') === chain.firstLink);
  const link2 = children[0];
  const link1Host = ledgerStr(link1, 'hostSessionId');
  const link2Id = link2?.file ?? '';
  const link2Host = ledgerStr(link2, 'hostSessionId');
  const decisionFor = (linkId: string) => chain.decisions.filter((d) => d.sessionId === linkId && d.decision !== 'chain-link-rejected').at(-1);
  const rejected = chain.decisions.filter((d) => d.decision === 'chain-link-rejected');
  const open = chain.ledgers.filter((l) => !ledgerStr(l, 'closedAt'));
  const cost = chainCost(chain);
  const stopReason = str(chain.stopped?.reason);
  const ledgerEvidence = excerpt(JSON.stringify({ ledgers: chain.ledgers, decisions: chain.decisions, stopped: chain.stopped }));

  // Link 1 was resolved by OMC_CHAIN_LINK: its ledger was closed by a host session with another id.
  const link1Ok = !!link1 && !!link1Host && link1Host !== chain.firstLink && ledgerStr(link1, 'decision') === 'enqueued';
  const spawnedOk = children.length === 1 && ledgerStr(link2, 'host') === 'copilot' && ledgerStr(link2, 'stage') === CHAIN_LINK2_STAGE;
  // Link 2 ended under its own inherited identity: its ledger (named after the
  // id the worker handed over) was closed by a third session id, and no
  // SessionEnd was rejected along the way.
  const inheritedOk = spawnedOk && !!link2Host && link2Host !== link2Id && link2Host !== link1Host
    && str(decisionFor(link2Id)?.hostSessionId) === link2Host && rejected.length === 0;
  const closedOk = chain.ledgers.length === 2 && open.length === 0 && stopReason === `loop-capped:${CHAIN_LINK2_STAGE}`;
  const sessionsFound = chain.sessions.length === 2 && chain.sessions.every((s) => s.events !== null);
  const creditsOk = sessionsFound && cost.credits <= CHAIN_MAX_CREDITS;

  return [
    {
      id: 'scn.chain.link1',
      ok: link1Ok,
      detail: link1Ok
        ? `link 1 ${chain.firstLink} closed by host session ${link1Host} via OMC_CHAIN_LINK, decision enqueued`
        : !link1 ? 'link 1 ledger missing' : !link1Host ? 'link 1 ledger never closed (its SessionEnd did not resolve OMC_CHAIN_LINK)'
          : `link 1 closed with decision ${ledgerStr(link1, 'decision') || '?'} by ${link1Host}`,
      ...(link1Ok ? {} : { evidence: ledgerEvidence }),
    },
    {
      id: 'scn.chain.spawned',
      ok: spawnedOk,
      detail: spawnedOk
        ? `link 2 ${link2Id} spawned by link 1's SessionEnd worker (host copilot, stage ${CHAIN_LINK2_STAGE})`
        : `${children.length} ledger(s) with parentLink ${chain.firstLink}`,
      ...(spawnedOk ? {} : { evidence: ledgerEvidence }),
    },
    {
      id: 'scn.chain.inherited',
      ok: inheritedOk,
      detail: inheritedOk
        ? `link 2 ended as chain link ${link2Id} (host session ${link2Host}); no rejected OMC_CHAIN_LINK`
        : `link 2 host session ${link2Host || 'none'}${rejected.length ? `; ${rejected.length} chain-link-rejected decision(s)` : ''}`,
      ...(inheritedOk ? {} : { evidence: ledgerEvidence }),
    },
    {
      id: 'scn.chain.closed',
      ok: closedOk,
      detail: closedOk
        ? `chain closed out: 2 links, 0 open ledgers, stop marker ${stopReason}`
        : `${chain.ledgers.length} link(s), ${open.length} open, stop marker ${stopReason || 'none'}`,
      ...(closedOk ? {} : { evidence: ledgerEvidence }),
    },
    {
      id: 'scn.chain.credits',
      ok: creditsOk,
      detail: `${Number(cost.credits.toFixed(3))} AI credits (legacy ${cost.premiumRequests} premium request(s)) over ${cost.source} (max ${CHAIN_MAX_CREDITS} credits)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Factory run scenarios (`omg factory run` with real lanes, scripted gh)
// ---------------------------------------------------------------------------

/**
 * AI credits ceilings: about 1 credit per lane is the estimate (a small write
 * or review with a few tool turns) on the cheap model the driver pins for the
 * lanes, 3 per lane the ceiling, as for chain. It catches a runaway lane, not
 * a measured figure. Lanes on runtime auto (no cheap model listed, or none
 * pinned) measured about 3.6 credits each on Sonnet (CLI 1.0.105) and fail it.
 */
export const FACTORY_RUN_MAX_CREDITS: Readonly<Record<FactoryRunScenario, number>> = { 'factory-run': 6, 'factory-run-fix': 12 };
/** Check ids of both factory run variants (before the common exit, adapter_errors and cost). */
const FACTORY_RUN_CHECKS = ['lanes', 'implemented', 'reviewed_on_head', 'verdict_recorded', 'tamper', 'draft_pr', 'parked', 'no_merge', 'no_lane_push', 'state_resumable', 'credits'];
/** The lanes each variant must run, in order, with the review verdicts. */
export const FACTORY_RUN_EXPECTED_LANES: Readonly<Record<FactoryRunScenario, ReadonlyArray<{ kind: string; verdict?: string }>>> = {
  'factory-run': [{ kind: 'implement' }, { kind: 'review', verdict: 'approve' }],
  'factory-run-fix': [{ kind: 'implement' }, { kind: 'review', verdict: 'changes-requested' }, { kind: 'fix' }, { kind: 'review', verdict: 'approve' }],
};

/** What the factory run left behind: the engine outcome, its state, the bare remote and the scripted gh. */
export interface FactoryRunEvidence {
  outcome: { exitCode: number; phase: string | null; gate: string | null; message: string; mergeCommand: string | null } | null;
  lanes: Array<{
    id: string; kind: string; status: string; verdict: string | null; jobId: string | null; startSha: string; endSha: string | null;
    maxCredits: number; credits: number | null; source: string | null;
  }>;
  /** Every lane start the backend saw (the engine's caps and profiles). */
  laneStarts: Array<{ laneId: string; profile: string; maxCredits: number }>;
  /** The last head the engine pushed, and the bare remote's factory branch. */
  head: string | null;
  remoteHead: string | null;
  /** The bare remote's base branch before and after the run (a merge would move it). */
  baseBefore: string;
  baseAfter: string;
  remoteRefs: string[];
  shipVerdict: { verdict: string; sha: string; reviewer: string } | null;
  /** The factory state passes its integrity seal (a rerun resumes from it). */
  integrityOk: boolean;
  /** History notes that mention tampering (lane-tampered, state-tampered). */
  tamperNotes: string[];
  gh: { prCreates: string[]; ready: boolean; mergeCalls: string[] };
  warnings: string[];
  durationMs: number;
  cost: ScenarioCost & { source: string };
}

function evaluateFactoryRun(run: ScenarioRun): SmokeCheck[] {
  const name = run.name as FactoryRunScenario;
  const f = run.factory;
  if (!f) return scenarioCheckIds(name).slice(0, 11).map((id) => ({ id, ok: false, detail: run.error ? `no factory evidence: ${excerpt(run.error, 200)}` : 'no factory evidence collected' }));
  const p = `scn.${name}`;
  const expected = FACTORY_RUN_EXPECTED_LANES[name];
  const shape = f.lanes.map((l) => `${l.kind}${l.verdict ? `:${l.verdict}` : ''}@${l.status}`).join(', ') || 'none';
  const lanesOk = f.lanes.length === expected.length
    && expected.every((e, i) => f.lanes[i].kind === e.kind && f.lanes[i].status === 'completed' && (e.verdict === undefined || f.lanes[i].verdict === e.verdict) && !!f.lanes[i].jobId)
    && f.laneStarts.length === expected.length;
  const writes = f.lanes.filter((l) => l.kind !== 'review');
  const implementedOk = writes.length > 0 && writes.every((l) => !!l.endSha && l.endSha !== l.startSha) && !!f.head && f.head === f.remoteHead && f.head === writes.at(-1)!.endSha;
  const lastReview = f.lanes.filter((l) => l.kind === 'review').at(-1);
  const reviewedOk = !!lastReview && !!f.head && lastReview.startSha === f.head && lastReview.verdict === 'approve';
  const verdictOk = f.shipVerdict?.verdict === 'approve' && f.shipVerdict.sha === f.head;
  const tamperOk = f.tamperNotes.length === 0 && f.outcome?.gate !== 'lane-tampered' && f.outcome?.gate !== 'state-tampered';
  const draftOk = f.gh.prCreates.length === 1 && /\s--draft(\s|$)/.test(f.gh.prCreates[0]);
  const parkedOk = !!f.outcome && f.outcome.exitCode === 0 && f.outcome.gate === 'merge' && /^gh pr merge \d+ /.test(f.outcome.mergeCommand ?? '');
  const noMergeOk = f.gh.mergeCalls.length === 0 && !!f.baseBefore && f.baseAfter === f.baseBefore;
  const allowedRefs = [`refs/heads/${FACTORY_RUN_BASE}`, `refs/heads/factory/issue-${FACTORY_RUN_ISSUE}`];
  const strayRefs = f.remoteRefs.filter((r) => !allowedRefs.includes(r));
  const capsOk = f.laneStarts.length > 0 && f.laneStarts.every((s) => s.maxCredits === RUNTIME_MIN_MAX_CREDITS);
  const measured = f.lanes.length > 0 && f.lanes.every((l) => typeof l.credits === 'number');
  const ceiling = FACTORY_RUN_MAX_CREDITS[name];
  const creditsOk = capsOk && measured && f.cost.credits > 0 && f.cost.credits <= ceiling;
  return [
    { id: `${p}.lanes`, ok: lanesOk, detail: lanesOk ? `lanes ${shape}, each a copilot_run job` : `lanes ${shape} (expected ${expected.map((e) => `${e.kind}${e.verdict ? `:${e.verdict}` : ''}`).join(', ')})` },
    { id: `${p}.implemented`, ok: implementedOk, detail: implementedOk ? `write lane(s) committed; engine pushed ${f.head!.slice(0, 12)} to factory/issue-${FACTORY_RUN_ISSUE}` : `head ${f.head ?? 'none'}, remote ${f.remoteHead ?? 'none'}, write lanes ${writes.map((l) => `${l.startSha.slice(0, 8)}..${(l.endSha ?? 'none').slice(0, 8)}`).join(', ') || 'none'}` },
    { id: `${p}.reviewed_on_head`, ok: reviewedOk, detail: reviewedOk ? `the last review ran at the pushed head and approved` : `last review ${lastReview ? `at ${lastReview.startSha.slice(0, 12)} verdict ${lastReview.verdict ?? 'none'}` : 'missing'}, head ${f.head ?? 'none'}` },
    { id: `${p}.verdict_recorded`, ok: verdictOk, detail: f.shipVerdict ? `ship verdict ${f.shipVerdict.verdict} by ${f.shipVerdict.reviewer} at ${f.shipVerdict.sha.slice(0, 12)}` : 'no ship verdict recorded' },
    { id: `${p}.tamper`, ok: tamperOk, detail: tamperOk ? 'every lane passed the shared git state and state file checks' : `tamper: ${f.tamperNotes.map((n) => excerpt(n, 200)).join(' | ') || f.outcome?.gate}` },
    { id: `${p}.draft_pr`, ok: draftOk, detail: draftOk ? `one draft PR created through the scripted gh` : `${f.gh.prCreates.length} gh pr create call(s)${f.gh.prCreates[0] ? `: ${excerpt(f.gh.prCreates[0], 200)}` : ''}` },
    { id: `${p}.parked`, ok: parkedOk, detail: parkedOk ? `awaiting-human: merge; printed ${f.outcome!.mergeCommand}` : `outcome ${f.outcome ? `exit ${f.outcome.exitCode}, phase ${f.outcome.phase ?? 'none'}, gate ${f.outcome.gate ?? 'none'}: ${f.outcome.message}` : 'none'}` },
    { id: `${p}.no_merge`, ok: noMergeOk, detail: noMergeOk ? `no merge call reached gh; ${FACTORY_RUN_BASE} on the remote unchanged` : `merge calls ${f.gh.mergeCalls.length}; ${FACTORY_RUN_BASE} ${f.baseBefore.slice(0, 12)} -> ${f.baseAfter.slice(0, 12)}` },
    { id: `${p}.no_lane_push`, ok: strayRefs.length === 0, detail: strayRefs.length === 0 ? `the remote holds only ${allowedRefs.join(' and ')}` : `stray remote refs: ${strayRefs.join(', ')}` },
    { id: `${p}.state_resumable`, ok: f.integrityOk, detail: f.integrityOk ? 'factory state passes its integrity seal' : 'factory state missing or fails its integrity seal' },
    {
      id: `${p}.credits`,
      ok: creditsOk,
      detail: `${Number(f.cost.credits.toFixed(3))} AI credits (legacy ${f.cost.premiumRequests} premium request(s)) over ${f.cost.source} (max ${ceiling} credits)`
        + (capsOk ? `; every lane capped at ${RUNTIME_MIN_MAX_CREDITS}` : `; lane caps ${f.laneStarts.map((s) => s.maxCredits).join(', ') || 'none'} (expected ${RUNTIME_MIN_MAX_CREDITS})`)
        + (measured ? '' : '; a lane has no recorded usage'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Sandbox lane scenario (copilot_run lanes in the OS sandbox)
// ---------------------------------------------------------------------------

/** The file the write lane's probe creates in its worktree, the one change the engine commits. */
export const SANDBOX_LANE_FILE = 'sandbox-lane-ok.txt';
/** The file the review lane is asked to create in its worktree (it must not land). */
export const SANDBOX_REVIEW_FILE = 'review-canary.txt';
/** The file the canary lane's executeUserRequested command creates in its worktree. */
export const SANDBOX_CANARY_FILE = 'canary-inside.txt';
/** The probe script committed at the scenario repository's root; it prints one {@link SANDBOX_PROBE_MARKER} line. */
export const SANDBOX_PROBE_SCRIPT = 'sandbox-probe.mjs';
export const SANDBOX_PROBE_MARKER = 'OMG_SANDBOX_PROBE ';
/** A ceiling of 3 AI credits per lane over the three lanes on the pinned cheap model, as for factory-run: it catches a runaway lane. */
export const SANDBOX_LANE_MAX_CREDITS = 9;

export type SandboxLaneRole = 'review' | 'write' | 'canary';
/** Where a probe write aimed; the host checks after the lane whether a file landed there. */
export type SandboxTargetKind = 'main-checkout' | 'shared' | 'git-dir' | 'real-home' | 'profile' | 'worktree';

export interface SandboxWriteTarget { kind: SandboxTargetKind; path: string; landed: boolean }

/** The sandbox state of one lane as copilot_run recorded it (CopilotRunSandboxState). */
export interface SandboxLaneState {
  mode: string;
  host: { supported: boolean; reason?: string; capabilities: Record<string, boolean> };
  applied: string;
  enforcement?: { required: boolean; blocked: boolean; reason?: string };
  canary: string;
  unsandboxedCalls: number;
  reason?: string;
}

export interface SandboxLaneRecord {
  role: SandboxLaneRole;
  state: string;
  error: string | null;
  sandbox: SandboxLaneState | null;
  /** Completed shell tool calls in the lane's events, and those without `sandboxed: true`. */
  shellCalls: number;
  unattestedShellCalls: number;
  /** Shell calls that completed with `success: true`: evidence the lane launched a process at all. */
  okShellCalls: number;
  /** Files changed or added in the lane worktree (copilot_run `changes`). */
  changedFiles: string[];
  maxCredits: number;
  credits: number | null;
  /** The model the lane's session ran on (copilot_run snapshot.model; null: not reported). */
  model: string | null;
}

/** What the probe script printed (its {@link SANDBOX_PROBE_MARKER} line): per-write outcome and the two network reaches. */
export interface SandboxProbeOutput {
  /** `<os.homedir()>/omg-canary-<nonce>` inside the sandbox: the relocated profile. */
  home?: string;
  writes: Array<{ path: string; ok: boolean; error?: string }>;
  net: { local?: { ok: boolean; status?: number; error?: string } | null; outbound?: { ok: boolean; status?: number; error?: string } | null };
}

/** The canary lane's `session.rpc.shell.executeUserRequested` call before its first turn (Q5). */
export interface SandboxCanaryRecord {
  called: boolean;
  error?: string;
  result: { success: boolean; exitCode: number | null; output: string; toolCallId: string } | null;
  /** `sandboxed` of the tool.execution_complete with the call's toolCallId (null: no such event, or no field). */
  sandboxed: boolean | null;
  /** onPermissionRequest calls the session made while the RPC ran. */
  permissionRequests: number;
  targets: SandboxWriteTarget[];
}

export interface SandboxLaneEvidence {
  nonce: string;
  lanes: SandboxLaneRecord[];
  reviewTargets: SandboxWriteTarget[];
  writeTargets: SandboxWriteTarget[];
  /** The write lane's probe output, read from its shell tool result (null: the probe never ran). */
  probe: SandboxProbeOutput | null;
  /** Requests the host's loopback listener received from the write lane's probe. */
  localHits: number;
  commit: { ok: boolean; sha?: string; files: string[]; reason?: string } | null;
  canary: SandboxCanaryRecord | null;
  /** The OS temp dir: the default sandbox grant includes it, and the scenario repository lives there. */
  tempDir: string;
  /** Set when the host probe said unsupported: no lane ran and no credit was spent. */
  hostUnsupported?: { supported: boolean; reason?: string; capabilities: Record<string, boolean> };
  durationMs: number;
  cost: ScenarioCost & { source: string };
}

/** The probe output line in a tool result text, or null. */
export function parseSandboxProbe(text: string): SandboxProbeOutput | null {
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(SANDBOX_PROBE_MARKER);
    if (at === -1) continue;
    try {
      const v = JSON.parse(line.slice(at + SANDBOX_PROBE_MARKER.length)) as SandboxProbeOutput;
      if (v && Array.isArray(v.writes) && v.net && typeof v.net === 'object') return v;
    } catch { /* not the probe's JSON */ }
  }
  return null;
}

const SANDBOX_LANE_CHECKS = ['host', 'review_no_write', 'write_inside', 'write_outside_blocked', 'network_blocked', 'attested', 'engine_commit', 'q1_profile', 'q2_git_dir', 'q5_canary_rpc', 'credits'];

function evaluateSandboxLane(run: ScenarioRun): SmokeCheck[] {
  const p = 'scn.sandbox-lane';
  const e = run.sandbox;
  if (!e) return scenarioCheckIds('sandbox-lane').slice(0, SANDBOX_LANE_CHECKS.length).map((id) => ({ id, ok: false, detail: run.error ? `no sandbox evidence: ${excerpt(run.error, 200)}` : 'no sandbox evidence collected' }));
  if (e.hostUnsupported) return [{ id: `${p}.host`, ok: false, detail: `host unsupported (${excerpt(e.hostUnsupported.reason ?? 'no reason', 160)}); no lane ran, no credits spent` }];
  const lane = (role: SandboxLaneRole) => e.lanes.find((l) => l.role === role);
  const review = lane('review');
  const write = lane('write');
  const canaryLane = lane('canary');
  const enforced = (l: SandboxLaneRecord | undefined) => l?.sandbox?.mode === 'enforced';
  const modeOf = (l: SandboxLaneRecord | undefined) => (l ? `${l.role} ${l.sandbox?.mode ?? 'no sandbox state'}${l.sandbox?.reason && l.sandbox.mode !== 'enforced' ? ` (${excerpt(l.sandbox.reason, 160)})` : ''}` : 'missing');
  const target = (list: SandboxWriteTarget[], kind: SandboxTargetKind) => list.find((t) => t.kind === kind);
  const fate = (t: SandboxWriteTarget | undefined) => (!t ? 'not probed' : t.landed ? `LANDED at ${t.path}` : 'blocked');
  const unanswered = (l: SandboxLaneRecord | undefined) => `unanswered: ${modeOf(l)}${l?.error ? `; ${excerpt(l.error, 160)}` : ''}`;
  const host = e.lanes.find((l) => l.sandbox)?.sandbox?.host;

  const hostOk = !!host?.supported && e.lanes.length === 3 && e.lanes.every(enforced);
  const caps = host ? Object.entries(host.capabilities).map(([k, v]) => `${k}${v ? '' : ' (no)'}`).join(', ') || 'none listed' : 'unknown';

  const reviewLanded = e.reviewTargets.filter((t) => t.landed);
  // A lane whose tools never ran (a dead sandbox launch) lands nothing: "blocked" counts only once a shell call of the
  // lane succeeded (its `git status`; the review allowlist refuses the probe's `node`).
  const reviewRan = !!review && review.okShellCalls > 0;
  const reviewOk = !!review && review.state === 'completed' && enforced(review) && reviewRan && e.reviewTargets.length > 0 && reviewLanded.length === 0 && review.changedFiles.length === 0;

  const inside = target(e.writeTargets, 'worktree');
  const insideOk = !!write && enforced(write) && !!inside?.landed;
  const outside = e.writeTargets.filter((t) => t.kind === 'main-checkout' || t.kind === 'shared');
  const main = target(e.writeTargets, 'main-checkout');
  // The scenario repository must live somewhere (no dir is surely outside every default grant), so under the temp dir its
  // main-checkout target is informational: a landed write there is the temp grant, not a checkout confinement failure.
  const mainInformational = !!main && isUnder(main.path, e.tempDir, process.platform);
  // No probe output: the probe never ran, so a target that did not land was never tried.
  const noProbe = `the write lane's probe never ran (no probe output), so no target was tried; ${modeOf(write)}${write?.error ? `; ${excerpt(write.error, 160)}` : ''}`;
  const outsideOk = enforced(write) && !!e.probe && outside.length === 2 && outside.every((t) => !t.landed || (mainInformational && t === main));
  const tempNote = mainInformational ? ` (main-checkout is informational: the scenario repository is under the OS temp dir${main?.landed ? ', which the default sandbox grant includes' : ''}; the shared target decides)` : '';

  const outbound = e.probe?.net.outbound;
  const local = e.probe?.net.local;
  const networkOk = enforced(write) && !!e.probe && e.localHits === 0 && outbound?.ok === false && local?.ok !== true;
  const reach = (r: { ok: boolean; status?: number; error?: string } | null | undefined) => (!r ? 'not tried' : r.ok ? `REACHED (HTTP ${r.status ?? '?'})` : `blocked (${excerpt(r.error ?? 'error', 80)})`);

  const enforcedLanes = e.lanes.filter(enforced);
  const attestedOk = enforcedLanes.length === e.lanes.length && e.lanes.length > 0 && !!write && write.okShellCalls > 0
    && e.lanes.every((l) => l.unattestedShellCalls === 0 && (l.sandbox?.unsandboxedCalls ?? 0) === 0);

  const commitOk = !!e.commit?.ok && e.commit.files.length === 1 && e.commit.files[0] === SANDBOX_LANE_FILE;

  const realHome = target(e.writeTargets, 'real-home');
  const profile = target(e.writeTargets, 'profile');
  const q1Answered = enforced(write) && !!realHome && !!e.probe;
  const q1Ok = q1Answered && !realHome!.landed;
  const q1Detail = !q1Answered ? (enforced(write) && !e.probe ? `Q1 unanswered: ${noProbe}` : `Q1 ${unanswered(write)}`)
    : `Q1: real profile write ${realHome!.landed ? `LANDED (${realHome!.path}): the profile grant is read-write and relocation does not move it; add the real home to readonlyPaths` : 'blocked'}; `
      + `relocated profile write ${!profile ? 'not probed (the probe printed no home)' : profile.landed ? `landed (${profile.path}): the profile grant follows USERPROFILE/HOME, and the read-only job home entry does not narrow it` : `blocked (${profile.path})`}`;

  const gitDir = target(e.writeTargets, 'git-dir');
  const q2Answered = enforced(write) && !!gitDir && !!e.probe;
  const q2Ok = q2Answered && !gitDir!.landed;
  const q2Detail = !q2Answered ? (enforced(write) && !e.probe ? `Q2 unanswered: ${noProbe}` : `Q2 ${unanswered(write)}`)
    : gitDir!.landed ? `Q2: common git dir write LANDED (${gitDir!.path}): the CLI grants it read-write for a linked worktree over the readonlyPaths entry; write lanes are not confined (upstream feature request)`
      : `Q2: common git dir write blocked (${gitDir!.path}): no linked-worktree auto-grant overrides the readonlyPaths entry`;

  const c = e.canary;
  const cOutside = c ? target(c.targets, 'shared') : undefined;
  const cInside = c ? target(c.targets, 'worktree') : undefined;
  // No probe line in the output: the probe never launched (node denied, say), so an outside write that did not land was never tried.
  const cProbeRan = !!c?.result && parseSandboxProbe(c.result.output) !== null;
  const q5Answered = enforced(canaryLane) && !!c?.called && cProbeRan;
  const q5Ok = q5Answered && c!.sandboxed === true && !!cOutside && !cOutside.landed && !!cInside?.landed;
  const q5Detail = !c?.called ? `Q5 ${unanswered(canaryLane)}`
    : !c.result ? `Q5: shell.executeUserRequested failed: ${excerpt(c.error ?? 'no result', 200)}`
      : !cProbeRan ? `Q5 unanswered: probe did not run (exit ${String(c.result.exitCode)}, no ${SANDBOX_PROBE_MARKER.trim()} line; output ${JSON.stringify(excerpt(c.result.output || c.error || '', 200))})`
      : `Q5: shell.executeUserRequested ran ${c.sandboxed === true ? 'sandboxed' : c.sandboxed === false ? 'NOT sandboxed' : 'with no sandboxed attestation'}`
        + ` (exit ${String(c.result.exitCode)}); outside write ${fate(cOutside)}; worktree write ${cInside?.landed ? 'landed' : 'missing'}; `
        + `onPermissionRequest ${c.permissionRequests > 0 ? `consulted (${c.permissionRequests})` : 'bypassed'}`
        + (q5Ok ? ': a free canary through this RPC works' : ': the canary needs a model turn instead');

  const capsOk = e.lanes.length > 0 && e.lanes.every((l) => l.maxCredits === RUNTIME_MIN_MAX_CREDITS);
  const measured = e.lanes.length > 0 && e.lanes.every((l) => typeof l.credits === 'number');
  const creditsOk = capsOk && measured && e.cost.credits > 0 && e.cost.credits <= SANDBOX_LANE_MAX_CREDITS;

  return [
    { id: `${p}.host`, ok: hostOk, detail: host ? `host ${host.supported ? 'supported' : `unsupported (${excerpt(host.reason ?? 'no reason', 160)})`}, capabilities ${caps}; ${e.lanes.map(modeOf).join(', ')}` : `no lane recorded a sandbox state; ${e.lanes.map(modeOf).join(', ') || 'no lanes'}` },
    {
      id: `${p}.review_no_write`,
      ok: reviewOk,
      detail: !review ? 'no review lane' : `review lane ${review.state}, ${modeOf(review)}; ${e.reviewTargets.map((t) => `${t.kind} ${t.landed ? 'LANDED' : 'blocked'}`).join(', ') || 'no targets'}; worktree changes ${review.changedFiles.join(', ') || 'none'}`
        + (reviewRan ? '' : `; the lane ran no command (none of its ${review.shellCalls} shell call(s) succeeded), so "blocked" is no evidence${review.error ? `: ${excerpt(review.error, 160)}` : ''}`),
    },
    { id: `${p}.write_inside`, ok: insideOk, detail: !write ? 'no write lane' : `write lane ${write.state}, ${modeOf(write)}; ${SANDBOX_LANE_FILE} in the worktree ${inside?.landed ? 'created' : 'missing'}` },
    { id: `${p}.write_outside_blocked`, ok: outsideOk, detail: !e.probe ? noProbe : outside.length ? `${outside.map((t) => `${t.kind} ${fate(t)}`).join('; ')}${tempNote}` : `no outside targets probed; ${modeOf(write)}` },
    { id: `${p}.network_blocked`, ok: networkOk, detail: !e.probe ? `no probe output from the write lane; ${modeOf(write)}` : `loopback listener ${e.localHits} hit(s), probe local ${reach(local)}; outbound https://github.com ${reach(outbound)}` },
    {
      id: `${p}.attested`,
      ok: attestedOk,
      detail: e.lanes.map((l) => `${l.role} ${l.shellCalls} shell call(s), ${l.unattestedShellCalls} without sandboxed:true, copilot_run counted ${l.sandbox?.unsandboxedCalls ?? 0}`).join('; ') || 'no lanes',
    },
    { id: `${p}.engine_commit`, ok: commitOk, detail: !e.commit ? 'the engine commit did not run' : e.commit.ok ? `engine committed ${e.commit.sha?.slice(0, 12)} with ${e.commit.files.join(', ') || 'no files'}${commitOk ? '' : ` (expected only ${SANDBOX_LANE_FILE})`}` : `engine commit refused: ${excerpt(e.commit.reason ?? '', 200)}` },
    { id: `${p}.q1_profile`, ok: q1Ok, detail: q1Detail },
    { id: `${p}.q2_git_dir`, ok: q2Ok, detail: q2Detail },
    { id: `${p}.q5_canary_rpc`, ok: q5Ok, detail: q5Detail },
    {
      id: `${p}.credits`,
      ok: creditsOk,
      detail: `${Number(e.cost.credits.toFixed(3))} AI credits (legacy ${e.cost.premiumRequests} premium request(s)) over ${e.cost.source} (max ${SANDBOX_LANE_MAX_CREDITS} credits)`
        + (capsOk ? `; every lane capped at ${RUNTIME_MIN_MAX_CREDITS}` : `; lane caps ${e.lanes.map((l) => l.maxCredits).join(', ') || 'none'} (expected ${RUNTIME_MIN_MAX_CREDITS})`)
        + (measured ? '' : '; a lane has no recorded usage')
        + `; lanes ran on ${e.lanes.map((l) => `${l.role} ${l.model ?? 'unreported'}`).join(', ') || 'none'}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Filetools scenario (pre/postToolUse hooks on Copilot's file tools)
// ---------------------------------------------------------------------------

/**
 * Probe plugin entries, loaded next to ours: each records its stdin payload.
 * PascalCase entries get the Claude-format payload (tool_name, tool_input);
 * camelCase entries the native one (toolName, toolArgs).
 */
export const PROBE_ENTRIES = [
  { event: 'PreToolUse', label: 'PreToolUse' },
  { event: 'PostToolUse', label: 'PostToolUse' },
  { event: 'PostToolUse', label: 'PostToolUse:matcher', matcher: FILE_TOOL_MATCHER },
  { event: 'preToolUse', label: 'preToolUse' },
  { event: 'postToolUse', label: 'postToolUse' },
] as const;
export type ProbeLabel = typeof PROBE_ENTRIES[number]['label'];

/** The probe plugin's hooks.json: `node <script> <label> <log>` per {@link PROBE_ENTRIES} entry. */
export function probeHooksJson(node: string, script: string, log: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const e of PROBE_ENTRIES) {
    (hooks[e.event] ??= []).push({
      type: 'command',
      ...('matcher' in e ? { matcher: e.matcher } : {}),
      exec: node,
      args: [script, e.label, log],
      timeoutSec: 10,
    });
  }
  return { version: 1, hooks };
}

/** One probe hook run: its entry label and the payload it read on stdin (null: not JSON). */
export interface ProbeRecord { label: string; payload: Record<string, unknown> | null }

export interface FiletoolsEvidence {
  /** Random tokens in the fixture's two README.md files (read side, write side), never in the prompt. */
  nonce: string;
  writeNonce: string;
  probe: ProbeRecord[];
  /** notes.txt reads `status: done`; created.txt exists. */
  edited: boolean;
  created: boolean;
}

/** Copilot's built-in file tools: read and write side. */
export const FILE_READ_TOOLS: readonly string[] = ['view'];
export const FILE_WRITE_TOOLS: readonly string[] = ['create', 'edit', 'str_replace_editor', 'apply_patch'];

/** `args` as the runtime reported them: an object, or apply_patch's patch text. */
interface FileToolCall { id: string; name: string; args: unknown; ok: boolean }

function fileToolCalls(events: CopilotEvent[]): FileToolCall[] {
  const done = new Map(events.filter((e) => e.type === 'tool.execution_complete').map((e) => [str(e.data?.toolCallId), e.data?.success === true]));
  return events.filter((e) => e.type === 'tool.execution_start' && [...FILE_READ_TOOLS, ...FILE_WRITE_TOOLS].includes(str(e.data?.toolName)))
    .map((e) => ({ id: str(e.data?.toolCallId), name: str(e.data?.toolName), args: e.data?.arguments, ok: done.get(str(e.data?.toolCallId)) === true }));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Same rule as scripts/lib/tool-input-paths.mjs: apply_patch names its files in these lines. */
const PATCH_FILE_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm;

/** The paths a file-tool input names: Claude `file_path`, Copilot `path`, or apply_patch's file lines. */
function inputPaths(input: unknown): string[] {
  if (typeof input === 'string') return [...input.matchAll(PATCH_FILE_LINE)].map((m) => m[1]);
  const o = asObject(input);
  const p = o ? str(o.file_path) || str(o.path) : '';
  return p ? [p] : [];
}

/**
 * Tool name and input of a probe payload: Claude format (`tool_name`,
 * `tool_input`) for PascalCase entries, native (`toolName`, `toolArgs`) for
 * camelCase ones (Copilot CLI 1.0.91).
 */
export function probeTool(r: ProbeRecord): { name: string; input: unknown } {
  const p = r.payload ?? {};
  return { name: str(p.tool_name) || str(p.toolName), input: p.tool_input ?? p.toolArgs };
}

/** Identity of a tool input: the text itself, or the object's JSON with sorted keys. */
function inputKey(input: unknown): string {
  if (typeof input === 'string') return `text:${input}`;
  const o = asObject(input);
  return o ? JSON.stringify(o, Object.keys(o).sort()) : '';
}

/**
 * Probe records of one label for one tool call. Neither payload carries the
 * tool call id (1.0.91), so a record belongs to the call whose arguments its
 * input equals.
 */
function recordsFor(call: FileToolCall, records: ProbeRecord[], label: string): ProbeRecord[] {
  const want = inputKey(call.args);
  return want ? records.filter((r) => r.label === label && inputKey(probeTool(r).input) === want) : [];
}

/** Model-facing text of a tool result: the completion's content, or what the runtime sent the model. */
function toolResultTexts(events: CopilotEvent[], callId: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (str(e.data?.toolCallId) !== callId) continue;
    if (e.type === 'tool.execution_complete') out.push(str(asObject(e.data?.result)?.content));
    if (e.type === 'model.tool_execution') out.push(str(asObject(e.data?.toolResult)?.textResultForLlm));
  }
  return out.filter(Boolean);
}

function evaluateFiletools(run: ScenarioRun): SmokeCheck[] {
  const ft = run.filetools;
  const ids = scenarioCheckIds('filetools');
  if (!ft) return ids.slice(0, 8).map((id) => ({ id, ok: false, detail: run.error ? `no filetools evidence: ${excerpt(run.error, 200)}` : 'no filetools evidence collected' }));
  const calls = fileToolCalls(run.events).filter((c) => c.ok);
  const reads = calls.filter((c) => FILE_READ_TOOLS.includes(c.name));
  const writes = calls.filter((c) => FILE_WRITE_TOOLS.includes(c.name));
  const toolsOk = reads.length > 0 && writes.length > 0 && ft.edited && ft.created;
  // Each completed file tool call against the probe records of each label (Claude and native entries).
  const seen = (claudeLabel: string, nativeLabel?: string) => {
    const rows = calls.map((c) => ({ c, claude: recordsFor(c, ft.probe, claudeLabel), native: nativeLabel ? recordsFor(c, ft.probe, nativeLabel) : [] }));
    const ok = calls.length > 0 && rows.every((r) => r.claude.length > 0 && (!nativeLabel || r.native.length > 0));
    const names = (recs: ProbeRecord[]) => [...new Set(recs.map((x) => probeTool(x).name || '?'))].join('/') || 'none';
    const detail = rows.map((r) => `${r.c.name}→${names(r.claude)}${nativeLabel ? ` (native ${names(r.native)})` : ''}`).join(', ') || 'no file tool calls';
    return { ok, detail, rows };
  };
  const pre = seen('PreToolUse', 'preToolUse');
  const post = seen('PostToolUse', 'postToolUse');
  const matcher = seen('PostToolUse:matcher');
  // Claude-format records name the tool by a name our matcher lists and carry its path(s); native ones keep the native name.
  const claudeNames = new Set(FILE_TOOL_MATCHER.split('|'));
  const payloadRows = [...pre.rows, ...post.rows];
  const payloadOk = calls.length > 0 && payloadRows.every((r) => r.claude.every((x) => claudeNames.has(probeTool(x).name) && inputPaths(probeTool(x).input).length > 0)
    && r.native.every((x) => probeTool(x).name === r.c.name));
  const shape = (recs: ProbeRecord[]) => {
    if (!recs[0]) return 'none';
    const { name, input } = probeTool(recs[0]);
    return typeof input === 'string' ? `${name} "<patch: ${inputPaths(input).map((p) => p.split(/[\\/]/).slice(-2).join('/')).join(', ')}>"` : `${name} {${Object.keys(asObject(input) ?? {}).join(',')}}`;
  };
  // A direct view of a fixture README.md would put its nonce in its own result: only other calls count.
  const contextCall = (c: FileToolCall) => inputPaths(c.args).some((p) => /readme\.md$/i.test(p));
  // Prove the path, not the wording: our injector's output at the hook, then in a model-facing tool result.
  const injection = (nonce: string, from: FileToolCall[]) => {
    const hookOut = run.events.some((e) => e.type === 'hook.end' && e.data?.hookType === 'postToolUse'
      && JSON.stringify(e.data?.output ?? '').includes(nonce));
    const carrier = from.find((c) => !contextCall(c) && toolResultTexts(run.events, c.id).some((t) => t.includes(nonce)));
    return {
      ok: hookOut && !!carrier,
      detail: `nonce ${hookOut ? 'in' : 'missing from'} a postToolUse hook.end output; `
        + `${carrier ? `in the ${carrier.name} tool result sent to the model` : 'in no model-facing tool result'}`,
    };
  };
  const read = injection(ft.nonce, reads);
  const write = injection(ft.writeNonce, writes);
  const echoed = assistantText(run.events).includes(ft.nonce);
  return [
    {
      id: 'scn.filetools.tools',
      ok: toolsOk,
      detail: `${calls.map((c) => c.name).join(', ') || 'no file tool calls'} completed; notes.txt ${ft.edited ? 'edited' : 'unchanged'}, created.txt ${ft.created ? 'created' : 'missing'}`,
    },
    hookCheck('scn.filetools.hooks', run.events, ['preToolUse', 'postToolUse']),
    { id: 'scn.filetools.pre', ok: pre.ok, detail: `PreToolUse probe: ${pre.detail}` },
    { id: 'scn.filetools.post', ok: post.ok, detail: `PostToolUse probe: ${post.detail}` },
    { id: 'scn.filetools.matcher', ok: matcher.ok, detail: `PostToolUse matcher ${FILE_TOOL_MATCHER}: ${matcher.detail}` },
    {
      id: 'scn.filetools.payload',
      ok: payloadOk,
      detail: post.rows.map((r) => `${r.c.name}: tool_name ${shape(r.claude)}`).join('; ') || 'no file tool calls',
      ...(payloadOk ? {} : { evidence: excerpt(JSON.stringify(payloadRows.map((r) => ({ call: r.c.name, claude: r.claude.map(probeTool), native: r.native.map(probeTool) })))) }),
    },
    {
      id: 'scn.filetools.injected',
      ok: read.ok,
      detail: `${FILETOOLS_FILES.context} ${read.detail}; model ${echoed ? 'echoed it' : 'did not echo it'}`,
      ...(read.ok ? {} : { evidence: excerpt(assistantText(run.events)) }),
    },
    {
      id: 'scn.filetools.injected_write',
      ok: write.ok,
      detail: `${FILETOOLS_FILES.writeContext} ${write.detail}`,
    },
  ];
}

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
    filetools: ['tools', 'hooks', 'pre', 'post', 'matcher', 'payload', 'injected', 'injected_write'],
    chain: ['link1', 'spawned', 'inherited', 'closed', 'credits'],
    team: ['started', 'completed', 'committed', 'status', 'shutdown', 'retained', 'duration', 'credits'],
    'factory-run': FACTORY_RUN_CHECKS,
    'factory-run-fix': FACTORY_RUN_CHECKS,
    'sandbox-lane': SANDBOX_LANE_CHECKS,
    continuation: ['blocked', 'reason_injected', 'stop_hook_active', 'echo'],
    'prompt-context': ['accepted', 'reached_model'],
    events: ['post_tool_use_failure', 'permission_request', 'pre_compact'],
    ultragoal: ['seeded', 'tools_allowed'],
  };
  return [...own[name], 'exit', 'adapter_errors', 'cost'].map((s) => `scn.${name}.${s}`);
}

export const SDK_STATIC_IDS = ['sdk.available', 'sdk.runtime', 'sdk.plugins', 'sdk.skills', 'sdk.agents', 'sdk.mcp', 'sdk.tools_excluded', 'sdk.sandbox'] as const;

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

/** The free part of the sandbox probe: host support, then the review policy on the static session and its enforcement. */
export interface SdkSandboxProbe {
  /** The host-support RPC answered (false: missing or it threw). */
  answered: boolean;
  host: { supported: boolean; reason?: string; capabilities: Record<string, boolean>; launchFailed?: true };
  /** Why the review policy was not applied (null: applied); absent when the host is unsupported. */
  applyError?: string | null;
  /** The enforcement status after the apply, or why it could not be read. */
  enforcement?: { required: boolean; blocked: boolean; reason?: string } | string;
  /** The spawn canary (sandboxed `node --version` and `git --version` with the lane env and grants, no model turn); absent when it did not get that far. */
  spawn?: { ok: boolean; detail: string };
}

/**
 * `sdk.sandbox`, no model call: what copilot_run would decide on this host.
 * An unsupported host passes (sessions fail closed: no shell for review,
 * write refuses); a supported host must take the review policy without
 * enforcement reporting blocked, and the spawn canary must launch a
 * sandboxed process with the lane env. The detail starts with `supported`
 * or `unsupported`.
 */
export function evaluateSdkSandbox(probe: SdkSandboxProbe): SmokeCheck {
  const id = 'sdk.sandbox';
  const { host } = probe;
  const caps = Object.entries(host.capabilities).map(([k, v]) => `${k}${v ? '' : ' (no)'}`).join(', ') || 'none listed';
  if (!probe.answered) return { id, ok: false, detail: `host probe failed: ${host.reason ?? 'no answer'}` };
  // The runtime claims support but cannot launch: lanes fail closed, yet nothing proved a sandboxed launch.
  if (!host.supported && host.launchFailed) {
    return { id, ok: false, detail: `launch-blocked: the runtime reports the sandbox supported, but a trial launch failed: ${host.reason ?? 'no reason'}; copilot_run sessions here run fail-closed; spawn canary not run (not a pass)` };
  }
  if (!host.supported) {
    return { id, ok: true, detail: `unsupported (${host.reason ?? 'no reason'}), capabilities ${caps}: copilot_run review sessions run read-only without a shell, write sessions refuse (sandbox-unavailable); canary skipped` };
  }
  if (probe.applyError) return { id, ok: false, detail: `supported, capabilities ${caps}; the review policy was not applied: ${probe.applyError}` };
  const enf = probe.enforcement;
  if (enf === undefined || typeof enf === 'string') return { id, ok: false, detail: `supported, capabilities ${caps}; review policy applied; enforcement unread: ${enf ?? 'not asked'}` };
  const spawn = probe.spawn ?? { ok: false, detail: 'not run' };
  return {
    id,
    ok: !enf.blocked && spawn.ok,
    detail: `supported, capabilities ${caps}; review policy applied (options.update), enforcement required=${enf.required} blocked=${enf.blocked}${enf.reason ? ` (${enf.reason})` : ''}; `
      + `spawn canary: ${spawn.detail}`,
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
  /** chain: the ledgers, decisions and link sessions the chain left behind. */
  chain?: ChainEvidence;
  /** team: start, status, tasks, commits and shutdown evidence of the 2-worker sdk team. */
  team?: TeamEvidence;
  /** factory-run, factory-run-fix: the engine outcome and state, the bare remote and the scripted gh. */
  factory?: FactoryRunEvidence;
  /** sandbox-lane: the three lanes, the host-side write checks, the engine commit and the canary RPC. */
  sandbox?: SandboxLaneEvidence;
  /** filetools: the probe plugin's hook records and the fixture's state after the turn. */
  filetools?: FiletoolsEvidence;
  /** CLI scenarios: the session id, stub nonce, per-process results, stub records and seed. */
  cli?: CliEvidence;
}

/** What one scenario run cost: chain and team span several sessions with their own totals. */
export function runCost(run: Pick<ScenarioRun, 'events' | 'chain' | 'team' | 'factory' | 'sandbox'>): ScenarioCost & { source: string } {
  if (run.chain) return chainCost(run.chain);
  if (run.team) return run.team.cost;
  if (run.factory) return run.factory.cost;
  if (run.sandbox) return run.sandbox.cost;
  return scenarioCost(run.events);
}

/** AI credits billed, plus the legacy premium request count the CLI still reports. */
export interface ScenarioCost { credits: number; premiumRequests: number }


function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** AI credits billed by one `assistant.usage` event (0 for any other event). */
export function usageCredits(event: CopilotEvent): number {
  if (event.type !== 'assistant.usage') return 0;
  return num((event.data?.copilotUsage as Record<string, unknown> | undefined)?.totalNanoAiu) / NANO_AIU_PER_CREDIT;
}

/**
 * Prefer `session.shutdown` totals (emitted at disconnect); else sum
 * `assistant.usage`: AI credits from `copilotUsage.totalNanoAiu` (every model
 * call bills credits), and the legacy premium requests counted per
 * user-initiated call.
 */
export function scenarioCost(events: CopilotEvent[]): ScenarioCost & { source: string } {
  const shutdown = [...events].reverse().find((e) => e.type === 'session.shutdown');
  if (shutdown?.data && (typeof shutdown.data.totalPremiumRequests === 'number' || typeof shutdown.data.totalNanoAiu === 'number')) {
    return { premiumRequests: num(shutdown.data.totalPremiumRequests), credits: num(shutdown.data.totalNanoAiu) / NANO_AIU_PER_CREDIT, source: 'session.shutdown' };
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
      detail: `${cost.credits.toFixed(3)} AI credits, legacy ${cost.premiumRequests} premium request(s) (${cost.source}); model ${run.model}`
        + (overBudget ? `; over the credit cap (${budget.toFixed(3)} left of maxCredits ${run.maxCredits})` : ''),
    },
  ];
}

/**
 * The account quota error in a scenario's events, or null: a
 * `model.call_failure` with HTTP 402 or a quota errorCode
 * (`quota_exceeded`), or a `session.error` of errorType `quota`.
 */
export function accountQuotaError(events: CopilotEvent[]): string | null {
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const code = typeof d.errorCode === 'string' ? d.errorCode : '';
    if (e.type === 'model.call_failure' && (d.statusCode === 402 || /quota/i.test(code))) {
      let message = typeof d.errorMessage === 'string' ? d.errorMessage : '';
      try { message = String((JSON.parse(message) as { message?: unknown }).message ?? message); } catch { /* plain text */ }
      return [String(d.statusCode ?? '?'), code, message && `"${excerpt(message, 120)}"`].filter(Boolean).join(' ');
    }
    if (e.type === 'session.error' && d.errorType === 'quota') return `session.error quota${typeof d.message === 'string' ? ` "${excerpt(d.message, 120)}"` : ''}`;
  }
  return null;
}

export function evaluateScenario(run: ScenarioRun): { checks: SmokeCheck[]; cost: ScenarioCost } {
  const own = {
    smoke: evaluateSmoke,
    guardrail: evaluateGuardrail,
    skill: evaluateSkill,
    delegate: evaluateDelegate,
    filetools: evaluateFiletools,
    chain: evaluateChain,
    team: evaluateTeam,
    'factory-run': evaluateFactoryRun,
    'factory-run-fix': evaluateFactoryRun,
    'sandbox-lane': evaluateSandboxLane,
    continuation: evaluateContinuation,
    'prompt-context': evaluatePromptContext,
    events: evaluateEvents,
    ultragoal: evaluateUltragoal,
  }[run.name](run);
  const cost = runCost(run);
  let checks = [...own, ...evaluateCommon(run, cost)];
  const pending = PENDING_SCENARIOS[run.name];
  if (pending) checks = checks.map((c) => (c.ok ? c : { ...c, detail: `[${pending}] ${c.detail}` }));
  const quota = accountQuotaError(run.events);
  if (quota) {
    checks = [
      { id: `scn.${run.name}.quota`, ok: false, detail: `account quota exhausted (${quota}), not a product failure; the checks below failed because no model call ran` },
      ...checks.map((c) => (c.ok ? c : { ...c, detail: `[quota exhausted] ${c.detail}` })),
    ];
  }
  return {
    checks,
    cost: { premiumRequests: cost.premiumRequests, credits: cost.credits },
  };
}

// ---------------------------------------------------------------------------
// Model choice
// ---------------------------------------------------------------------------

const CHEAP_MODEL = /(mini|flash|haiku|nano|lite|luna)/i;

/** `ScenarioRun.model` of a lane scenario: the model pinned for its lanes, then the ones they reported running on. */
export function laneModelLabel(pinned: string | undefined, used: ReadonlyArray<string | null>): string {
  const ran = [...new Set(used.map((m) => m ?? 'unreported'))];
  return `copilot_run lanes ${pinned ? `pinned to ${pinned}` : 'on runtime auto (no cheap model listed)'}; ran on ${ran.join(', ') || 'no lane yet'}`;
}

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
