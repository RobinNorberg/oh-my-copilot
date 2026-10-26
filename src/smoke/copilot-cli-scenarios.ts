/**
 * Tier 2 CLI scenarios of `omg smoke copilot` (opt-in): headless `copilot`
 * sessions with the plugin under test, outside the SDK runtime, for what an
 * SDK session cannot set up: a stub plugin next to ours, a resumed session,
 * or a seeded workflow state. Ported from the 2026-10-23 live probe.
 *
 * - continuation: a stub Stop hook blocks the first stop with a reason that
 *   carries a nonce. Copilot injects the reason as a user.message, the model
 *   answers it, and the next stop carries stop_hook_active:true.
 * - prompt-context: a stub UserPromptSubmit hook returns a top-level
 *   additionalContext (the shape our adapter emits) with a nonce, and the
 *   model must echo it.
 * - events: a view of a missing file (postToolUseFailure) and a shell call
 *   under default permissions (permissionRequest), then the same session
 *   resumed with `/compact` (preCompact).
 * - ultragoal: our UserPromptSubmit group activates ultragoal for the session,
 *   the state is backdated past the confirmation TTL, and the session's tool
 *   calls must not be denied (pending lane g-cont, see PENDING_SCENARIOS).
 *
 * Every process gets the tier 1 isolation (the tier 2 env and COPILOT_HOME),
 * `--plugin-dir` for the plugin under test, `--max-ai-credits`, debug logs in
 * the shared `<home>/logs` (sliced per scenario by the driver), and the
 * persisted events.jsonl of its session id as the scenario's event stream.
 */

import { randomBytes, randomUUID } from 'crypto';
import { spawn as nodeSpawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildHostBinarySpawn } from '../cli/tmux-utils.js';
import { excerpt, parseJsonl, type CopilotEvent } from './copilot-session-eval.js';
import { dispatchHookEntry, entryMatches, readCopilotHookManifest } from './copilot-hook-manifest.js';
import {
  continuationReason,
  COMPACT_PROMPT,
  promptContextLine,
  runCost,
  RUNTIME_MIN_MAX_CREDITS,
  SCENARIOS,
  ULTRAGOAL_ACTIVATION_PROMPT,
  ULTRAGOAL_CONFIRM_TTL_MS,
  type CliEvidence,
  type CliScenario,
  type CliStepRecord,
  type ScenarioRun,
} from './copilot-sdk-scenarios.js';
import { runAsync, type SpawnFn, type SpawnSyncFn } from './process-utils.js';

export interface CliScenarioInput {
  name: CliScenario;
  /** The installed copilot binary (.exe or the .js a shim launches). */
  bin: string;
  root: string;
  /** Tier 2 session env (isolated COPILOT_HOME, login identity, OMC_HOOK_FAIL_CLOSED). */
  env: NodeJS.ProcessEnv;
  projectDir: string;
  home: string;
  /** Per copilot process. */
  timeoutMs: number;
  maxCredits: number;
  budget: number;
  eventsPath: string;
  spawnSync: SpawnSyncFn;
  /** Test seams. */
  spawn?: SpawnFn;
  randomUUID?: () => string;
  node?: string;
  now?: () => number;
}

/**
 * Sandbox flags per scenario (deny rules beat allow rules). Every scenario
 * denies our host_smoke tool and the built-in MCP servers; no scenario may
 * write files. `events` and `ultragoal` pre-approve only `view`, so the shell
 * call of `events` goes through a permission request.
 */
export const CLI_SCENARIO_PERMISSIONS: Record<CliScenario, string[]> = {
  continuation: ['--allow-all-tools', '--no-ask-user', '--deny-tool', 'shell', '--deny-tool', 'write'],
  'prompt-context': ['--allow-all-tools', '--no-ask-user', '--deny-tool', 'shell', '--deny-tool', 'write'],
  events: ['--allow-tool', 'view', '--no-ask-user', '--deny-tool', 'write'],
  ultragoal: ['--allow-tool', 'view', '--no-ask-user', '--deny-tool', 'shell', '--deny-tool', 'write'],
};
const SANDBOX_FLAGS = ['--deny-tool', 't(host_smoke)', '--disable-builtin-mcps', '--no-auto-update'];

/** Stub hook registrations, PascalCase like ours in copilot/hooks.json. */
const STUB_EVENTS: Partial<Record<CliScenario, { event: string; kind: string }>> = {
  continuation: { event: 'Stop', kind: 'stop' },
  'prompt-context': { event: 'UserPromptSubmit', kind: 'prompt' },
};

