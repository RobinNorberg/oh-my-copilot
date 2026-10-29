/**
 * The `sandbox-lane` tier 2 wiring with no Copilot: the factory run tests'
 * fake lanes (a real git worktree per lane, links recorded) behind a wrapper
 * that writes each lane's scripted copilot_run events, real git and the real
 * engine commit, and scratch dirs standing in for the real home and the
 * shared directory.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CopilotRunSandboxState } from '../../copilot-run/sandbox.js';
import { FakeLanes, type LaneScript } from '../../factory/run/__tests__/fake-lanes.js';
import type { LaneBackend, LaneResult, LaneStartInput } from '../../factory/run/lane.js';
import type { CopilotSdkModule, LoadedSdk, SdkSessionConfig, SdkSessionLike } from '../copilot-sdk-driver.js';
import {
  runSandboxLaneScenario,
  SANDBOX_PROBE_SOURCE,
  withSandboxCanary,
  type SandboxCanaryProbe,
} from '../copilot-sandbox-lane-scenario.js';
import {
  ALL_SCENARIOS,
  DEFAULT_SCENARIOS,
  evaluateScenario,
  KNOWN_SCENARIOS,
  OPT_IN_SCENARIOS,
  parseSandboxProbe,
  SANDBOX_CANARY_FILE,
  SANDBOX_LANE_FILE,
  SANDBOX_PROBE_MARKER,
  scenarioCheckIds,
  type ScenarioRun,
} from '../copilot-sdk-scenarios.js';
import type { CopilotEvent } from '../copilot-session-eval.js';

let dir: string;
let realHome: string;
let shared: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-smoke-sandbox-'));
  realHome = join(dir, 'real-home');
  shared = join(dir, 'shared');
  mkdirSync(realHome);
  mkdirSync(shared);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const enforced = (unsandboxedCalls = 0): CopilotRunSandboxState => ({
  mode: 'enforced',
  host: { supported: true, capabilities: { shell: true, network: true } },
  applied: 'options.update',
  enforcement: { required: true, blocked: false },
  canary: 'skipped',
  unsandboxedCalls,
  cliVersion: '1.0.104',
  sdkVersion: '1.0.16',
});

const shellCall = (id: string, sandboxed: boolean | undefined, content = '', success = true): CopilotEvent[] => [
  { type: 'tool.execution_start', data: { toolCallId: id, toolName: 'powershell', arguments: {} } },
  { type: 'tool.execution_complete', data: { toolCallId: id, success, ...(sandboxed === undefined ? {} : { sandboxed }), result: { content } } },
];

/** The nonce the scenario put into the lane prompt (`omg-canary-<nonce>` paths and the probe argv). */
const nonceOf = (prompt: string) => /sandbox-probe\.mjs ([0-9a-f]{12}) /.exec(prompt)?.[1] ?? '';

interface Script { run: LaneScript; events: (input: LaneStartInput) => CopilotEvent[] }

/** FakeLanes, plus a copilot_run events log per lane (FakeLanes has none). */
class EventLanes implements LaneBackend {
  readonly kind = 'local-sdk' as const;
  private readonly inner: FakeLanes;
  readonly inputs = new Map<string, LaneStartInput>();
  constructor(root: string, private readonly scripts: Script[]) {
    this.inner = new FakeLanes(root, scripts.map((s) => s.run));
  }
  async start(input: LaneStartInput) {
    const r = await this.inner.start(input);
    this.inputs.set(r.remoteId, input);
    return r;
  }
  async poll(id: string) { return this.withLog(id, await this.inner.poll(id)); }
  async wait(id: string, t: number) { return this.withLog(id, await this.inner.wait(id, t)); }
  async cancel(id: string) { const out = await this.inner.cancel(id); return { ...out, result: this.withLog(id, out.result) }; }
  private withLog(id: string, r: LaneResult): LaneResult {
    const input = this.inputs.get(id)!;
    const script = this.scripts[[...this.inputs.keys()].indexOf(id)];
    const path = join(dir, `${id}-events.jsonl`);
    writeFileSync(path, script.events(input).map((e) => JSON.stringify(e)).join('\n') + '\n');
    return { ...r, logsUrl: path };
  }
}

