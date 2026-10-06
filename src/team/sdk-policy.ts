/**
 * Permission and tool policy for headless SDK team workers (`--transport sdk`).
 *
 * Pane workers run with `--allow-all-*`. An SDK worker gets no allow-all: its
 * host answers every `onPermissionRequest` with {@link decideSdkPermission},
 * and removes tools up front with {@link buildSdkExcludedTools}.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** The subset of the SDK PermissionRequest the policy reads (SDK 1.0.16). */
export interface SdkPermissionRequest {
  kind?: string;
  fullCommandText?: string;
  path?: unknown;
  fileName?: unknown;
  resolvedPath?: unknown;
  serverName?: unknown;
  toolName?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

export interface SdkPolicyContext {
  /** The worker's working directory (its worktree, or the leader cwd without worktrees). */
  cwd: string;
  /** The leader's team state root: inbox, status, heartbeat, shutdown ack, verdicts. */
  stateRoot: string;
  /** The oh-my-copilot plugin root (skills, agents, hook scripts are read from here). */
  pluginRoot: string;
  /** Extra read-only roots (the per-worker COPILOT_HOME). */
  readRoots?: string[];
  /** The plugin MCP server name (`t`). */
  mcpServer: string;
  /** `permissions.workerDenyTools`. */
  denyTools?: string[];
  /** `permissions.workerDenyUrls`. */
  denyUrls?: string[];
  platform?: NodeJS.Platform;
}

export interface SdkPermissionDecision {
  approve: boolean;
  reason: string;
}

/**
 * Shell commands a worker must never run, whatever the config says:
 * - team control other than `team api` (nested teams, shutdown of its own team);
 * - `omg smoke` (would spend credits from inside a worker);
 * - the multiplexers (the pane transport's control plane);
 * - `git push` (workers commit in their worktree; the leader integrates).
 *
 * This is a denylist over the command text, not a sandbox: it stops the
 * direct and quoted spellings a model actually writes, but a worker that
 * builds the command indirectly (an alias, a script file, `Invoke-Expression`,
 * an encoded command) is not stopped by it. The real boundaries are the
 * write-path check, the credit cap and the per-worker COPILOT_HOME.
 * Patterns run on {@link normalizeShellCommand}'s output.
 */
export const SDK_SHELL_DENY_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  // `\s+(?!\s|api\b)`: doubled whitespace must not let `team  api` backtrack into a deny.
  { re: /\b(?:omg|omc|oh-my-copilot|oh-my-claudecode)(?:\.cmd|\.ps1)?\s+team\s+(?!\s|api\b)/i, reason: 'team control outside `team api`' },
  { re: /\bcli\.cjs["']?\s+team\s+(?!\s|api\b)/i, reason: 'team control outside `team api`' },
  { re: /\b(?:omg|omc|oh-my-copilot)(?:\.cmd|\.ps1)?\s+smoke\b/i, reason: '`omg smoke` from a worker' },
  { re: /(?:^|[\s;&|("'])(?:tmux|psmux)(?:\.exe)?\b/i, reason: 'multiplexer control' },
  // `push` as git's subcommand: only global options (`-C <dir>`, `-c <k=v>`, `--flag[=v]`) may sit between.
  { re: /(?:^|[\s;&|("'/\\])git(?:\.exe)?(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+push\b/i, reason: '`git push` from a worker' },
  // `$g="git"; & $g push` / `g=git; $g push`: git named, then pushed through a variable.
  { re: /\bgit\b[\s\S]*\$\{?\w+\}?\s+push\b/i, reason: '`git push` from a worker' },
];

/** Strip quotes around single tokens (`"omg" 'team'` -> `omg team`) so quoting cannot dodge a pattern. */
export function normalizeShellCommand(command: string): string {
  return command.replace(/(["'])([^"'\s]+)\1/g, '$2');
}

function canon(p: string, platform: NodeJS.Platform): string {
  let out = resolve(p);
  try { out = realpathSync.native(out); } catch { /* missing: keep the resolved form */ }
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? out.toLowerCase() : out;
}

/** True when `p` is `root` or lies below it (realpath, case-folded on win32). */
export function isUnderRoot(p: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!p || !root) return false;
  const child = canon(p, platform);
  const parent = canon(root, platform);
  return child === parent || child.startsWith(`${parent}/`);
}

function requestPath(req: SdkPermissionRequest, cwd: string): string | null {
  for (const key of ['resolvedPath', 'path', 'fileName'] as const) {
    const value = req[key];
    if (typeof value === 'string' && value.trim()) {
      return isAbsolute(value) ? value : resolve(cwd, value);
    }
  }
  return null;
}

/** `shell(<prefix>)` entries of `workerDenyTools`, as command prefixes. */
export function shellDenyPrefixes(denyTools: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const raw of denyTools) {
    const m = /^shell\((.+)\)$/i.exec(raw.trim());
    if (m && m[1]!.trim()) out.push(m[1]!.trim().replace(/:\*$/, ''));
  }
  return out;
}

function matchesDenyUrl(url: string, patterns: readonly string[]): boolean {
  const lower = url.toLowerCase();
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL: substring match only */ }
  return patterns.some((p) => {
    const pattern = p.trim().toLowerCase();
    if (!pattern) return false;
    if (host && (host === pattern || host.endsWith(`.${pattern}`))) return true;
    return lower.includes(pattern);
  });
}

export function decideSdkPermission(req: SdkPermissionRequest, ctx: SdkPolicyContext): SdkPermissionDecision {
  const platform = ctx.platform ?? process.platform;
  switch (req.kind) {
    case 'read': {
      const path = requestPath(req, ctx.cwd);
      if (!path) return { approve: true, reason: 'read without a path' };
      const roots = [ctx.cwd, ctx.stateRoot, ctx.pluginRoot, ...(ctx.readRoots ?? [])];
      return roots.some((root) => isUnderRoot(path, root, platform))
        ? { approve: true, reason: 'read inside worker roots' }
        : { approve: false, reason: `read outside worker roots: ${path}` };
    }
    case 'write': {
      const path = requestPath(req, ctx.cwd);
      if (!path) return { approve: false, reason: 'write without a path' };
      return isUnderRoot(path, ctx.cwd, platform) || isUnderRoot(path, ctx.stateRoot, platform)
        ? { approve: true, reason: 'write inside worktree or team state' }
        : { approve: false, reason: `write outside worktree and team state: ${path}` };
    }
    case 'shell': {
      const command = String(req.fullCommandText ?? '');
      if (!command.trim()) return { approve: false, reason: 'shell without command text' };
      const normalized = normalizeShellCommand(command);
      for (const { re, reason } of SDK_SHELL_DENY_PATTERNS) {
        if (re.test(normalized)) return { approve: false, reason };
      }
      const spellings = [command.trim(), normalized.trim()];
      for (const prefix of shellDenyPrefixes(ctx.denyTools)) {
        if (spellings.some((s) => s === prefix || s.startsWith(`${prefix} `))) {
          return { approve: false, reason: `permissions.workerDenyTools shell(${prefix})` };
        }
      }
      return { approve: true, reason: 'shell' };
    }
    case 'url': {
      const url = String(req.url ?? '');
      return matchesDenyUrl(url, ctx.denyUrls ?? [])
        ? { approve: false, reason: `permissions.workerDenyUrls: ${url}` }
        : { approve: true, reason: 'url' };
    }
    case 'mcp':
      return req.serverName === ctx.mcpServer
        ? { approve: true, reason: `mcp server ${ctx.mcpServer}` }
        : { approve: false, reason: `mcp server ${String(req.serverName)} is not the plugin server` };
    default:
      return { approve: false, reason: `permission kind ${String(req.kind)} is not granted to sdk workers` };
  }
}

/** Built-in tool names a bare `workerDenyTools` kind expands to. */
const KIND_TOOLS: Record<string, string[]> = {
  shell: ['shell', 'powershell', 'bash'],
  write: ['create', 'edit'],
};

/**
 * Built-in tools that start or drive other agents. A worker is one agent on
 * one credit cap; these would fan out work (and spend) outside the team's
 * task and claim protocol.
 */
export const SDK_AGENT_FANOUT_TOOLS: readonly string[] = [
  'task',
  'run_dynamic_workflow',
  'dynamic_workflows_manage',
  'write_agent',
  'read_agent',
  'list_agents',
  'search_code_subagent',
];

/**
 * `excludedTools` for an SDK worker session: the recursion fence (the
 * `<server>-host_smoke` tool and {@link SDK_AGENT_FANOUT_TOOLS}) plus each bare
 * `workerDenyTools` name; `<server>(<tool>)` becomes `<server>-<tool>`, the
 * SDK's MCP tool name. `shell(<prefix>)` entries stay with the handler.
 */
export function buildSdkExcludedTools(mcpServer: string, denyTools: readonly string[] = []): string[] {
  const out = new Set<string>([`${mcpServer}-host_smoke`, ...SDK_AGENT_FANOUT_TOOLS]);
  for (const raw of denyTools) {
    const entry = raw.trim();
    if (!entry) continue;
    const call = /^([A-Za-z0-9_.-]+)\(([^)]*)\)$/.exec(entry);
    if (call) {
      if (call[1]!.toLowerCase() === 'shell' || call[1]!.toLowerCase() === 'write') continue;
      if (call[2]) out.add(`${call[1]}-${call[2]}`);
      continue;
    }
    for (const name of KIND_TOOLS[entry.toLowerCase()] ?? [entry]) out.add(name);
  }
  return [...out];
}
