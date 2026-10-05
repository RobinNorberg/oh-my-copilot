import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CopilotEvent } from '../../smoke/copilot-session-eval.js';
import type {
  CopilotSdkModule,
  LoadedSdk,
  SdkClientOptions,
  SdkSessionConfig,
  SdkSessionLike,
} from '../../smoke/copilot-sdk-driver.js';
import { buildSdkExcludedTools, decideSdkPermission, type SdkPolicyContext } from '../sdk-policy.js';
import { prependPath, readDoorbell, runSdkHost, type SdkHostDeps } from '../sdk-host.js';
import {
  isSdkTarget,
  readSdkSession,
  ringDoorbell,
  sdkPaneId,
  sdkWorkerFiles,
  stopSdkHost,
  type SdkHostSpec,
} from '../sdk-transport.js';
import {
  awaitWorkerLaunchAcknowledgement,
  observeWorkerLaunchProvider,
  prepareWorkerLaunchAttempt,
  retireAndCleanupCurrentWorkerLaunchAttempt,
  type WorkerLaunchAttempt,
} from '../worker-launch-ack.js';
import { teamStateRoot } from '../state-paths.js';
import { getProcessStartIdentitySync } from '../../platform/process-utils.js';

let TEAM = 'sdk-team';
const WORKER = 'worker-1';

let cwd: string;
let worktree: string;
let pluginRoot: string;
let stateRoot: string;

beforeEach(() => {
  // The state root does not follow a temp cwd under the test config: keep each test's team distinct.
  TEAM = `sdk-team-${randomUUID().slice(0, 8)}`;
  cwd = mkdtempSync(join(tmpdir(), 'sdk-team-leader-'));
  worktree = mkdtempSync(join(tmpdir(), 'sdk-team-wt-'));
  pluginRoot = mkdtempSync(join(tmpdir(), 'sdk-team-plugin-'));
  stateRoot = teamStateRoot(cwd, TEAM);
  mkdirSync(join(stateRoot, 'workers', WORKER), { recursive: true });
});