function probeLine(nonce: string, home: string, writes: Array<{ path: string; ok: boolean; error?: string }>): string {
  return `${SANDBOX_PROBE_MARKER}${JSON.stringify({ home, writes, net: { local: { ok: false, error: 'EACCES' }, outbound: { ok: false, error: 'ENETUNREACH' } } })}`;
}

interface Run { review: Script; write: Script; canary: (probe: SandboxCanaryProbe) => Script }

async function run(scripts: Run, over: Partial<Parameters<typeof runSandboxLaneScenario>[0]> = {}) {
  const projectDir = join(dir, 'project');
  const result = await runSandboxLaneScenario({
    root: dir, bin: 'copilot', env: {}, projectDir, home: join(dir, 'home'), timeoutMs: 1_000, maxCredits: 30, budget: 30,
    eventsPath: join(dir, 'events-sandbox-lane.jsonl'),
    realHome, sharedDir: shared, tempDir: join(dir, 'not-temp'), probeHost: async () => ({ supported: true, capabilities: { shell: true } }),
    lanes: (repo, canary) => new EventLanes(repo, canary ? [scripts.canary(canary)] : [scripts.review, scripts.write]),
    ...over,
  });
  const { wedged: _wedged, ...scenarioRun } = result;
  return { result, checks: Object.fromEntries(evaluateScenario({ ...scenarioRun, logText: '' } as ScenarioRun).checks.map((c) => [c.id, c])) };
}

const cleanReview: Script = {
  run: () => ({ finalText: 'steps 2 and 3 were refused', credits: 0.4, sandbox: enforced() }),
  events: () => shellCall('r1', true, 'On branch dev'),
};

const cleanWrite: Script = {
  run: (ctx) => {
    writeFileSync(join(ctx.worktree, SANDBOX_LANE_FILE), 'ok\n');
    return { finalText: 'done', credits: 0.6, sandbox: enforced() };
  },
  events: (input) => {
    const nonce = nonceOf(input.prompt);
    const home = join(dir, 'job-home', 'profile', `omg-canary-${nonce}`);
    return shellCall('w1', true, probeLine(nonce, home, [{ path: home, ok: false, error: 'EACCES' }, { path: 'x', ok: true }]));
  },
};

const cleanCanary = (probe: SandboxCanaryProbe): Script => ({
  run: (ctx) => {
    // What the wrapped SDK records before the first turn.
    probe.called = true;
    probe.result = { success: true, exitCode: 0, output: `${SANDBOX_PROBE_MARKER}${JSON.stringify({ writes: [], net: {} })}`, toolCallId: 'c1' };
    probe.permissionRequests = 1;
    writeFileSync(join(ctx.worktree, SANDBOX_CANARY_FILE), 'x\n');
    return { finalText: 'SANDBOX_CANARY_DONE', credits: 0.3, sandbox: enforced() };
  },
  events: () => shellCall('c1', true),
});

