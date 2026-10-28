/**
 * OS sandbox plumbing for copilot_run sessions
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §3-§6).
 *
 * The Copilot runtime confines shell commands and local MCP/LSP servers in
 * Microsoft Execution Containers when a session carries a `sandboxConfig`.
 * SDK 1.0.16 has no createSession field for it, so the config goes through
 * `session.rpc.options.update` before the first turn; an SDK whose
 * createSession forwards the field gets it at create
 * (sdkCreateSessionAcceptsSandbox).
 *
 * Fail closed (§3): a review session without a confirmed sandbox runs with no
 * shell tool, a write session refuses with `sandbox-unavailable` unless
 * `writeUnsandboxed: "detect-only"` is set, and a shell call the runtime
 * reports as not sandboxed stops the session with `sandbox-escaped`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { userConfigLayers } from '../ship/config.js';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import { SMOKE_SET_ENV } from '../smoke/copilot-session-env.js';
import { isUnderRoot } from '../team/sdk-policy.js';
import { parseJsonc } from '../utils/jsonc.js';
/** Shell tools whose `tool.execution_complete` must carry `sandboxed: true` in an enforced session. */
export const SANDBOX_SHELL_TOOLS = new Set(['powershell', 'bash', 'shell']);
/** The built-in tools a review session keeps: view, search, and the turn bookkeeping tools. */
export const REVIEW_READ_TOOLS = ['view', 'grep', 'glob', 'rg', 'report_intent', 'task_complete', 'update_todo', 'think'];
/** The shell tools a review session adds when its sandbox is confirmed (no write_* input to a running shell). */
export const REVIEW_SHELL_TOOLS = ['powershell', 'bash', 'read_powershell', 'read_bash', 'stop_powershell', 'stop_bash'];
export const DEFAULT_SANDBOX_SETTINGS = Object.freeze({
    enabled: true,
    reviewUnsandboxed: 'no-shell',
    writeUnsandboxed: 'refuse',
    writeNetwork: 'none',
    allowedHosts: [],
    extraReadonlyPaths: [],
    extraReadwritePaths: [],
});
/** The env kill switch (§6): honoured from the MCP server's / engine's env only, never from repo config. */
export const SANDBOX_KILL_ENV = 'OMG_SANDBOX';
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
/** The `sandbox` block of one config file for `scope` (factory: `copilotRun.sandbox` then `factory.run.sandbox`). */
function sandboxBlock(config, scope, source) {
    const pick = (value, name) => {
        if (value === undefined || value === null)
            return {};
        if (typeof value !== 'object' || Array.isArray(value))
            throw new Error(`${source}: ${name} must be an object`);
        return value;
    };
    const c = (config ?? {});
    const base = pick(c.copilotRun?.sandbox, 'copilotRun.sandbox');
    return scope === 'factory' ? { ...base, ...pick(c.factory?.run?.sandbox, 'factory.run.sandbox') } : base;
}
/** Merge a block over the defaults; ill-typed fields are rejected, not ignored. */
export function resolveSandboxSettings(raw, source = 'sandbox') {
    const out = { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] };
    const bad = (key, want) => { throw new Error(`${source}.${key} must be ${want}`); };
    const oneOf = (key, values) => values.includes(raw[key]) ? raw[key] : bad(key, values.map((v) => JSON.stringify(v)).join(' or '));
    if (raw.enabled !== undefined)
        out.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : bad('enabled', 'a boolean');
    if (raw.reviewUnsandboxed !== undefined)
        out.reviewUnsandboxed = oneOf('reviewUnsandboxed', ['no-shell', 'refuse']);
    if (raw.writeUnsandboxed !== undefined)
        out.writeUnsandboxed = oneOf('writeUnsandboxed', ['refuse', 'detect-only']);
    if (raw.writeNetwork !== undefined)
        out.writeNetwork = oneOf('writeNetwork', ['none', 'registry']);
    for (const key of ['allowedHosts', 'extraReadonlyPaths', 'extraReadwritePaths']) {
        if (raw[key] === undefined)
            continue;
        if (!isStringArray(raw[key]))
            bad(key, 'a string array');
        if (key !== 'allowedHosts' && !raw[key].every((p) => isAbsolute(p)))
            bad(key, 'an array of absolute paths');
        out[key] = [...raw[key]];
    }
    return out;
}
function defaultLayers(root) {
    let user = null;
    try {
        user = userConfigLayers().trustedUser;
    }
    catch { /* unreadable: defaults */ }
    const path = resolveProjectConfigPath(root);
    const project = existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
    return { user, project };
}
/**
 * The settings for a session in `root`: the user config, then the project
 * config, which may only tighten (§6, the `ship.*` trust split): it can set
 * `enabled: true`, `reviewUnsandboxed: "refuse"`, `writeUnsandboxed:
 * "refuse"` and `writeNetwork: "none"`, never the looser values, hosts or
 * extra paths. A malformed block throws.
 */
