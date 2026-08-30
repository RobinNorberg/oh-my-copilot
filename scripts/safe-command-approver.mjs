#!/usr/bin/env node

/**
 * OMC Safe Command Approver (PreToolUse)
 *
 * Auto-approves known-safe Bash commands (git status, npm test, dotnet build, etc.)
 * so they don't trigger an interactive permission prompt. Works on both Copilot CLI
 * and Claude Code — migrated from the Claude-Code-only permissionRequest handler.
 *
 * For non-Bash tools or unrecognised commands, outputs nothing (passes through to
 * the runtime's native permission flow).
 *
 * Hook output (preToolUse — Copilot CLI compliant):
 *   - Allow ({ permissionDecision: "allow" }) for safe commands
 *   - No output for everything else (defer to runtime)
 */

import { readStdin } from './lib/stdin.mjs';

// --- Safe command patterns (mirrored from src/hooks/permission-handler/index.ts) ---

const SAFE_PATTERNS = [
  /^git (status|diff|log|branch|show|fetch)/,
  /^npm (test|run (test|lint|build|check|typecheck))/,
  /^pnpm (test|run (test|lint|build|check|typecheck))/,
  /^yarn (test|run (test|lint|build|check|typecheck))/,
  /^tsc( |$)/,
  /^gh (issue|pr) (view|list|status)\b/,
  /^eslint /,
  /^prettier /,
  /^cargo (test|check|clippy|build)/,
  /^pytest/,
  /^python -m pytest/,
  /^ls( |$)/,
  /^grep /,
  /^find /,
  /^wc /,
  /^pwd$/,
  /^which /,
  /^echo /,
  /^env$/,
  /^node --version$/,
  /^dotnet (--version|--list-sdks|--list-runtimes|--info)$/,
  /^dotnet (build|test|run|restore|clean)( |$)/,
  /^gh (pr|issue|repo|api|run|workflow) (view|list|status|diff|checks)/,
  /^gh auth status/,
  /^az (account show|group list|resource list|ad signed-in-user show)/,
  /^az devops (project list|configure)/,
  /^az pipelines (list|show|runs list)/,
  /^az repos (list|show|pr list)/,
];

// Shell metacharacters that enable command chaining / injection
const DANGEROUS_SHELL_CHARS = /[;&|`$()<>\n\r\t\0\\{}\[\]*?~!#]/;

// Heredoc operator detection
const HEREDOC_PATTERN = /<<[-~]?\s*['"]?\w+['"]?/;

const SAFE_HEREDOC_PATTERNS = [
  /^git commit\b/,
  /^git tag\b/,
];

const SAFE_RIPGREP_FLAGS = new Set([
  '-n', '--line-number', '-S', '--smart-case', '-F', '--fixed-strings',
  '-i', '--ignore-case', '--no-heading',
]);

function isSafeCommand(command) {
  const trimmed = command.trim();
  if (DANGEROUS_SHELL_CHARS.test(trimmed)) return false;
  return SAFE_PATTERNS.some(p => p.test(trimmed));
}

function isHeredocWithSafeBase(command) {
  const trimmed = command.trim();
  if (!trimmed.includes('\n')) return false;
  if (!HEREDOC_PATTERN.test(trimmed)) return false;
  const firstLine = trimmed.split('\n')[0].trim();
  return SAFE_HEREDOC_PATTERNS.some(p => p.test(firstLine));
}

function tokenizeShellCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { tokens.push(current); current = ''; } continue; }
    current += char;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function isRipgrepReadOnly(tokens) {
  if (tokens[0] !== 'rg') return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (SAFE_RIPGREP_FLAGS.has(t)) continue;
      if (t.startsWith('--type=') || t.startsWith('--glob=') || t.startsWith('-g')) continue;
      if (t === '--type' || t === '--glob' || t === '-g' || t === '-t') { i++; continue; }
      return false;
    }
  }
  return true;
}

function isSafeRepoInspectionCommand(command) {
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length === 0) return false;
  if (isRipgrepReadOnly(tokens)) return true;
  if (/^cat( |$)/.test(command) || /^head( |$)/.test(command) || /^tail( |$)/.test(command)) return true;
  return false;
}

function isSafeTargetedLocalTestCommand(command) {
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length < 2) return false;
  const bin = tokens[0];
  if (bin === 'npx' && tokens[1] === 'vitest' && tokens.includes('run') && tokens.some(t => t.endsWith('.test.ts') || t.endsWith('.test.js'))) return true;
  if (bin === 'pytest' && tokens.some(t => t.endsWith('.py') || t.includes('::') || t.startsWith('tests/'))) return true;
  if (bin === 'go' && tokens[1] === 'test' && tokens.some(t => t.startsWith('./') || t.includes('...'))) return true;
  return false;
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const toolName = data.tool_name || data.toolName || '';

    // Only process Bash tool calls
    if (toolName !== 'Bash') return;

    const command = data.tool_input?.command ?? data.toolInput?.command;
    if (!command || typeof command !== 'string') return;

    const trimmed = command.trim();
    if (!trimmed) return;

    if (isSafeCommand(trimmed) || isHeredocWithSafeBase(trimmed)
        || isSafeRepoInspectionCommand(trimmed) || isSafeTargetedLocalTestCommand(trimmed)) {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
    }
    // No output for unrecognised commands — defer to runtime's native permission flow
  } catch {
    // On error, produce no output — never block on hook failure
  }
}

main();
