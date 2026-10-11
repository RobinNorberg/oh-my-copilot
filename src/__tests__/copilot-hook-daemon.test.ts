import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Fork (oh-my-copilot): the opt-in warm hook daemon (scripts/copilot/hook-daemon.cjs).
 * The differential tests run the same group and payload through the cold
 * dispatcher and through a running daemon and require the same exit code,
 * stdout, stderr, hook order, cwd and owner pid. The fallback tests break the
 * daemon in each way the client must survive and require the cold verdict.
 * The lifecycle tests pin idle exit, host-gone exit, the single-instance lock
 * and its stale reclaim, retire after an abnormal request, and that the
 * daemon never holds the client's stdio pipes.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'copilot-hook-daemon', 'probe.mjs');
const PLUGIN_FILES = [
  'scripts/run.cjs',
  'scripts/copilot/dispatch.cjs',
  'scripts/copilot/hook-daemon.cjs',
  'scripts/lib/copilot-hook-adapter.cjs',
  'scripts/lib/config-dir.cjs',
];
const require = createRequire(import.meta.url);
const daemonModule = require(join(REPO_ROOT, 'scripts', 'copilot', 'hook-daemon.cjs')) as {
  DAEMON_SAFE_HOOKS: Map<string, unknown>;
};
const dispatcher = require(join(REPO_ROOT, 'scripts', 'copilot', 'dispatch.cjs')) as {
  encodeDispatchArgv(event: string, hooks: Array<{ script: string; args?: string[] }>): string[];
};

type Meta = { pid: number; endpoint: string; token: string; version: string; code: string; hostPid: number; protocol: number };
type Trace = { name: string; pid: number; isMainThread: boolean; argv: string[]; cwd: string; marker: string | null; owner: string | null; event: string | null; probeEnv: string | null };
type Run = { status: number | null; stdout: string; stderr: string; traces: Trace[]; exitAt: number; closeAt: number };
type Fixture = { root: string; home: string; cwd: string };

const WARM = { OMC_COPILOT_HOOK_DAEMON: '1', OMC_COPILOT_HOOK_DAEMON_IDLE_MS: '30000' };
const tempDirs: string[] = [];
const homes: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return predicate();
}

const daemonDirOf = (home: string) => join(home, '.omg', 'state', 'hook-daemon');
function daemonFiles(home: string): string[] {
  const dir = daemonDirOf(home);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
function metas(home: string): Array<Meta & { file: string }> {
  return daemonFiles(home).filter(name => name.endsWith('.json'))
    .map(name => ({ ...(readJson<Meta>(join(daemonDirOf(home), name)) as Meta), file: join(daemonDirOf(home), name) }))
    .filter(meta => Number.isInteger(meta.pid));
}
function daemonPids(home: string): number[] {
  const pids = new Set<number>();
  for (const name of daemonFiles(home)) {
    if (!/\.(json|lock)$/.test(name)) continue;
    const record = readJson<{ pid?: number }>(join(daemonDirOf(home), name));
    // The fake-endpoint tests write this process into a lock; never kill it.
    if (record && Number.isInteger(record.pid) && record.pid !== process.pid) pids.add(record.pid as number);
  }
  return [...pids];
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    const pids = daemonPids(home);
    for (const pid of pids) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    await waitFor(() => pids.every(pid => !pidAlive(pid)), 5000);
  }
  // A hung probe's supervised child is reaped by a fire-and-forget taskkill on
  // Windows and holds its cwd until then; rmSync does not retry that EPERM.
  for (const dir of tempDirs.splice(0)) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
});

