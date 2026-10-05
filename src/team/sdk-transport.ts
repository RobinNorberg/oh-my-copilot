/**
 * Leader side of the headless SDK team transport (`omg team --transport sdk`).
 *
 * Pane workers are processes a multiplexer owns; SDK workers are sessions a
 * detached `omg team sdk-host` process owns (sdk-host.ts). This module holds
 * what the leader, the monitor, mailbox delivery and shutdown need:
 * - the per-worker file layout under the team state root;
 * - the doorbell (`sdk-doorbell.jsonl`), the only way to reach a session;
 * - the session file (`sdk-session.json`), read instead of a pane capture;
 * - host launch (launch attempt + detached spawn + ack/started handshake)
 *   and host stop (doorbell stop, then a bounded wait, then a tree kill).
 *
 * The team target is `sdk:<team>` and each worker's `pane_id` is `sdk:<worker>`:
 * neither names a multiplexer resource, so pane code paths must skip them
 * ({@link isSdkTarget}).
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { killProcessTree, isProcessAlive } from '../platform/process-utils.js';
import { resolveRuntimeCliPath } from './runtime-owner-client.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  observeWorkerLaunchProvider,
  prepareWorkerLaunchAttempt,
  type WorkerLaunchAttempt,
} from './worker-launch-ack.js';

export const SDK_TARGET_PREFIX = 'sdk:';

/** True for the sdk team target (`sdk:<team>`) and sdk worker ids (`sdk:<worker>`). */
export function isSdkTarget(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SDK_TARGET_PREFIX);
}

export function sdkTeamTarget(teamName: string): string {
  return `${SDK_TARGET_PREFIX}${teamName}`;
}

export function sdkPaneId(workerName: string): string {
  return `${SDK_TARGET_PREFIX}${workerName}`;
}

export function sdkWorkerFiles(stateRoot: string, workerName: string) {
  const dir = join(stateRoot, 'workers', workerName);
  return {
    dir,
    spec: join(dir, 'sdk-host-spec.json'),
    doorbell: join(dir, 'sdk-doorbell.jsonl'),
    session: join(dir, 'sdk-session.json'),
    events: join(dir, 'sdk-events.jsonl'),
    log: join(dir, 'sdk-host.log'),
    home: join(dir, 'copilot-home'),
    bin: join(dir, 'bin'),
    shutdownAck: join(dir, 'shutdown-ack.json'),
  };
}

export interface SdkHostSpec {
  schema_version: 1;
  leader_cwd: string;
  team_name: string;
  worker_name: string;
  instance_id: string;
  attempt_id: string;
  pane_id: string;
  runtime_cli_path: string;
  worker_cwd: string;
  state_root: string;
  plugin_root: string;
  /** The installed Copilot exe (or its npm package .js), never a .cmd shim. */
  copilot_bin: string;
  model?: string;
  max_credits: number;
  worker_env: Record<string, string>;
  deny_tools: string[];
  deny_urls: string[];
  mcp_server: string;
  /** The leader's `bridge/cli.cjs`; the worker's `omg` shim runs it. */
  omg_cli_path: string;
  node_path: string;
  /** Copilot config dir whose login identity the per-worker home copies. */
  user_config_dir: string;
}

export interface SdkDoorbellEntry {
  id: string;
  kind: 'prompt' | 'abort' | 'stop' | 'shutdown';
  text?: string;
  at: string;
  from?: string;
}

export type SdkSessionState = 'starting' | 'idle' | 'busy' | 'capped' | 'closing' | 'closed' | 'failed';

