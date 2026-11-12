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
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { userConfigLayers } from '../ship/config.js';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import { SMOKE_SET_ENV } from '../smoke/copilot-session-env.js';
import { isUnderRoot } from '../team/sdk-policy.js';
import { parseJsonc } from '../utils/jsonc.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { getGlobalOmcStateRoot } from '../utils/paths.js';
import { findOnPath } from '../utils/windows-search.js';
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
export const GATES_SANDBOX_MODES = ['enforced', 'ack', 'unsandboxed'];
/**
 * The gates mode and where it came from. The kill switch wins, then the user
 * config, then the base's committed config, then `enforced`. The base may set
 * `enforced` or `ack` but never `unsandboxed` (the PR's repository must not
 * switch the sandbox off for its own code): that throws, as does any other
 * value.
 */
export function resolveGatesSandboxMode(layers) {
    // The kill switch never runs the PR's code unsandboxed by itself: it parks per head for the human's ack.
    if (layers.env[SANDBOX_KILL_ENV] === 'off')
        return { mode: 'ack', source: `${SANDBOX_KILL_ENV}=off` };
    const read = (config, source) => {
        // factory.run.sandbox only: copilotRun.sandbox (copilot_run jobs) has no gates.
        const value = sandboxBlock({ factory: config?.factory }, 'factory', source).gates;
        if (value === undefined)
            return undefined;
        if (!GATES_SANDBOX_MODES.includes(value))
            throw new Error(`${source}: factory.run.sandbox.gates must be ${GATES_SANDBOX_MODES.map((m) => JSON.stringify(m)).join(' or ')}`);
        return value;
    };
    const user = read(layers.user, 'user config');
    const base = read(layers.base, 'the base .copilot/omg.jsonc');
    if (base === 'unsandboxed') {
        throw new Error('factory.run.sandbox.gates "unsandboxed" is accepted from the user config only, never from the repository\'s .copilot/omg.jsonc; set it in your user config, or use "ack" there');
    }
    if (user)
        return { mode: user, source: 'user config' };
    if (base)
        return { mode: base, source: 'the base .copilot/omg.jsonc' };
    return { mode: 'enforced', source: 'default' };
}
/**
 * `factory.run.sandbox.requireDeniedPaths`: a sandboxed gate on a host that
 * does not report `denied_paths` (Windows today) runs and counts by default,
 * with the credential files under the user profile readable; `true` makes
 * such a host give no verdict (the gates-unsandboxed park). Read from the
 * user config and the base-committed `.copilot/omg.jsonc` only; either layer
 * can turn it on and no layer can turn it off over the other's `true`.
 */
export function resolveRequireDeniedPaths(layers) {
    const read = (config, source) => {
        const value = sandboxBlock({ factory: config?.factory }, 'factory', source).requireDeniedPaths;
        if (value === undefined)
            return undefined;
        if (typeof value !== 'boolean')
            throw new Error(`${source}: factory.run.sandbox.requireDeniedPaths must be a boolean`);
        return value;
    };
    const user = read(layers.user, 'user config');
    const base = read(layers.base, 'the base .copilot/omg.jsonc');
    if (user)
        return { require: true, source: 'user config' };
    if (base)
        return { require: true, source: 'the base .copilot/omg.jsonc' };
    return { require: false, source: user === false || base === false ? 'config' : 'default' };
}
const CONTAINER_KEYS = ['runtime', 'image', 'memory', 'cpus', 'pidsLimit', 'installTimeoutMinutes', 'diskLimit'];
/** The default gate image: the host Node major on Debian bookworm slim. */
export const defaultGateImage = (nodeVersion = process.versions.node) => `node:${nodeVersion.split('.')[0]}-bookworm-slim`;
/**
 * `factory.run.sandbox.isolation` and `factory.run.sandbox.container` from
 * the USER config only: the PR's repository must never choose where its own
 * code runs or with what limits, so a value committed in the base's
 * `.copilot/omg.jsonc` is ignored (`ignoredBase` names it for a notice). A
 * malformed user value throws. The image may not start with `-` (it is one
 * argv word after the runtime's options) and holds only reference characters.
 */
