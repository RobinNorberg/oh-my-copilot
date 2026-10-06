import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Fork (oh-my-copilot): scripts/copilot/dispatch.cjs runs every hook of one
 * (event, matcher) group of hooks/hooks.json in a single process and merges
 * the adapted outputs. These tests pin the argv encoding, the merge rules per
 * event, the exit-code precedence, the OMC_COPILOT_HOOK_DISPATCH=0 kill switch,
 * and output parity with the old one-process-per-hook path on real hooks.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DISPATCH = join(REPO_ROOT, 'scripts', 'copilot', 'dispatch.cjs');
const ADAPTER = join(REPO_ROOT, 'scripts', 'lib', 'copilot-hook-adapter.cjs');
const RUN_CJS = join(REPO_ROOT, 'scripts', 'run.cjs');
const PROBE = join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'copilot-hook-dispatch', 'probe.mjs');

type HookResult = { script: string; stdout: string; exitCode: number };
type Merged = { stdout: string; exitCode: number; stderr: string };
const dispatcher = createRequire(import.meta.url)(DISPATCH) as {
  HOOK_SEPARATOR: string;
  parseDispatchArgv(argv: string[]): { event: string; hooks: Array<{ script: string; args: string[] }> };
  encodeDispatchArgv(event: string, hooks: Array<{ script: string; args?: string[] }>): string[];
  mergeExitCodes(codes: number[]): number;
  mergeHookResults(event: string, results: HookResult[]): Merged;
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Process env without host or test switches that would change routing. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OMC_HOOK_EVENT', 'OMC_HOOK_FAIL_CLOSED', 'OMC_HOOK_STRICT', 'OMC_COPILOT_HOOK_WORKER', 'OMC_COPILOT_HOOK_DISPATCH',
    'OMC_SESSION_OWNER_PID', 'OMC_DEBUG_HOOKS', 'OMC_DEBUG', 'NODE_ENV', 'OMC_STATE_DIR', 'OMC_SESSION_END_BUDGET_MS',
  ]) delete env[key];
  return { ...env, ...extra };
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const hook = (script: string, value: unknown, exitCode = 0): HookResult => ({
  script: `/p/scripts/${script}`,
  stdout: value === '' ? '' : typeof value === 'string' ? value : json(value),
  exitCode,
});

describe('dispatch argv encoding', () => {
  it.each([
    ['one hook', 'PreToolUse', [{ script: '/r/scripts/pre-tool-enforcer.mjs', args: [] }]],
    ['hooks with extra args', 'SubagentStop', [
      { script: '/r/scripts/subagent-tracker.mjs', args: ['stop'] },
      { script: '/r/scripts/verify-deliverables.mjs', args: [] },
    ]],
    ['paths with spaces and a dash arg', 'Stop', [
      { script: 'C:/Program Files/omg/scripts/a.mjs', args: ['-x', '--flag'] },
      { script: 'C:/Program Files/omg/scripts/b.mjs', args: [] },
      { script: '/c.mjs', args: ['start'] },
    ]],
  ])('round-trips %s', (_label, event, hooks) => {
    const argv = dispatcher.encodeDispatchArgv(event, hooks);
    expect(argv[0]).toBe(event);
    expect(argv.filter(arg => arg === dispatcher.HOOK_SEPARATOR)).toHaveLength(hooks.length - 1);
    expect(dispatcher.parseDispatchArgv(argv)).toEqual({ event, hooks });
  });

  it.each([
    [[]],
    [['stop']],
    [['Stop']],
    [['Stop', '--']],
    [['Stop', '--', '/a.mjs']],
    [['Stop', '/a.mjs', '--']],
    [['Stop', '/a.mjs', '--', '--', '/b.mjs']],
  ])('rejects malformed argv %j', (argv) => {
    expect(() => dispatcher.parseDispatchArgv(argv)).toThrow();
  });

  it('refuses to encode an argument it could not decode', () => {
    expect(() => dispatcher.encodeDispatchArgv('Stop', [{ script: '/a.mjs', args: ['--'] }])).toThrow();
    expect(() => dispatcher.encodeDispatchArgv('Stop', [{ script: '' }])).toThrow();
    expect(() => dispatcher.encodeDispatchArgv('Stop', [])).toThrow();
  });
});

