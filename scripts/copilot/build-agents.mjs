#!/usr/bin/env node
/**
 * Generate copilot/agents/*.md (Copilot CLI custom agents) from agents/*.md
 * (upstream Claude Code form, kept byte-identical to upstream).
 *
 * The root plugin.json `agents` field points at copilot/agents/, which REPLACES
 * default agents/ discovery, so every source agent must be generated.
 *
 * Frontmatter transform (the body is copied byte-for-byte):
 *   - `name`, `description`: copied verbatim.
 *   - `model: <alias>` -> `models: [...]` fallback list (first id the user's plan
 *     can access wins; a single `model` id warns "not available" on other plans).
 *     Unknown alias -> omitted, so the agent inherits the session model.
 *   - `disallowedTools` -> `tools` allowlist of native Copilot tool names
 *     (Claude names like `Bash` silently drop the Windows shell).
 *   - `level`: dropped (Claude-only).
 *   - Every agent except `explore` and `document-specialist` gets
 *     `include-custom-instructions: true` so it sees AGENTS.md/CLAUDE.md as a
 *     subagent (Copilot recommends it for agents that review or edit code).
 *   - Any other frontmatter key or disallowed tool throws, so an upstream change
 *     breaks the build instead of shipping a silently wrong agent.
 *
 * Usage:
 *   node scripts/copilot/build-agents.mjs            list what would be generated
 *   node scripts/copilot/build-agents.mjs --write    write copilot/agents/*.md
 *   node scripts/copilot/build-agents.mjs --verify   exit 1 on drift
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');
const SOURCE_DIR = join(REPO_ROOT, 'agents');
const OUT_DIR = join(REPO_ROOT, 'copilot', 'agents');

export const MODEL_TABLE = {
  opus: ['claude-opus-5', 'claude-opus-4.8', 'gpt-5.5'],
  sonnet: ['claude-sonnet-5', 'claude-sonnet-4.6', 'gpt-5.5'],
  haiku: ['claude-haiku-4.5', 'gpt-5.4-mini', 'gpt-5-mini'],
  fable: ['claude-fable-5.1', 'claude-fable-5', 'claude-opus-5'],
};

/**
 * Every native Copilot CLI tool id an agent may be granted. A `disallowedTools`
 * agent's `tools` allowlist is FULL_TOOLS minus the ids its disallowed Claude
 * tools map to, so each DISALLOWED_TOOL_MAP entry really removes something.
 * Verified ids: view, create, edit, apply_patch, str_replace_editor, rg, grep,
 * glob, bash, powershell, web_fetch, task, skill, ask_user, update_todo, plus
 * `t/*` (the OMC MCP server's tools). `web_search` is NOT a Copilot tool id.
 */
export const FULL_TOOLS = [
  'view', 'create', 'edit', 'apply_patch', 'str_replace_editor',
  'rg', 'grep', 'glob', 'bash', 'powershell', 'web_fetch',
  'task', 'skill', 'ask_user', 'update_todo', 't/*',
];

/** Agents that only search/read docs; every other agent reviews or edits code. */
const NO_CUSTOM_INSTRUCTIONS = new Set(['explore', 'document-specialist']);

export const DISALLOWED_TOOL_MAP = {
  Write: ['create'],
  Edit: ['edit', 'apply_patch', 'str_replace_editor'],
  Bash: ['bash', 'powershell'],
};
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n/;
const KEY_LINE_PATTERN = /^([A-Za-z][\w-]*):\s*(.*)$/;

export function buildCopilotAgent(sourceText, fileName = 'agent') {
  const match = FRONTMATTER_PATTERN.exec(sourceText);
  if (!match) throw new Error(`agents/${fileName}: missing "---" frontmatter`);
  const body = sourceText.slice(match[0].length);
  const out = [];
  let agentName = fileName.replace(/\.md$/, '');
  for (const line of match[1].split('\n')) {
    const keyLine = KEY_LINE_PATTERN.exec(line);
    if (!keyLine) throw new Error(`agents/${fileName}: unsupported frontmatter line: ${JSON.stringify(line)}`);
    const [, key, value] = keyLine;
    switch (key) {
      case 'name':
        agentName = value.trim();
        out.push(line);
        break;
      case 'description':
        out.push(line);
        break;
      case 'level':
        break;
      case 'model': {
        const models = MODEL_TABLE[value.trim()];
        if (models) out.push(`models: ${JSON.stringify(models)}`);
        break;
      }
      case 'disallowedTools': {
        const removed = new Set();
        for (const tool of value.split(',').map(t => t.trim()).filter(Boolean)) {
          const mapped = DISALLOWED_TOOL_MAP[tool];
          if (!mapped) throw new Error(`agents/${fileName}: unmapped disallowed tool "${tool}"`);
          for (const name of mapped) removed.add(name);
        }
        out.push(`tools: ${JSON.stringify(FULL_TOOLS.filter(tool => !removed.has(tool)))}`);
        break;
      }
      default:
        throw new Error(`agents/${fileName}: unknown frontmatter key "${key}"`);
    }
  }
  if (!NO_CUSTOM_INSTRUCTIONS.has(agentName)) out.push('include-custom-instructions: true');
  return `---\n${out.join('\n')}\n---\n${body}`;
}

/** Returns Map<fileName, generatedText> for every agents/*.md, sorted by name. */
export function renderCopilotAgents(sourceDir = SOURCE_DIR) {
  const rendered = new Map();
  for (const fileName of readdirSync(sourceDir).filter(f => f.endsWith('.md')).sort()) {
    rendered.set(fileName, buildCopilotAgent(readFileSync(join(sourceDir, fileName), 'utf8'), fileName));
  }
  return rendered;
}

function listOutDir() {
  try {
    return readdirSync(OUT_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const rendered = renderCopilotAgents();
  if (args.has('--verify')) {
    const drift = [];
    for (const [fileName, text] of rendered) {
      let onDisk = null;
      try {
        onDisk = readFileSync(join(OUT_DIR, fileName), 'utf8');
      } catch {
        // missing file is reported as drift below
      }
      if (onDisk !== text) drift.push(fileName);
    }
    for (const fileName of listOutDir()) {
      if (!rendered.has(fileName)) drift.push(`${fileName} (stale)`);
    }
    if (drift.length > 0) {
      console.error(`[copilot-agents] drift detected in copilot/agents/: ${drift.join(', ')}`);
      console.error('  to refresh: node scripts/copilot/build-agents.mjs --write');
      process.exit(1);
    }
    console.log(`[copilot-agents] verify ok (${rendered.size} agents)`);
    return;
  }
  if (args.has('--write')) {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const fileName of listOutDir()) {
      if (!rendered.has(fileName)) rmSync(join(OUT_DIR, fileName));
    }
    for (const [fileName, text] of rendered) writeFileSync(join(OUT_DIR, fileName), text, 'utf8');
    console.log(`[copilot-agents] wrote ${rendered.size} agents to copilot/agents/`);
    return;
  }
  for (const fileName of rendered.keys()) console.log(`copilot/agents/${fileName}`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (error) {
    console.error(`[copilot-agents] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