/** Process env without host or test switches that would change routing. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OMC_HOOK_EVENT', 'OMC_HOOK_FAIL_CLOSED', 'OMC_HOOK_STRICT', 'OMC_COPILOT_HOOK_WORKER', 'OMC_COPILOT_HOOK_DISPATCH',
    'OMC_COPILOT_HOOK_DAEMON', 'OMC_COPILOT_HOOK_DAEMON_IDLE_MS', 'OMC_SESSION_OWNER_PID', 'OMC_DEBUG_HOOKS', 'OMC_DEBUG',
    'NODE_ENV', 'OMC_STATE_DIR', 'OMC_SESSION_END_BUDGET_MS', 'OMC_GIT_GUARDRAILS', 'COPILOT_HOME', 'CLAUDE_PLUGIN_ROOT',
  ]) delete env[key];
  return { ...env, ...extra };
}

const SAFE_PROBES = ['context-guard-stop.mjs', 'workflow-drift-guard.mjs', 'budget-guard.mjs', 'code-simplifier.mjs',
  'pre-tool-enforcer.mjs', 'git-guardrails.mjs', 'permission-handler.mjs', 'verify-deliverables.mjs'];

/**
 * A self-contained temp plugin: the dispatcher, daemon, run.cjs and adapter,
 * a package.json, and the probe under daemon-safe names plus one unsafe name
 * (persistent-mode.mjs). workflow-drift-guard.mjs (1 s) stays on the
 * supervised child path; the other Stop names run in a Worker;
 * pre-tool-enforcer.mjs and git-guardrails.mjs take the trusted Worker path.
 */
function fixture(): Fixture {
  const root = tempDir('omg-daemon-plugin-');
  for (const file of PLUGIN_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(root, file));
  }
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'omg-daemon-probe', version: '0.0.0-probe' }));
  for (const name of [...SAFE_PROBES, 'persistent-mode.mjs']) copyFileSync(PROBE, join(root, 'scripts', name));
  const command = (script: string) => `node "\${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "\${CLAUDE_PLUGIN_ROOT}"/scripts/${script}`;
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{ matcher: '*', hooks: [
        { type: 'command', command: command('context-guard-stop.mjs'), timeout: 5 },
        { type: 'command', command: command('workflow-drift-guard.mjs'), timeout: 1 },
        { type: 'command', command: command('budget-guard.mjs'), timeout: 5 },
        { type: 'command', command: command('code-simplifier.mjs'), timeout: 5 },
        { type: 'command', command: command('persistent-mode.mjs'), timeout: 5 },
      ] }],
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: command('pre-tool-enforcer.mjs'), timeout: 5 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: command('git-guardrails.mjs'), timeout: 5 }] },
      ],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: command('permission-handler.mjs'), timeout: 5 }] }],
      SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: `${command('verify-deliverables.mjs')} probe-arg`, timeout: 5 }] }],
    },
  }));
  const home = tempDir('omg-daemon-home-');
  homes.push(home);
  return { root, home, cwd: tempDir('omg-daemon-cwd-') };
}

function argvFor(root: string, event: string, scripts: string[][]): string[] {
  const hooks = scripts.map(([script, ...args]) => ({ script: join(root, 'scripts', script), args }));
  return [
    '--require', join(root, 'scripts', 'lib', 'copilot-hook-adapter.cjs'),
    join(root, 'scripts', 'copilot', 'dispatch.cjs'),
    ...dispatcher.encodeDispatchArgv(event, hooks),
  ];
}

/** One Copilot hook entry, run the way the host runs it. Async, so an in-test fake daemon can answer. */
function runEntry(fx: Fixture, event: string, scripts: string[][], payload: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Run> {
  const trace = join(tempDir('omg-daemon-trace-'), 'trace.jsonl');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let exitAt = 0;
    let status: number | null = null;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(process.execPath, argvFor(fx.root, event, scripts), {
      cwd: fx.cwd,
      env: cleanEnv({ CLAUDE_PLUGIN_ROOT: fx.root, OMC_HOOK_EVENT: event, COPILOT_HOME: fx.home, ...extra }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const killer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => { exitAt = Date.now() - started; status = code; });
    child.on('close', () => {
      clearTimeout(killer);
      const traces = existsSync(trace)
        ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace)
        : [];
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), traces, exitAt, closeAt: Date.now() - started });
    });
    child.stdin.end(JSON.stringify({ ...payload, trace }));
  });
}

/** Start the fixture's daemon with a request that prints nothing, and wait until it listens. */
async function startDaemon(fx: Fixture, extra: Record<string, string> = {}): Promise<Meta & { file: string }> {
  const live = () => metas(fx.home).find(meta => pidAlive(meta.pid));
  if (!live()) {
    await runEntry(fx, 'PermissionRequest', [['permission-handler.mjs']], {}, { ...WARM, ...extra });
    expect(await waitFor(() => Boolean(live()), 15_000), `daemon did not start: ${daemonFiles(fx.home).join(',')}`).toBe(true);
  }
  return live() as Meta & { file: string };
}

const withoutPid = (traces: Trace[]) => traces.map(({ pid: _pid, ...rest }) => rest);

