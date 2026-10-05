/**
 * `omg team sdk-host`: the detached per-worker process behind `--transport sdk`.
 *
 * One host owns one `@github/copilot-sdk` client and one session for one team
 * worker. It is the worker's launch "provider": it writes the launch-attempt
 * ack and the `provider_started` record with its own pid and strict process
 * start identity, so the existing provider liveness, retire and cleanup code
 * observes it like a pane provider. On exit it writes the `.terminal` record.
 *
 * Inputs (all under the worker's state dir, see sdk-transport.ts):
 * - `sdk-host-spec.json`  written by the leader before the spawn;
 * - `sdk-doorbell.jsonl`  appended by anyone (leader, other workers' mailbox
 *   sends); the host tails it and `send()`s prompts only while the session is
 *   idle, so a busy session never receives a second send;
 * - `<started>.termination-request`  written by the shared retire path: hard stop.
 * Outputs: `sdk-session.json` (state, usage, permissions, timeline),
 * `sdk-events.jsonl` (every session event), and `shutdown-ack.json` when the
 * doorbell carries a shutdown.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { atomicWriteJson } from '../lib/atomic-write.js';
import type { CopilotEvent } from '../smoke/copilot-session-eval.js';
import { RUNTIME_MIN_MAX_CREDITS, usageCredits } from '../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../smoke/copilot-smoke.js';
import {
  runtimePid,
  type LoadedSdk,
  type SdkClientLike,
  type SdkSessionLike,
} from '../smoke/copilot-sdk-driver.js';
import { loadWorkerLaunchAttempt, type WorkerLaunchAttempt } from './worker-launch-ack.js';
import { buildSdkExcludedTools, decideSdkPermission, type SdkPermissionRequest, type SdkPolicyContext } from './sdk-policy.js';
import { sdkWorkerFiles, type SdkDoorbellEntry, type SdkHostSpec, type SdkSessionFile } from './sdk-transport.js';

const DECISION_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STOP_TIMEOUT_MS = 15_000;
const PERMISSION_LOG_MAX = 200;

export interface SdkHostDeps {
  loadSdk: () => Promise<LoadedSdk | null>;
  pid: number;
  /** Strict start identity of `pid` (`ticks:<n>` on win32), as liveness reads it. */
  startIdentity: (pid: number) => string | null;
  isAlive: (pid: number) => boolean;
  killTree: (pid: number) => void;
  platform: NodeJS.Platform;
  pollMs: number;
  /** Source env for the runtime (the host's own env). */
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export type SdkHostOutcome =
  | 'stopped'
  | 'terminated'
  | 'team_gone'
  | 'invalid_spec'
  | 'decision_revoked'
  | 'decision_timeout'
  | 'ack_conflict'
  | 'sdk_missing'
  | 'start_failed';

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function identityOf(a: WorkerLaunchAttempt) {
  return {
    schema_version: a.schema_version,
    attempt_id: a.attempt_id,
    nonce: a.nonce,
    instance_id: a.instance_id,
    team_name: a.team_name,
    worker_name: a.worker_name,
    pane_id: a.pane_id,
    provider: a.provider,
    created_at: a.created_at,
  };
}

/** Same exclusive candidate+link publish the launch protocol uses. */
async function writeExclusive(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, path);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function waitForDecision(attempt: WorkerLaunchAttempt, timeoutMs: number): Promise<'accepted' | 'revoked' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readJsonFile(attempt.decisionPath);
    if (record && record.kind === 'worker_launch_decision' && record.attempt_id === attempt.attempt_id && record.nonce === attempt.nonce) {
      if (record.decision === 'accepted' || record.decision === 'revoked') return record.decision;
    }
    await sleep(25);
  }
  return 'timeout';
}

/** Parse doorbell lines after `offset`; returns entries and the new offset (complete lines only). */
export function readDoorbell(path: string, offset: number): { entries: SdkDoorbellEntry[]; offset: number } {
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return { entries: [], offset }; }
  if (buf.length <= offset) return { entries: [], offset };
  const chunk = buf.subarray(offset).toString('utf8');
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) return { entries: [], offset };
  const complete = chunk.slice(0, lastNewline);
  const entries: SdkDoorbellEntry[] = [];
  for (const line of complete.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SdkDoorbellEntry;
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') entries.push(parsed);
    } catch { /* a torn or foreign line is skipped */ }
  }
  return { entries, offset: offset + Buffer.byteLength(complete, 'utf8') + 1 };
}