export function loadSandboxSettings(root, scope, layers = defaultLayers(root)) {
    const settings = resolveSandboxSettings(sandboxBlock(layers.user, scope, 'user config'), 'user config sandbox');
    const projectRaw = sandboxBlock(layers.project, scope, 'project config');
    const project = resolveSandboxSettings(projectRaw, 'project config sandbox');
    const warnings = [];
    if (projectRaw.enabled === true)
        settings.enabled = true;
    if (projectRaw.reviewUnsandboxed === 'refuse')
        settings.reviewUnsandboxed = 'refuse';
    if (projectRaw.writeUnsandboxed === 'refuse')
        settings.writeUnsandboxed = 'refuse';
    if (projectRaw.writeNetwork === 'none')
        settings.writeNetwork = 'none';
    const loosening = [];
    if (projectRaw.enabled === false)
        loosening.push('enabled');
    if (project.reviewUnsandboxed !== 'refuse' && projectRaw.reviewUnsandboxed !== undefined)
        loosening.push('reviewUnsandboxed');
    if (project.writeUnsandboxed !== 'refuse' && projectRaw.writeUnsandboxed !== undefined)
        loosening.push('writeUnsandboxed');
    if (project.writeNetwork !== 'none' && projectRaw.writeNetwork !== undefined)
        loosening.push('writeNetwork');
    for (const key of ['allowedHosts', 'extraReadonlyPaths', 'extraReadwritePaths'])
        if (projectRaw[key] !== undefined)
            loosening.push(key);
    if (loosening.length > 0)
        warnings.push(`sandbox: ignoring ${loosening.join(', ')} from the project config; it may only tighten the sandbox`);
    return { settings, warnings };
}
export const REGISTRY_HOSTS = ['registry.npmjs.org', '*.npmjs.org'];
/** The target of `<worktree>/node_modules` when it is a junction or symlink (read-only for a write session). */
function nodeModulesLinkTarget(worktree) {
    const nm = join(worktree, 'node_modules');
    try {
        return lstatSync(nm).isSymbolicLink() ? realpathSync.native(nm) : null;
    }
    catch {
        return null;
    }
}
/**
 * The read-write carve-outs of the read-only common git dir for a write
 * session: `objects/` and its own `worktrees/<name>` admin dir. No ref is
 * granted: the job worktree's HEAD is detached, so a commit writes only the
 * admin dir's HEAD, index and logs/HEAD, and the host moves the job's branch
 * after the session (job.ts syncJobBranch). One job cannot rewrite another
 * job's branch. Without a linked worktree (isolation "none") the git dir is
 * the common dir and only `objects/` is granted: the session cannot commit,
 * it fails closed.
 *
 * The grants are directories, and git writes by lock and rename (`index.lock`
 * then `index`, `HEAD.lock` then `HEAD`), which needs create and rename rights
 * in the directory itself, so the admin dir's `commondir`, `gitdir` and
 * `config.worktree` files (and the worktree's `.git` file) cannot be kept
 * read-only inside it: a lane can create or rename over any of them. The
 * host records them at creation (config.worktree as a hash, absent counts)
 * and runs no git in the worktree once they differ (git-worktree.ts
 * worktreeGitLinksIntact, and runHostGit before every command), with every host git call
 * hardened (hostGitHardeningArgs) and pointed at the recorded git dir.
 * `objects/info/alternates` is writable for the same reason: it only adds
 * places to look objects up, runs no code, and cannot forge an object,
 * because git names every object by the hash of its content.
 */
export function laneGitWritePaths(ctx) {
    const out = [join(ctx.commonGitDir, 'objects')];
    const own = ctx.gitDir && resolve(ctx.gitDir) !== resolve(ctx.commonGitDir) && isUnderRoot(ctx.gitDir, join(ctx.commonGitDir, 'worktrees'), ctx.platform) ? ctx.gitDir : null;
    if (own)
        out.push(own);
    return out;
}
/**
 * The sandboxConfig for a session. `review` is §4.2 exactly. `write` with
 * `hostCommits` (omg factory run, whose engine commits after the lane) is
 * §4.3: the common git dir is read-only as a whole, so the session cannot
 * stage, commit or write any git file. `write` without it (a copilot_run job
 * that commits in its worktree) keeps the common git dir read-only except
 * what a commit on its detached HEAD writes (laneGitWritePaths). Either way
 * config, hooks, info, packed-refs and every ref stay read-only: the session
 * cannot plant core.hooksPath, core.fsmonitor or a hook for host-side git.
 * `deniedPaths` is sent only when the host reports `denied_paths`. An extra
 * read-write path outside the worktree throws.
 */
