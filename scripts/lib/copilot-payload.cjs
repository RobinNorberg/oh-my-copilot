'use strict';
/**
 * Copilot CLI hook payload normalizer (fork-owned, oh-my-copilot).
 *
 * scripts/copilot/dispatch.cjs passes every hook payload through
 * normalizeHookPayload() before the hooks read it. The upstream scripts read
 * Claude Code field names; Copilot CLI 1.0.91 sends (live probe 2026-10-23):
 *   - PascalCase PreToolUse/PostToolUse: snake_case with Claude tool names,
 *     except `skill` (stays lowercase) and MCP tools (`t-state_read`);
 *   - PascalCase PermissionRequest and SubagentStart: native camelCase
 *     (`sessionId`, `toolName: "powershell"`, `toolInput`, `transcriptPath`);
 *   - tool_input with Copilot argument names (path, old_str, new_str, file_text);
 *   - tool_result {result_type, text_result_for_llm}, no tool_response.
 *
 * The result is additive: every original key is kept and a Claude key is
 * only added when the payload has none, so scripts that already read the
 * Copilot names see the same values. The one rewrite is `tool_name`, which
 * becomes the Claude name (`skill` → `Skill`, `t-x`/`t/x` → `mcp__t__x`).
 * File paths named by an apply_patch text input are tool-input-paths.mjs's job.
 *
 * No dependencies; CommonJS; Node 20+.
 */

// Copilot runtime tool → Claude tool name (docs "Claude-format matchers"; `skill` observed live).
const CLAUDE_TOOL_NAMES = {
  bash: 'Bash',
  powershell: 'Bash',
  view: 'Read',
  create: 'Write',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  apply_patch: 'Edit',
  grep: 'Grep',
  rg: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user: 'AskUserQuestion',
  update_todo: 'TodoWrite',
  task: 'Agent',
  skill: 'Skill',
};
// The plugin's MCP server is `t`: `t-state_read` in tool events, `t/state_read` in permissionRequest.
const PLUGIN_MCP_TOOL = /^t[-/](.+)$/;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);
// [Copilot key, Claude key] pairs copied when the Claude key is absent.
const PAYLOAD_ALIASES = [
  ['sessionId', 'session_id'],
  ['transcriptPath', 'transcript_path'],
  ['stopReason', 'stop_reason'],
  ['toolInput', 'tool_input'],
  ['toolArgs', 'tool_input'],
  ['toolResult', 'tool_result'],
];
const TOOL_INPUT_ALIASES = [
  ['old_str', 'old_string'],
  ['new_str', 'new_string'],
  ['file_text', 'content'],
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The Claude tool name for a Copilot runtime (or already Claude) tool name. */
function claudeToolName(name) {
  if (typeof name !== 'string' || !name) return name;
  if (has(CLAUDE_TOOL_NAMES, name)) return CLAUDE_TOOL_NAMES[name];
  const mcp = PLUGIN_MCP_TOOL.exec(name);
  return mcp ? `mcp__t__${mcp[1]}` : name;
}

function normalizeToolInput(toolName, input) {
  if (!isPlainObject(input)) return input;
  const output = { ...input };
  for (const [from, to] of TOOL_INPUT_ALIASES) {
    if (has(output, from) && !has(output, to)) output[to] = output[from];
  }
  // Grep/Glob `path` is a search root in both hosts; only file tools name a file.
  if (FILE_TOOLS.has(toolName) && typeof output.path === 'string' && !has(output, 'file_path')) {
    output.file_path = output.path;
  }
  if (toolName === 'Agent') {
    if (typeof output.agent_type === 'string' && !has(output, 'subagent_type')) output.subagent_type = output.agent_type;
    if (output.mode === 'background' && !has(output, 'run_in_background')) output.run_in_background = true;
  }
  return output;
}

function toolResultText(result) {
  if (!isPlainObject(result)) return undefined;
  const text = has(result, 'text_result_for_llm') ? result.text_result_for_llm : result.textResultForLlm;
  return typeof text === 'string' ? text : undefined;
}

/**
 * A copy of `payload` with Claude field names added (see the header).
 * A non-object payload is returned as is.
 */
function normalizeHookPayload(event, payload) {
  if (!isPlainObject(payload)) return payload;
  const output = { ...payload };
  if (typeof event === 'string' && event && !has(output, 'hook_event_name')) output.hook_event_name = event;
  for (const [from, to] of PAYLOAD_ALIASES) {
    if (has(output, from) && !has(output, to)) output[to] = output[from];
  }
  const rawToolName = has(output, 'tool_name') ? output.tool_name : output.toolName;
  if (typeof rawToolName === 'string' && rawToolName) {
    output.tool_name = claudeToolName(rawToolName);
    if (has(output, 'tool_input')) output.tool_input = normalizeToolInput(output.tool_name, output.tool_input);
  }
  if (!has(output, 'tool_response')) {
    const text = toolResultText(output.tool_result);
    if (text !== undefined) output.tool_response = text;
  }
  return output;
}

module.exports = { normalizeHookPayload, claudeToolName, CLAUDE_TOOL_NAMES };