/** Prepend `dir` to PATH, matching the key case-insensitively on win32. */
export function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): void {
  const key = platform === 'win32'
    ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
    : 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  env[key] = env[key] ? `${dir}${sep}${env[key]}` : dir;
}

/** `omg` shims so `omg team api …` inside the worker runs the leader's own CLI build. */
function writeOmgShims(binDir: string, cliPath: string, nodePath: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'omg.cmd'), `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`);
  writeFileSync(join(binDir, 'omg.ps1'), `& "${nodePath}" "${cliPath}" @args\r\nexit $LASTEXITCODE\r\n`);
  writeFileSync(join(binDir, 'omg'), `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
}

/** Zero-model introspection: the offered tool names and MCP server states. */
async function probeSession(s: SdkSessionLike): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    const tools = s.rpc.tools;
    if (tools?.initializeAndValidate) await withTimeout(tools.initializeAndValidate(), RPC_TIMEOUT_MS, 'tools.initializeAndValidate');
    const meta = tools?.getCurrentMetadata ? await withTimeout(tools.getCurrentMetadata(), RPC_TIMEOUT_MS, 'tools.getCurrentMetadata') : null;
    const list = (meta as { tools?: Array<{ name?: string }> } | null)?.tools ?? [];
    out.tools = list.map((t) => t.name).filter(Boolean).sort();
  } catch (err) { out.tools_error = errText(err); }
  try { out.mcp = await withTimeout(s.rpc.mcp.list(), RPC_TIMEOUT_MS, 'mcp.list'); } catch (err) { out.mcp_error = errText(err); }
  return out;
}

export async function runSdkHost(spec: SdkHostSpec, deps: SdkHostDeps): Promise<SdkHostOutcome> {
  const files = sdkWorkerFiles(spec.state_root, spec.worker_name);
  const log = deps.log ?? (() => {});
  const attempt = await loadWorkerLaunchAttempt({
    cwd: spec.leader_cwd,
    teamName: spec.team_name,
    workerName: spec.worker_name,
    instanceId: spec.instance_id,
    paneId: spec.pane_id,
    provider: 'copilot',
    attemptId: spec.attempt_id,
    runtimeCliPath: spec.runtime_cli_path,
  });
  if (!attempt) return 'invalid_spec';

  const session: SdkSessionFile = {
    schema_version: 1,
    team_name: spec.team_name,
    worker_name: spec.worker_name,
    attempt_id: spec.attempt_id,
    host_pid: deps.pid,
    runtime_pid: null,
    session_id: null,
    model: spec.model ?? null,
    state: 'starting',
    turns: 0,
    queued: 0,
    delivered: [],
    last_event_type: null,
    last_event_at: null,
    updated_at: new Date().toISOString(),
    usage: { credits: 0, premium_requests: 0, shutdown_premium_requests: null, shutdown_credits: null },
    hooks: { session_end_runs: 0, failed: 0 },
    aborts: 0,
    permissions: [],
    last_error: null,
    timeline: { host_started_at: new Date().toISOString() },
  };
  let dirty = true;
  const flush = async (force = false) => {
    if (!dirty && !force) return;
    dirty = false;
    session.updated_at = new Date().toISOString();
    try {
      await atomicWriteJson(files.session, session);
    } catch (err) {
      // win32: the rename fails (EPERM/EBUSY) while a reader holds the file; retry on the next tick.
      dirty = true;
      log(`session write failed: ${errText(err)}`);
    }
  };
  const mark = (stamp?: keyof SdkSessionFile['timeline']) => {
    if (stamp && !session.timeline[stamp]) session.timeline[stamp] = new Date().toISOString();
    dirty = true;
  };

  // 1. Launch protocol: ack, leader decision, provider_started (this host).
  const identity = identityOf(attempt);
  if (!await writeExclusive(attempt.ackPath, { ...identity, kind: 'worker_launch_ack', written_at: new Date().toISOString() })) {
    return 'ack_conflict';
  }
  mark('ack_at');
  const decision = await waitForDecision(attempt, DECISION_TIMEOUT_MS);
  if (decision !== 'accepted') return decision === 'revoked' ? 'decision_revoked' : 'decision_timeout';
  mark('accepted_at');
  const startIdentity = deps.startIdentity(deps.pid);
  if (!startIdentity) return 'start_failed';
  const groupFields = deps.platform === 'win32' ? {} : { process_group_id: deps.pid };
  await writeExclusive(attempt.startedPath, {
    ...identity,
    kind: 'worker_launch_provider_started',
    pid: deps.pid,
    process_start_identity: startIdentity,
    written_at: new Date().toISOString(),
    ...groupFields,
  });
  await flush(true);

  const writeTerminal = async (cleanupVerified: boolean) => {
    const record = {
      ...identity,
      kind: 'worker_launch_provider_terminal',
      outcome: cleanupVerified ? 'exit' : 'cleanup_unverified',
      cleanup_verified: cleanupVerified,
      pid: deps.pid,
      process_start_identity: startIdentity,
      exit_code: 0,
      signal: null,
      written_at: new Date().toISOString(),
      ...(deps.platform === 'win32' ? {} : { child_reaped: true, ...groupFields }),
    };
    try { await atomicWriteJson(`${attempt.startedPath}.terminal`, record); } catch (err) { log(`terminal write failed: ${errText(err)}`); }
    if (cleanupVerified && existsSync(`${attempt.startedPath}.termination-request`)) {
      await writeExclusive(`${attempt.startedPath}.termination-complete`, {
        ...identity,
        kind: 'worker_launch_termination_complete',
        cleanup_verified: true,
        pid: deps.pid,
        process_start_identity: startIdentity,
        ...groupFields,
        written_at: new Date().toISOString(),
      }).catch(() => false);
    }
  };
  const fail = async (outcome: SdkHostOutcome, error: string): Promise<SdkHostOutcome> => {
    session.state = 'failed';
    session.last_error = error;
    mark('closed_at');
    await flush(true);
    await writeTerminal(true);
    return outcome;
  };

  // 2. SDK client + session.
  let loaded: LoadedSdk | null = null;
  try { loaded = await deps.loadSdk(); } catch { loaded = null; }
  if (!loaded) return fail('sdk_missing', '@github/copilot-sdk is not installed (npm i -g @github/copilot-sdk --omit=optional --ignore-scripts)');

  mkdirSync(files.home, { recursive: true });
  const homeConfig = join(files.home, 'config.json');
  const ident = loginIdentity(spec.user_config_dir);
  if (!existsSync(homeConfig)) {
    writeFileSync(homeConfig, `${JSON.stringify({ ...ident, trustedFolders: [spec.worker_cwd, spec.leader_cwd] }, null, 2)}\n`);
  }
  writeOmgShims(files.bin, spec.omg_cli_path, spec.node_path);
  const env = buildSessionEnv(deps.env, files.home, { session: false, hasLogin: ident.loggedInUsers !== undefined });
  Object.assign(env, spec.worker_env, { OMC_GIT_GUARDRAILS: '1', COPILOT_ALLOW_ALL: 'false' });
  prependPath(env, files.bin, deps.platform);

  const policy: SdkPolicyContext = {
    cwd: spec.worker_cwd,
    stateRoot: spec.state_root,
    pluginRoot: spec.plugin_root,
    readRoots: [files.home],
    mcpServer: spec.mcp_server,
    denyTools: spec.deny_tools,
    denyUrls: spec.deny_urls,
    platform: deps.platform,
  };
  const cap = Math.max(RUNTIME_MIN_MAX_CREDITS, Math.ceil(spec.max_credits));
  const denyFlags = [
    ...spec.deny_tools.map((p) => `--deny-tool=${p}`),
    ...spec.deny_urls.map((p) => `--deny-url=${p}`),
  ];
  const { CopilotClient, RuntimeConnection } = loaded.module;
  const client: SdkClientLike = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: spec.copilot_bin,
      args: ['--log-level', 'debug', '--max-ai-credits', String(cap), ...denyFlags],
      env,
    }),
    baseDirectory: files.home,
    workingDirectory: spec.worker_cwd,
  });

  let sessionRef: SdkSessionLike | null = null;
  let busy = false;
  let capped = false;
  let idleWaiter: (() => void) | null = null;
  let shutdownSeen: (() => void) | null = null;
  const shutdownEvent = new Promise<void>((r) => { shutdownSeen = r; });
  const onEvent = (event: CopilotEvent) => {
    const at = new Date().toISOString();
    try { appendFileSync(files.events, `${JSON.stringify({ at, ...event })}\n`); } catch { /* evidence only */ }
    session.last_event_type = event.type ?? null;
    session.last_event_at = at;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'session.idle':
        busy = false;
        session.state = capped ? 'capped' : 'idle';
        idleWaiter?.();
        break;
      case 'assistant.message':
        mark('first_message_at');
        break;
      case 'assistant.usage': {
        session.usage.credits += usageCredits(event);
        if (data.initiator === 'user') session.usage.premium_requests += 1;
        if (!capped && session.usage.credits > spec.max_credits) {
          capped = true;
          session.last_error = `credit cap ${spec.max_credits} reached (${session.usage.credits.toFixed(2)})`;
          void sessionRef?.abort().catch(() => undefined);
        }
        break;
      }
      case 'session.shutdown':
        if (typeof data.totalPremiumRequests === 'number') session.usage.shutdown_premium_requests = data.totalPremiumRequests;
        if (typeof data.totalNanoAiu === 'number') session.usage.shutdown_credits = data.totalNanoAiu / 1e9;
        shutdownSeen?.();
        break;
      case 'session.error':
      case 'model.turn_failed':
        session.last_error = String(data.message ?? data.error ?? data.reason ?? event.type).slice(0, 500);
        break;
      case 'abort':
        session.aborts += 1;
        break;
      case 'hook.start':
        if (data.hookType === 'sessionEnd') session.hooks.session_end_runs += 1;
        break;
      case 'hook.end':
        if (data.success === false) session.hooks.failed += 1;
        break;
      default:
        break;
    }
    dirty = true;
  };
  const onPermissionRequest = (req: SdkPermissionRequest) => {
    const decision = decideSdkPermission(req, policy);
    session.permissions.push({
      at: new Date().toISOString(),
      kind: String(req.kind),
      approve: decision.approve,
      reason: decision.reason,
      detail: String(req.fullCommandText ?? req.resolvedPath ?? req.fileName ?? req.path ?? req.url ?? req.toolName ?? '').slice(0, 300),
    });
    if (session.permissions.length > PERMISSION_LOG_MAX) session.permissions.splice(0, session.permissions.length - PERMISSION_LOG_MAX);
    dirty = true;
    return decision.approve
      ? { kind: 'approve-once' as const }
      : { kind: 'reject' as const, feedback: `omg team sdk worker policy: ${decision.reason}` };
  };

  try {
    await withTimeout(client.start(), START_TIMEOUT_MS, 'client.start()');
    session.runtime_pid = runtimePid(client) ?? null;
    mark('client_started_at');
    sessionRef = await withTimeout(client.createSession({
      onPermissionRequest,
      onEvent,
      pluginDirectories: [spec.plugin_root],
      workingDirectory: spec.worker_cwd,
      disabledMcpServers: ['github-mcp-server'],
      excludedTools: buildSdkExcludedTools(spec.mcp_server, spec.deny_tools),
      ...(spec.model ? { model: spec.model } : {}),
    }), RPC_TIMEOUT_MS, 'createSession()');
    session.session_id = sessionRef.sessionId;
    session.state = 'idle';
    mark('session_created_at');
    await flush(true);
  } catch (err) {
    const pid = session.runtime_pid ?? runtimePid(client);
    if (pid && deps.isAlive(pid)) deps.killTree(pid);
    try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), 5_000, 'forceStop()'); } catch { /* gone */ }
    return fail('start_failed', errText(err));
  }

  // 3. Doorbell loop.
  const queue: Array<{ id: string; text: string }> = [];
  let offset = 0;
  let stop: 'graceful' | 'hard' | null = null;
  let outcome: SdkHostOutcome = 'stopped';
  const s = sessionRef;
  for (;;) {
    const read = readDoorbell(files.doorbell, offset);
    offset = read.offset;
    for (const entry of read.entries) {
      if (entry.kind === 'prompt' && typeof entry.text === 'string' && entry.text.trim()) {
        queue.push({ id: entry.id, text: entry.text });
      } else if (entry.kind === 'abort') {
        if (busy) await s.abort().catch(() => undefined);
      } else if (entry.kind === 'shutdown') {
        try {
          await atomicWriteJson(files.shutdownAck, { status: 'accept', reason: 'sdk_host_shutdown', updated_at: new Date().toISOString() });
        } catch (err) { log(`shutdown ack failed: ${errText(err)}`); }
        stop = 'graceful';
      } else if (entry.kind === 'stop') {
        stop = 'graceful';
      } else if (entry.kind === 'probe' && !busy) {
        await atomicWriteJson(files.probe, await probeSession(s)).catch(() => undefined);
      }
    }
    if (!stop && existsSync(`${attempt.startedPath}.termination-request`)) { stop = 'hard'; outcome = 'terminated'; }
    if (!stop && !existsSync(spec.state_root)) { stop = 'hard'; outcome = 'team_gone'; }
    if (stop) break;
    session.queued = queue.length;
    if (!busy && queue.length > 0 && !capped) {
      const next = queue.shift()!;
      busy = true;
      session.state = 'busy';
      session.turns += 1;
      session.delivered.push(next.id);
      mark('first_send_at');
      try {
        await withTimeout(s.send({ prompt: next.text }), RPC_TIMEOUT_MS, 'send()');
      } catch (err) {
        busy = false;
        session.state = 'idle';
        session.last_error = `send failed: ${errText(err)}`;
      }
    }
    await flush();
    await sleep(deps.pollMs);
  }

  // 4. Teardown.
  session.state = 'closing';
  await flush(true);
  const pid = session.runtime_pid ?? runtimePid(client) ?? undefined;
  if (stop === 'hard') {
    if (pid && deps.isAlive(pid)) deps.killTree(pid);
    try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), 5_000, 'forceStop()'); } catch { /* gone */ }
  } else {
    if (busy) {
      const settled = new Promise<void>((r) => { idleWaiter = r; });
      await s.abort().catch(() => undefined);
      await Promise.race([settled, sleep(ABORT_GRACE_MS)]);
    }
    try { await withTimeout(s.disconnect(), RPC_TIMEOUT_MS, 'disconnect()'); } catch { /* runtime gone */ }
    await Promise.race([shutdownEvent, sleep(SHUTDOWN_GRACE_MS)]);
    try { await withTimeout(client.deleteSession(s.sessionId), RPC_TIMEOUT_MS, 'deleteSession()'); } catch { /* best effort */ }
    let stopped = false;
    try { await withTimeout(client.stop(), STOP_TIMEOUT_MS, 'client.stop()'); stopped = true; } catch { /* escalate */ }
    if (!stopped) {
      if (pid && deps.isAlive(pid)) deps.killTree(pid);
      try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS, 'forceStop()'); } catch { /* gone */ }
    }
  }
  if (pid && deps.isAlive(pid)) deps.killTree(pid);
  const runtimeGone = !pid || !deps.isAlive(pid);
  session.state = 'closed';
  mark('closed_at');
  await flush(true);
  await writeTerminal(runtimeGone);
  return outcome;
}

/** CLI entry (`omg team sdk-host --spec <file>`): runs the host, then exits the process. */
export async function runSdkHostMain(specPath: string): Promise<never> {
  const { spawnSync } = await import('node:child_process');
  const { loadCopilotSdk } = await import('../smoke/copilot-sdk-driver.js');
  const { killProcessTree } = await import('../smoke/process-utils.js');
  const { getProcessStartIdentitySync, isProcessAlive } = await import('../platform/process-utils.js');
  const log = (line: string) => { process.stdout.write(`${new Date().toISOString()} [sdk-host ${process.pid}] ${line}\n`); };
  let code = 1;
  try {
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SdkHostSpec;
    if (spec?.schema_version !== 1 || !spec.worker_name || !spec.state_root) throw new Error('invalid sdk host spec');
    log(`start team=${spec.team_name} worker=${spec.worker_name} attempt=${spec.attempt_id}`);
    const outcome = await runSdkHost(spec, {
      loadSdk: () => loadCopilotSdk(process.env, spawnSync),
      pid: process.pid,
      startIdentity: (pid) => getProcessStartIdentitySync(pid),
      isAlive: (pid) => isProcessAlive(pid),
      killTree: (pid) => killProcessTree(pid, spawnSync),
      platform: process.platform,
      pollMs: 250,
      env: process.env,
      log,
    });
    log(`exit outcome=${outcome}`);
    code = outcome === 'stopped' || outcome === 'terminated' || outcome === 'team_gone' ? 0 : 1;
  } catch (err) {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  process.exit(code);
}
