#!/usr/bin/env node

/**
 * PostToolUse Hook: Rules Injector (issue #2577 bug 2)
 *
 * Injects relevant rule files (.claude/rules, .github/instructions,
 * .cursor/rules, ~/.claude/rules) into context when Claude accesses files.
 *
 * Uses content-hash + realpath dedup (via rules-injector storage) so the same
 * rule is never injected more than once per session regardless of how many
 * files are accessed.
 *
 * Worktree safety (bug 3): project root is derived from the ACCESSED FILE's
 * path via findProjectRoot, not from data.cwd. A .git FILE at the worktree
 * root stops the upward walk, preventing parent-repo rules from leaking in.
 */

import { isAbsolute, join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readStdin } from './lib/stdin.mjs';
// fork: Copilot apply_patch sends patch text, not a path object; extract its paths.
import { toolInputPaths } from './lib/tool-input-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getRuntimeBaseDir() {
  return process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');
}

// Dynamic import — graceful no-op when dist/ is not built (first run / dev)
let createRulesInjectorHook = null;
try {
  const runtimeBase = getRuntimeBaseDir();
  const mod = await import(
    pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'rules-injector', 'index.js')).href
  );
  createRulesInjectorHook = mod.createRulesInjectorHook;
} catch {
  // dist not available — skip rules injection silently
}

async function main() {
  // Skip guard: honor the documented kill switches (see issues #838, #3253).
  // This hook injects context on PostToolUse alongside post-tool-verifier.mjs, so it
  // accepts the same `post-tool-use` event token. Without this, DISABLE_OMC=1 and
  // OMC_SKIP_HOOKS=post-tool-use failed to suppress rule injection because only
  // post-tool-verifier.mjs honored them.
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map((s) => s.trim());
  if (
    process.env.DISABLE_OMC === '1' ||
    process.env.DISABLE_OMC === 'true' ||
    _skipHooks.includes('post-tool-use')
  ) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch { /* ignore parse errors */ }

    if (!createRulesInjectorHook) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const toolName  = data.tool_name  || data.toolName  || '';
    const toolInput = data.tool_input || data.toolInput  || {};
    const sessionId = data.session_id || data.sessionId  || 'unknown';
    const cwd       = data.cwd        || process.cwd();

    // fork: Copilot apply_patch sends patch text; extract every patched path (capped).
    // One path for Read/Write/Edit/MultiEdit; every patched file for Copilot's apply_patch.
    const rawPaths = toolInputPaths(toolInput);
    if (rawPaths.length === 0) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // createRulesInjectorHook uses cwd only for relative-path resolution.
    // Internally, processToolExecution calls findProjectRoot(filePath) to
    // determine the project boundary — so worktree isolation is maintained
    // even when cwd points to a parent repository.
    const hook = createRulesInjectorHook(cwd);
    const rulesText = rawPaths
      // Resolve relative paths against the shell CWD
      .map((rawPath) => hook.processToolExecution(toolName, isAbsolute(rawPath) ? rawPath : join(cwd, rawPath), sessionId))
      .filter(Boolean)
      .join('\n\n');

    if (rulesText) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: rulesText,
        },
      }));
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
  } catch {
    // Always continue on error — rules injection is additive only
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
