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

  it('keeps omc ask invocations inside an active Claude session to avoid nested bridge launches', () => {
    const env = {
      CLAUDE_PLUGIN_ROOT: '/tmp/plugin-root',
      CLAUDECODE: '1',
      CLAUDE_SESSION_ID: 'session-123',
    } as NodeJS.ProcessEnv;

    expect(resolveOmcCliPrefix({ omcAvailable: true, env })).toBe('omcp');
    expect(formatOmcCliInvocation('ask codex --prompt "check"', { omcAvailable: true, env }))
      .toBe('omcp ask codex --prompt "check"');

    const input = [
      'Run `omc ask codex "review"`.',
      '> omc ask gemini --prompt "improve docs"',
    ].join('\n');

    // ask commands stay on omcp (not rewritten to bridge), preserving the CLI binary name
    const expected = [
      'Run `omcp ask codex "review"`.',
      '> omcp ask gemini --prompt "improve docs"',
    ].join('\n');
    expect(rewriteOmcCliInvocations(input, { omcAvailable: true, env })).toBe(expected);
  });

  it('rewrites omc to omcp when the binary is available', () => {
    const input = 'Use `omc team status demo` and\nomc team wait demo';
    const expected = 'Use `omcp team status demo` and\nomcp team wait demo';
    expect(rewriteOmcCliInvocations(input, { omcAvailable: true, env: {} as NodeJS.ProcessEnv })).toBe(expected);
  });
});