describe('dispatch exit-code precedence', () => {
  it.each([
    [[], 0],
    [[0, 0, 0], 0],
    [[0, 2, 0], 2],
    [[1, 2], 2],
    [[2, 124, 1], 124],
    [[130, 124], 124],
    [[130, 1], 130],
  ])('%j -> %i', (codes, expected) => {
    expect(dispatcher.mergeExitCodes(codes)).toBe(expected);
  });
});

describe('dispatch merge rules', () => {
  it('passes a single non-empty output through byte for byte', () => {
    const raw = '{ "continue": true,  "suppressOutput": true }\n';
    const merged = dispatcher.mergeHookResults('Stop', [hook('a.mjs', ''), hook('b.mjs', raw), hook('c.mjs', '')]);
    expect(merged).toEqual({ stdout: raw, exitCode: 0, stderr: '' });
  });

  it('returns empty stdout when no hook printed anything', () => {
    expect(dispatcher.mergeHookResults('Stop', [hook('a.mjs', ''), hook('b.mjs', '')]).stdout).toBe('');
  });

  it('joins additionalContext (top level and hookSpecificOutput) in hook order', () => {
    const merged = dispatcher.mergeHookResults('SessionStart', [
      hook('a.mjs', { continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'one' }, additionalContext: 'one' }),
      hook('b.mjs', { continue: true, suppressOutput: true }),
      hook('c.mjs', { continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'two' }, additionalContext: 'two' }),
    ]);
    expect(JSON.parse(merged.stdout)).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'one\ntwo' },
      additionalContext: 'one\ntwo',
    });
    expect(merged.exitCode).toBe(0);
  });

  it('joins systemMessage and keeps suppressOutput only when every output sets it', () => {
    const quiet = dispatcher.mergeHookResults('UserPromptSubmit', [
      hook('a.mjs', { continue: true, suppressOutput: true }),
      hook('b.mjs', { continue: true, suppressOutput: true }),
    ]);
    expect(quiet.stdout).toBe(json({ continue: true, suppressOutput: true }));
    const loud = dispatcher.mergeHookResults('PreCompact', [
      hook('a.mjs', { continue: true, systemMessage: 'first' }),
      hook('b.mjs', { continue: true, suppressOutput: true, systemMessage: 'second' }),
    ]);
    expect(JSON.parse(loud.stdout)).toEqual({ continue: true, systemMessage: 'first\nsecond' });
  });

  it('PreToolUse: any deny wins and keeps the first deny reason', () => {
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    });
    const allow = {
      continue: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fine', additionalContext: 'ctx' },
      permissionDecision: 'allow',
      permissionDecisionReason: 'fine',
      additionalContext: 'ctx',
    };
    const merged = JSON.parse(dispatcher.mergeHookResults('PreToolUse', [
      hook('a.mjs', allow), hook('b.mjs', deny('first no')), hook('c.mjs', deny('second no')),
    ]).stdout);
    expect(merged.permissionDecision).toBe('deny');
    expect(merged.permissionDecisionReason).toBe('first no');
    expect(merged.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'first no', additionalContext: 'ctx' });
    expect(merged.additionalContext).toBe('ctx');
    const allowed = JSON.parse(dispatcher.mergeHookResults('PreToolUse', [hook('a.mjs', allow), hook('b.mjs', { continue: true })]).stdout);
    expect(allowed.permissionDecision).toBe('allow');
  });

  it.each(['Stop', 'SubagentStop'])('%s: the first decision:block wins with its reason', (event) => {
    const merged = dispatcher.mergeHookResults(event, [
      hook('a.mjs', { continue: true, suppressOutput: true }),
      hook('b.mjs', { decision: 'block', reason: 'keep going' }),
      hook('c.mjs', { decision: 'block', reason: 'later reason' }),
      hook('d.mjs', { continue: true }),
    ]);
    expect(JSON.parse(merged.stdout)).toEqual({ continue: true, decision: 'block', reason: 'keep going' });
  });

  it('Stop: continue:false from one hook and decision:block from another still allows the stop', () => {
    const merged = dispatcher.mergeHookResults('Stop', [
      hook('a.mjs', { decision: 'block', reason: 'keep going' }),
      hook('b.mjs', { continue: false, stopReason: 'context full' }),
    ]);
    expect(merged.stdout).toBe('{}\n');
    expect(merged.stderr).toContain('continue:false overrides decision:block; allowing stop: context full');
  });

  it('continue:false wins with its own stopReason on other events', () => {
    const merged = dispatcher.mergeHookResults('UserPromptSubmit', [
      hook('a.mjs', { continue: true, stopReason: 'unused' }),
      hook('b.mjs', { continue: false, stopReason: 'halt' }),
    ]);
    expect(JSON.parse(merged.stdout)).toEqual({ continue: false, stopReason: 'halt' });
  });

  it('PermissionRequest: exit 2 is kept', () => {
    const merged = dispatcher.mergeHookResults('PermissionRequest', [hook('a.mjs', '', 2), hook('b.mjs', { continue: true })]);
    expect(merged.exitCode).toBe(2);
    expect(merged.stdout).toBe(json({ continue: true }));
  });

  it('drops non-JSON stdout next to JSON output, and concatenates all-raw output', () => {
    const mixed = dispatcher.mergeHookResults('Stop', [
      hook('a.mjs', 'plain text'), hook('b.mjs', { continue: true }), hook('c.mjs', { continue: true }),
    ]);
    expect(mixed.stdout).toBe(json({ continue: true }));
    expect(mixed.stderr).toContain('dropped non-JSON stdout of a.mjs');
    expect(dispatcher.mergeHookResults('Stop', [hook('a.mjs', 'one'), hook('b.mjs', 'two\n')]).stdout).toBe('one\ntwo\n');
  });

  it('keeps the first value of any other key', () => {
    const merged = dispatcher.mergeHookResults('SubagentStart', [
      hook('a.mjs', { continue: true, extra: 1, hookSpecificOutput: { hookEventName: 'SubagentStart', agent_count: 1 } }),
      hook('b.mjs', { continue: true, extra: 2, hookSpecificOutput: { hookEventName: 'SubagentStart', agent_count: 9 } }),
    ]);
    expect(JSON.parse(merged.stdout)).toEqual({ continue: true, extra: 1, hookSpecificOutput: { hookEventName: 'SubagentStart', agent_count: 1 } });
  });
});