/**
 * Writes the stub plugin under the home: `stub.cjs <kind> <config> <log>`.
 * `stop` blocks the first stop with the configured reason, then allows;
 * `prompt` returns the configured additionalContext. Each run appends
 * `{kind, payload, out}` to the log.
 */
export function prepareStubPlugin(home: string, name: CliScenario, text: string, node: string = process.execPath): { dir: string; log: string } | null {
  const reg = STUB_EVENTS[name];
  if (!reg) return null;
  const dir = join(home, `${name}-stub`);
  const log = join(home, `${name}-stub.jsonl`);
  const config = join(dir, 'config.json');
  const script = join(dir, 'stub.cjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({ name: `omg-smoke-${name}-stub`, version: '0.0.0', description: `omg smoke ${name} stub hook`, hooks: './hooks.json' }, null, 2)}\n`);
  writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify({ version: 1, hooks: { [reg.event]: [{ type: 'command', exec: node, args: [script, reg.kind, config, log], timeoutSec: 10 }] } }, null, 2)}\n`);
  writeFileSync(config, JSON.stringify({ text }));
  writeFileSync(script, [
    "'use strict';",
    "const fs = require('fs');",
    'const [kind, config, log] = process.argv.slice(2);',
    "const { text } = JSON.parse(fs.readFileSync(config, 'utf8'));",
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    '  let payload = null;',
    "  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded as null */ }",
    '  let out = {};',
    "  if (kind === 'prompt') out = { additionalContext: text };",
    "  if (kind === 'stop') {",
    "    const count = log + '.count';",
    "    if (!fs.existsSync(count)) { fs.writeFileSync(count, '1'); out = { decision: 'block', reason: text }; }",
    '  }',
    "  fs.appendFileSync(log, JSON.stringify({ kind, payload, out }) + '\\n');",
    '  process.stdout.write(JSON.stringify(out));',
    '});',
    '',
  ].join('\n'));
  return { dir, log };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  try { return parseJsonl(readFileSync(path, 'utf8')).events as unknown as Array<Record<string, unknown>>; } catch { return []; }
}

/**
 * Where the hooks write the session's ultragoal state. A literal `.omg/`, not
 * getOmcRoot(): the hook env is stripped of OMC_STATE_DIR (buildSessionEnv),
 * while this process may carry one.
 */
export function ultragoalStatePath(projectDir: string, sessionId: string): string {
  return join(projectDir, '.omg', 'state', 'sessions', sessionId, 'ultragoal-state.json');
}

/**
 * Activate ultragoal for the session through our real UserPromptSubmit hook
 * group (keyword-detector), then backdate the confirmation past its TTL and
 * cap the reinforcements at 1, so a continuation loop ends after one turn.
 */
export function seedUltragoal(input: Pick<CliScenarioInput, 'root' | 'projectDir' | 'env' | 'spawnSync'>, sessionId: string, now: number): NonNullable<CliEvidence['seed']> {
  let entries;
  try {
    entries = (readCopilotHookManifest(input.root).hooks.UserPromptSubmit ?? []).filter((e) => entryMatches(e));
  } catch (err) {
    return { ok: false, detail: `copilot/hooks.json: ${(err as Error).message}` };
  }
  if (entries.length === 0) return { ok: false, detail: 'copilot/hooks.json registers no UserPromptSubmit entry' };
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: sessionId, timestamp: new Date(now).toISOString(), cwd: input.projectDir, prompt: ULTRAGOAL_ACTIVATION_PROMPT };
  const runs = entries.map((e) => dispatchHookEntry('UserPromptSubmit', e, input.root, payload, { cwd: input.projectDir, env: input.env, spawnSync: input.spawnSync }));
  const path = ultragoalStatePath(input.projectDir, sessionId);
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    const run = runs.find((r) => r.status !== 0 || r.stderr.trim()) ?? runs[0];
    return { ok: false, detail: `no ultragoal state after the activation hook (exit ${String(run?.status)}): ${excerpt(run?.stderr || run?.stdout, 200)}` };
  }
  if (state.active !== true) return { ok: false, detail: 'activation hook wrote an inactive ultragoal state', state };
  state = { ...state, awaiting_confirmation_set_at: new Date(now - ULTRAGOAL_CONFIRM_TTL_MS - 60_000).toISOString(), max_reinforcements: 1 };
  writeFileSync(path, JSON.stringify(state, null, 2));
  return { ok: true, detail: `ultragoal activated by our UserPromptSubmit group, confirmation backdated past the ${ULTRAGOAL_CONFIRM_TTL_MS / 1000} s TTL`, state };
}

export async function runCliScenario(input: CliScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & { wedged: boolean }> {
  const { name } = input;
  const sessionId = (input.randomUUID ?? randomUUID)();
  const nonce = randomBytes(6).toString('hex');
  const cli: CliEvidence = { sessionId, nonce, steps: [], stub: [] };
  const base = {
    name,
    timeoutMs: input.timeoutMs,
    model: 'cli default (copilot, no --model)',
    maxCredits: input.maxCredits,
    budget: input.budget,
    capped: false,
    wedged: false,
    cli,
  };

  let stub: ReturnType<typeof prepareStubPlugin> = null;
  try {
    stub = prepareStubPlugin(input.home, name, name === 'continuation' ? continuationReason(nonce) : promptContextLine(nonce), input.node);
    if (name === 'ultragoal') {
      writeFileSync(join(input.projectDir, 'README.md'), '# omg smoke ultragoal fixture\n');
      cli.seed = seedUltragoal(input, sessionId, (input.now ?? Date.now)());
    }
  } catch (err) {
    return { ...base, events: [], idle: false, timedOut: false, error: `${name} setup: ${(err as Error).message}` };
  }
  if (cli.seed && !cli.seed.ok) return { ...base, events: [], idle: false, timedOut: false, error: `ultragoal seed: ${cli.seed.detail}` };

  const eventsFile = join(input.home, 'session-state', sessionId, 'events.jsonl');
  const readEvents = (): CopilotEvent[] => {
    try { return parseJsonl(readFileSync(eventsFile, 'utf8')).events; } catch { return []; }
  };
  const argsFor = (budget: number) => [
    '--plugin-dir', input.root,
    ...(stub ? ['--plugin-dir', stub.dir] : []),
    '--session-id', sessionId,
    '--output-format', 'json',
    ...CLI_SCENARIO_PERMISSIONS[name],
    ...SANDBOX_FLAGS,
    '--log-level', 'debug',
    '--log-dir', join(input.home, 'logs'),
    '--max-ai-credits', String(Math.max(RUNTIME_MIN_MAX_CREDITS, Math.ceil(budget))),
  ];
  // `events` resumes the same session id with /compact (preCompact, no premium request).
  const prompts: Array<[string, string]> = [['prompt', SCENARIOS[name].prompt], ...(name === 'events' ? [['compact', COMPACT_PROMPT] as [string, string]] : [])];
  let error: string | undefined;
  let timedOut = false;
  let budget = input.budget;
  for (const [label, prompt] of prompts) {
    const plan = buildHostBinarySpawn(input.bin, argsFor(budget));
    // The prompt rides stdin, never argv (a piped prompt is non-interactive).
    const res = await runAsync(input.spawn ?? nodeSpawn, input.spawnSync, plan.command, plan.args, {
      cwd: input.projectDir,
      env: input.env,
      input: `${prompt}\n`,
      timeoutMs: input.timeoutMs,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    const step: CliStepRecord = { label, code: res.code, timedOut: res.timedOut, durationMs: res.durationMs, ...(res.error ? { error: res.error } : {}) };
    cli.steps.push(step);
    if (res.timedOut) { timedOut = true; break; }
    if (res.error || res.code !== 0) { error = res.error ?? `copilot (${label}) exited ${String(res.code)}: ${excerpt(res.stderr, 200)}`; break; }
    // The next step gets only what this one left of the scenario budget.
    budget = input.budget - runCost({ events: readEvents() }).credits;
  }

  const events = readEvents();
  if (!error && !timedOut && events.length === 0) error = `no events.jsonl for session ${sessionId}`;
  try { writeFileSync(input.eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')); } catch { /* best effort */ }
  if (stub && existsSync(stub.log)) {
    cli.stub = readJsonl(stub.log).map((r) => ({
      kind: String(r.kind ?? ''),
      payload: r.payload && typeof r.payload === 'object' ? r.payload as Record<string, unknown> : null,
      out: r.out && typeof r.out === 'object' ? r.out as Record<string, unknown> : {},
    }));
  }
  return { ...base, events, idle: !timedOut && !error, timedOut, ...(error ? { error } : {}) };
}