export interface SdkSessionFile {
  schema_version: 1;
  team_name: string;
  worker_name: string;
  attempt_id: string;
  host_pid: number;
  runtime_pid: number | null;
  session_id: string | null;
  model: string | null;
  state: SdkSessionState;
  turns: number;
  queued: number;
  /** Doorbell ids sent to the session, in order. */
  delivered: string[];
  last_event_type: string | null;
  last_event_at: string | null;
  updated_at: string;
  usage: {
    credits: number;
    premium_requests: number;
    shutdown_premium_requests: number | null;
    shutdown_credits: number | null;
  };
  hooks: { session_end_runs: number; failed: number };
  aborts: number;
  permissions: Array<{ at: string; kind: string; approve: boolean; reason: string; detail: string }>;
  last_error: string | null;
  timeline: Partial<Record<
    'host_started_at' | 'ack_at' | 'accepted_at' | 'client_started_at' | 'session_created_at'
    | 'first_send_at' | 'first_message_at' | 'closed_at',
    string
  >>;
}

/** Append one doorbell entry; returns its id. Appends are line-sized and atomic enough for one writer per call. */
export function ringDoorbell(
  stateRoot: string,
  workerName: string,
  entry: Omit<SdkDoorbellEntry, 'id' | 'at'> & { id?: string },
): string {
  const files = sdkWorkerFiles(stateRoot, workerName);
  mkdirSync(files.dir, { recursive: true });
  const id = entry.id ?? randomUUID();
  const line: SdkDoorbellEntry = { ...entry, id, at: new Date().toISOString() };
  appendFileSync(files.doorbell, `${JSON.stringify(line)}\n`);
  return id;
}

