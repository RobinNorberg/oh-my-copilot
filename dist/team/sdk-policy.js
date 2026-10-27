/**
 * Permission and tool policy for headless SDK team workers (`--transport sdk`).
 *
 * Pane workers run with `--allow-all-*`. An SDK worker gets no allow-all: its
 * host answers every `onPermissionRequest` with {@link decideSdkPermission},
 * and removes tools up front with {@link buildSdkExcludedTools}.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { COPILOT_RUN_TOOL_NAMES } from '../copilot-run/names.js';
/**
 * git's global options before the subcommand: `-C <dir>`, `-c <k=v>`, the long
 * options that take a separate value, and `--flag[=v]`.
 */
const GIT_GLOBAL_OPTIONS = String.raw `(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source)\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*`;
/**
 * Deny patterns for `git <global options> <tail>` (`tail` is a regex source),
 * spelled directly or through a variable (`$g="git"; & $g push`, `g=git; $g push`).
 */
export function gitSubcommandDeny(tail, reason) {
    return [
        { re: new RegExp(String.raw `(?:^|[\s;&|("'/\\])git(?:\.exe)?["']?${GIT_GLOBAL_OPTIONS}\s+${tail}`, 'i'), reason },
        { re: new RegExp(String.raw `\bgit\b[\s\S]*\$\{?\w+\}?${GIT_GLOBAL_OPTIONS}\s+${tail}`, 'i'), reason },
    ];
}
/**
 * Shell commands a worker must never run, whatever the config says:
 * - team control other than `team api` (nested teams, shutdown of its own team);
 * - `omg smoke` (would spend credits from inside a worker);
 * - the multiplexers (the pane transport's control plane);
 * - `git push` (workers commit in their worktree; the leader integrates), and
 *   the git aliases and config overrides that could rename it.
 *
 * This is a denylist over the command text, not a sandbox: it stops the
 * direct and quoted spellings a model actually writes, but a worker that
 * builds the command indirectly (a script file, `Invoke-Expression`, an
 * encoded command, a shell escape such as `pu\sh`) is not stopped by it. The real boundaries are the
 * write-path check, the credit cap and the per-worker COPILOT_HOME.
 * Patterns run on {@link normalizeShellCommand}'s output.
 */