afterEach(() => {
  for (const dir of [cwd, worktree, pluginRoot, stateRoot]) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('sdk permission policy', () => {
  const ctx = (): SdkPolicyContext => ({
    cwd: worktree,
    stateRoot,
    pluginRoot,
    mcpServer: 't',
    denyTools: ['shell(rm -rf)', 'web_fetch', 't(state_clear)', 'write'],
    denyUrls: ['evil.example'],
    platform: process.platform,
  });

  const cases: Array<[string, () => Record<string, unknown>, boolean]> = [
    ["{ kind: 'read', path: join(worktree, 'README.md') }", () => ({ kind: 'read', path: join(worktree, 'README.md') }), true],
    ["{ kind: 'read', path: join(stateRoot, 'workers', WORKER, 'inbox.md') }", () => ({ kind: 'read', path: join(stateRoot, 'workers', WORKER, 'inbox.md') }), true],
    ["{ kind: 'read', path: join(pluginRoot, 'skills', 'plan', 'SKILL.md') }", () => ({ kind: 'read', path: join(pluginRoot, 'skills', 'plan', 'SKILL.md') }), true],
    ["{ kind: 'read', path: join(tmpdir(), 'elsewhere.txt') }", () => ({ kind: 'read', path: join(tmpdir(), 'elsewhere.txt') }), false],
    ["{ kind: 'write', fileName: 'README.md' }", () => ({ kind: 'write', fileName: 'README.md' }), true], // relative: resolved against the worktree
    ["{ kind: 'write', fileName: join(stateRoot, 'workers', WORKER, 'status.", () => ({ kind: 'write', fileName: join(stateRoot, 'workers', WORKER, 'status.json') }), true],
    ["{ kind: 'write', fileName: join(cwd, 'README.md') }", () => ({ kind: 'write', fileName: join(cwd, 'README.md') }), false], // the leader checkout is not the worktree
    ["{ kind: 'write' }", () => ({ kind: 'write' }), false],
    ["{ kind: 'shell', fullCommandText: 'omg team api claim-task --input \\'{", () => ({ kind: 'shell', fullCommandText: 'omg team api claim-task --input \'{}\' --json' }), true],
    ["{ kind: 'shell', fullCommandText: 'git add README.md && git commit -m ", () => ({ kind: 'shell', fullCommandText: 'git add README.md && git commit -m "x"' }), true],
    ["{ kind: 'shell', fullCommandText: 'omg team shutdown sdk-team' }", () => ({ kind: 'shell', fullCommandText: 'omg team shutdown sdk-team' }), false],
    ["{ kind: 'shell', fullCommandText: 'omg team 2:copilot \"nested\"' }", () => ({ kind: 'shell', fullCommandText: 'omg team 2:copilot "nested"' }), false],
    ["{ kind: 'shell', fullCommandText: 'node \"C:/x/bridge/cli.cjs\" team shu", () => ({ kind: 'shell', fullCommandText: 'node "C:/x/bridge/cli.cjs" team shutdown t' }), false],
    ["{ kind: 'shell', fullCommandText: 'omg smoke copilot --tier 2' }", () => ({ kind: 'shell', fullCommandText: 'omg smoke copilot --tier 2' }), false],
    ["{ kind: 'shell', fullCommandText: 'tmux kill-server' }", () => ({ kind: 'shell', fullCommandText: 'tmux kill-server' }), false],
    ["{ kind: 'shell', fullCommandText: 'git -c a=b push origin HEAD' }", () => ({ kind: 'shell', fullCommandText: 'git -c a=b push origin HEAD' }), false],
    ["{ kind: 'shell', fullCommandText: 'rm -rf /' }", () => ({ kind: 'shell', fullCommandText: 'rm -rf /' }), false], // workerDenyTools shell(rm -rf)
    ["{ kind: 'shell', fullCommandText: '' }", () => ({ kind: 'shell', fullCommandText: '' }), false],
    ["{ kind: 'url', url: 'https://docs.github.com/x' }", () => ({ kind: 'url', url: 'https://docs.github.com/x' }), true],
    ["{ kind: 'url', url: 'https://api.evil.example/x' }", () => ({ kind: 'url', url: 'https://api.evil.example/x' }), false],
    ["{ kind: 'mcp', serverName: 't', toolName: 'state_read' }", () => ({ kind: 'mcp', serverName: 't', toolName: 'state_read' }), true],
    ["{ kind: 'mcp', serverName: 'github-mcp-server', toolName: 'x' }", () => ({ kind: 'mcp', serverName: 'github-mcp-server', toolName: 'x' }), false],
    ["{ kind: 'memory' }", () => ({ kind: 'memory' }), false],
    ["{ kind: 'custom-tool' }", () => ({ kind: 'custom-tool' }), false],
    ["{ kind: 'hook' }", () => ({ kind: 'hook' }), false],
  ];
  it.each(cases)('%s -> approve=%s', (_label, req, approve) => {
    expect(decideSdkPermission(req(), ctx()).approve).toBe(approve);
  });

  it('excludes the recursion fence and maps workerDenyTools to SDK tool names', () => {
    expect(buildSdkExcludedTools('t', ['shell(rm -rf)', 'web_fetch', 't(state_clear)', 'write']).sort())
      .toEqual(['create', 'edit', 't-host_smoke', 't-state_clear', 'task', 'web_fetch'].sort());
    expect(buildSdkExcludedTools('t', ['shell'])).toEqual(expect.arrayContaining(['shell', 'powershell']));
  });
});

// ---------------------------------------------------------------------------
// Doorbell + ids
// ---------------------------------------------------------------------------

describe('doorbell', () => {
  it('reads complete lines only and resumes from the returned offset', () => {
    const { doorbell } = sdkWorkerFiles(stateRoot, WORKER);
    const a = ringDoorbell(stateRoot, WORKER, { kind: 'prompt', text: 'one' });
    appendFileSync(doorbell, '{"kind":"prompt","id":"torn"'); // a writer mid-line
    const first = readDoorbell(doorbell, 0);
    expect(first.entries.map((e) => e.id)).toEqual([a]);
    appendFileSync(doorbell, ',"text":"two","at":"x"}\nnot json\n');
    const second = readDoorbell(doorbell, first.offset);
    expect(second.entries.map((e) => e.id)).toEqual(['torn']);
    expect(readDoorbell(doorbell, second.offset).entries).toEqual([]);
  });

  it('marks sdk targets and worker ids', () => {
    expect(isSdkTarget('sdk:t')).toBe(true);
    expect(isSdkTarget(sdkPaneId('worker-2'))).toBe(true);
    expect(isSdkTarget('%3')).toBe(false);
    expect(isSdkTarget(undefined)).toBe(false);
  });

  it('prepends the omg shim dir to PATH under the existing key casing', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\a' };
    prependPath(env, 'C:\\shim', 'win32');
    expect(env.Path).toBe('C:\\shim;C:\\a');
    const posix: NodeJS.ProcessEnv = { PATH: '/a' };
    prependPath(posix, '/shim', 'linux');
    expect(posix.PATH).toBe('/shim:/a');
  });
});

// ---------------------------------------------------------------------------
// Host with a fake SDK (modelled on the Tier 2 driver test's fake)
// ---------------------------------------------------------------------------

interface FakeRec {
  ops: string[];
  connection?: { path?: string; args?: string[]; env?: NodeJS.ProcessEnv };
  sessions: SdkSessionConfig[];
  /** True if send() ran while a previous turn had not reached idle. */
  sentWhileBusy: boolean;
  prompts: string[];
}

interface FakeOpts {
  pid?: number;
  /** ms before a turn reaches session.idle (default 30). */
  turnMs?: number;
  /** credits each turn's assistant.usage reports (default 0.5). */
  credits?: number;
  /** permission requests each turn raises. */
  permissions?: Array<Record<string, unknown>>;
  startError?: string;
  /** never reach idle until abort. */
  hang?: boolean;
  /** Live pids; the runtime pid leaves it on stop/forceStop (the runtime exits). */
  alive?: Set<number>;
}

function fakeSdk(opts: FakeOpts = {}): { loaded: LoadedSdk; rec: FakeRec } {
  const rec: FakeRec = { ops: [], sessions: [], sentWhileBusy: false, prompts: [] };
  class FakeClient {
    cliProcess: { pid: number } | null = opts.pid ? { pid: opts.pid } : null;
    constructor(options: SdkClientOptions) { rec.connection = options.connection as FakeRec['connection']; }
    async start() { rec.ops.push('start'); if (opts.startError) throw new Error(opts.startError); }
    async stop() { rec.ops.push('stop'); if (opts.pid) opts.alive?.delete(opts.pid); this.cliProcess = null; return []; }
    async forceStop() { rec.ops.push('forceStop'); if (opts.pid) opts.alive?.delete(opts.pid); this.cliProcess = null; }
    async getStatus() { return { version: '1.0.91', protocolVersion: 3 }; }
    async listModels() { return [{ id: 'auto' }]; }
    async deleteSession(id: string) { rec.ops.push(`delete:${id}`); }
    async createSession(config: SdkSessionConfig): Promise<SdkSessionLike> {
      rec.ops.push('create');
      rec.sessions.push(config);
      const emit = (e: CopilotEvent) => config.onEvent?.(e);
      let busy = false;
      let timer: NodeJS.Timeout | undefined;
      const idle = (aborted = false) => { busy = false; emit({ type: 'session.idle', data: aborted ? { aborted } : {} }); };
      return {
        sessionId: 's1',
        async send({ prompt }) {
          rec.ops.push('send');
          if (busy) rec.sentWhileBusy = true;
          busy = true;
          rec.prompts.push(prompt);
          for (const req of opts.permissions ?? []) {
            await config.onPermissionRequest(req, { sessionId: 's1' });
          }
          emit({ type: 'assistant.usage', data: { initiator: 'user', copilotUsage: { totalNanoAiu: (opts.credits ?? 0.5) * 1e9 } } });
          emit({ type: 'assistant.message', data: { content: 'ok' } });
          if (!opts.hang) timer = setTimeout(() => idle(), opts.turnMs ?? 30);
          return 'm1';
        },
        async abort() {
          rec.ops.push('abort');
          if (timer) clearTimeout(timer);
          setImmediate(() => { emit({ type: 'abort', data: { reason: 'user_initiated' } }); idle(true); });
        },
        async disconnect() {
          rec.ops.push('disconnect');
          setImmediate(() => emit({ type: 'session.shutdown', data: { totalPremiumRequests: rec.prompts.length, totalNanoAiu: 1.5e9 } }));
        },
        rpc: {
          plugins: { list: async () => ({}) },
          skills: { list: async () => ({}) },
          agent: { list: async () => ({}) },
          mcp: { list: async () => ({}), listTools: async () => ({}) },
        },
      };
    }
  }
  const module: CopilotSdkModule = {
    CopilotClient: FakeClient as unknown as CopilotSdkModule['CopilotClient'],
    RuntimeConnection: { forStdio: (o) => o },
  };
  return { loaded: { module, version: '1.0.16', from: 'fake' }, rec };
}

async function newAttempt(): Promise<WorkerLaunchAttempt> {
  return prepareWorkerLaunchAttempt({
    cwd,
    teamName: TEAM,
    workerName: WORKER,
    instanceId: randomUUID(),
    paneId: sdkPaneId(WORKER),
    provider: 'copilot',
    runtimeCliPath: '/runtime-cli.cjs',
    context: { kind: 'initial' },
  });
}

function specFor(attempt: WorkerLaunchAttempt, over: Partial<SdkHostSpec> = {}): SdkHostSpec {
  return {
    schema_version: 1,
    leader_cwd: cwd,
    team_name: TEAM,
    worker_name: WORKER,
    instance_id: attempt.instance_id,
    attempt_id: attempt.attempt_id,
    pane_id: attempt.pane_id,
    runtime_cli_path: '/runtime-cli.cjs',
    worker_cwd: worktree,
    state_root: stateRoot,
    plugin_root: pluginRoot,
    copilot_bin: 'C:/fake/copilot.exe',
    model: 'gpt-test',
    max_credits: 10,
    worker_env: { OMC_TEAM_WORKER: `${TEAM}/${WORKER}`, OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id },
    deny_tools: ['web_fetch'],
    deny_urls: [],
    mcp_server: 't',
    omg_cli_path: '/bridge/cli.cjs',
    node_path: process.execPath,
    user_config_dir: join(cwd, 'no-user-config'),
    ...over,
  };
}

function deps(sdk: LoadedSdk | null, over: Partial<SdkHostDeps> & { killed?: number[]; alive?: Set<number> } = {}): SdkHostDeps {
  const alive = over.alive ?? new Set<number>();
  return {
    loadSdk: async () => sdk,
    pid: 4242,
    startIdentity: () => 'ticks:123456',
    isAlive: (pid) => alive.has(pid),
    killTree: (pid) => { over.killed?.push(pid); alive.delete(pid); },
    // The terminal record's shape follows the real platform, which the shared observers read.
    platform: process.platform,
    pollMs: 10,
    env: { [process.platform === 'win32' ? 'Path' : 'PATH']: '/usr/bin', OMC_STRIPPED: '1', COPILOT_HOME: '/real-home' },
    ...over,
  };
}

/** Run the host while the test plays leader: accept the attempt, then drive the doorbell. */
async function hostWithLeader(
  attempt: WorkerLaunchAttempt,
  hostDeps: SdkHostDeps,
  drive: () => Promise<void>,
  spec = specFor(attempt),
) {
  const host = runSdkHost(spec, hostDeps);
  const ack = await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 5_000, pollIntervalMs: 5 });
  expect(ack).toEqual({ ok: true });
  await drive();
  return host;
}

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('sdk host', () => {
  it('handshakes as the launch provider, serializes doorbell prompts, acks shutdown and tears down', async () => {
    const attempt = await newAttempt();
    const alive = new Set([777]);
    const { loaded, rec } = fakeSdk({ pid: 777, alive, turnMs: 60, permissions: [
      { kind: 'write', fileName: join(cwd, 'README.md') },
      { kind: 'shell', fullCommandText: 'omg team api claim-task --json' },
    ] });
    const killed: number[] = [];
    const host = await hostWithLeader(attempt, deps(loaded, { alive, killed }), async () => {
      await until(() => readSdkSession(stateRoot, WORKER)?.state === 'idle');
      ringDoorbell(stateRoot, WORKER, { kind: 'prompt', text: 'first' });
      ringDoorbell(stateRoot, WORKER, { kind: 'prompt', text: 'second' });
      await until(() => rec.prompts.length === 2 && readSdkSession(stateRoot, WORKER)?.state === 'idle');
      ringDoorbell(stateRoot, WORKER, { kind: 'shutdown' });
    });
    expect(await host).toBe('stopped');

    // The second prompt waited for the first turn's idle.
    expect(rec.prompts).toEqual(['first', 'second']);
    expect(rec.sentWhileBusy).toBe(false);

    // Session config: plugin, worktree, fence, no github MCP, explicit model.
    const cfg = rec.sessions[0]!;
    expect(cfg.pluginDirectories).toEqual([pluginRoot]);
    expect(cfg.workingDirectory).toBe(worktree);
    expect(cfg.disabledMcpServers).toEqual(['github-mcp-server']);
    expect(cfg.excludedTools).toEqual(expect.arrayContaining(['t-host_smoke', 'task', 'web_fetch']));
    expect(cfg.model).toBe('gpt-test');

    // Runtime: installed exe, credit cap floor, deny flag, no allow-all, worker env, isolated home.
    expect(rec.connection?.path).toBe('C:/fake/copilot.exe');
    expect(rec.connection?.args).toEqual(['--log-level', 'debug', '--max-ai-credits', '30', '--deny-tool=web_fetch']);
    const env = rec.connection!.env!;
    expect(env.COPILOT_ALLOW_ALL).toBe('false');
    expect(env.OMC_GIT_GUARDRAILS).toBe('1');
    expect(env.OMC_TEAM_WORKER).toBe(`${TEAM}/${WORKER}`);
    expect(env.OMC_STRIPPED).toBeUndefined();
    expect(env.COPILOT_HOME).toBe(sdkWorkerFiles(stateRoot, WORKER).home);
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!;
    expect(env[pathKey]?.startsWith(sdkWorkerFiles(stateRoot, WORKER).bin)).toBe(true);
    expect(existsSync(join(sdkWorkerFiles(stateRoot, WORKER).bin, 'omg.cmd'))).toBe(true);

    // Graceful teardown ladder, no tree kill needed.
    const order = ['disconnect', 'delete:s1', 'stop'].map((op) => rec.ops.indexOf(op));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rec.ops).not.toContain('forceStop');
    expect(killed).toEqual([]);

    // Evidence: ack, session file, events, permissions, billing totals.
    const ackFile = JSON.parse(readFileSync(sdkWorkerFiles(stateRoot, WORKER).shutdownAck, 'utf8'));
    expect(ackFile.status).toBe('accept');
    const session = readSdkSession(stateRoot, WORKER)!;
    expect(session.state).toBe('closed');
    expect(session.turns).toBe(2);
    expect(session.usage.premium_requests).toBe(2);
    expect(session.usage.shutdown_premium_requests).toBe(2);
    expect(session.usage.credits).toBeCloseTo(1);
    expect(session.permissions.map((p) => [p.kind, p.approve])).toEqual([
      ['write', false], ['shell', true], ['write', false], ['shell', true],
    ]);
    expect(session.timeline.first_send_at).toBeDefined();
    const events = readFileSync(sdkWorkerFiles(stateRoot, WORKER).events, 'utf8').trim().split('\n');
    expect(events.length).toBeGreaterThanOrEqual(7);

    // Provider records: the host's identity, then a reaped terminal the shared observers read as dead.
    const started = JSON.parse(readFileSync(attempt.startedPath, 'utf8'));
    expect(started).toMatchObject({ kind: 'worker_launch_provider_started', pid: 4242, process_start_identity: 'ticks:123456' });
    expect(await observeWorkerLaunchProvider(attempt)).toBe('dead');
    expect(await retireAndCleanupCurrentWorkerLaunchAttempt(attempt, 'test', async () => true)).toBe(true);
    expect(existsSync(attempt.currentPath)).toBe(false);
  });

  it('a termination request hard-stops: tree-kills the runtime and publishes termination-complete', async () => {
    const attempt = await newAttempt();
    const { loaded, rec } = fakeSdk({ pid: 888 });
    const alive = new Set([888]);
    const killed: number[] = [];
    const host = await hostWithLeader(attempt, deps(loaded, { alive, killed }), async () => {
      await until(() => readSdkSession(stateRoot, WORKER)?.state === 'idle');
      writeFileSync(`${attempt.startedPath}.termination-request`, '{}');
    });
    expect(await host).toBe('terminated');
    expect(killed).toEqual([888]);
    expect(rec.ops).toContain('forceStop');
    expect(rec.ops).not.toContain('disconnect');
    const complete = JSON.parse(readFileSync(`${attempt.startedPath}.termination-complete`, 'utf8'));
    expect(complete).toMatchObject({ kind: 'worker_launch_termination_complete', cleanup_verified: true, pid: 4242 });
  });

  it('aborts the turn and stops sending once the credit cap is passed', async () => {
    const attempt = await newAttempt();
    const { loaded, rec } = fakeSdk({ credits: 6, hang: true });
    const host = await hostWithLeader(attempt, deps(loaded), async () => {
      await until(() => readSdkSession(stateRoot, WORKER)?.state === 'idle');
      ringDoorbell(stateRoot, WORKER, { kind: 'prompt', text: 'a' });
      await until(() => rec.ops.includes('abort') === false && rec.prompts.length === 1);
      // 6 credits < cap 10: still busy (hang). Abort via doorbell, then a second prompt pushes past the cap.
      ringDoorbell(stateRoot, WORKER, { kind: 'abort' });
      await until(() => readSdkSession(stateRoot, WORKER)?.state === 'idle');
      ringDoorbell(stateRoot, WORKER, { kind: 'prompt', text: 'b' });
      await until(() => readSdkSession(stateRoot, WORKER)?.state === 'capped');
      ringDoorbell(stateRoot, WORKER, { kind: 'prompt', text: 'c' });
      await new Promise((r) => setTimeout(r, 80));
      ringDoorbell(stateRoot, WORKER, { kind: 'stop' });
    });
    expect(await host).toBe('stopped');
    expect(rec.prompts).toEqual(['a', 'b']);
    const session = readSdkSession(stateRoot, WORKER)!;
    expect(session.last_error).toMatch(/credit cap 10 reached/);
    expect(session.aborts).toBeGreaterThanOrEqual(2);
  });

  it('a missing SDK fails the launch with a terminal record and an install hint', async () => {
    const attempt = await newAttempt();
    const host = await hostWithLeader(attempt, deps(null), async () => {});
    expect(await host).toBe('sdk_missing');
    const session = readSdkSession(stateRoot, WORKER)!;
    expect(session.state).toBe('failed');
    expect(session.last_error).toMatch(/npm i -g @github\/copilot-sdk/);
    expect(await observeWorkerLaunchProvider(attempt)).toBe('dead');
  });

  it('a runtime that fails to start is reported and its tree is killed', async () => {
    const attempt = await newAttempt();
    const { loaded } = fakeSdk({ pid: 999, startError: 'spawn EACCES' });
    const alive = new Set([999]);
    const killed: number[] = [];
    const host = await hostWithLeader(attempt, deps(loaded, { alive, killed }), async () => {});
    expect(await host).toBe('start_failed');
    expect(killed).toEqual([999]);
    expect(readSdkSession(stateRoot, WORKER)?.last_error).toBe('spawn EACCES');
  });

  it('exits when the team state root disappears (orphan guard)', async () => {
    const attempt = await newAttempt();
    const { loaded } = fakeSdk();
    const spec = specFor(attempt, { state_root: join(stateRoot, 'gone-root') });
    mkdirSync(spec.state_root, { recursive: true });
    const host = await hostWithLeader(attempt, deps(loaded), async () => {
      await until(() => existsSync(join(spec.state_root, 'workers', WORKER, 'sdk-session.json')));
      await new Promise((r) => setTimeout(r, 30));
      rmSync(spec.state_root, { recursive: true, force: true });
    }, spec);
    expect(await host).toBe('team_gone');
  });

  it('a revoked launch never starts the runtime', async () => {
    const attempt = await newAttempt();
    const { loaded, rec } = fakeSdk();
    const host = runSdkHost(specFor(attempt), deps(loaded));
    await until(() => existsSync(attempt.ackPath));
    writeFileSync(attempt.decisionPath, JSON.stringify({ ...attempt, kind: 'worker_launch_decision', decision: 'revoked', reason: 'test', written_at: new Date().toISOString() }));
    expect(await host).toBe('decision_revoked');
    expect(rec.ops).toEqual([]);
  });
});

describe('stopSdkHost', () => {
  it('rings stop and returns once the host reports its provider dead', async () => {
    const attempt = await newAttempt();
    const { loaded, rec } = fakeSdk();
    let stopped: Promise<boolean> | undefined;
    // The provider record must name a live process: use this test process and its real start identity.
    const live = deps(loaded, { pid: process.pid, startIdentity: (pid) => getProcessStartIdentitySync(pid) });
    const host = await hostWithLeader(attempt, live, async () => {
      await until(() => readSdkSession(stateRoot, WORKER)?.state === 'idle');
      stopped = stopSdkHost(attempt, stateRoot, { timeoutMs: 5_000, pollMs: 10 });
    });
    expect(await host).toBe('stopped');
    expect(await stopped).toBe(true);
    expect(rec.ops).toContain('stop');
  }, 60_000);
});