/**
 * The same group and payload, cold and then warm. Returns both runs after
 * asserting identical verdicts and that the warm run's Worker hooks ran in the daemon.
 */
async function differential(fx: Fixture, event: string, scripts: string[][], payload: Record<string, unknown>, extra: Record<string, string> = {}) {
  const cold = await runEntry(fx, event, scripts, payload, extra);
  const meta = await startDaemon(fx);
  const warm = await runEntry(fx, event, scripts, payload, { ...extra, ...WARM });
  expect(warm.status, warm.stderr).toBe(cold.status);
  expect(warm.stdout).toBe(cold.stdout);
  expect(warm.stderr).toBe(cold.stderr);
  expect(withoutPid(warm.traces)).toEqual(withoutPid(cold.traces));
  const workerTraces = warm.traces.filter(trace => !trace.isMainThread);
  expect(workerTraces.length).toBeGreaterThan(0);
  expect(workerTraces.every(trace => trace.pid === meta.pid), JSON.stringify(warm.traces)).toBe(true);
  expect(cold.traces.every(trace => trace.pid !== meta.pid)).toBe(true);
  for (const trace of warm.traces) expect(trace.cwd).toBe(cold.traces[0].cwd);
  return { cold, warm, meta };
}

async function expectRetired(fx: Fixture, meta: Meta) {
  expect(await waitFor(() => !pidAlive(meta.pid), 10_000), 'daemon kept running').toBe(true);
  expect(await waitFor(() => daemonFiles(fx.home).filter(name => /\.(json|lock|sock)$/.test(name)).length === 0, 5000), daemonFiles(fx.home).join(',')).toBe(true);
}

const STOP = [['context-guard-stop.mjs'], ['workflow-drift-guard.mjs'], ['budget-guard.mjs'], ['code-simplifier.mjs']];