export const SDK_SHELL_DENY_PATTERNS = [
    // `\s+(?!\s|api\b)`: doubled whitespace must not let `team  api` backtrack into a deny.
    { re: /\b(?:omg|omc|oh-my-copilot|oh-my-claudecode)(?:\.cmd|\.ps1)?\s+team\s+(?!\s|api\b)/i, reason: 'team control outside `team api`' },
    { re: /\bcli\.cjs["']?\s+team\s+(?!\s|api\b)/i, reason: 'team control outside `team api`' },
    { re: /\b(?:omg|omc|oh-my-copilot)(?:\.cmd|\.ps1)?\s+smoke\b/i, reason: '`omg smoke` from a worker' },
    { re: /(?:^|[\s;&|("'])(?:tmux|psmux)(?:\.exe)?\b/i, reason: 'multiplexer control' },
    ...gitSubcommandDeny(String.raw `(?:push|send-pack|http-push|subtree\s+push)\b`, '`git push` from a worker'),
    // An alias (or an included config file) renames a denied subcommand: `git -c alias.p=push p`, `git config alias.p push`.
    ...gitSubcommandDeny(String.raw `(?:-c\s+|--config-env(?:=|\s+))['"]?(?:alias|include|includeif)\.`, 'git alias or include from a worker'),
    ...gitSubcommandDeny(String.raw `config\b[^;&|\n]*?(?:alias|include|includeif)\.`, 'git alias or include from a worker'),
    // GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS and GIT_CONFIG_GLOBAL set config (aliases) through the environment.
    { re: /\bGIT_CONFIG/i, reason: 'git config through the environment from a worker' },
];
/**
 * Drop empty quotes (`c''ommit` -> `commit`), then strip quotes around single
 * tokens (`"omg" 'team'` -> `omg team`), so quoting cannot dodge a pattern.
 */
export function normalizeShellCommand(command) {
    return command.replace(/''|""/g, '').replace(/(["'])([^"'\s]+)\1/g, '$2');
}
function canon(p, platform) {
    let out = resolve(p);
    try {
        out = realpathSync.native(out);
    }
    catch { /* missing: keep the resolved form */ }
    out = out.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? out.toLowerCase() : out;
}
/** True when `p` is `root` or lies below it (realpath, case-folded on win32). */
export function isUnderRoot(p, root, platform = process.platform) {
    if (!p || !root)
        return false;
    const child = canon(p, platform);
    const parent = canon(root, platform);
    return child === parent || child.startsWith(`${parent}/`);
}
function requestPath(req, cwd) {
    for (const key of ['resolvedPath', 'path', 'fileName']) {
        const value = req[key];
        if (typeof value === 'string' && value.trim()) {
            return isAbsolute(value) ? value : resolve(cwd, value);
        }
    }
    return null;
}
/** `shell(<prefix>)` entries of `workerDenyTools`, as command prefixes. */
export function shellDenyPrefixes(denyTools = []) {
    const out = [];
    for (const raw of denyTools) {
        const m = /^shell\((.+)\)$/i.exec(raw.trim());
        if (m && m[1].trim())
            out.push(m[1].trim().replace(/:\*$/, ''));
    }
    return out;
}
function matchesDenyUrl(url, patterns) {
    const lower = url.toLowerCase();
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch { /* not a URL: substring match only */ }
    return patterns.some((p) => {
        const pattern = p.trim().toLowerCase();
        if (!pattern)
            return false;
        if (host && (host === pattern || host.endsWith(`.${pattern}`)))
            return true;
        return lower.includes(pattern);
    });
}
export function decideSdkPermission(req, ctx) {
    const platform = ctx.platform ?? process.platform;
    switch (req.kind) {
        case 'read': {
            const path = requestPath(req, ctx.cwd);
            if (!path)
                return { approve: true, reason: 'read without a path' };
            const roots = [ctx.cwd, ctx.stateRoot, ctx.pluginRoot, ...(ctx.readRoots ?? [])];
            return roots.some((root) => isUnderRoot(path, root, platform))
                ? { approve: true, reason: 'read inside worker roots' }
                : { approve: false, reason: `read outside worker roots: ${path}` };
        }
        case 'write': {
            const path = requestPath(req, ctx.cwd);
            if (!path)
                return { approve: false, reason: 'write without a path' };
            return isUnderRoot(path, ctx.cwd, platform) || isUnderRoot(path, ctx.stateRoot, platform)
                ? { approve: true, reason: 'write inside worktree or team state' }
                : { approve: false, reason: `write outside worktree and team state: ${path}` };
        }
        case 'shell': {
            const command = String(req.fullCommandText ?? '');
            if (!command.trim())
                return { approve: false, reason: 'shell without command text' };
            const normalized = normalizeShellCommand(command);
            for (const { re, reason } of SDK_SHELL_DENY_PATTERNS) {
                if (re.test(normalized))
                    return { approve: false, reason };
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
const KIND_TOOLS = {
    shell: ['shell', 'powershell', 'bash'],
    write: ['create', 'edit'],
};
/**
 * Built-in tools that start or drive other agents. A worker is one agent on
 * one credit cap; these would fan out work (and spend) outside the team's
 * task and claim protocol.
 */
export const SDK_AGENT_FANOUT_TOOLS = [
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
 * `<server>-host_smoke` and `<server>-copilot_run_*` tools and
 * {@link SDK_AGENT_FANOUT_TOOLS}) plus each bare
 * `workerDenyTools` name; `<server>(<tool>)` becomes `<server>-<tool>`, the
 * SDK's MCP tool name. `shell(<prefix>)` entries stay with the handler.
 */
export function buildSdkExcludedTools(mcpServer, denyTools = []) {
    const out = new Set([
        `${mcpServer}-host_smoke`,
        ...COPILOT_RUN_TOOL_NAMES.map((name) => `${mcpServer}-${name}`),
        ...SDK_AGENT_FANOUT_TOOLS,
    ]);
    for (const raw of denyTools) {
        const entry = raw.trim();
        if (!entry)
            continue;
        const call = /^([A-Za-z0-9_.-]+)\(([^)]*)\)$/.exec(entry);
        if (call) {
            if (call[1].toLowerCase() === 'shell' || call[1].toLowerCase() === 'write')
                continue;
            if (call[2])
                out.add(`${call[1]}-${call[2]}`);
            continue;
        }
        for (const name of KIND_TOOLS[entry.toLowerCase()] ?? [entry])
            out.add(name);
    }
    return [...out];
}
//# sourceMappingURL=sdk-policy.js.map