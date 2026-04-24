import { describe, expect, it } from 'vitest';
import {
  formatOmcCliInvocation,
  resolveOmcCliPrefix,
  rewriteOmcCliInvocations,
} from '../utils/omc-cli-rendering.js';

describe('omcp CLI rendering', () => {
  it('uses omcp when the binary is available', () => {
    expect(resolveOmcCliPrefix({ omcAvailable: true, env: {} as NodeJS.ProcessEnv })).toBe('omcp');
    expect(formatOmcCliInvocation('team api claim-task', { omcAvailable: true, env: {} as NodeJS.ProcessEnv }))
      .toBe('omcp team api claim-task');
  });

  it('falls back to the plugin bridge when omcp is unavailable but CLAUDE_PLUGIN_ROOT is set', () => {
    const env = { CLAUDE_PLUGIN_ROOT: '/tmp/plugin-root' } as NodeJS.ProcessEnv;
    expect(resolveOmcCliPrefix({ omcAvailable: false, env }))
      .toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs');
    expect(formatOmcCliInvocation('autoresearch --mission "m"', { omcAvailable: false, env }))
      .toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch --mission "m"');
  });

  it('rewrites inline and list-form omc commands for plugin installs', () => {
    const env = { CLAUDE_PLUGIN_ROOT: '/tmp/plugin-root' } as NodeJS.ProcessEnv;
    const input = [
      'Run `omc autoresearch --mission "m" --eval "e"`.',
      '- omc team api claim-task --input \'{}\' --json',
      '> omc ask codex --agent-prompt critic "check"',
    ].join('\n');

    const output = rewriteOmcCliInvocations(input, { omcAvailable: false, env });

    expect(output).toContain('`node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch --mission "m" --eval "e"`');
    expect(output).toContain('- node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs team api claim-task --input \'{}\' --json');
    expect(output).toContain('> node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask codex --agent-prompt critic "check"');
  });

  it('routes ask invocations through the plugin bridge inside an active Claude session when CLAUDE_PLUGIN_ROOT is set', () => {
    // Previously, ask flows were pinned to the omcp binary inside a Claude session
    // to avoid nested bridge launches. That guard broke /ccg ask routing whenever
    // PATH lacked omcp (fresh shells, CI, workspace setups) — the intended prefix
    // fell through to a binary that did not exist. The standard resolution path
    // already prefers omcp when available and falls back to the plugin bridge
    // otherwise, so the guard is removed and ask flows follow the same rules.
    const env = {
      CLAUDE_PLUGIN_ROOT: '/tmp/plugin-root',
      CLAUDECODE: '1',
      CLAUDE_SESSION_ID: 'session-123',
    } as NodeJS.ProcessEnv;

    expect(resolveOmcCliPrefix({ omcAvailable: false, env })).toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs');
    expect(formatOmcCliInvocation('ask codex --prompt "check"', { omcAvailable: false, env }))
      .toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask codex --prompt "check"');

    const input = [
      'Run `omc ask codex "review"`.',
      '> omc ask gemini --prompt "improve docs"',
    ].join('\n');

    const output = rewriteOmcCliInvocations(input, { omcAvailable: false, env });
    expect(output).toContain('`node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask codex "review"`');
    expect(output).toContain('> node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask gemini --prompt "improve docs"');
  });

  it('rewrites omc to omcp when the binary is available', () => {
    const input = 'Use `omc team status demo` and\nomc team wait demo';
    const expected = 'Use `omcp team status demo` and\nomcp team wait demo';
    expect(rewriteOmcCliInvocations(input, { omcAvailable: true, env: {} as NodeJS.ProcessEnv })).toBe(expected);
  });
});
