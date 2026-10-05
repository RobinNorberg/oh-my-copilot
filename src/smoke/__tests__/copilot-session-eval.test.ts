import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectHookRuns,
  evaluateAdapterErrors,
  evaluateEventsLog,
  evaluateHooks,
  evaluateMcpLoaded,
  evaluatePluginsLoaded,
  evaluateSessionExit,
  evaluateStateWritten,
  evaluateSubagent,
  excerpt,
  parseJsonl,
} from '../copilot-session-eval.js';
import { evaluateTier1 } from '../copilot-smoke.js';

// Captured from real Copilot CLI 1.0.91 runs of `omg smoke copilot --tier 1`
// (default prompt and --delegate), redacted: paths -> <HOME>, login -> <USER>.
const FIXTURES = join(__dirname, 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

const tempDirs: string[] = [];
function tempProject(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-eval-'));
  tempDirs.push(dir);
  if (withMarker) {
    const sessionDir = join(dir, '.omg', 'state', 'sessions', 'b9b765ff-8271-4099-85e3-9afa9161ab77');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session-started.json'), '{}');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('parseJsonl', () => {
  it('parses the captured events log with no bad lines', () => {
    const { events, bad } = parseJsonl(fixture('tier1-events.jsonl'));
    expect(bad).toBe(0);
    expect(events[0].type).toBe('session.start');
    expect(events.at(-1)?.type).toBe('session.shutdown');
  });

  it('counts non-JSON and non-object lines instead of throwing', () => {
    const { events, bad, badSample } = parseJsonl('{"type":"a"}\nnot json\n[1]\n\n');
    expect(events).toHaveLength(1);
    expect(bad).toBe(2);
    expect(badSample).toBe('not json');
  });
});

describe('evaluateSessionExit', () => {
  const base = { exitCode: 0, timedOut: false, stderr: '', timeoutMs: 1000 };

  it('passes on the captured stdout (assistant.message content SMOKE_OK)', () => {
    const check = evaluateSessionExit({ ...base, stdout: fixture('tier1-stdout.jsonl') });
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/JSONL events/);
  });

  it('does not count the echoed prompt (user.message) as the answer', () => {
    const stdout = [
      JSON.stringify({ type: 'user.message', data: { content: 'Reply with exactly: SMOKE_OK.' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'Sure.' } }),
    ].join('\n');
    const check = evaluateSessionExit({ ...base, stdout });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/SMOKE_OK missing/);
  });

  it('falls back to raw text when stdout is not JSONL', () => {
    expect(evaluateSessionExit({ ...base, stdout: 'SMOKE_OK\n' }).ok).toBe(true);
  });

  it('fails on non-zero exit and hints when the CLI rejected --model', () => {
    const check = evaluateSessionExit({ ...base, exitCode: 1, stdout: '', stderr: 'Error: Model "x" from --model flag is not available.' });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/omit it/);
    expect(check.evidence).toContain('not available');
  });

  it('reports timeouts', () => {
    const check = evaluateSessionExit({ ...base, exitCode: null, timedOut: true, stdout: '' });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/timed out after 1000 ms/);
  });
});

describe('evaluateEventsLog', () => {
  it('fails when the file is missing', () => {
    expect(evaluateEventsLog('/x/events.jsonl', null).check).toMatchObject({ id: 'session.events', ok: false });
  });

  it('fails with evidence on an unparseable line', () => {
    const { check } = evaluateEventsLog('/x', '{"type":"a"}\n{broken');
    expect(check.ok).toBe(false);
    expect(check.evidence).toBe('{broken');
  });
});