export function resolveGateIsolation(layers, nodeVersion = process.versions.node) {
    const block = (config) => {
        const raw = config?.factory?.run?.sandbox;
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    };
    const base = block(layers.base);
    const ignoredBase = ['isolation', 'container'].filter((k) => base[k] !== undefined).map((k) => `factory.run.sandbox.${k}`);
    const user = block(layers.user);
    const bad = (key, want) => { throw new Error(`user config: factory.run.sandbox.${key} must be ${want}`); };
    const isolation = user.isolation === undefined ? 'copilot' : user.isolation === 'copilot' || user.isolation === 'container' ? user.isolation : bad('isolation', '"copilot" or "container"');
    const raw = user.container ?? {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        bad('container', 'an object');
    const c = raw;
    const unknown = Object.keys(c).filter((k) => !CONTAINER_KEYS.includes(k));
    if (unknown.length > 0)
        bad('container', `an object with only ${CONTAINER_KEYS.join(', ')} (got ${unknown.join(', ')})`);
    const int = (key, min, max, fallback) => {
        const v = c[key];
        if (v === undefined)
            return fallback;
        return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : bad(`container.${key}`, `an integer from ${min} to ${max}`);
    };
    const runtime = c.runtime === undefined ? 'docker' : c.runtime === 'docker' || c.runtime === 'podman' ? c.runtime : bad('container.runtime', '"docker" or "podman"');
    const image = c.image === undefined ? defaultGateImage(nodeVersion)
        : typeof c.image === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(c.image) ? c.image : bad('container.image', 'an image reference (letters, digits and . _ / : @ -, not starting with -)');
    const memory = c.memory === undefined ? '4g' : typeof c.memory === 'string' && /^[1-9]\d{0,5}[kmg]$/i.test(c.memory) ? c.memory : bad('container.memory', 'a size such as "4g" or "512m"');
    const cpus = c.cpus === undefined ? 2 : typeof c.cpus === 'number' && c.cpus > 0 && c.cpus <= 64 ? c.cpus : bad('container.cpus', 'a number above 0 and at most 64');
    const diskLimit = c.diskLimit === undefined ? '10g' : typeof c.diskLimit === 'string' && /^[1-9]\d{0,5}[mg]$/i.test(c.diskLimit) ? c.diskLimit : bad('container.diskLimit', 'a size such as "10g" or "800m"');
    const container = { runtime, image, memory, cpus, pidsLimit: int('pidsLimit', 64, 65_536, 1_024), installTimeoutMinutes: int('installTimeoutMinutes', 1, 120, 15), diskLimit };
    return { isolation, ...(isolation === 'container' ? { container } : {}), ignoredBase };
}
export const REGISTRY_HOSTS = ['registry.npmjs.org', '*.npmjs.org'];
/** `real` (a realpath) is the realpath of `want`; false when `want` cannot be resolved. Case-folded on win32. */
function sameRealPath(real, want, platform) {
    let w;
    try {
        w = realpathSync.native(want);
    }
    catch {
        return false;
    }
    return platform === 'win32' ? real.toLowerCase() === w.toLowerCase() : real === w;
}
/**
 * Why `<worktree>/node_modules` must not be granted, or null. `target` is the
 * engine-recorded node_modules (review-483 M4). A single link must resolve
 * to it (older releases). A real directory is the engine's per-run tree
 * (factory/run/prepare.ts linkNodeModules): each top-level link in it must
 * point at `<target>/<its own name>` exactly, so a link the PR's code
 * re-pointed or added (to your home, your checkout, a git dir) is refused,
 * never granted. Plain dirs and files in it are the checkout's own
 * (read-write anyway). `linked`: the tree uses `target` at all.
 *
 * Workspaces (factory/run/workspace-tree.ts): a link may also point into
 * the worktree itself, lexically and by realpath (a workspace self-link to
 * the gate checkout's package; it grants nothing the worktree does not
 * have), and the links in a real `@scope` dir are checked the same way. The
 * tree's marker lists nested trees (`<rel>/node_modules`); each line of the
 * exact relative shape, through plain dirs only, is checked with
 * `<dirname(target)>/<rel>/node_modules` as its target, and that dir (a
 * real dir, never a link) is returned in `nested` as a candidate: the
 * grant needs an exact match with the engine's own list too
 * (nestedNodeModulesTargets). A line of another shape is ignored.
 */
export function nodeModulesTreeProblem(worktree, target, platform = process.platform) {
    const nm = join(worktree, 'node_modules');
    let st;
    try {
        st = lstatSync(nm);
    }
    catch {
        return { problem: null, linked: false };
    }
    if (st.isSymbolicLink()) {
        let real;
        try {
            real = realpathSync.native(nm);
        }
        catch (error) {
            return { problem: `${nm} is a link that cannot be resolved (${error instanceof Error ? error.message : String(error)})`, linked: false };
        }
        return sameRealPath(real, target, platform) ? { problem: null, linked: true } : { problem: `${nm} resolves to ${real}, not your node_modules ${target} (the only target the engine links)`, linked: false };
    }
    if (!st.isDirectory())
        return { problem: null, linked: false };
    const P = platform === 'win32' ? win32 : posix;
    const same = (a, b) => (platform === 'win32' ? P.resolve(a).toLowerCase() === P.resolve(b).toLowerCase() : P.resolve(a) === P.resolve(b));
    // Lexically under the worktree (never the worktree itself), and the link's realpath too (isUnderRoot resolves links).
    const insideWorktree = (p, to) => {
        const rel = P.relative(P.resolve(worktree), to);
        if (!rel || rel.startsWith('..') || P.isAbsolute(rel))
            return false;
        try {
            return isUnderRoot(p, worktree, platform);
        }
        catch {
            return false;
        }
    };
    /** The links in `dir` (and in its real `@scope` dirs): each `<base>/<name>` or into the worktree; true when one uses `base`. */
    const check = (dir, base, scoped) => {
        let linked = false;
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            let link;
            try {
                const e = lstatSync(p);
                if (!e.isSymbolicLink()) {
                    if (!scoped && name.startsWith('@') && e.isDirectory()) {
                        const inner = check(p, join(base, name), true);
                        if ('problem' in inner)
                            return inner;
                        linked ||= inner.linked;
                    }
                    continue;
                }
                link = readlinkSync(p);
            }
            catch (error) {
                return { problem: `${p} cannot be read (${error instanceof Error ? error.message : String(error)})` };
            }
            const to = P.resolve(P.dirname(p), link);
            if (same(to, join(base, name)))
                linked = true;
            else if (!insideWorktree(p, to))
                return { problem: `${p} points to ${to}, not ${join(base, name)} the engine linked` };
        }
        return { linked };
    };
    const top = check(nm, target, false);
    if ('problem' in top)
        return { problem: top.problem, linked: false };
    const nested = [];
    for (const rel of gateTreeNestedRels(nm)) {
        let dir = worktree;
        let plain = true;
        for (const s of rel.split('/')) {
            dir = join(dir, s);
            try {
                const e = lstatSync(dir);
                plain = !e.isSymbolicLink() && e.isDirectory();
            }
            catch {
                plain = false;
            }
            if (!plain)
                break;
        }
        const inner = join(dir, 'node_modules');
        try {
            if (!plain || lstatSync(inner).isSymbolicLink() || !lstatSync(inner).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        const yours = join(P.dirname(target), ...rel.split('/'), 'node_modules');
        // Only a workspace package of yours: its package.json is there and its dir lies in your checkout by realpath.
        try {
            if (!lstatSync(join(P.dirname(yours), 'package.json')).isFile() || !isUnderRoot(P.dirname(yours), P.dirname(target), platform))
                continue;
        }
        catch {
            continue;
        }
        const r = check(inner, yours, false);
        if ('problem' in r)
            return { problem: r.problem, linked: false };
        if (!r.linked)
            continue;
        try {
            if (lstatSync(yours).isSymbolicLink() || !lstatSync(yours).isDirectory())
                return { problem: `${yours} is not a plain directory, so the links of ${inner} to it are not granted`, linked: false };
            nested.push(realpathSync.native(yours));
        }
        catch (error) {
            return { problem: `${yours} cannot be read (${error instanceof Error ? error.message : String(error)})`, linked: false };
        }
    }
    return { problem: null, linked: top.linked, ...(nested.length > 0 ? { nested } : {}) };
}
/** The engine's marker in a gate node_modules tree (factory/run/prepare.ts GATE_TREE_MARKER; the team bundle may not import src/factory). */
const GATE_TREE_MARKER_NAME = '.omg-gate-tree';
/** The nested tree dirs the marker of the gate tree `nm` lists, each of the exact relative shape (no empty, dot or node_modules segment in any case, none ending in a dot or space or holding `~`, not absolute, no drive or backslash; at most 6 segments). */
function gateTreeNestedRels(nm) {
    const marker = join(nm, GATE_TREE_MARKER_NAME);
    try {
        const m = lstatSync(marker);
        if (!m.isFile() || m.size > 64 * 1024)
            return [];
    }
    catch {
        return [];
    }
    return [...new Set(readFileSync(marker, 'utf-8').split('\n'))].filter((rel) => {
        if (!rel || rel.length > 512 || /[\\:\0-\x1f]/.test(rel) || rel.startsWith('/'))
            return false;
        const segs = rel.split('/');
        // No dot segment (`.omg`, `.git`: engine state and other runs' checkouts) and no node_modules segment, nor a win32 alias of one.
        return segs.length <= 6 && segs.every((s) => s !== '' && !s.startsWith('.') && !/[ .]$/.test(s) && !s.includes('~') && s.toLowerCase() !== 'node_modules');
    });
}
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
 * in the directory itself. The admin dir's `commondir`, `gitdir` and
 * `config.worktree` files and the worktree's `.git` file are read-only
 * entries nested in those grants (buildSandboxConfig): on Copilot CLI 1.0.105
 * on Windows the sandbox then refuses writing, renaming over and deleting
 * them, but it cannot protect a name that does not exist yet. The
 * host also records them at creation (config.worktree as a hash, absent counts)
 * and runs no git in the worktree once they differ (git-worktree.ts
 * worktreeGitLinksIntact, and runHostGit before every command), with every host git call
 * hardened (hostGitHardeningArgs) and pointed at the recorded git dir.
 * `objects/info/alternates` is writable for the same reason: it only adds
 * places to look objects up, runs no code, and cannot forge an object,
 * because git names every object by the hash of its content.
 */
export function laneGitWritePaths(ctx) {
    const out = [join(ctx.commonGitDir, 'objects')];
    const own = ownGitDir(ctx);
    if (own)
        out.push(own);
    return out;
}
/** The session's own `<commonGitDir>/worktrees/<name>` admin dir, or null (isolation "none", or a git dir elsewhere). */
function ownGitDir(ctx) {
    return ctx.gitDir && resolve(ctx.gitDir) !== resolve(ctx.commonGitDir) && isUnderRoot(ctx.gitDir, join(ctx.commonGitDir, 'worktrees'), ctx.platform) ? ctx.gitDir : null;
}
function existingFile(p) {
    try {
        return lstatSync(p).isFile() ? p : null;
    }
    catch {
        return null;
    }
}
/** `/tmp`, `/var/tmp` or another sticky world-writable dir: every user's files share it, so it is never denied whole. */
function stickyShared(dir) {
    if (dir === '/tmp' || dir === '/var/tmp')
        return true;
    try {
        const { mode } = statSync(dir);
        return (mode & 0o1000) !== 0 && (mode & 0o002) !== 0;
    }
    catch {
        return false;
    }
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
 * read-write path outside the worktree throws. The tool dirs (`toolPaths`)
 * are read-only in both profiles; one that holds the real home, the worktree,
 * the common git dir or the job dir (a `D:\dev\node.exe` with every repo
 * beside it), or is a filesystem root, is dropped.
 */
export function buildSandboxConfig(profile, ctx, host) {
    const { settings } = ctx;
    for (const p of settings.extraReadwritePaths) {
        if (!isUnderRoot(p, ctx.worktree, ctx.platform))
            throw new Error(`sandbox.extraReadwritePaths: ${p} is not under the worktree ${ctx.worktree}`);
    }
    const P = ctx.platform === 'win32' ? win32 : posix;
    const real = (p) => { try {
        return realpathSync.native(p);
    }
    catch {
        return p;
    } };
    // A path that does not resolve (a dangling link) is dropped rather than failing the whole config.
    const tools = [...(ctx.toolPaths ?? []), ...(ctx.extraReadonly ?? [])].filter((p) => {
        try {
            return P.dirname(P.resolve(real(p))) !== P.resolve(real(p)) && ![ctx.realHome, ctx.worktree, ctx.commonGitDir, ctx.jobDir].some((x) => x && isUnderRoot(x, p, ctx.platform));
        }
        catch {
            return false;
        }
    });
    // Of the job home only the relocated temp and profile dirs: the runtime reads config.json, its session
    // state, policies and logs from the rest, and loads code from the package cache (relocatedProfileEnv).
    // The lane's global git config is read-only.
    const relocated = relocatedProfileEnv(ctx.jobHome);
    const laneHome = [relocated.TEMP, relocated.USERPROFILE];
    const gitConfigDir = dirname(relocated.GIT_CONFIG_GLOBAL);
    // The unsandboxed runtime runs git in the worktree too: a lane that rewrote the worktree's `.git` gitfile or
    // the admin dir's commondir or config.worktree would point that git at its own config (core.fsmonitor, a filter
    // driver). The sandbox keeps a read-only file nested in a read-write dir read-only, rename-over and delete
    // included (Copilot CLI 1.0.105, Windows), but only a file that exists: job.ts creates config.worktree when git
    // reads one. `<worktree>/.git` is a file only in a linked worktree; with isolation "none" it is the (read-only)
    // git dir. With hostCommits the whole common git dir, the admin dir in it, is read-only already.
    const own = ctx.hostCommits ? null : ownGitDir(ctx);
    const gitLinks = [join(ctx.worktree, '.git'), ...(own ? ['commondir', 'gitdir', 'config.worktree'].map((f) => join(own, f)) : [])]
        .map(existingFile).filter((p) => p !== null);
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
                    readonlyPaths: [ctx.worktree, ctx.commonGitDir, ctx.pluginRoot, gitConfigDir, ...gitLinks, ...tools, ...settings.extraReadonlyPaths],
                    readwritePaths: [...laneHome, ...settings.extraReadwritePaths],
                },
                network: { allowOutbound: false, allowLocalNetwork: false },
            },
        };
    }
    // The worktree is read-write: a job dir inside it (isolation "none" with the OMC state root in the repository)
    // would hand the lane the job home and events.jsonl, which the unsandboxed engine and runtime read back.
    if (isUnderRoot(ctx.jobDir, ctx.worktree, ctx.platform)) {
        throw new Error(`the job dir ${ctx.jobDir} lies inside the lane-writable worktree ${ctx.worktree}; use isolation "worktree"`);
    }
    let nm;
    let nested = [];
    if (ctx.nodeModulesTarget === undefined)
        nm = nodeModulesLinkTarget(ctx.worktree);
    else {
        // The engine's link or per-run tree: only the engine-recorded target is granted (read-only), never a link's own target.
        const tree = nodeModulesTreeProblem(ctx.worktree, ctx.nodeModulesTarget, ctx.platform);
        if (tree.problem)
            throw new Error(`the node_modules in ${ctx.worktree} is not as the engine linked it (${tree.problem}); it is not granted`);
        nm = null;
        if (tree.linked)
            try {
                nm = realpathSync.native(ctx.nodeModulesTarget);
            }
            catch { /* nothing to grant */ }
        // A workspace package's node_modules of yours that a nested gate tree links to (read-only, like the root's), only
        // when it is exactly one the engine validated (review-501 M1): the marker naming it is PR-writable.
        const fold = (p) => (ctx.platform === 'win32' ? p.toLowerCase() : p);
        const allowed = new Set((ctx.nestedNodeModulesTargets ?? []).flatMap((p) => { try {
            return [fold(realpathSync.native(p))];
        }
        catch {
            return [];
        } }));
        nested = (tree.nested ?? []).filter((p) => allowed.has(fold(p)));
    }
    const filesystem = {
        readwritePaths: [ctx.worktree, ...laneHome, ...(ctx.hostCommits ? [] : laneGitWritePaths(ctx)), ...settings.extraReadwritePaths],
        readonlyPaths: [ctx.commonGitDir, ctx.pluginRoot, gitConfigDir, ...gitLinks, ...(nm ? [nm] : []), ...nested, ...tools, ...settings.extraReadonlyPaths],
    };
    if (host.capabilities.denied_paths === true) {
        // Git's plaintext credential stores (~/.git-credentials, XDG), the credential-cache daemon's socket dir, and the
        // gh, cloud, registry, container and signing credentials.
        filesystem.deniedPaths = [
            '.ssh', '.gitconfig', '.omg', '.copilot', '.azure', '.git-credentials', join('.config', 'git', 'credentials'), join('.cache', 'git', 'credential'),
            join('.config', 'gh'), '.aws', '.npmrc', '.docker', '.kube', '.netrc', join('.cargo', 'credentials'), join('.cargo', 'credentials.toml'),
            '.gnupg', '.pypirc', join('.config', 'gcloud'),
            // Windows: gh's hosts.yml (%APPDATA%\GitHub CLI) and the GCM/MSAL token cache (%LOCALAPPDATA%\.IdentityService).
            ...(ctx.platform === 'win32' ? [join('AppData', 'Roaming', 'GitHub CLI'), join('AppData', 'Local', '.IdentityService')] : []),
        ].map((p) => join(ctx.realHome, p));
        // A grant canon cannot resolve (a dangling link) holds nothing: the deny stays.
        // A nested workspace grant never lifts a deny (the PR-writable marker names it): a deny around it stays.
        const grants = [...filesystem.readwritePaths, ...filesystem.readonlyPaths.filter((p) => !nested.includes(p)), ctx.realHome];
        const holdsGrant = (s) => grants.some((g) => { try {
            return isUnderRoot(g, s, ctx.platform);
        }
        catch {
            return false;
        } });
        // The OMC global state root (OMC_HOME/state, XDG state omc, or ~/.omg/state) holds the forge mirrors and PR store, the
        // factory ledger and the budget ledger: the engine's trust anchors. Denied whole, unless a grant lives inside it (the
        // job dir under team-jobs): then only its sensitive children are.
        const stateRoot = ctx.omcStateRoot ?? getGlobalOmcStateRoot();
        const covered = (p) => filesystem.deniedPaths.some((d) => { try {
            return isUnderRoot(p, d, ctx.platform);
        }
        catch {
            return false;
        } });
        // The factory ledger (OMC_STATE_DIR/factory-ledger, as defaultLedgerDir in factory/run/ledger.ts; the team bundle may not import src/factory; ~/.omg/factory-ledger is under the home deny) and the budget ledger
        // (<omc root of the main checkout>/state/budget-ledger.json) live elsewhere when OMC_STATE_DIR is set: name the real
        // paths, and only those that exist (the host may refuse a deny of a missing path). A granted job dir stays granted.
        const mainRoot = ctx.mainRoot ?? (basename(ctx.commonGitDir) === '.git' ? dirname(ctx.commonGitDir) : undefined);
        const ledgers = [...(process.env.OMC_STATE_DIR?.trim() ? [join(resolve(process.env.OMC_STATE_DIR), 'factory-ledger')] : []), ...(mainRoot ? [join(getOmcRoot(mainRoot), 'state', 'budget-ledger.json')] : [])];
        // The engine creates the forge dir and the factory ledger dir later, and the lane could read them once they exist: make them now so the
        // deny names them (the host may refuse a deny of a missing path). The budget ledger is a file the engine writes on first use, so only an existing one is named.
        // A bare repo or separate git dir has no main checkout (mainRoot undefined): the budget ledger is then not denied, as the worktree's own
        // .omg would lie inside the lane's grant anyway.
        const ensureDir = (d) => { try {
            mkdirSync(d, { recursive: true });
        }
        catch { /* an uncreatable dir stays denied only if it exists */ } return d; };
        const forgeDir = join(stateRoot, 'forge');
        const stateDeny = [
            ...(holdsGrant(stateRoot) ? [ensureDir(forgeDir)].filter(existsSync) : [stateRoot]),
            ...ledgers.map((l) => (l.endsWith('factory-ledger') ? ensureDir(l) : l)).filter(existsSync),
        ];
        filesystem.deniedPaths.push(...[...new Set(stateDeny)].filter((p) => !holdsGrant(p) && !covered(p)));
        filesystem.deniedPaths.push(...[...new Set(ctx.extraDenied ?? [])].filter((p) => existsSync(p) && !holdsGrant(p) && !covered(p)));
        if (ctx.platform !== 'win32') {
            // Sockets that run commands for the caller outside the sandbox: the user's runtime dir (D-Bus, systemd, agents),
            // the container daemons and the SSH agent. Never a dir that holds a grant (the root, the home, a parent of either,
            // a tool dir), and of an agent socket directly in a shared sticky dir (/tmp) only the socket.
            const sockDir = ctx.sshAuthSock && posix.isAbsolute(ctx.sshAuthSock) ? posix.dirname(ctx.sshAuthSock) : null;
            const sockets = [
                ...(ctx.uid !== undefined ? [`/run/user/${ctx.uid}`] : []),
                '/var/run/docker.sock', '/run/docker.sock', '/run/podman',
                ...(sockDir ? [stickyShared(sockDir) ? ctx.sshAuthSock : sockDir] : []),
            ];
            filesystem.deniedPaths.push(...sockets.filter((s) => s !== '/' && !holdsGrant(s)));
        }
    }
    const network = settings.writeNetwork === 'registry'
        ? { allowOutbound: true, allowedHosts: [...REGISTRY_HOSTS, ...settings.allowedHosts], allowLocalNetwork: ctx.platform === 'win32' }
        : { allowOutbound: false, allowLocalNetwork: false };
    return { enabled: true, addCurrentWorkingDirectory: true, ...common, userPolicy: { filesystem, network } };
}
export { findOnPath };
function defaultToolPathProbe(env, platform) {
    return {
        execPath: process.execPath,
        which: (name) => findOnPath(name, env, platform),
        gitExecPath: (git) => {
            const r = spawnSync(git, ['--exec-path'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            const out = r.status === 0 ? (r.stdout ?? '').trim() : '';
            return out || null;
        },
        realpath: (p) => realpathSync.native(p),
    };
}
/**
 * The install dirs of the programs every lane starts: node (the plugin
 * hooks and the `t` MCP server run `node`) and git. With
 * `allowDevToolAccess` off the runtime grants no PATH entry, and on Windows
 * MXC then denies launching `C:\Program Files\nodejs\node.exe`; on Linux
 * and macOS the system dirs stay granted, so this matters there for a
 * toolchain outside them (nvm, the runner's tool cache, Homebrew's Cellar).
 * They are granted read-only, never read-write, and by name rather than all
 * of PATH (allowDevToolAccess): PATH entries can be per-user dirs that hold
 * config or credentials, and a lane needs only these two programs.
 *
 * node: the dir of the engine's own binary and of the `node` the lane's
 * PATH resolves to (both, realpath and link). git: Git for Windows's install
 * root (`<root>\cmd\git.exe` launches `<root>\mingw64\bin\git.exe`, which
 * runs `<root>\usr\bin\sh.exe` for hooks), found from `git --exec-path`
 * (`<root>\mingw64\libexec\git-core`) and kept only when the PATH git lies
 * under it; elsewhere the git binary's dir and its exec path.
 */
export function laneToolPaths(env, platform, probe = defaultToolPathProbe(env, platform)) {
    const P = platform === 'win32' ? win32 : posix;
    const out = [];
    const real = (p) => { try {
        return probe.realpath(p);
    }
    catch {
        return p;
    } };
    const binDirs = (p) => (p ? [P.dirname(p), P.dirname(real(p))] : []);
    out.push(...binDirs(probe.execPath), ...binDirs(probe.which('node')));
    const git = probe.which('git');
    if (git) {
        const execDir = probe.gitExecPath(git);
        const root = platform === 'win32' ? gitForWindowsRoot(execDir) : null;
        const under = (p, dir) => { const rel = P.relative(dir, p); return !!rel && !rel.startsWith('..') && !P.isAbsolute(rel); };
        if (root && under(real(git), root))
            out.push(root);
        else
            out.push(...binDirs(git), ...(execDir ? [execDir] : []));
    }
    const seen = new Set();
    return out.map((p) => P.resolve(p)).filter((p) => {
        const key = platform === 'win32' ? p.toLowerCase() : p;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/** Git for Windows's install root from its `--exec-path` (`<root>\mingw64\libexec\git-core`), or null. */
function gitForWindowsRoot(execDir) {
    return execDir && /[\\/]libexec[\\/]git-core[\\/]?$/i.test(execDir) ? win32.resolve(execDir, '..', '..', '..') : null;
}
/** `<root>\usr\bin\sh.exe`, the shell Git for Windows runs hooks with, for the git on `env`'s PATH; or null. */
export function gitForWindowsShell(env, probe = defaultToolPathProbe(env, 'win32')) {
    const git = probe.which('git');
    const root = git ? gitForWindowsRoot(probe.gitExecPath(git)) : null;
    return root ? win32.join(root, 'usr', 'bin', 'sh.exe') : null;
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
/**
 * The trial launch: bwrap with the namespaces the runtime's Linux sandbox
 * creates, network included (`--unshare-all`; policies without outbound
 * access get an empty net namespace), around `true`.
 */
export const BWRAP_TRIAL_ARGS = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--die-with-parent', '--', 'true'];
const defaultTrialSpawner = (cmd, args, timeoutMs) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ...(r.error ? { error: r.error } : {}), status: r.status, stderr: r.stderr ?? '' };
};
/**
 * Whether bwrap can launch a process here: null when it can, else why not.
 * `sandbox.getHostSupport` reports a host with bwrap installed as supported
 * even where unprivileged user namespaces lack capabilities (Ubuntu 24.04's
 * AppArmor default), and there every sandboxed launch fails.
 */
export function bwrapTrialLaunchError(spawn = defaultTrialSpawner, timeoutMs = 10_000) {
    const r = spawn('bwrap', BWRAP_TRIAL_ARGS, timeoutMs);
    if (r.error?.code === 'ENOENT')
        return 'bwrap (bubblewrap) is not on PATH, and the Linux sandbox runs every shell under it: install bubblewrap';
    if (r.error)
        return `a trial bwrap launch failed: ${errText(r.error)}`;
    if (r.status === 0)
        return null;
    const stderr = r.stderr.trim().slice(0, 200);
    if (/RTM_NEWADDR|uid map|new namespace/i.test(stderr)) {
        return 'unprivileged user namespaces are restricted (AppArmor kernel.apparmor_restrict_unprivileged_userns=1), so bwrap cannot launch the sandbox; '
            + `see "Linux: restricted user namespaces" in docs/REFERENCE.md (bwrap: ${stderr})`;
    }
    return `a trial bwrap launch failed (exit ${String(r.status)})${stderr ? `: ${stderr}` : ''}`;
}
let cachedBwrapTrial;
/** bwrapTrialLaunchError with the real bwrap, run once per process. */
export function cachedBwrapTrialLaunchError() {
    if (cachedBwrapTrial === undefined)
        cachedBwrapTrial = bwrapTrialLaunchError();
    return cachedBwrapTrial;
}
/**
 * `client.rpc.sandbox.getHostSupport()`; supported only with the `shell`
 * capability and, on Linux, a trial bwrap launch that succeeds.
 */
export async function probeHostSupport(client, timeoutMs, launch = {}) {
    const host = await askHostSupport(client, timeoutMs);
    if (!host.supported || (launch.platform ?? process.platform) !== 'linux')
        return host;
    const launchError = (launch.trialLaunch ?? cachedBwrapTrialLaunchError)();
    return launchError ? { supported: false, reason: launchError, capabilities: host.capabilities, launchFailed: true } : host;
}
async function askHostSupport(client, timeoutMs) {
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
    // TEMP, TMP and TMPDIR are not passed: relocatedProfileEnv points them at the job's own temp dir.
    'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'LANG',
    // Non-secret OS variables shells and git expect.
    'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
    // The runtime reaches Copilot through a proxy and a private CA with these; the shells inherit them (proxyCaEnv).
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER', 'LOGNAME', 'TERM', 'TZ',
    // A path, not a secret: the Windows sandbox needs it (MXC_REQUIRED_ENV) and grants %LOCALAPPDATA%\Programs read-only from it.
    // The HOST value is kept on purpose: per-user tools on PATH live under Programs. Lane-launched code that resolves host
    // paths from it (python-repl/paths.ts, utils/paths.ts getDataDir/getStateDir) finds them, but sandboxed writes there
    // are denied, so the effect is breakage or shared read state, never escalation.
    'LOCALAPPDATA',
];
/**
 * The CA paths to grant sandboxed node and git read-only, and notes: the bundle file itself of NODE_EXTRA_CA_CERTS
 * and SSL_CERT_FILE (never its dir, which may be ~/Downloads), and each SSL_CERT_DIR entry unless it is a filesystem
 * root or holds the real home. An entry that does not resolve (missing, a dangling link) is dropped with a note
 * rather than failing the whole sandbox config. A proxy URL with userinfo is noted too: the shells inherit the
 * runtime env, so they see it, and it is not stripped because the runtime needs it.
 */
export function proxyCaEnv(env, platform, realHome) {
    const P = platform === 'win32' ? win32 : posix;
    const caPaths = [];
    const notes = [];
    const entries = [
        ...['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'].map((name) => ({ name, value: envValue(env, name), dir: false })),
        ...(envValue(env, 'SSL_CERT_DIR') ?? '').split(P.delimiter).map((value) => ({ name: 'SSL_CERT_DIR', value, dir: true })),
    ];
    for (const { name, value, dir } of entries) {
        if (!value || !P.isAbsolute(value))
            continue;
        let real;
        let isDir;
        try {
            real = realpathSync.native(value);
            isDir = statSync(real).isDirectory();
        }
        catch (err) {
            notes.push(`sandbox: ${name} ${value} does not resolve (${err.code ?? 'error'}); it is not granted to the lane.`);
            continue;
        }
        if (isDir !== dir) {
            notes.push(`sandbox: ${name} ${value} is not a ${dir ? 'directory' : 'file'}; it is not granted to the lane.`);
            continue;
        }
        let tooBroad = true;
        try {
            tooBroad = dir && (P.dirname(real) === real || isUnderRoot(realHome, real, platform));
        }
        catch { /* unresolvable: refuse */ }
        if (tooBroad) {
            notes.push(`sandbox: ${name} ${value} is a filesystem root or holds the home; it is not granted to the lane.`);
            continue;
        }
        caPaths.push(real);
    }
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY']) {
        const value = envValue(env, name);
        let userinfo = false;
        try {
            if (value) {
                const u = new URL(value);
                userinfo = u.username !== '' || u.password !== '';
            }
        }
        catch { /* not a URL */ }
        if (userinfo)
            notes.push(`sandbox: ${name} carries credentials; the lane shell inherits it. With writeNetwork "none" the shell cannot use it.`);
    }
    return { caPaths, notes };
}
/**
 * The variables the Windows sandbox (MXC) needs to launch any process,
 * hook or shell, with the runtime's env taken verbatim
 * (`inheritDefaultEnv` false): presence only, the value is not checked.
 * Copilot CLI 1.0.105 rejects a launch without them ("policy_validation:
 * ... missing the required variable(s)"). In runtime.node 1.0.105 only
 * SYSTEMROOT sits next to that message; LOCALAPPDATA comes from separate MXC
 * strings ("LOCALAPPDATA and USERPROFILE both unset", "no user-profile
 * grants: %LOCALAPPDATA% is unset ... Programs") and from the live error.
 * SystemRoot locates the system DLLs, LOCALAPPDATA the container's profile.
 */
export const MXC_REQUIRED_ENV = ['SYSTEMROOT', 'LOCALAPPDATA'];
/** The {@link MXC_REQUIRED_ENV} names `env` lacks (or holds blank) on win32; none elsewhere. */
export function missingSandboxEnv(env, platform) {
    return platform === 'win32' ? MXC_REQUIRED_ENV.filter((n) => envValue(env, n) === undefined) : [];
}
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
/**
 * The relocated profile variables, all under `<jobHome>/profile`, and the
 * temp variables, `<jobHome>/tmp` (the caller creates it). The runtime
 * grants the sandbox read-write on the dir its own TEMP names ("temporary
 * storage" in the SDK's allowDevToolAccess doc; the host value was the
 * user's whole %TEMP%, other jobs' homes and repositories included), and
 * no temp dir at all when that dir is missing. The temp and profile dirs
 * are lane-writable (buildSandboxConfig), so nothing the unsandboxed
 * runtime loads code or config from sits in them: the global git config
 * (the runtime runs git itself, and core.fsmonitor or a filter driver would
 * run unsandboxed) is read-only in `<jobHome>/git`, the package cache sits
 * in `<jobHome>/.cache`, and node's compile cache, which defaults to the
 * temp dir, is off.
 */
export function relocatedProfileEnv(jobHome) {
    const profile = join(jobHome, 'profile');
    const tmp = join(jobHome, 'tmp');
    return {
        TEMP: tmp,
        TMP: tmp,
        TMPDIR: tmp,
        USERPROFILE: profile,
        HOME: profile,
        XDG_CONFIG_HOME: join(profile, '.config'),
        GIT_CONFIG_GLOBAL: join(jobHome, 'git', 'config'),
        NODE_DISABLE_COMPILE_CACHE: '1',
        // The runtime's cache would follow the host LOCALAPPDATA (allowlisted for MXC): keep it, and the sandboxed MCP cache grant
        // anchored on it, in the job home but outside the lane-writable profile: the runtime loads code from its pkg dir.
        COPILOT_CACHE_HOME: join(jobHome, '.cache', 'copilot'),
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