export function buildSandboxConfig(profile, ctx, host) {
    const { settings } = ctx;
    for (const p of settings.extraReadwritePaths) {
        if (!isUnderRoot(p, ctx.worktree, ctx.platform))
            throw new Error(`sandbox.extraReadwritePaths: ${p} is not under the worktree ${ctx.worktree}`);
    }
    const common = {
        allowBypass: false,
        allowDevToolAccess: false,
        sandboxMcpServers: true,
        sandboxLspServers: true,
        auth: { git: false, gh: false },
    };
    if (profile === 'review') {
        return {
            enabled: true,
            addCurrentWorkingDirectory: false,
            ...common,
            userPolicy: {
                filesystem: {
                    readonlyPaths: [ctx.worktree, ctx.commonGitDir, ctx.pluginRoot, ctx.jobHome, ...settings.extraReadonlyPaths],
                    readwritePaths: [ctx.jobDir, ...settings.extraReadwritePaths],
                },
                network: { allowOutbound: false, allowLocalNetwork: false },
            },
        };
    }
    const nm = nodeModulesLinkTarget(ctx.worktree);
    const filesystem = {
        readwritePaths: [ctx.worktree, ctx.jobDir, ...(ctx.hostCommits ? [] : laneGitWritePaths(ctx)), ...settings.extraReadwritePaths],
        readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, ctx.jobHome, ...(nm ? [nm] : []), ...settings.extraReadonlyPaths],
    };
    if (host.capabilities.denied_paths === true) {
        filesystem.deniedPaths = ['.ssh', '.gitconfig', '.omg', '.copilot'].map((p) => join(ctx.realHome, p));
    }
    const network = settings.writeNetwork === 'registry'
        ? { allowOutbound: true, allowedHosts: [...REGISTRY_HOSTS, ...settings.allowedHosts], allowLocalNetwork: ctx.platform === 'win32' }
        : { allowOutbound: false, allowLocalNetwork: false };
    return { enabled: true, addCurrentWorkingDirectory: true, ...common, userPolicy: { filesystem, network } };
}
// ---------------------------------------------------------------------------
// Detection (§5)
// ---------------------------------------------------------------------------
const errText = (err) => (err instanceof Error ? err.message : String(err));
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
/** A method `name` on `obj.<path>` bound to its owner, or null (getters that throw count as missing). */
function rpcMethod(root, path, name) {
    try {
        let owner = root;
        for (const key of path)
            owner = owner?.[key];
        const fn = owner?.[name];
        return typeof fn === 'function' ? fn.bind(owner) : null;
    }
    catch {
        return null;
    }
}
/** `client.rpc.sandbox.getHostSupport()`; supported only with the `shell` capability. */
export async function probeHostSupport(client, timeoutMs) {
    const call = rpcMethod(client, ['rpc', 'sandbox'], 'getHostSupport');
    if (!call)
        return { supported: false, reason: 'the SDK has no sandbox.getHostSupport RPC', capabilities: {} };
    try {
        const res = (await withTimeout(call(), timeoutMs, 'sandbox.getHostSupport()'));
        const capabilities = {};
        for (const c of Array.isArray(res?.capabilities) ? res.capabilities : []) {
            if (typeof c?.name === 'string')
                capabilities[c.name] = c.supported === true;
        }
        const reason = typeof res?.reason === 'string' ? res.reason : undefined;
        if (res?.supported !== true)
            return { supported: false, reason: reason ?? 'the host does not support the sandbox', capabilities };
        if (capabilities.shell !== true)
            return { supported: false, reason: 'the host reports no shell sandbox capability', capabilities };
        return { supported: true, ...(reason ? { reason } : {}), capabilities };
    }
    catch (err) {
        return { supported: false, reason: `sandbox.getHostSupport failed: ${errText(err)}`, capabilities: {} };
    }
}
/** `session.rpc.options.update({ sandboxConfig })`; null when applied, else why not. */
export async function applySandboxConfig(session, config, timeoutMs) {
    const update = rpcMethod(session, ['rpc', 'options'], 'update');
    if (!update)
        return 'the SDK has no options.update RPC';
    try {
        const res = (await withTimeout(update({ sandboxConfig: config, sandboxConfigSource: 'session_flag' }), timeoutMs, 'options.update()'));
        return res?.success === true ? null : 'options.update did not report success';
    }
    catch (err) {
        return `options.update failed: ${errText(err)}`;
    }
}
/** `session.rpc.sandbox.getEnforcementStatus()`, or why it could not be read. */
export async function readEnforcement(session, timeoutMs) {
    const call = rpcMethod(session, ['rpc', 'sandbox'], 'getEnforcementStatus');
    if (!call)
        return 'the SDK has no sandbox.getEnforcementStatus RPC';
    try {
        const res = (await withTimeout(call(), timeoutMs, 'sandbox.getEnforcementStatus()'));
        return {
            required: res?.required === true,
            blocked: res?.blocked !== false,
            ...(typeof res?.reason === 'string' ? { reason: res.reason } : {}),
        };
    }
    catch (err) {
        return `sandbox.getEnforcementStatus failed: ${errText(err)}`;
    }
}
/**
 * What a session runs as when its sandbox is not confirmed (§3):
 * review -> `read-only-no-shell` (or `refused` with reviewUnsandboxed
 * "refuse"), write -> `refused` (or `detect-only` with writeUnsandboxed
 * "detect-only").
 */