describe('evaluateHooks', () => {
  it('passes every lifecycle hook on the captured default run; tool hooks are n/a', () => {
    const { events } = parseJsonl(fixture('tier1-events.jsonl'));
    const checks = evaluateHooks(events);
    expect(checks.map((c) => c.id)).toEqual([
      'hooks.sessionStart', 'hooks.userPromptSubmitted', 'hooks.agentStop', 'hooks.sessionEnd',
      'hooks.preToolUse', 'hooks.postToolUse',
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.id === 'hooks.preToolUse')?.detail).toBe('n/a (no tool use)');
  });

  it('asserts tool hooks when the captured delegate run used a tool', () => {
    const { events } = parseJsonl(fixture('tier1-delegate-events.jsonl'));
    const checks = evaluateHooks(events);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.id === 'hooks.preToolUse')?.detail).toMatch(/1 start/);
  });

  it('fails a hook whose hook.end reports success=false', () => {
    const events = [
      { type: 'hook.start', data: { hookInvocationId: 'a', hookType: 'sessionStart' } },
      { type: 'hook.end', data: { hookInvocationId: 'a', hookType: 'sessionStart', success: false, error: 'boom' } },
    ];
    const check = evaluateHooks(events).find((c) => c.id === 'hooks.sessionStart')!;
    expect(check.ok).toBe(false);
    expect(check.evidence).toContain('boom');
  });

  it('fails a missing required hook and a tool hook missing despite tool use', () => {
    const checks = evaluateHooks([{ type: 'tool.execution_start', data: {} }]);
    expect(checks.find((c) => c.id === 'hooks.sessionEnd')?.ok).toBe(false);
    expect(checks.find((c) => c.id === 'hooks.preToolUse')?.ok).toBe(false);
  });

  it('fails a hook whose hook.end carries no success flag (null/undefined is not success)', () => {
    // Variant of the captured default run: the sessionStart hook.end lost `success`.
    const { events } = parseJsonl(fixture('tier1-events.jsonl'));
    const variant = events.map((e) => (e.type === 'hook.end' && e.data?.hookType === 'sessionStart'
      ? { ...e, data: { ...e.data, success: undefined } }
      : e));
    const check = evaluateHooks(variant).find((c) => c.id === 'hooks.sessionStart')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('1 start(s), 1 end(s), 1 without success:true');
    expect(check.evidence).toBe('success=null');
  });

  it('pairs a hook.end without hookType through hookInvocationId', () => {
    const runs = collectHookRuns([
      { type: 'hook.start', data: { hookInvocationId: 'x', hookType: 'agentStop' } },
      { type: 'hook.end', data: { hookInvocationId: 'x', success: true } },
    ]);
    expect(runs).toEqual([{ hookType: 'agentStop', ended: true, success: true }]);
  });
});

describe('evaluateAdapterErrors', () => {
  // The adapter's fail-open line (scripts/lib/copilot-hook-adapter.cjs transform()).
  const FAIL_OPEN = '[omg-hook] SessionStart internal error: session-start.mjs exited 1; failing open';

  it('passes on the captured debug log and stdout', () => {
    const check = evaluateAdapterErrors([
      { name: 'debug log', text: fixture('tier1-debug-excerpt.log') },
      { name: 'stdout', text: fixture('tier1-stdout.jsonl') },
      { name: 'session stderr', text: '' },
    ]);
    expect(check).toMatchObject({ id: 'hooks.adapter_errors', ok: true, detail: 'no [omg-hook] error lines in debug log, stdout' });
  });

  it('fails on a fail-open line even though Copilot recorded hook.end success:true', () => {
    // Fail-open variant: every hook.end still says success:true, so only the stderr line betrays it.
    const { events } = parseJsonl(fixture('tier1-events.jsonl'));
    expect(evaluateHooks(events).every((c) => c.ok)).toBe(true);
    const check = evaluateAdapterErrors([
      { name: 'debug log', text: `${fixture('tier1-debug-excerpt.log')}\n2026-10-05T09:53:17.000Z [DEBUG] hook stderr: ${FAIL_OPEN}` },
    ]);
    expect(check.ok).toBe(false);
    expect(check.evidence).toContain('failing open');
  });

  it('flags adapter errors and missing targets but ignores the informational notes', () => {
    expect(evaluateAdapterErrors([{ name: 'session stderr', text: '[omg-hook] Stop adapter error: boom' }]).ok).toBe(false);
    expect(evaluateAdapterErrors([{ name: 'session stderr', text: '[omg-hook] PreToolUse: hook target is not a file: x' }]).ok).toBe(false);
    expect(evaluateAdapterErrors([{
      name: 'session stderr',
      text: '[omg-hook] Stop: continue:false overrides decision:block; allowing stop\n'
        + '[omg-hook] PreToolUse: dropped hookSpecificOutput.updatedInput (not portable to Copilot tool args)',
    }]).ok).toBe(true);
  });
});

