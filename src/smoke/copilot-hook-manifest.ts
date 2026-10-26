/**
 * The generated Copilot hook manifest (copilot/hooks.json) and one entry run
 * exactly as Copilot CLI spawns it: `exec` + `args` with no shell, the
 * `${CLAUDE_PLUGIN_ROOT}` token replaced by the plugin root, the entry's `env`
 * on top, and the hook payload on stdin. Shared by the tier 2 CLI scenarios
 * (the ultragoal activation seed) and `omg hooks doctor` (the dry dispatch).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { SpawnSyncFn } from './process-utils.js';

export const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';
export const COPILOT_HOOKS_PATH = 'copilot/hooks.json';

export interface CopilotHookEntry {
  type: string;
  matcher?: string;
  exec: string;
  args: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface CopilotHookManifest {
  version: number;
  hooks: Record<string, CopilotHookEntry[]>;
}

/** Parse `<root>/copilot/hooks.json`; throws when it is missing or not a manifest. */
export function readCopilotHookManifest(root: string): CopilotHookManifest {
  const parsed = JSON.parse(readFileSync(join(root, COPILOT_HOOKS_PATH), 'utf-8')) as CopilotHookManifest;
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks || typeof parsed.hooks !== 'object') {
    throw new Error(`${COPILOT_HOOKS_PATH} has no "hooks" object`);
  }
  return parsed;
}

export function resolveEntryArgs(entry: CopilotHookEntry, root: string): string[] {
  return entry.args.map((a) => a.replaceAll(PLUGIN_ROOT_TOKEN, root));
}

/** No matcher matches every call; a matcher is an anchored regex over the (Claude-format) tool name. */
export function entryMatches(entry: CopilotHookEntry, toolName?: string): boolean {
  if (!entry.matcher) return true;
  if (!toolName) return false;
  try { return new RegExp(`^(?:${entry.matcher})$`).test(toolName); } catch { return false; }
}

/** Seconds Copilot would allow an entry before the extra grace the runner adds. */
export const DEFAULT_ENTRY_TIMEOUT_SEC = 30;
const GRACE_MS = 5_000;

export interface HookDispatchResult {
  event: string;
  matcher: string | null;
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export function dispatchHookEntry(
  event: string,
  entry: CopilotHookEntry,
  root: string,
  payload: unknown,
  opts: { cwd: string; env: NodeJS.ProcessEnv; spawnSync: SpawnSyncFn },
): HookDispatchResult {
  const timeoutMs = (entry.timeoutSec ?? DEFAULT_ENTRY_TIMEOUT_SEC) * 1000 + GRACE_MS;
  const started = Date.now();
  const res = opts.spawnSync(entry.exec, resolveEntryArgs(entry, root), {
    cwd: opts.cwd,
    env: { ...opts.env, ...(entry.env ?? {}) },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const err = res.error as NodeJS.ErrnoException | undefined;
  const timedOut = err?.code === 'ETIMEDOUT';
  return {
    event,
    matcher: entry.matcher ?? null,
    status: res.status,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    durationMs: Date.now() - started,
    timedOut,
    ...(err && !timedOut ? { error: err.message } : {}),
  };
}