/**
 * A temp plugin: the probe under audited script names, plus a hooks/hooks.json
 * that gives each one its event and timeout. `not-audited.mjs` (1s) stays on
 * the supervised child path; the 5s audited names run in a Worker.
 */
function probePlugin(): string {
  const root = tempDir('omg-dispatch-plugin-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
  for (const name of ['context-guard-stop.mjs', 'budget-guard.mjs', 'persistent-mode.mjs', 'not-audited.mjs', 'subagent-tracker.mjs', 'pre-tool-enforcer.mjs']) {
    copyFileSync(PROBE, join(root, 'scripts', name));
  }
  const command = (script: string) => `node "\${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "\${CLAUDE_PLUGIN_ROOT}"/scripts/${script}`;
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{ matcher: '*', hooks: [
        { type: 'command', command: command('context-guard-stop.mjs'), timeout: 5 },
        { type: 'command', command: command('not-audited.mjs'), timeout: 1 },
        { type: 'command', command: command('budget-guard.mjs'), timeout: 5 },
        { type: 'command', command: command('persistent-mode.mjs'), timeout: 5 },
      ] }],
      SubagentStart: [{ matcher: '*', hooks: [{ type: 'command', command: `${command('subagent-tracker.mjs')} start`, timeout: 5 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('pre-tool-enforcer.mjs'), timeout: 5 }] }],
    },
  }));
  return root;
}

type Trace = { name: string; pid: number; isMainThread: boolean; argv: string[]; marker: string | null; owner: string | null; event: string | null };