describe('evaluatePluginsLoaded', () => {
  it('passes on the captured debug log excerpt', () => {
    const check = evaluatePluginsLoaded(fixture('tier1-debug-excerpt.log'));
    expect(check.ok).toBe(true);
    expect(check.evidence).toContain('Plugins loaded: ["oh-my-copilot"]');
  });

  it('fails without a log or without our plugin', () => {
    expect(evaluatePluginsLoaded(null).ok).toBe(false);
    expect(evaluatePluginsLoaded('Plugins loaded: ["other"]\nPlugin activation [agents]: loaded=0').ok).toBe(false);
  });

  it('requires the exact plugin name, not a substring', () => {
    const activation = 'Plugin activation [agents]: fingerprint=legacy, plugins=1, loaded=3';
    expect(evaluatePluginsLoaded(`Plugins loaded: ["oh-my-copilot-fork"]\n${activation}`).ok).toBe(false);
    expect(evaluatePluginsLoaded(`Plugins loaded: ["x","oh-my-copilot"]\n${activation}`).ok).toBe(true);
  });
});

describe('evaluateMcpLoaded', () => {
  it('uses session.mcp_servers_loaded from the captured stdout', () => {
    const { events } = parseJsonl(fixture('tier1-stdout.jsonl'));
    const check = evaluateMcpLoaded(events, null, ['t']);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/session\.mcp_servers_loaded/);
  });

  it('falls back to the MCP stderr tag in the captured debug log', () => {
    const check = evaluateMcpLoaded([], fixture('tier1-debug-excerpt.log'), ['t']);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/debug log/);
  });

  it('fails when neither source names the server', () => {
    expect(evaluateMcpLoaded([], 'nothing here', ['t']).ok).toBe(false);
  });
});

describe('evaluateStateWritten', () => {
  it('passes when SessionStart wrote the session marker', () => {
    const check = evaluateStateWritten(tempProject(true));
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('.omg/state/sessions/b9b765ff-8271-4099-85e3-9afa9161ab77/session-started.json');
  });

  it('fails when .omg is absent or lacks the marker', () => {
    expect(evaluateStateWritten(tempProject(false)).ok).toBe(false);
    const dir = tempProject(false);
    mkdirSync(join(dir, '.omg'));
    writeFileSync(join(dir, '.omg', 'other.json'), '{}');
    const check = evaluateStateWritten(dir);
    expect(check.ok).toBe(false);
    expect(check.evidence).toContain('.omg/other.json');
  });
});

describe('evaluateSubagent', () => {
  it('prefers subagent.selected in the captured delegate run', () => {
    const { events } = parseJsonl(fixture('tier1-delegate-events.jsonl'));
    const check = evaluateSubagent(events, 'oh-my-copilot:architect');
    expect(check).toMatchObject({ ok: true, detail: 'subagent.selected oh-my-copilot:architect' });
  });

  it('fails on the default run (no delegation)', () => {
    const { events } = parseJsonl(fixture('tier1-events.jsonl'));
    expect(evaluateSubagent(events, 'oh-my-copilot:architect').ok).toBe(false);
  });
});

describe('evaluateTier1 over captured fixtures', () => {
  it('passes every Tier 1 check for the default and delegate runs', () => {
    for (const [prefix, delegate] of [['tier1', false], ['tier1-delegate', true]] as const) {
      const checks = evaluateTier1({
        exitCode: 0,
        timedOut: false,
        stdout: fixture(`${prefix}-stdout.jsonl`),
        stderr: '',
        timeoutMs: 180_000,
        eventsPath: 'events.jsonl',
        eventsText: fixture(`${prefix}-events.jsonl`),
        logText: fixture(`${prefix}-debug-excerpt.log`),
        projectDir: tempProject(true),
        mcpServerNames: ['t'],
        delegate,
      });
      expect(checks.filter((c) => !c.ok)).toEqual([]);
      expect(checks.some((c) => c.id === 'subagent.selected')).toBe(delegate);
    }
  });

  it('fails hooks.adapter_errors when a hook failed open into the session stderr', () => {
    const checks = evaluateTier1({
      exitCode: 0,
      timedOut: false,
      stdout: fixture('tier1-stdout.jsonl'),
      stderr: '[omg-hook] UserPromptSubmit internal error: keyword-detector.mjs exited 1; failing open\n',
      timeoutMs: 180_000,
      eventsPath: 'events.jsonl',
      eventsText: fixture('tier1-events.jsonl'),
      logText: fixture('tier1-debug-excerpt.log'),
      projectDir: tempProject(true),
      mcpServerNames: ['t'],
      delegate: false,
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['hooks.adapter_errors']);
  });
});

describe('excerpt', () => {
  it('caps evidence at 400 chars', () => {
    expect(excerpt('x'.repeat(1000))).toHaveLength(400);
    expect(excerpt(null)).toBe('');
  });
});