describe('warm daemon differential (probe plugin)', () => {
  it('Stop merge rules: context join, block beats continue:false, block reasons joined, adapter exit-2 block', async () => {
    const fx = fixture();
    const { warm, meta } = await differential(fx, 'Stop', STOP, {
      marker: 'stdin-ok',
      hooks: {
        'context-guard-stop.mjs': { stdout: { continue: true, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'a' } } },
        'workflow-drift-guard.mjs': { exitCode: 2, stderr: 'second block' },
        'budget-guard.mjs': { stdout: { decision: 'block', reason: 'first block' } },
        'code-simplifier.mjs': { stdout: { continue: false, stopReason: 'halt' } },
      },
    });
    expect(warm.status).toBe(0);
    expect(JSON.parse(warm.stdout)).toMatchObject({ decision: 'block', reason: 'second block\n\nfirst block', additionalContext: 'a' });
    expect(warm.stderr).toContain('decision:block overrides continue:false of code-simplifier.mjs: halt');
    expect(warm.traces.map(trace => trace.name)).toEqual(STOP.map(([name]) => name));
    // The <=3 s hook still took the supervised child path inside the daemon.
    expect(warm.traces.find(trace => trace.name === 'workflow-drift-guard.mjs')?.isMainThread).toBe(true);
    // The session owner is the host (this test process), never the daemon.
    for (const trace of warm.traces) expect(trace.owner).toBe(String(process.pid));
    expect(warm.traces.every(trace => trace.marker === 'stdin-ok' && trace.event === 'Stop')).toBe(true);
    // Exit 2 is ordinary hook output: the daemon keeps serving.
    expect(pidAlive(meta.pid)).toBe(true);
  }, 90_000);

  it('non-JSON stdout next to JSON is dropped the same way', async () => {
    const fx = fixture();
    const { warm } = await differential(fx, 'Stop', STOP, {
      hooks: { 'context-guard-stop.mjs': { stdout: 'plain text' }, 'budget-guard.mjs': { stdout: { continue: true } } },
    });
    expect(warm.stderr).toContain('dropped non-JSON stdout of context-guard-stop.mjs');
  }, 90_000);

  it('fail-open non-zero exit, and the daemon retires after it', async () => {
    const fx = fixture();
    const { warm, meta } = await differential(fx, 'Stop', STOP, { hooks: { 'budget-guard.mjs': { exitCode: 7 } } });
    expect(warm.status).toBe(0);
    expect(warm.stderr).toContain('budget-guard.mjs exited 7; failing open');
    await expectRetired(fx, meta);
  }, 90_000);

  it('fail-closed worst exit code, and 124 for a timed-out supervised child', async () => {
    const fx = fixture();
    const worst = await differential(fx, 'Stop', STOP, {
      hooks: { 'context-guard-stop.mjs': { exitCode: 7 }, 'budget-guard.mjs': { exitCode: 3 } },
    }, { OMC_HOOK_FAIL_CLOSED: '1' });
    expect(worst.warm.status).toBe(7);
    await expectRetired(fx, worst.meta);

    const timedOut = await differential(fx, 'Stop', STOP, {
      hooks: {
        'workflow-drift-guard.mjs': { stdout: { decision: 'block', reason: 'printed before the hang' }, hang: true },
        'code-simplifier.mjs': { stdout: { decision: 'block', reason: 'after the timeout' } },
      },
    }, { OMC_HOOK_FAIL_CLOSED: '1' });
    expect(timedOut.warm.status).toBe(124);
    expect(JSON.parse(timedOut.warm.stdout)).toEqual({ decision: 'block', reason: 'after the timeout' });
    await expectRetired(fx, timedOut.meta);
  }, 120_000);

  it('a Worker hook that times out fails open the same way and retires the daemon', async () => {
    const fx = fixture();
    const { warm, meta } = await differential(fx, 'Stop', STOP, {
      hooks: { 'budget-guard.mjs': { hang: true }, 'code-simplifier.mjs': { stdout: { continue: true } } },
    });
    expect(warm.status).toBe(0);
    expect(warm.stderr).toMatch(/\[run\.cjs\] Hook budget-guard\.mjs timed out after \d+ms; exiting fail-open/);
    await expectRetired(fx, meta);
  }, 120_000);

  it('PreToolUse deny (trusted Worker path), PermissionRequest exit 2, and extra hook args', async () => {
    const fx = fixture();
    const deny = await differential(fx, 'PreToolUse', [['pre-tool-enforcer.mjs']], {
      tool_name: 'Bash',
      hooks: { 'pre-tool-enforcer.mjs': { exitCode: 2, stderr: 'not allowed' } },
    });
    expect(JSON.parse(deny.warm.stdout)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'not allowed' });

    const permission = await differential(fx, 'PermissionRequest', [['permission-handler.mjs']], {
      hooks: { 'permission-handler.mjs': { exitCode: 2, stderr: 'denied' } },
    });
    expect(permission.warm.status).toBe(2);

    const args = await differential(fx, 'SubagentStop', [['verify-deliverables.mjs', 'probe-arg']], {
      hooks: { 'verify-deliverables.mjs': { stdout: { continue: true } } },
    });
    expect(args.warm.traces[0].argv).toEqual(['probe-arg']);
  }, 120_000);
});