function runDispatch(root: string, event: string, scripts: string[][], payload: Record<string, unknown>, extra: Record<string, string> = {}) {
  const trace = join(tempDir('omg-dispatch-trace-'), 'trace.jsonl');
  const hooks = scripts.map(([script, ...args]) => ({ script: join(root, 'scripts', script), args }));
  const result = spawnSync(process.execPath, ['--require', ADAPTER, DISPATCH, ...dispatcher.encodeDispatchArgv(event, hooks)], {
    encoding: 'utf8',
    env: cleanEnv({ CLAUDE_PLUGIN_ROOT: root, OMC_HOOK_EVENT: event, ...extra }),
    input: JSON.stringify({ ...payload, trace }),
    timeout: 60_000,
    windowsHide: true,
  });
  const traces: Trace[] = existsSync(trace)
    ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace)
    : [];
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', traces, pid: result.pid };
}

const STOP_SCRIPTS = [['context-guard-stop.mjs'], ['not-audited.mjs'], ['budget-guard.mjs'], ['persistent-mode.mjs']];

describe('dispatch.cjs end to end (probe plugin)', () => {
  it('runs every hook in order with the same stdin and merges the adapted outputs', () => {
    const root = probePlugin();
    const result = runDispatch(root, 'Stop', STOP_SCRIPTS, {
      marker: 'stdin-ok',
      hooks: {
        'context-guard-stop.mjs': { stdout: { continue: true, suppressOutput: true } },
        // Claude-shaped exit 2: the adapter turns it into decision:block per hook.
        'not-audited.mjs': { exitCode: 2, stderr: 'from stderr\n' },
        'budget-guard.mjs': { stdout: { decision: 'block', reason: 'second block' } },
        'persistent-mode.mjs': { stdout: { continue: true } },
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true, decision: 'block', reason: 'from stderr' });
    expect(result.traces.map(t => t.name)).toEqual(STOP_SCRIPTS.map(([script]) => script));
    expect(result.traces.every(t => t.marker === 'stdin-ok' && t.event === 'Stop')).toBe(true);
    // Worker hooks share the dispatcher process; the <=3s hook ran as a supervised child.
    const byName = Object.fromEntries(result.traces.map(t => [t.name, t]));
    expect(byName['context-guard-stop.mjs'].isMainThread).toBe(false);
    expect(byName['budget-guard.mjs'].pid).toBe(byName['context-guard-stop.mjs'].pid);
    expect(byName['not-audited.mjs'].isMainThread).toBe(true);
    expect(byName['not-audited.mjs'].pid).not.toBe(byName['context-guard-stop.mjs'].pid);
    expect(result.stderr).toContain('from stderr');
  }, 60_000);

  it('passes extra script args into the hook argv', () => {
    const root = probePlugin();
    const result = runDispatch(root, 'SubagentStart', [['subagent-tracker.mjs', 'start']], {
      hooks: { 'subagent-tracker.mjs': { stdout: { continue: true } } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({ isMainThread: false, argv: ['start'] });
  });

  it('fails open by default: a non-zero hook becomes 0 with an [omg-hook] line, later hooks still run', () => {
    const root = probePlugin();
    const result = runDispatch(root, 'Stop', STOP_SCRIPTS, {
      hooks: { 'context-guard-stop.mjs': { exitCode: 7 }, 'persistent-mode.mjs': { stdout: { continue: true } } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('[omg-hook] Stop internal error: context-guard-stop.mjs exited 7; failing open');
    expect(result.traces).toHaveLength(STOP_SCRIPTS.length);
    expect(result.stdout).toBe(json({ continue: true }));
  }, 60_000);

  it('under OMC_HOOK_FAIL_CLOSED=1 exits with the worst code, 124 (timeout) above all', () => {
    const root = probePlugin();
    const worst = runDispatch(root, 'Stop', STOP_SCRIPTS, {
      hooks: { 'context-guard-stop.mjs': { exitCode: 7 }, 'budget-guard.mjs': { exitCode: 3 } },
    }, { OMC_HOOK_FAIL_CLOSED: '1' });
    expect(worst.status, worst.stderr).toBe(7);

    const timedOut = runDispatch(root, 'Stop', STOP_SCRIPTS, {
      hooks: {
        'context-guard-stop.mjs': { exitCode: 7 },
        'not-audited.mjs': { hang: true },
        'persistent-mode.mjs': { stdout: { decision: 'block', reason: 'after the timeout' } },
      },
    }, { OMC_HOOK_FAIL_CLOSED: '1' });
    expect(timedOut.status, timedOut.stderr).toBe(124);
    expect(timedOut.stderr).toMatch(/\[run\.cjs\] Hook not-audited\.mjs timed out after \d+ms; exiting fail-closed \(124\)/);
    // The hook after the timeout still ran and its block still reaches the host.
    expect(JSON.parse(timedOut.stdout)).toEqual({ decision: 'block', reason: 'after the timeout' });

    const open = runDispatch(root, 'Stop', STOP_SCRIPTS, { hooks: { 'not-audited.mjs': { hang: true } } });
    expect(open.status, open.stderr).toBe(0);
    expect(open.stderr).toContain('exiting fail-open');
  }, 60_000);

  it('PreToolUse: a deny from the adapter-shaped exit 2 reaches the host as a deny', () => {
    const root = probePlugin();
    const result = runDispatch(root, 'PreToolUse', [['pre-tool-enforcer.mjs']], {
      hooks: { 'pre-tool-enforcer.mjs': { exitCode: 2, stderr: 'not allowed' } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'not allowed' });
  });

  it('skips a directory target with the adapter note and still runs the others', () => {
    const root = probePlugin();
    mkdirSync(join(root, 'scripts', 'dir.mjs'));
    const result = runDispatch(root, 'Stop', [['dir.mjs'], ['persistent-mode.mjs']], {
      hooks: { 'persistent-mode.mjs': { stdout: { continue: true } } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('[omg-hook] Stop: hook target is not a file:');
    expect(result.traces.map(t => t.name)).toEqual(['persistent-mode.mjs']);
  });

  it('a malformed argv fails open, or 1 under OMC_HOOK_FAIL_CLOSED=1', () => {
    for (const [extra, status] of [[{}, 0], [{ OMC_HOOK_FAIL_CLOSED: '1' }, 1]] as const) {
      const result = spawnSync(process.execPath, ['--require', ADAPTER, DISPATCH, 'Stop'], {
        encoding: 'utf8', env: cleanEnv({ OMC_HOOK_EVENT: 'Stop', ...extra }), input: '{}', timeout: 30_000, windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).toContain('[omg-hook] dispatch: no hook scripts');
      expect(result.stdout).toBe('');
    }
  });

  it('OMC_COPILOT_HOOK_DISPATCH=0 runs one process per hook and merges to the same output', () => {
    const root = probePlugin();
    const payload = {
      marker: 'stdin-ok',
      hooks: {
        'context-guard-stop.mjs': { stdout: { continue: true, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'a' } } },
        'not-audited.mjs': { stdout: { continue: true, suppressOutput: true } },
        'budget-guard.mjs': { stdout: { decision: 'block', reason: 'first block' } },
        'persistent-mode.mjs': { exitCode: 2, stderr: 'second block' },
      },
    };
    const dispatched = runDispatch(root, 'Stop', STOP_SCRIPTS, payload);
    const perHook = runDispatch(root, 'Stop', STOP_SCRIPTS, payload, { OMC_COPILOT_HOOK_DISPATCH: '0' });
    // The session owner is the host (here: this test process), never the dispatcher.
    for (const trace of [...dispatched.traces, ...perHook.traces]) expect(trace.owner, trace.name).toBe(String(process.pid));
    expect(perHook.status, perHook.stderr).toBe(dispatched.status);
    expect(perHook.stdout).toBe(dispatched.stdout);
    expect(JSON.parse(perHook.stdout)).toMatchObject({ decision: 'block', reason: 'first block', additionalContext: 'a' });
    expect(perHook.traces.map(t => t.name)).toEqual(STOP_SCRIPTS.map(([script]) => script));
    expect(new Set(perHook.traces.map(t => t.pid)).size).toBe(STOP_SCRIPTS.length);
    expect(perHook.traces.every(t => t.marker === 'stdin-ok')).toBe(true);
    expect(new Set(dispatched.traces.map(t => t.pid)).size).toBeLessThan(STOP_SCRIPTS.length);
  }, 60_000);
});

/**
 * Real hooks, idle project: the dispatcher's stdout must equal what the old
 * per-hook entries (`node --require adapter run.cjs <script>`) print, merged
 * with the same rules, and the kill switch must print the same again. Each
 * variant runs in its own fresh git project with an isolated home.
 */
describe('stdout parity with the per-hook path (real hooks)', () => {
  const source = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  const scriptsOf = (event: string) => source.hooks[event][0].hooks.map(({ command }) => {
    const match = /\/scripts\/run\.cjs \S+\/scripts\/(\S+)((?: \S+)*)$/.exec(command.replace(/"/g, ''));
    return [join(REPO_ROOT, 'scripts', match![1]), ...match![2].split(' ').filter(Boolean)];
  });

  function project(tag: string) {
    const base = tempDir(`omg-dispatch-parity-${tag}-`);
    const cwd = join(base, 'p');
    const home = join(base, 'h');
    mkdirSync(cwd);
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
    writeFileSync(join(cwd, 'README.md'), 'x\n');
    const env = cleanEnv({ HOME: home, USERPROFILE: home, COPILOT_HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT });
    const normalise = (text: string) => text
      .split(cwd).join('<P>').split(cwd.replace(/\\/g, '\\\\')).join('<P>')
      .split(home).join('<H>').split(home.replace(/\\/g, '\\\\')).join('<H>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TS>');
    const files = () => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) { if (entry.name !== '.git') walk(path); } else {
            out.push(relative(base, path).replace(/\\/g, '/').replace(/\d{4}-\d\d-\d\dT[\d-]+Z/g, '<TS>'));
          }
        }
      };
      walk(base);
      return out.sort();
    };
    return { cwd, home, env, normalise, files };
  }

  function payload(event: string, cwd: string, home: string) {
    const value: Record<string, unknown> = {
      session_id: '11111111-2222-4333-8444-555555555555', cwd, hook_event_name: event, transcript_path: join(home, 'events.jsonl'),
    };
    if (event === 'SessionStart') value.source = 'startup';
    if (event === 'Stop') value.stop_hook_active = false;
    return JSON.stringify(value);
  }

  it.each(['Stop', 'SessionStart'])('%s', (event) => {
    const scripts = scriptsOf(event);

    const old = project('old');
    const perHook: HookResult[] = scripts.map(([script, ...args]) => {
      const result = spawnSync(process.execPath, ['--require', ADAPTER, RUN_CJS, script, ...args], {
        cwd: old.cwd, env: { ...old.env, OMC_HOOK_EVENT: event }, input: payload(event, old.cwd, old.home),
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      expect(result.status, `${basename(script)}: ${result.stderr}`).toBe(0);
      return { script, stdout: result.stdout || '', exitCode: result.status ?? 0 };
    });
    const expected = dispatcher.mergeHookResults(event, perHook);

    const runEntry = (tag: string, extra: Record<string, string>) => {
      const fresh = project(tag);
      const argv = dispatcher.encodeDispatchArgv(event, scripts.map(([script, ...args]) => ({ script, args })));
      const result = spawnSync(process.execPath, ['--require', ADAPTER, DISPATCH, ...argv], {
        cwd: fresh.cwd, env: { ...fresh.env, OMC_HOOK_EVENT: event, ...extra }, input: payload(event, fresh.cwd, fresh.home),
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      return { status: result.status, stdout: fresh.normalise(result.stdout || ''), stderr: result.stderr || '', files: fresh.files() };
    };
    const dispatched = runEntry('dispatch', {});
    const killSwitch = runEntry('killswitch', { OMC_COPILOT_HOOK_DISPATCH: '0' });

    expect(dispatched.status, dispatched.stderr).toBe(expected.exitCode);
    expect(dispatched.stdout).toBe(old.normalise(expected.stdout));
    expect(dispatched.stdout.length).toBeGreaterThan(0);
    expect(killSwitch.status, killSwitch.stderr).toBe(expected.exitCode);
    expect(killSwitch.stdout).toBe(dispatched.stdout);
    expect(dispatched.stderr).not.toMatch(/timed out|\[omg-hook\]/);
    // The same state files appear either way.
    expect(dispatched.files).toEqual(killSwitch.files);
    expect(dispatched.files).toEqual(old.files());
  }, 120_000);
});
