#!/usr/bin/env node
/**
 * Generate copilot/hooks.json (Copilot CLI hook manifest) from hooks/hooks.json
 * (upstream Claude Code form, kept byte-identical to upstream).
 *
 * Copilot runs a Claude `command` string through pwsh on Windows, which splits
 * `node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ...` into separate arguments and
 * silently turns every hook into a no-op. The generated file uses `exec` + `args`
 * instead: no shell, each path is exactly one argv element.
 *
 * Rules:
 *   - One entry per (event, matcher) group runs scripts/copilot/dispatch.cjs,
 *     which runs the group's hooks in order in one process and merges their
 *     outputs (argv: <Event> <script> [args]... [-- <script> [args]...]...).
 *   - PascalCase event keys are kept (payloads stay snake_case, matchers work).
 *   - The group matcher is copied onto its entry, except "*" and empty.
 *   - SessionStart groups with a non-"*" matcher (init, maintenance) are dropped:
 *     Copilot ignores SessionStart matchers, so they would run every session.
 *   - `async` is dropped; `timeoutSec` is the sum of the group's `timeout`s
 *     (the dispatcher runs them one after another, each with its own timeout).
 *   - `env.OMC_HOOK_EVENT` names the event for the output adapter preload.
 *   - Any command or hook field outside the known upstream form throws, so an
 *     upstream change breaks the build instead of shipping a silent no-op.
 *
 * Usage:
 *   node scripts/copilot/build-hooks.mjs            print to stdout
 *   node scripts/copilot/build-hooks.mjs --write    write copilot/hooks.json
 *   node scripts/copilot/build-hooks.mjs --verify   exit 1 on drift
 *   --no-preload                                    omit the adapter preload (diagnostics only)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');
const SOURCE_PATH = join(REPO_ROOT, 'hooks', 'hooks.json');
const OUT_PATH = join(REPO_ROOT, 'copilot', 'hooks.json');

export const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';
export const ADAPTER_ARG = `${PLUGIN_ROOT_TOKEN}/scripts/lib/copilot-hook-adapter.cjs`;
export const DISPATCH_ARG = `${PLUGIN_ROOT_TOKEN}/scripts/copilot/dispatch.cjs`;
// Must match HOOK_SEPARATOR in scripts/copilot/dispatch.cjs.
export const HOOK_SEPARATOR = '--';
const COMMAND_PATTERN = /^node "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/run\.cjs "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/(\S+)((?: \S+)*)$/;
const KNOWN_HOOK_FIELDS = new Set(['type', 'command', 'timeout', 'async']);
const KNOWN_GROUP_FIELDS = new Set(['matcher', 'hooks']);

export function buildCopilotHooks(source, { preload = true } = {}) {
  if (!source || typeof source !== 'object' || !source.hooks || typeof source.hooks !== 'object') {
    throw new Error('hooks/hooks.json must have a "hooks" object');
  }
  const hooks = {};
  for (const [event, groups] of Object.entries(source.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks/hooks.json ${event} must be an array`);
    const entries = [];
    for (const group of groups) {
      for (const key of Object.keys(group ?? {})) {
        if (!KNOWN_GROUP_FIELDS.has(key)) throw new Error(`hooks/hooks.json ${event}: unknown group field "${key}"`);
      }
      if (!Array.isArray(group?.hooks)) throw new Error(`hooks/hooks.json ${event}: group has no hooks array`);
      const matcher = typeof group.matcher === 'string' && group.matcher !== '*' ? group.matcher : '';
      if (event === 'SessionStart' && matcher) continue;
      const segments = [];
      let timeoutSec = 0;
      let hasTimeout = false;
      for (const hook of group.hooks) {
        for (const key of Object.keys(hook ?? {})) {
          if (!KNOWN_HOOK_FIELDS.has(key)) throw new Error(`hooks/hooks.json ${event}: unknown hook field "${key}"`);
        }
        const match = hook.type === 'command' && typeof hook.command === 'string'
          ? COMMAND_PATTERN.exec(hook.command)
          : null;
        if (!match) throw new Error(`hooks/hooks.json ${event}: unsupported hook command form: ${JSON.stringify(hook)}`);
        const [, script, extra] = match;
        const extraArgs = extra.split(' ').filter(Boolean);
        if (extraArgs.includes(HOOK_SEPARATOR)) {
          throw new Error(`hooks/hooks.json ${event}: hook arg "${HOOK_SEPARATOR}" cannot be dispatched: ${hook.command}`);
        }
        if (segments.length > 0) segments.push(HOOK_SEPARATOR);
        segments.push(`${PLUGIN_ROOT_TOKEN}/scripts/${script}`, ...extraArgs);
        if (hook.timeout !== undefined) {
          timeoutSec += hook.timeout;
          hasTimeout = true;
        }
      }
      if (segments.length === 0) continue;
      const entry = { type: 'command' };
      if (matcher) entry.matcher = matcher;
      entry.exec = 'node';
      entry.args = [
        ...(preload ? ['--require', ADAPTER_ARG] : []),
        DISPATCH_ARG,
        event,
        ...segments,
      ];
      entry.env = { OMC_HOOK_EVENT: event };
      if (hasTimeout) entry.timeoutSec = timeoutSec;
      entries.push(entry);
    }
    if (entries.length > 0) hooks[event] = entries;
  }
  return {
    description: 'Generated by scripts/copilot/build-hooks.mjs from hooks/hooks.json. Do not edit.',
    version: 1,
    hooks,
  };
}

export function renderCopilotHooks(sourceText, options) {
  return `${JSON.stringify(buildCopilotHooks(JSON.parse(sourceText), options), null, 2)}\n`;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const rendered = renderCopilotHooks(readFileSync(SOURCE_PATH, 'utf8'), { preload: !args.has('--no-preload') });
  if (args.has('--verify')) {
    let onDisk = null;
    try {
      onDisk = readFileSync(OUT_PATH, 'utf8');
    } catch {
      // missing file is reported as drift below
    }
    if (onDisk !== rendered) {
      console.error('[copilot-hooks] drift detected: copilot/hooks.json differs from hooks/hooks.json');
      console.error('  to refresh: node scripts/copilot/build-hooks.mjs --write');
      process.exit(1);
    }
    console.log('[copilot-hooks] verify ok');
    return;
  }
  if (args.has('--write')) {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, rendered, 'utf8');
    console.log('[copilot-hooks] wrote copilot/hooks.json');
    return;
  }
  process.stdout.write(rendered);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (error) {
    console.error(`[copilot-hooks] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
