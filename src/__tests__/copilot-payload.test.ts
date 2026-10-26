import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Fork (oh-my-copilot): scripts/lib/copilot-payload.cjs adds Claude field
 * names to the payloads Copilot CLI sends, using payloads recorded live from
 * Copilot CLI 1.0.91 (fixtures/copilot-live-payloads/cli-1.0.91.json).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { normalizeHookPayload, claudeToolName } = createRequire(import.meta.url)(
  join(REPO_ROOT, 'scripts', 'lib', 'copilot-payload.cjs'),
) as {
  normalizeHookPayload(event: string, payload: unknown): Record<string, unknown>;
  claudeToolName(name: string): string;
};
const LIVE = JSON.parse(readFileSync(join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'copilot-live-payloads', 'cli-1.0.91.json'), 'utf8')) as Record<string, Record<string, unknown>>;

describe('copilot-payload normalizeHookPayload()', () => {
  it('maps the camelCase PermissionRequest payload to Claude names and keeps the originals', () => {
    const out = normalizeHookPayload('PermissionRequest', LIVE['PermissionRequest.shell']);
    expect(out).toMatchObject({
      ...LIVE['PermissionRequest.shell'],
      hook_event_name: 'PermissionRequest',
      session_id: LIVE['PermissionRequest.shell'].sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'echo probe-shell' },
    });
  });

  it('maps plugin MCP tool names in both Copilot spellings', () => {
    expect(normalizeHookPayload('PermissionRequest', LIVE['PermissionRequest.mcp']).tool_name).toBe('mcp__t__state_read');
    expect(normalizeHookPayload('PreToolUse', LIVE['PreToolUse.mcp']).tool_name).toBe('mcp__t__state_read');
  });

  it('maps the lowercase skill tool to Skill', () => {
    expect(normalizeHookPayload('PreToolUse', LIVE['PreToolUse.skill'])).toMatchObject({ tool_name: 'Skill', tool_input: { skill: 'cancel' } });
  });

  it('adds file_path for file tools only', () => {
    const view = normalizeHookPayload('PreToolUse', LIVE['PreToolUse.view']);
    expect(view.tool_input).toEqual({
      path: 'C:\\probe\\project\\does-not-exist-probe.txt',
      file_path: 'C:\\probe\\project\\does-not-exist-probe.txt',
    });
    const grep = normalizeHookPayload('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x', path: 'src' } });
    expect(grep.tool_input).toEqual({ pattern: 'x', path: 'src' });
  });

  it('adds the Claude edit argument names', () => {
    const edit = normalizeHookPayload('PreToolUse', { tool_name: 'Edit', tool_input: { path: 'a.ts', old_str: 'a', new_str: 'b' } });
    expect(edit.tool_input).toEqual({ path: 'a.ts', file_path: 'a.ts', old_str: 'a', new_str: 'b', old_string: 'a', new_string: 'b' });
    const create = normalizeHookPayload('PreToolUse', { tool_name: 'Write', tool_input: { path: 'b.ts', file_text: 'x' } });
    expect(create.tool_input).toMatchObject({ file_path: 'b.ts', content: 'x' });
  });

  it('adds subagent_type for the task tool', () => {
    expect(normalizeHookPayload('PreToolUse', LIVE['PreToolUse.task']).tool_input).toMatchObject({ agent_type: 'explore', subagent_type: 'explore' });
    const background = normalizeHookPayload('PreToolUse', { tool_name: 'Agent', tool_input: { agent_type: 'explore', mode: 'background' } });
    expect(background.tool_input).toMatchObject({ run_in_background: true });
  });

  it('adds tool_response from the Copilot tool_result text', () => {
    const out = normalizeHookPayload('PostToolUse', LIVE['PostToolUse.shell']);
    expect(out.tool_response).toBe('probe-shell\n<shellId: 0 completed with exit code 0>');
    expect(out.tool_result).toEqual(LIVE['PostToolUse.shell'].tool_result);
  });

  it('never overwrites a Claude key the payload already has', () => {
    const out = normalizeHookPayload('PostToolUse', {
      session_id: 'claude', sessionId: 'copilot', tool_name: 'Read', tool_input: { file_path: 'a', path: 'b' },
      tool_response: 'kept', tool_result: { text_result_for_llm: 'ignored' },
    });
    expect(out).toMatchObject({ session_id: 'claude', tool_input: { file_path: 'a', path: 'b' }, tool_response: 'kept' });
  });

  it('keeps Claude Code payloads as they are, apart from hook_event_name', () => {
    const claude = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(normalizeHookPayload('PreToolUse', claude)).toEqual(claude);
  });

  it('returns non-objects unchanged', () => {
    expect(normalizeHookPayload('Stop', null)).toBeNull();
    expect(normalizeHookPayload('Stop', [1])).toEqual([1]);
  });

  it('claudeToolName leaves unknown names alone', () => {
    expect(claudeToolName('powershell')).toBe('Bash');
    expect(claudeToolName('browser-use')).toBe('browser-use');
    expect(claudeToolName('mcp__x__y')).toBe('mcp__x__y');
  });
});