export function readSdkSession(stateRoot: string, workerName: string): SdkSessionFile | null {
  try {
    const parsed = JSON.parse(readFileSync(sdkWorkerFiles(stateRoot, workerName).session, 'utf8')) as SdkSessionFile;
    return parsed && parsed.schema_version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export interface SdkLaunchInput {
  leaderCwd: string;
  teamName: string;
  workerName: string;
  instanceId: string;
  workerCwd: string;
  stateRoot: string;
  workerEnv: Record<string, string>;
  copilotBin: string;
  pluginRoot: string;
  userConfigDir: string;
  model?: string;
  maxCredits: number;
  denyTools: string[];
  denyUrls: string[];
  mcpServer?: string;
  /** Test seam for the detached spawn. */
  spawnHost?: (cliPath: string, specPath: string, logPath: string, cwd: string) => number | undefined;
  ackTimeoutMs?: number;
}

export type SdkLaunchResult =
  | { ok: true; attempt: WorkerLaunchAttempt; hostPid: number | undefined; paneId: string }
  | { ok: false; attempt: WorkerLaunchAttempt | null; reason: string; hostPid?: number };

function spawnDetachedHost(cliPath: string, specPath: string, logPath: string, cwd: string): number | undefined {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [cliPath, 'team', 'sdk-host', '--spec', specPath], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * Create the launch attempt, write the host spec and spawn the detached host,
 * then run the same ack -> accepted -> provider_started handshake a pane
 * bootstrap runs. A failed handshake tree-kills the host it spawned.
 */
export async function launchSdkHost(input: SdkLaunchInput): Promise<SdkLaunchResult> {
  const paneId = sdkPaneId(input.workerName);
  const runtimeCliPath = resolveRuntimeCliPath();
  const attempt = await prepareWorkerLaunchAttempt({
    cwd: input.leaderCwd,
    teamName: input.teamName,
    workerName: input.workerName,
    instanceId: input.instanceId,
    paneId,
    provider: 'copilot',
    runtimeCliPath,
    context: { kind: 'initial' },
  });
  const files = sdkWorkerFiles(input.stateRoot, input.workerName);
  mkdirSync(files.dir, { recursive: true });
  const cliPath = join(dirname(runtimeCliPath), 'cli.cjs');
  const spec: SdkHostSpec = {
    schema_version: 1,
    leader_cwd: input.leaderCwd,
    team_name: input.teamName,
    worker_name: input.workerName,
    instance_id: input.instanceId,
    attempt_id: attempt.attempt_id,
    pane_id: paneId,
    runtime_cli_path: runtimeCliPath,
    worker_cwd: input.workerCwd,
    state_root: input.stateRoot,
    plugin_root: input.pluginRoot,
    copilot_bin: input.copilotBin,
    ...(input.model ? { model: input.model } : {}),
    max_credits: input.maxCredits,
    worker_env: { ...input.workerEnv, OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id },
    deny_tools: input.denyTools,
    deny_urls: input.denyUrls,
    mcp_server: input.mcpServer ?? 't',
    omg_cli_path: cliPath,
    node_path: process.execPath,
    user_config_dir: input.userConfigDir,
  };
  writeFileSync(files.spec, `${JSON.stringify(spec, null, 2)}\n`);
  if (!existsSync(files.doorbell)) writeFileSync(files.doorbell, '');
  const hostPid = (input.spawnHost ?? spawnDetachedHost)(cliPath, files.spec, files.log, input.workerCwd);
  const kill = async () => { if (hostPid && isProcessAlive(hostPid)) await killProcessTree(hostPid, 'SIGKILL').catch(() => undefined); };
  const timeoutMs = input.ackTimeoutMs ?? 30_000;
  const ack = await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs });
  if (!ack.ok) {
    await kill();
    return { ok: false, attempt, reason: `sdk_host_ack_${ack.reason}`, ...(hostPid ? { hostPid } : {}) };
  }
  if (!await awaitWorkerLaunchProviderStarted(attempt, { timeoutMs })) {
    await kill();
    return { ok: false, attempt, reason: 'sdk_host_provider_not_started', ...(hostPid ? { hostPid } : {}) };
  }
  return { ok: true, attempt, hostPid, paneId };
}

/**
 * Ring `stop` (or `shutdown`, which also writes the shutdown ack), wait for the
 * host to report its provider dead, then tree-kill it as the last resort.
 * True once the provider is observed dead.
 */
export async function stopSdkHost(
  attempt: WorkerLaunchAttempt,
  stateRoot: string,
  opts: { timeoutMs?: number; kind?: 'stop' | 'shutdown'; pollMs?: number } = {},
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 250;
  if (await observeWorkerLaunchProvider(attempt) === 'dead') return true;
  ringDoorbell(stateRoot, attempt.worker_name, { kind: opts.kind ?? 'stop', from: 'leader-fixed' });
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    if (await observeWorkerLaunchProvider(attempt) === 'dead') return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const started = readStartedRecord(attempt);
  const pid = started?.pid ?? null;
  if (pid && isProcessAlive(pid)) await killProcessTree(pid, 'SIGKILL').catch(() => undefined);
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!pid || !isProcessAlive(pid)) {
      // The host died without its own terminal record: publish the
      // termination proof the shared retire path accepts (pid + identity).
      if (pid && started) writeTerminationComplete(attempt, pid, started.process_start_identity);
      return true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

function readStartedRecord(attempt: WorkerLaunchAttempt): { pid: number; process_start_identity: string } | null {
  try {
    const record = JSON.parse(readFileSync(attempt.startedPath, 'utf8')) as { pid?: unknown; process_start_identity?: unknown };
    return typeof record.pid === 'number' && record.pid > 0 && typeof record.process_start_identity === 'string'
      ? { pid: record.pid, process_start_identity: record.process_start_identity }
      : null;
  } catch {
    return null;
  }
}

function writeTerminationComplete(attempt: WorkerLaunchAttempt, pid: number, startIdentity: string): void {
  const path = `${attempt.startedPath}.termination-complete`;
  if (existsSync(path)) return;
  try {
    writeFileSync(path, JSON.stringify({
      schema_version: attempt.schema_version,
      attempt_id: attempt.attempt_id,
      nonce: attempt.nonce,
      instance_id: attempt.instance_id,
      team_name: attempt.team_name,
      worker_name: attempt.worker_name,
      pane_id: attempt.pane_id,
      provider: attempt.provider,
      created_at: attempt.created_at,
      kind: 'worker_launch_termination_complete',
      cleanup_verified: true,
      pid,
      process_start_identity: startIdentity,
      ...(process.platform === 'win32' ? {} : { process_group_id: pid }),
      written_at: new Date().toISOString(),
    }), { flag: 'wx' });
  } catch { /* a concurrent writer won */ }
}