describe('warm daemon fallbacks keep the cold verdict', () => {
  const PAYLOAD = { hooks: { 'budget-guard.mjs': { stdout: { decision: 'block', reason: 'kept' } } } };
  const debugWarm = { ...WARM, OMC_DEBUG_HOOKS: '1' };

  async function expectCold(fx: Fixture, extra: Record<string, string>, reason: RegExp) {
    const cold = await runEntry(fx, 'Stop', STOP, PAYLOAD);
    const run = await runEntry(fx, 'Stop', STOP, PAYLOAD, { ...debugWarm, ...extra });
    expect(run.status, run.stderr).toBe(cold.status);
    expect(run.stdout).toBe(cold.stdout);
    expect(run.stderr).toMatch(reason);
    expect(run.stderr).not.toContain('daemon: served');
    expect(run.traces.map(trace => trace.name)).toEqual(STOP.map(([name]) => name));
    return run;
  }

  it('is off by default and with OMC_COPILOT_HOOK_DAEMON=0, and never creates daemon files', async () => {
    const fx = fixture();
    for (const extra of [{}, { OMC_COPILOT_HOOK_DAEMON: '0' }] as Array<Record<string, string>>) {
      const run = await runEntry(fx, 'Stop', STOP, PAYLOAD, { ...extra, OMC_DEBUG_HOOKS: '1' });
      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain('daemon');
    }
    expect(existsSync(daemonDirOf(fx.home))).toBe(false);
  }, 60_000);

  it('OMC_COPILOT_HOOK_DISPATCH=0 wins over the daemon', async () => {
    const fx = fixture();
    await expectCold(fx, { OMC_COPILOT_HOOK_DISPATCH: '0' }, /daemon: kill switch OMC_COPILOT_HOOK_DISPATCH=0/);
    expect(existsSync(daemonDirOf(fx.home))).toBe(false);
  }, 60_000);

  it('a group with a hook that is not daemon-safe never reaches the daemon', async () => {
    const fx = fixture();
    const cold = await runEntry(fx, 'Stop', [...STOP, ['persistent-mode.mjs']], PAYLOAD);
    const run = await runEntry(fx, 'Stop', [...STOP, ['persistent-mode.mjs']], PAYLOAD, debugWarm);
    expect(run.stdout).toBe(cold.stdout);
    expect(run.stderr).toContain('daemon: persistent-mode.mjs is not daemon-safe');
    expect(existsSync(daemonDirOf(fx.home))).toBe(false);
  }, 60_000);

  it('the pre-tool-enforcer AskUserQuestion branch stays cold', async () => {
    const fx = fixture();
    const run = await runEntry(fx, 'PreToolUse', [['pre-tool-enforcer.mjs']], { tool_name: 'AskUserQuestion' }, debugWarm);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('daemon: pre-tool-enforcer.mjs AskUserQuestion branch is not daemon-safe');
  }, 60_000);

  it('no daemon: runs cold and starts one for the next hook', async () => {
    const fx = fixture();
    await expectCold(fx, {}, /daemon: no daemon \(daemon started for the next hook\)/);
    expect(await waitFor(() => metas(fx.home).some(meta => pidAlive(meta.pid)), 15_000)).toBe(true);
  }, 60_000);

  it('a hard-killed daemon (stale metadata and lock) falls back, and the next daemon reclaims the lock', async () => {
    const fx = fixture();
    const meta = await startDaemon(fx);
    process.kill(meta.pid, 'SIGKILL');
    expect(await waitFor(() => !pidAlive(meta.pid), 5000)).toBe(true);
    // A SIGKILL / TerminateProcess skips the exit cleanup: the metadata and lock stay.
    expect(existsSync(meta.file)).toBe(true);
    await expectCold(fx, {}, /daemon: (ENOENT|ECONNREFUSED|connect timeout|connection closed during connect)[^\n]*\(daemon started for the next hook\)/);
    expect(await waitFor(() => metas(fx.home).some(next => next.pid !== meta.pid && pidAlive(next.pid)), 15_000)).toBe(true);
  }, 60_000);

  it('a wrong token is refused', async () => {
    const fx = fixture();
    const meta = await startDaemon(fx);
    writeFileSync(meta.file, JSON.stringify({ ...readJson<Meta>(meta.file), token: 'f'.repeat(64) }));
    await expectCold(fx, {}, /daemon: refused: unauthorized/);
  }, 60_000);

  it('metadata from another plugin version is not used', async () => {
    const fx = fixture();
    const meta = await startDaemon(fx);
    writeFileSync(meta.file, JSON.stringify({ ...readJson<Meta>(meta.file), version: '9.9.9' }));
    await expectCold(fx, {}, /daemon: daemon metadata does not match this plugin/);
  }, 60_000);

  describe('a misbehaving daemon endpoint', () => {
    let server: Server | null = null;
    afterEach(() => new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
      server = null;
    }));

    async function fakeDaemon(fx: Fixture, onLine: (socket: import('node:net').Socket) => void) {
      const meta = await startDaemon(fx);
      process.kill(meta.pid, 'SIGKILL');
      await waitFor(() => !pidAlive(meta.pid), 5000);
      const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\omg-hookd-test-${process.pid}-${Date.now()}`
        : join(tempDir('omg-daemon-fake-'), 'fake.sock');
      server = createServer((socket) => {
        socket.on('error', () => {});
        socket.once('data', () => onLine(socket));
      });
      await new Promise<void>(resolve => server!.listen(endpoint, resolve));
      // A live lock holder (this process) so the client does not start a real daemon.
      const lock = meta.file.replace(/\.json$/, '.lock');
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'test' }));
      writeFileSync(meta.file, JSON.stringify({ ...readJson<Meta>(meta.file), endpoint }));
    }

    it('garbage reply', async () => {
      const fx = fixture();
      await fakeDaemon(fx, socket => socket.end('this is not json\n'));
      await expectCold(fx, {}, /daemon: protocol error/);
    }, 60_000);

    it('connection dropped after accept', async () => {
      const fx = fixture();
      await fakeDaemon(fx, (socket) => {
        socket.write(`${JSON.stringify({ accepted: true, budgetMs: 1000 })}\n`);
        setTimeout(() => socket.destroy(), 100);
      });
      await expectCold(fx, {}, /daemon: connection closed during run/);
    }, 60_000);

    it('accepted but never answers: gives up after the budget plus grace', async () => {
      const fx = fixture();
      await fakeDaemon(fx, socket => socket.write(`${JSON.stringify({ accepted: true, budgetMs: 1 })}\n`));
      const run = await expectCold(fx, {}, /daemon: run timeout/);
      expect(run.exitAt).toBeLessThan(20_000);
    }, 60_000);

    it('a malformed done line', async () => {
      const fx = fixture();
      await fakeDaemon(fx, (socket) => {
        socket.write(`${JSON.stringify({ accepted: true, budgetMs: 1000 })}\n`);
        socket.end(`${JSON.stringify({ done: true, stdout: 1 })}\n`);
      });
      await expectCold(fx, {}, /daemon: protocol error/);
    }, 60_000);
  });

  it('busy: a request that overlaps a running one runs cold with its own env; the daemon then serves again', async () => {
    const fx = fixture();
    const meta = await startDaemon(fx);
    const slow = { hooks: { 'budget-guard.mjs': { sleepMs: 2500, stdout: { continue: true } } } };
    const first = runEntry(fx, 'Stop', STOP, slow, { ...WARM, PROBE_ENV: 'a' });
    await new Promise(resolve => setTimeout(resolve, 900));
    const other = await runEntry(fx, 'Stop', STOP, PAYLOAD, { ...debugWarm, PROBE_ENV: 'b' });
    expect(other.stderr).toContain('daemon: refused: busy');
    expect(other.traces.every(trace => trace.pid !== meta.pid && trace.probeEnv === 'b')).toBe(true);
    expect(JSON.parse(other.stdout)).toEqual({ decision: 'block', reason: 'kept' });
    const firstRun = await first;
    expect(firstRun.traces.filter(trace => !trace.isMainThread).every(trace => trace.pid === meta.pid)).toBe(true);
    expect(firstRun.traces.every(trace => trace.probeEnv === 'a')).toBe(true);

    // The env of the first request did not leak into the next one.
    const next = await runEntry(fx, 'Stop', STOP, slow, WARM);
    expect(next.traces.filter(trace => !trace.isMainThread).every(trace => trace.pid === meta.pid)).toBe(true);
    expect(next.traces.every(trace => trace.probeEnv === null)).toBe(true);
  }, 90_000);
});

describe('warm daemon lifecycle', () => {
  it('exits after the idle timeout and removes its files', async () => {
    const fx = fixture();
    const meta = await startDaemon(fx, { OMC_COPILOT_HOOK_DAEMON_IDLE_MS: '1500' });
    expect(daemonFiles(fx.home).some(name => name.endsWith('.lock'))).toBe(true);
    await expectRetired(fx, meta);
  }, 60_000);

  it('exits when the host process is gone', async () => {
    const fx = fixture();
    const host = join(tempDir('omg-daemon-host-'), 'host.cjs');
    writeFileSync(host, [
      "const { spawnSync } = require('child_process');",
      'const [argv, env, cwd] = JSON.parse(process.argv[2]);',
      "spawnSync(process.execPath, argv, { cwd, env, input: '{}', windowsHide: true });",
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const env = cleanEnv({ CLAUDE_PLUGIN_ROOT: fx.root, OMC_HOOK_EVENT: 'PermissionRequest', COPILOT_HOME: fx.home, ...WARM });
    const child = spawn(process.execPath, [host, JSON.stringify([argvFor(fx.root, 'PermissionRequest', [['permission-handler.mjs']]), env, fx.cwd])], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    await new Promise(resolve => child.stdout.once('data', resolve));
    expect(await waitFor(() => metas(fx.home).some(meta => meta.hostPid === child.pid && pidAlive(meta.pid)), 15_000)).toBe(true);
    const meta = metas(fx.home).find(entry => entry.hostPid === child.pid) as Meta;
    child.kill();
    await expectRetired(fx, meta);
  }, 60_000);

  it('keeps one daemon per key, and reclaims a lock whose owner is dead', async () => {
    const fx = fixture();
    const meta = await startDaemon(fx);
    const key = basename(meta.file, '.json');
    const dir = daemonDirOf(fx.home);
    const serve = (serveKey: string) => {
      const child = spawn(process.execPath, [join(fx.root, 'scripts', 'copilot', 'hook-daemon.cjs'), '--serve', serveKey, String(process.pid), dir], {
        cwd: dir, env: cleanEnv({ COPILOT_HOME: fx.home, OMC_COPILOT_HOOK_DAEMON_IDLE_MS: '30000' }), stdio: 'ignore', windowsHide: true,
      });
      return { child, exited: new Promise<void>(resolve => child.once('exit', () => resolve())) };
    };

    // A second daemon for a live key exits at once and leaves the first in place.
    await serve(key).exited;
    expect(pidAlive(meta.pid)).toBe(true);
    expect(readJson<Meta>(meta.file)?.pid).toBe(meta.pid);

    // Two daemons racing for a fresh key: one wins, the other exits.
    const fresh = 'a'.repeat(24);
    const racers = [serve(fresh), serve(fresh)];
    expect(await waitFor(() => existsSync(join(dir, `${fresh}.json`)), 15_000)).toBe(true);
    await Promise.race(racers.map(racer => racer.exited));
    await new Promise(resolve => setTimeout(resolve, 500));
    const alive = racers.filter(racer => racer.child.exitCode === null);
    expect(alive.length).toBe(1);
    expect(readJson<Meta>(join(dir, `${fresh}.json`))?.pid).toBe(alive[0].child.pid);

    // A lock left by a dead process is reclaimed.
    const dead = spawn(process.execPath, ['-v'], { stdio: 'ignore' });
    await new Promise(resolve => dead.once('exit', resolve));
    const stale = 'b'.repeat(24);
    writeFileSync(join(dir, `${stale}.lock`), JSON.stringify({ pid: dead.pid, nonce: 'dead' }));
    serve(stale);
    expect(await waitFor(() => readJson<Meta>(join(dir, `${stale}.json`))?.pid !== undefined, 15_000)).toBe(true);
    expect(readJson<{ pid: number }>(join(dir, `${stale}.lock`))?.pid).not.toBe(dead.pid);
  }, 60_000);

  it('never holds the client stdio: the hook entry closes as soon as it exits, with the daemon still running', async () => {
    const fx = fixture();
    const payload = { hooks: { 'budget-guard.mjs': { stdout: { continue: true } } } };
    const cold = await runEntry(fx, 'Stop', STOP, payload);
    // This run starts the daemon (the detached child of this hook process).
    const run = await runEntry(fx, 'Stop', STOP, payload, WARM);
    expect(run.stdout).toBe(cold.stdout);
    expect(run.closeAt - run.exitAt).toBeLessThan(1500);
    expect(await waitFor(() => metas(fx.home).some(meta => pidAlive(meta.pid)), 15_000)).toBe(true);
    // Served runs close promptly too, and print exactly the merged stdout.
    const served = await runEntry(fx, 'Stop', STOP, { hooks: { 'budget-guard.mjs': { stdout: { continue: true } } } }, WARM);
    expect(served.stdout).toBe(run.stdout);
    expect(served.closeAt - served.exitAt).toBeLessThan(1500);
  }, 60_000);
});

/**
 * Real hooks, idle project: every daemon-eligible group of copilot/hooks.json,
 * cold in one fresh project and warm in another, must print the same and
 * leave the same state files.
 */
describe('warm daemon differential (real hooks)', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ args: string[] }>>;
  };
  const groups = Object.entries(manifest.hooks).flatMap(([event, entries]) => entries.map((entry, index) => {
    const scripts = entry.args.slice(4).map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', REPO_ROOT));
    return { event, index, scripts };
  })).filter(({ scripts }) => scripts.filter(arg => arg !== '--' && arg.endsWith('.mjs'))
    .every(script => daemonModule.DAEMON_SAFE_HOOKS.has(basename(script))));

  it('covers the PreToolUse and PermissionRequest groups', () => {
    expect(groups.map(({ event }) => event).sort()).toEqual(['PermissionRequest', 'PreToolUse', 'PreToolUse']);
  });

  function project(tag: string) {
    const base = tempDir(`omg-daemon-real-${tag}-`);
    const cwd = join(base, 'p');
    const home = join(base, 'h');
    mkdirSync(cwd);
    mkdirSync(home);
    homes.push(home);
    execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
    writeFileSync(join(cwd, 'README.md'), 'x\n');
    const env = cleanEnv({ HOME: home, USERPROFILE: home, COPILOT_HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT, OMC_DEBUG_HOOKS: '1' });
    const normalise = (text: string) => text
      .split(cwd).join('<P>').split(cwd.replace(/\\/g, '\\\\')).join('<P>')
      .split(home).join('<H>').split(home.replace(/\\/g, '\\\\')).join('<H>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TS>');
    const files = () => {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) { if (entry.name !== '.git' && entry.name !== 'hook-daemon') walk(path); } else {
            out[relative(base, path).replace(/\\/g, '/')] = normalise(readFileSync(path, 'utf8')).replace(/\b\d{10,13}\b/g, '<N>');
          }
        }
      };
      walk(base);
      return out;
    };
    return { cwd, home, env, normalise, files };
  }

  const run = (p: ReturnType<typeof project>, event: string, scripts: string[], extra: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--require', join(REPO_ROOT, 'scripts', 'lib', 'copilot-hook-adapter.cjs'), join(REPO_ROOT, 'scripts', 'copilot', 'dispatch.cjs'), event, ...scripts], {
      cwd: p.cwd, env: { ...p.env, OMC_HOOK_EVENT: event, ...extra }, windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout: p.normalise(stdout), stderr: p.normalise(stderr) }));
    child.stdin.end(JSON.stringify({
      session_id: '11111111-2222-4333-8444-555555555555', cwd: p.cwd, hook_event_name: event,
      tool_name: 'Bash', tool_input: { command: 'git status' }, transcript_path: join(p.home, 'events.jsonl'),
    }));
  });
  // Debug lines carry timings and say which path ran.
  const scrubDebug = (stderr: string) => stderr.split('\n').filter(line => !/^\[omg-hook\] \w+ (dispatch|daemon): /.test(line)).join('\n');

  it.each(groups.map(group => [`${group.event}#${group.index}`, group] as const))('%s', async (_label, { event, scripts }) => {
    const cold = project('cold');
    const coldRun = await run(cold, event, scripts, {});

    const warm = project('warm');
    // Start the daemon with a request that writes nothing: git-guardrails switched off.
    const guardrails = join(REPO_ROOT, 'scripts', 'git-guardrails.mjs');
    await run(warm, 'PreToolUse', [guardrails], { ...WARM, OMC_GIT_GUARDRAILS: '0' });
    expect(await waitFor(() => metas(warm.home).some(meta => pidAlive(meta.pid)), 15_000)).toBe(true);
    const warmRun = await run(warm, event, scripts, WARM);

    expect(warmRun.stderr).toContain('daemon: served by pid');
    expect(warmRun.status, warmRun.stderr).toBe(coldRun.status);
    expect(warmRun.stdout).toBe(coldRun.stdout);
    expect(scrubDebug(warmRun.stderr)).toBe(scrubDebug(coldRun.stderr));
    expect(warm.files()).toEqual(cold.files());
  }, 120_000);
});

describe('daemon-safe list', () => {
  const developers = readFileSync(join(REPO_ROOT, 'docs', 'DEVELOPERS.md'), 'utf8');
  const section = developers.slice(developers.indexOf('### Daemon safety'));
  const rows = [...section.matchAll(/^\| `([a-z-]+\.mjs)` \| (yes|no)\b/gm)].map(match => [match[1], match[2]] as const);
  const manifestScripts = new Set([...readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8')
    .matchAll(/\/scripts\/([a-z-]+\.mjs)"/g)].map(match => match[1]));

  it('the DEVELOPERS.md table lists every Copilot hook once', () => {
    expect(rows.map(([name]) => name).sort()).toEqual([...manifestScripts].sort());
  });

  it('the table and DAEMON_SAFE_HOOKS agree', () => {
    expect(rows.filter(([, safe]) => safe === 'yes').map(([name]) => name).sort())
      .toEqual([...daemonModule.DAEMON_SAFE_HOOKS.keys()].sort());
  });
});