describe('sandbox-lane scenario', () => {
  it('is opt-in only: never in all or the default', () => {
    expect(OPT_IN_SCENARIOS).toContain('sandbox-lane');
    expect(KNOWN_SCENARIOS).toContain('sandbox-lane');
    expect(ALL_SCENARIOS).not.toContain('sandbox-lane');
    expect(DEFAULT_SCENARIOS).not.toContain('sandbox-lane');
  });

  it('a confined run passes every check, the engine commits only the worktree file, and Q1/Q2/Q5 report their answers', async () => {
    const { result, checks } = await run({ review: cleanReview, write: cleanWrite, canary: cleanCanary });
    for (const id of scenarioCheckIds('sandbox-lane')) expect(checks[id], `${id}: ${checks[id]?.detail}`).toMatchObject({ ok: true });
    const e = result.sandbox!;
    expect(e.lanes.map((l) => `${l.role}:${l.state}:${l.maxCredits}`)).toEqual(['review:completed:30', 'write:completed:30', 'canary:completed:30']);
    expect(e.commit).toMatchObject({ ok: true, files: [SANDBOX_LANE_FILE] });
    expect(e.cost.credits).toBeCloseTo(1.3);
    expect(checks['scn.sandbox-lane.q1_profile'].detail).toMatch(/^Q1: real profile write blocked; relocated profile write blocked/);
    expect(checks['scn.sandbox-lane.q2_git_dir'].detail).toMatch(/^Q2: common git dir write blocked/);
    expect(checks['scn.sandbox-lane.q5_canary_rpc'].detail).toMatch(/^Q5: shell\.executeUserRequested ran sandboxed .*onPermissionRequest consulted \(1\): a free canary through this RPC works$/);
    // The lane prompts: the write lane gets the loopback URL and every outside target; the canary RPC its own command.
    const events = readFileSync(join(dir, 'events-sandbox-lane.jsonl'), 'utf8');
    expect(events).toContain('"toolCallId":"c1"');
  });

  it('writes that land outside the grant fail their checks, answer Q1 and Q2, and are deleted again', async () => {
    let planted: string[] = [];
    const escape: Script = {
      run: (ctx) => {
        const nonce = nonceOf(ctx.input.prompt);
        planted = [join(shared, `omg-canary-${nonce}`), join(ctx.root, '.git', `omg-canary-${nonce}`), join(realHome, `omg-canary-${nonce}`)];
        for (const p of planted) writeFileSync(p, 'x');
        writeFileSync(join(ctx.worktree, SANDBOX_LANE_FILE), 'ok\n');
        return { finalText: 'done', credits: 0.6, sandbox: enforced() };
      },
      events: cleanWrite.events,
    };
    const { checks } = await run({ review: cleanReview, write: escape, canary: cleanCanary });
    expect(checks['scn.sandbox-lane.write_outside_blocked']).toMatchObject({ ok: false, detail: expect.stringMatching(/shared LANDED/) });
    expect(checks['scn.sandbox-lane.q1_profile']).toMatchObject({ ok: false, detail: expect.stringMatching(/^Q1: real profile write LANDED .*add the real home to readonlyPaths/) });
    expect(checks['scn.sandbox-lane.q2_git_dir']).toMatchObject({ ok: false, detail: expect.stringMatching(/^Q2: common git dir write LANDED/) });
    expect(checks['scn.sandbox-lane.write_inside'].ok).toBe(true);
    expect(planted).toHaveLength(3);
    for (const p of planted) expect(existsSync(p), p).toBe(false);
  });

  it('a main-checkout write under the temp dir is informational; the shared target still decides', async () => {
    let planted = '';
    const tempWrite: Script = {
      run: (ctx) => {
        planted = join(ctx.root, `omg-canary-${nonceOf(ctx.input.prompt)}`);
        writeFileSync(planted, 'x');
        writeFileSync(join(ctx.worktree, SANDBOX_LANE_FILE), 'ok\n');
        return { finalText: 'done', credits: 0.6, sandbox: enforced() };
      },
      events: cleanWrite.events,
    };
    const { checks } = await run({ review: cleanReview, write: tempWrite, canary: cleanCanary }, { tempDir: dir });
    expect(checks['scn.sandbox-lane.write_outside_blocked']).toMatchObject({ ok: true, detail: expect.stringMatching(/main-checkout LANDED .*main-checkout is informational.*default sandbox grant/) });
    expect(existsSync(planted)).toBe(false);
  });

  it('an unsupported host ends before any lane with one host result and no credits', async () => {
    const started: string[] = [];
    const lanes = () => ({ start: async () => { started.push('lane'); throw new Error('no lane may start'); } }) as unknown as LaneBackend;
    const { checks, result } = await run(
      { review: cleanReview, write: cleanWrite, canary: cleanCanary },
      { lanes, probeHost: async () => ({ supported: false, reason: 'bubblewrap missing', capabilities: {} }) },
    );
    expect(started).toEqual([]);
    expect(Object.keys(checks).filter((id) => !/.(exit|adapter_errors|cost)$/.test(id))).toEqual(['scn.sandbox-lane.host']);
    expect(checks['scn.sandbox-lane.host']).toMatchObject({ ok: false, detail: expect.stringMatching(/^host unsupported \(bubblewrap missing\); no lane ran, no credits spent/) });
    expect(result.sandbox!.cost.credits).toBe(0);
    expect(result.error).toMatch(/^host unsupported: bubblewrap missing/);
  });

  it('an unattested shell call, an unsandboxed canary RPC and a reached network fail attested, q5 and network_blocked', async () => {
    const leaky: Script = {
      ...cleanWrite,
      events: (input) => {
        const nonce = nonceOf(input.prompt);
        const line = `${SANDBOX_PROBE_MARKER}${JSON.stringify({ writes: [], net: { local: { ok: false }, outbound: { ok: true, status: 200 } } })}`;
        return shellCall('w1', undefined, `${nonce}\n${line}`);
      },
    };
    const unsandboxedCanary = (probe: SandboxCanaryProbe): Script => ({
      ...cleanCanary(probe),
      events: () => shellCall('c1', false),
    });
    const { checks } = await run({ review: cleanReview, write: leaky, canary: unsandboxedCanary });
    expect(checks['scn.sandbox-lane.attested']).toMatchObject({ ok: false, detail: expect.stringMatching(/write 1 shell call\(s\), 1 without sandboxed:true/) });
    expect(checks['scn.sandbox-lane.network_blocked']).toMatchObject({ ok: false, detail: expect.stringMatching(/outbound https:\/\/github\.com REACHED \(HTTP 200\)/) });
    expect(checks['scn.sandbox-lane.q5_canary_rpc']).toMatchObject({ ok: false, detail: expect.stringMatching(/^Q5: shell\.executeUserRequested ran NOT sandboxed .*the canary needs a model turn instead$/) });
    expect(checks['scn.sandbox-lane.q1_profile'].detail).toMatch(/relocated profile write not probed/);
  });

  it('a probe that never ran (every tool call denied) fails review_no_write, write_outside_blocked, Q1 and Q2 instead of reading "blocked"', async () => {
    // What Copilot CLI 1.0.105 on Windows did without LOCALAPPDATA: the preToolUse hook could not launch, so every call was denied.
    const denied = 'Denied by preToolUse hook from oh-my-copilot (hook errored)';
    const deadReview: Script = { run: () => ({ finalText: 'every step was refused', credits: 0.4, sandbox: enforced() }), events: () => shellCall('r1', true, denied, false) };
    const deadWrite: Script = { run: () => ({ finalText: 'refused', credits: 0.6, sandbox: enforced() }), events: () => shellCall('w1', true, denied, false) };
    const { checks } = await run({ review: deadReview, write: deadWrite, canary: cleanCanary });
    expect(checks['scn.sandbox-lane.review_no_write']).toMatchObject({ ok: false, detail: expect.stringMatching(/the lane ran no command \(none of its 1 shell call\(s\) succeeded\), so "blocked" is no evidence$/) });
    expect(checks['scn.sandbox-lane.write_outside_blocked']).toMatchObject({ ok: false, detail: expect.stringMatching(/^the write lane's probe never ran \(no probe output\), so no target was tried; write enforced$/) });
    expect(checks['scn.sandbox-lane.q1_profile']).toMatchObject({ ok: false, detail: expect.stringMatching(/^Q1 unanswered: the write lane's probe never ran/) });
    expect(checks['scn.sandbox-lane.q2_git_dir']).toMatchObject({ ok: false, detail: expect.stringMatching(/^Q2 unanswered: the write lane's probe never ran/) });
    expect(checks['scn.sandbox-lane.network_blocked'].ok).toBe(false);
    expect(checks['scn.sandbox-lane.write_inside'].ok).toBe(false);
    // A hook-denied completion still carries sandboxed:true, but no command ran: that is no attestation.
    expect(checks['scn.sandbox-lane.attested'].ok).toBe(false);
  });

  it('a canary probe that never launched (node denied: exit 1, no probe line) is Q5 unanswered, not "outside write blocked"', async () => {
    const deadCanary = (probe: SandboxCanaryProbe): Script => ({
      run: () => {
        probe.called = true;
        probe.result = { success: false, exitCode: 1, output: "ResourceUnavailable: Program 'node.exe' failed to run ... Access is denied.", toolCallId: 'c1' };
        return { finalText: 'SANDBOX_CANARY_DONE', credits: 0.3, sandbox: enforced() };
      },
      events: () => shellCall('c1', true),
    });
    const { checks } = await run({ review: cleanReview, write: cleanWrite, canary: deadCanary });
    expect(checks['scn.sandbox-lane.q5_canary_rpc']).toMatchObject({ ok: false, detail: expect.stringMatching(/^Q5 unanswered: probe did not run \(exit 1, no OMG_SANDBOX_PROBE line; output ".*Access is denied/) });
    expect(checks['scn.sandbox-lane.q5_canary_rpc'].detail).not.toMatch(/blocked|model turn/);
  });

  it('pins every lane to the requested model and reports the model each lane ran on', async () => {
    const backends: EventLanes[] = [];
    const lanes = (repo: string, canary: SandboxCanaryProbe | null) => {
      const b = new EventLanes(repo, canary ? [cleanCanary(canary)] : [cleanReview, cleanWrite]);
      backends.push(b);
      return b;
    };
    const { result, checks } = await run({ review: cleanReview, write: cleanWrite, canary: cleanCanary }, { lanes, model: 'claude-haiku-5.5' });
    expect(backends.flatMap((b) => [...b.inputs.values()].map((i) => i.model))).toEqual(['claude-haiku-5.5', 'claude-haiku-5.5', 'claude-haiku-5.5']);
    // FakeLanes reports no session model.
    expect(result.model).toBe('copilot_run lanes pinned to claude-haiku-5.5; ran on unreported');
    expect(checks['scn.sandbox-lane.credits'].detail).toMatch(/; lanes ran on review unreported, write unreported, canary unreported$/);
  });

  it('without a model the lanes start unpinned and the report says runtime auto', async () => {
    const backends: EventLanes[] = [];
    const lanes = (repo: string, canary: SandboxCanaryProbe | null) => {
      const b = new EventLanes(repo, canary ? [cleanCanary(canary)] : [cleanReview, cleanWrite]);
      backends.push(b);
      return b;
    };
    const { result } = await run({ review: cleanReview, write: cleanWrite, canary: cleanCanary }, { lanes });
    expect(backends.flatMap((b) => [...b.inputs.values()].map((i) => i.model))).toEqual([undefined, undefined, undefined]);
    expect(result.model).toBe('copilot_run lanes on runtime auto (no cheap model listed); ran on unreported');
  });

  it('a host without the sandbox: review read-only, write refused; every question is reported unanswered', async () => {
    const unsupported = (mode: CopilotRunSandboxState['mode']): CopilotRunSandboxState => ({
      ...enforced(), mode, host: { supported: false, reason: 'bubblewrap missing', capabilities: {} }, applied: 'none', reason: 'bubblewrap missing',
    });
    const review: Script = { run: () => ({ finalText: 'no shell', credits: 0.3, sandbox: unsupported('read-only-no-shell') }), events: () => [] };
    const write: Script = { run: () => ({ state: 'failed', error: 'sandbox-unavailable: bubblewrap missing', credits: 0, sandbox: unsupported('refused') }), events: () => [] };
    const canary = (probe: SandboxCanaryProbe): Script => ({ run: () => { void probe; return { state: 'failed', error: 'sandbox-unavailable: bubblewrap missing', credits: 0, sandbox: unsupported('refused') }; }, events: () => [] });
    const { checks, result } = await run({ review, write, canary });
    expect(checks['scn.sandbox-lane.host']).toMatchObject({ ok: false, detail: expect.stringMatching(/^host unsupported \(bubblewrap missing\)/) });
    expect(checks['scn.sandbox-lane.q1_profile'].detail).toMatch(/^Q1 unanswered: write refused \(bubblewrap missing\); sandbox-unavailable/);
    expect(checks['scn.sandbox-lane.q2_git_dir'].detail).toMatch(/^Q2 unanswered: write refused/);
    expect(checks['scn.sandbox-lane.q5_canary_rpc'].detail).toMatch(/^Q5 unanswered: canary refused/);
    expect(checks['scn.sandbox-lane.engine_commit'].detail).toBe('the engine commit did not run');
    expect(checks['scn.sandbox-lane.exit'].ok).toBe(false);
    expect(result.error).toMatch(/write lane ended failed: sandbox-unavailable/);
  });
});

describe('sandbox probe script', () => {
  it('writes each target, reports a failed write, and prints one parseable line (writes mode: no home, no network)', () => {
    const repo = join(dir, 'probe');
    mkdirSync(repo);
    writeFileSync(join(repo, 'sandbox-probe.mjs'), SANDBOX_PROBE_SOURCE);
    const missing = join(dir, 'no-such-dir', 'x.txt');
    const r = spawnSync(process.execPath, ['sandbox-probe.mjs', 'abc123abc123', 'writes', 'inside.txt', missing], { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = parseSandboxProbe(r.stdout)!;
    expect(out.home).toBeUndefined();
    expect(out.net).toEqual({});
    expect(out.writes).toEqual([
      { path: join(repo, 'inside.txt'), ok: true },
      { path: missing, ok: false, error: 'ENOENT' },
    ]);
    expect(readFileSync(join(repo, 'inside.txt'), 'utf8')).toBe('abc123abc123\n');
  });

  it('parseSandboxProbe ignores lines without the marker or with broken JSON', () => {
    expect(parseSandboxProbe('nothing here')).toBeNull();
    expect(parseSandboxProbe(`${SANDBOX_PROBE_MARKER}{not json`)).toBeNull();
    expect(parseSandboxProbe(`noise\n> ${SANDBOX_PROBE_MARKER}{"writes":[],"net":{}}`)).toEqual({ writes: [], net: {} });
  });
});

describe('withSandboxCanary', () => {
  function fakeModule(rec: { ops: string[] }) {
    class Client {
      async start() {}
      async stop() { return []; }
      async getStatus() { return {}; }
      async listModels() { return []; }
      async deleteSession() {}
      async createSession(config: SdkSessionConfig): Promise<SdkSessionLike> {
        rec.ops.push('create');
        const session = {
          sessionId: 's1',
          send: async () => { rec.ops.push('send'); return 'm'; },
          abort: async () => {},
          disconnect: async () => {},
          rpc: {
            plugins: { list: async () => ({}) }, skills: { list: async () => ({}) }, agent: { list: async () => ({}) },
            mcp: { list: async () => ({}), listTools: async () => ({}) },
            shell: {
              executeUserRequested: async (p: { requestId: string; command: string }) => {
                rec.ops.push(`exec:${p.command}`);
                await config.onPermissionRequest({ kind: 'shell', fullCommandText: p.command }, { sessionId: 's1' });
                return { toolCallId: 't9', success: true, output: 'out', exitCode: 0 };
              },
            },
          },
        };
        return session as unknown as SdkSessionLike;
      }
    }
    return { module: { CopilotClient: Client, RuntimeConnection: { forStdio: (o: unknown) => o } } as unknown as CopilotSdkModule, version: '1.0.16', from: 'fake' } satisfies LoadedSdk;
  }

  it('runs the command once, before the first send only, and counts the permission requests it raised; the prototype stays the SDK\'s', async () => {
    const rec = { ops: [] as string[] };
    const loaded = fakeModule(rec);
    const probe: SandboxCanaryProbe = { command: 'node sandbox-probe.mjs n writes x', called: false, result: null, permissionRequests: 0 };
    const wrapped = withSandboxCanary(loaded, probe);
    expect((wrapped.module.CopilotClient as unknown as { prototype: { createSession: unknown } }).prototype.createSession)
      .toBe((loaded.module.CopilotClient as unknown as { prototype: { createSession: unknown } }).prototype.createSession);
    const client = new wrapped.module.CopilotClient({ connection: {}, baseDirectory: dir, workingDirectory: dir });
    let asked = 0;
    const session = await client.createSession({ onPermissionRequest: () => { asked += 1; return { kind: 'approve-once' }; }, pluginDirectories: [], workingDirectory: dir, disabledMcpServers: [], excludedTools: [] });
    await session.send({ prompt: 'one' });
    await session.send({ prompt: 'two' });
    expect(rec.ops).toEqual(['create', 'exec:node sandbox-probe.mjs n writes x', 'send', 'send']);
    expect(probe).toMatchObject({ called: true, permissionRequests: 1, result: { toolCallId: 't9', success: true, exitCode: 0, output: 'out' } });
    expect(asked).toBe(1); // the job's own handler still decides
  });
});