export function unconfirmedMode(profile, settings) {
    if (profile === 'review')
        return settings.reviewUnsandboxed === 'refuse' ? 'refused' : 'read-only-no-shell';
    return settings.writeUnsandboxed === 'detect-only' ? 'detect-only' : 'refused';
}
// ---------------------------------------------------------------------------
// Environment (§4.3 L4)
// ---------------------------------------------------------------------------
/**
 * Caller variables the runtime keeps (case-insensitive); everything else,
 * secrets included, is dropped. No credential passes: the runtime's env is
 * what its shell children inherit, so COPILOT_GITHUB_TOKEN goes to the
 * session over RPC instead (sessionGitHubToken).
 */
export const SESSION_ENV_ALLOWLIST = [
    'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG',
    // Non-secret OS variables shells and git expect.
    'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER', 'LOGNAME', 'TERM', 'TZ',
];
/** The caller's env value for `name`, looked up case-insensitively (Windows env keys). */
function envValue(env, name) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name);
    const value = key === undefined ? undefined : env[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
/**
 * The explicit Copilot credential for the session's `gitHubToken` option
 * (SDK 1.0.16 SessionConfig: sent over the session RPC, never put in the
 * runtime's env, unlike the client-level option).
 */
export function sessionGitHubToken(env) {
    return envValue(env, 'COPILOT_GITHUB_TOKEN');
}
/** GitHub token shapes: classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_. */
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
/** The token values in the caller's env that lane output must never carry. */
export function secretValues(env) {
    return ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
        .map((n) => envValue(env, n))
        .filter((v) => v !== undefined && v.length >= 8);
}
/**
 * `text` with every GitHub token shape and every exact `secrets` value
 * replaced by `[redacted]`. It matches literal text only: a token that is
 * base64-encoded, URL-encoded, split across lines or events, or otherwise
 * transformed passes through unredacted.
 */
export function scrubTokens(text, secrets) {
    let out = text;
    for (const s of secrets)
        out = out.split(s).join('[redacted]');
    return out.replace(TOKEN_PATTERN, '[redacted]');
}
/** The relocated profile variables, all under `<jobHome>/profile`. */
export function relocatedProfileEnv(jobHome) {
    const profile = join(jobHome, 'profile');
    return {
        USERPROFILE: profile,
        HOME: profile,
        XDG_CONFIG_HOME: join(profile, '.config'),
        GIT_CONFIG_GLOBAL: join(profile, '.gitconfig'),
    };
}
/**
 * The runtime env from buildSessionEnv's output: allowlisted caller
 * variables, `LC_*`, the variables the job sets (COPILOT_HOME, the
 * SMOKE_SET_ENV flags, OMC_* — buildSessionEnv already stripped the
 * caller's), and the relocated profile. NODE_OPTIONS, GH_TOKEN, GITHUB_TOKEN,
 * cloud and npm tokens never pass.
 */
export function allowlistSessionEnv(env, jobHome) {
    const allow = new Set([...SESSION_ENV_ALLOWLIST, ...Object.keys(SMOKE_SET_ENV), 'COPILOT_HOME'].map((k) => k.toUpperCase()));
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        const upper = key.toUpperCase();
        if (allow.has(upper) || upper.startsWith('LC_') || upper.startsWith('OMC_'))
            out[key] = value;
    }
    return { ...out, ...relocatedProfileEnv(jobHome) };
}
//# sourceMappingURL=sandbox.js.map