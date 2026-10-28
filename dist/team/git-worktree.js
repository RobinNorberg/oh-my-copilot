// src/team/git-worktree.ts
/**
 * Git worktree manager for team worker isolation.
 *
 * Native team worktrees live at:
 *   {repoRoot}/.omg/team/{team}/worktrees/{worker}
 * Branch naming (branch mode): omc-team/{teamName}/{workerName}
 *
 * The public create/remove helpers are kept for legacy callers, but the
 * implementation is conservative: compatible clean worktrees are reused,
 * dirty team worktrees are preserved, and cleanup never force-removes dirty
 * worker changes.
 */
import { existsSync, lstatSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { validateWorktreeRemovalTarget } from '../lib/worktree-cleanup-safety.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot, OmcPaths, resolveOmcPath } from '../lib/worktree-paths.js';
/** Get canonical native team worktree path for a worker. */
export function getWorktreePath(repoRoot, teamName, workerName) {
    return join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees', sanitizeName(workerName));
}
/** Get branch name for a worker. */
export function getBranchName(teamName, workerName) {
    return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}
let emptyHooksDir = null;
/** A host-owned empty directory for core.hooksPath; a fresh one whenever the last is gone or not empty. */
function hostHooksDir() {
    try {
        if (emptyHooksDir && readdirSync(emptyHooksDir).length === 0)
            return emptyHooksDir;
    }
    catch { /* gone: make a new one */ }
    emptyHooksDir = mkdtempSync(join(tmpdir(), 'omg-host-git-nohooks-'));
    return emptyHooksDir;
}
/**
 * `-c` pairs on every host-side git command in a worktree an agent may have
 * configured (a team worker, a copilot_run job): no hook, no fsmonitor, no
 * pager and no external diff it planted in a config level it can write (the
 * worktree's config.worktree, an include, a redirected common dir) runs in
 * the leader's process. Command-line config wins over every file, and git
 * passes it on to the git children it spawns (`worktree remove` runs
 * `status`). The system config stays: only an administrator writes it, and
 * Git for Windows keeps `core.autocrlf` there, so dropping it
 * (GIT_CONFIG_NOSYSTEM) would make clean worktrees look dirty. Its drivers
 * (`filter.lfs`) are blanked on work-tree commands all the same
 * (hostGitDriverOverrides).
 *
 * Every command here only reads, or changes refs and worktree records:
 * `update-ref` would run a reference-transaction hook, which no team flow
 * relies on. `worktree add` stays unhardened so the repository's own
 * post-checkout hook still runs at creation, before any agent ran there.
 * A future fetch, push, commit or merge from an agent's worktree must also
 * pass an explicit `--git-dir` (the repository's common dir).
 *
 * Every other config key that names a program is pinned too (ssh, credential
 * helper, signing programs, editors): an agent can write `config.worktree`
 * once the repository sets `extensions.worktreeConfig` (sparse-checkout does).
 * `-c extensions.worktreeConfig=false` is no defence: git reads extensions
 * from the repository config file only, so config.worktree is still read.
 * Drivers have agent-chosen names (`filter.<name>.clean`, `diff.<name>.textconv`),
 * so runHostGit lists and blanks them per command (hostGitDriverOverrides).
 */
export function hostGitHardeningArgs() {
    return [
        '-c', `core.hooksPath=${hostHooksDir()}`,
        ...EXEC_KEY_OVERRIDES.flatMap((kv) => ['-c', kv]),
    ];
}
const EXEC_KEY_OVERRIDES = [
    'core.fsmonitor=false', 'core.pager=cat', 'diff.external=', 'core.sshCommand=ssh', 'credential.helper=',
    'gpg.program=gpg', 'gpg.ssh.program=ssh-keygen', 'gpg.x509.program=gpgsm', 'core.editor=:', 'sequence.editor=:',
];
let emptyAttributesFile = null;
/** A host-owned empty file for core.attributesFile; a fresh one whenever the last is gone or not empty. */
function hostAttributesFile() {
    try {
        if (emptyAttributesFile && readFileSync(emptyAttributesFile, 'utf-8') === '')
            return emptyAttributesFile;
    }
    catch { /* gone: make a new one */ }
    emptyAttributesFile = join(mkdtempSync(join(tmpdir(), 'omg-host-git-noattrs-')), 'attributes');
    writeFileSync(emptyAttributesFile, '');
    return emptyAttributesFile;
}
/** Subcommands that read or write work-tree files, so a clean, smudge or process filter (or a textconv) can run. */
const WORK_TREE_SUBCOMMANDS = new Set([
    'status', 'diff', 'diff-files', 'diff-index', 'ls-files', 'worktree', 'checkout', 'checkout-index', 'restore',
    'switch', 'reset', 'add', 'stash', 'merge', 'commit', 'update-index', 'read-tree', 'apply', 'rm', 'mv', 'clean',
]);
/** Global options before a subcommand that take the next argument as their value. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
/** The index of the subcommand in `args`, or -1. */
function gitSubcommandIndex(args) {
    for (let i = 0; i < args.length; i++) {
        if (GLOBAL_OPTIONS_WITH_VALUE.has(args[i]))
            i++;
        else if (!args[i].startsWith('-'))
            return i;
    }
    return -1;
}
/**
 * The environment of a host git command that names a worktree's recorded git
 * dir (`--git-dir <common>/worktrees/<name> --work-tree <path>`, from
 * worktreeGitDirArgs): GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR pinned to the
 * recorded paths, so git reads no link file (the admin dir's `commondir`, the
 * worktree's `.git`) after worktreeGitLinksIntact checked them; a lane child
 * that survived the session cannot flip them in between. Every host command
 * also gets GIT_LFS_SKIP_SMUDGE=1: host git only inspects and never checks
 * files out (`worktree add` does not come here), so a git-lfs that still runs
 * (hostGitDriverOverrides blanks filter.lfs) downloads and writes nothing.
 */
export function hostGitEnv(args, base = process.env) {
    const valueOf = (flag) => {
        const i = args.indexOf(flag);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const gitDir = valueOf('--git-dir');
    if (!gitDir)
        return { ...base, GIT_LFS_SKIP_SMUDGE: '1' };
    const env = { ...base, GIT_DIR: resolve(gitDir), GIT_LFS_SKIP_SMUDGE: '1' };
    const workTree = valueOf('--work-tree');
    if (workTree)
        env.GIT_WORK_TREE = resolve(workTree);
    // worktreeGitLinksIntact proved the admin dir is a direct child of <common>/worktrees.
    if (basename(dirname(resolve(gitDir))) === 'worktrees')
        env.GIT_COMMON_DIR = dirname(dirname(resolve(gitDir)));
    return env;
}
/**
 * `-c` pairs that switch off every filter and diff driver a config level an
 * agent can write (local, worktree, global, an include) defines: empty
 * `clean`, `smudge` and `process` with `required=false`, empty `textconv` and
 * `command`. Git runs a driver only when its command is non-empty, so status
 * and diff read file bytes as they are. A system-config driver is blanked
 * too: Git for Windows ships `filter.lfs` there, and git-lfs runs the
 * `lfs.extension.<name>.clean/smudge` programs of the merged config, which
 * includes a lane-written config.worktree; host inspection of a lane wants
 * raw bytes, not LFS. An LFS file whose stat changed then shows as modified:
 * a false dirty keeps a worktree, it never loses one.
 * Listing the config runs nothing. Null when the drivers cannot be listed or a
 * filter name cannot be passed as `-c` (it holds `=` or a line break): the
 * caller fails closed.
 */
export function hostGitDriverOverrides(cwd, env, timeout) {
    let out;
    try {
        out = execFileSync('git', [...hostGitHardeningArgs(), 'config', '--null', '--show-scope', '--name-only', '--get-regexp', '^(filter|diff)\\.'], { cwd, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout });
    }
    catch (err) {
        // Exit 1: no key matches.
        return err.status === 1 ? [] : null;
    }
    const parts = out.split('\0');
    const filters = new Set();
    const diffs = new Set();
    // `--show-scope --null`: scope NUL key NUL, per entry.
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const key = parts[i + 1];
        const section = key.startsWith('filter.') ? 'filter' : key.startsWith('diff.') ? 'diff' : null;
        const dot = key.lastIndexOf('.');
        if (section === null)
            return null;
        // `diff.renames` and friends have no driver name; a two-level filter key is malformed.
        if (dot <= section.length) {
            if (section === 'filter')
                return null;
            continue;
        }
        const name = key.slice(section.length + 1, dot);
        if (/[=\r\n]/.test(name))
            return null;
        (section === 'filter' ? filters : diffs).add(name);
    }
    return [
        ...[...filters].flatMap((n) => ['clean=', 'smudge=', 'process=', 'required=false'].flatMap((kv) => ['-c', `filter.${n}.${kv}`])),
        ...[...diffs].flatMap((n) => ['textconv=', 'command='].flatMap((kv) => ['-c', `diff.${n}.${kv}`])),
    ];
}
/**
 * Run one host git command, hardened: hostGitHardeningArgs on every command;
 * on a command that touches work-tree files (WORK_TREE_SUBCOMMANDS) also an
 * empty core.attributesFile and hostGitDriverOverrides; and the git dir,
 * work tree and common dir pinned in the environment (hostGitEnv) when the
 * args name a recorded git dir. A git dir worktreeGitDirArgs named is checked
 * against its recorded links (config.worktree included) before every command,
 * so a change after the caller's check still runs no git. In such a lane
 * worktree GIT_ATTR_SOURCE names the empty tree, so no attribute (and so no
 * driver, whatever any config level defines) applies, and no submodule is
 * entered (LANE_SUBMODULE_OVERRIDES, `--ignore-submodules=all`); the driver
 * blanking stays as a second layer. Without attributes no eol/text
 * conversion applies either: in a repository that relies on `.gitattributes`
 * eol (and no core.autocrlf) a stat-dirty file may show as modified, so the
 * worktree is kept, never lost. Raw stdout; throws
 * what execFileSync throws, when the drivers cannot be listed, or
 * `sandbox-escaped:` when the recorded links changed. `baseEnv` (default
 * process.env) is the environment the pins are set over (the factory
 * engine's commit identity).
 */
export function runHostGit(cwd, args, timeout, baseEnv = process.env) {
    const env = hostGitEnv(args, baseEnv);
    const recorded = env.GIT_DIR ? recordedGitDirs.get(env.GIT_DIR) : undefined;
    if (recorded && !sameGitLinks(readWorktreeGitLinks(recorded.wtPath), recorded.links)) {
        throw new Error(`sandbox-escaped: the git links or config.worktree of ${recorded.wtPath} changed since they were recorded; no git ran in it`);
    }
    const at = gitSubcommandIndex(args);
    const subcommand = at >= 0 ? args[at] : '';
    let tree = [];
    if (WORK_TREE_SUBCOMMANDS.has(subcommand)) {
        const drivers = hostGitDriverOverrides(cwd, env, timeout);
        if (drivers === null)
            throw new Error('host git: the filter and diff drivers cannot be listed or overridden; refusing to run it in the work tree');
        tree = ['-c', `core.attributesFile=${hostAttributesFile()}`, ...drivers];
    }
    let finalArgs = args;
    if (recorded) {
        // A lane worktree: no attribute applies (no filter, diff, textconv or merge driver can be selected, whatever its config
        // says, also in a submodule child), and git never enters a nested repository the lane made.
        env.GIT_ATTR_SOURCE = recorded.emptyTree;
        tree = [...tree, ...LANE_SUBMODULE_OVERRIDES.flatMap((kv) => ['-c', kv])];
        if (IGNORE_SUBMODULES_SUBCOMMANDS.has(subcommand))
            finalArgs = [...args.slice(0, at + 1), '--ignore-submodules=all', ...args.slice(at + 1)];
    }
    return execFileSync('git', [...hostGitHardeningArgs(), ...tree, ...finalArgs], { cwd, env, encoding: 'utf-8', stdio: 'pipe', windowsHide: true, timeout });
}
/** `-c` pairs on every host command in a lane worktree: no submodule recursion, status or summary. */
const LANE_SUBMODULE_OVERRIDES = ['submodule.recurse=false', 'diff.ignoreSubmodules=all', 'status.submoduleSummary=false'];
/** Subcommands that take `--ignore-submodules` (it also beats a lane's per-submodule `submodule.<name>.ignore`). */
const IGNORE_SUBMODULES_SUBCOMMANDS = new Set(['status', 'diff', 'diff-files', 'diff-index', 'diff-tree']);
/** The empty tree of each object format: GIT_ATTR_SOURCE names it, so host git reads no `.gitattributes`. */
export const EMPTY_TREE = {
    sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};
/** The first git that honours GIT_ATTR_SOURCE (git --attr-source, 2.41.0). */
export const HOST_GIT_ATTR_SOURCE_MIN = '2.41.0';
let hostGitVersionCache;
/**
 * Why the host git cannot inspect a sandboxed lane, or null when it can: a
 * git older than HOST_GIT_ATTR_SOURCE_MIN ignores GIT_ATTR_SOURCE, so the
 * lane's `.gitattributes` would still select drivers and only the driver
 * blanking would stand. `version` is `git --version` output (default: run it).
 */
export function hostGitAttrSourceProblem(version) {
    if (version === undefined) {
        if (hostGitVersionCache === undefined) {
            try {
                hostGitVersionCache = execFileSync('git', ['--version'], { encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();
            }
            catch {
                hostGitVersionCache = null;
            }
        }
        version = hostGitVersionCache;
    }
    const m = version ? /(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
    if (!m)
        return `cannot read the git version (${version ?? 'git --version failed'}); a sandboxed lane needs git ${HOST_GIT_ATTR_SOURCE_MIN} or newer`;
    const [maj, min, patch] = HOST_GIT_ATTR_SOURCE_MIN.split('.').map(Number);
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ok = v[0] !== maj ? v[0] > maj : v[1] !== min ? v[1] > min : v[2] >= patch;
    return ok ? null : `${version} does not honour GIT_ATTR_SOURCE; a sandboxed lane needs git ${HOST_GIT_ATTR_SOURCE_MIN} or newer, so host git reads none of the lane's .gitattributes`;
}
function git(repoRoot, args, cwd = repoRoot) {
    return runHostGit(cwd, args).trim();
}
/** A regular file's bytes (never through a link), or null. */
function readPlainFile(path) {
    try {
        return lstatSync(path).isFile() ? readFileSync(path, 'utf-8') : null;
    }
    catch {
        return null;
    }
}
/** The worktree's git links as they are on disk now (read without git), or null when any is missing, a link or malformed. */
export function readWorktreeGitLinks(wtPath) {
    const dotGit = readPlainFile(join(wtPath, '.git'));
    const match = dotGit === null ? null : /^gitdir: (.+?)\r?\n?$/.exec(dotGit);
    if (!dotGit || !match)
        return null;
    const adminDir = resolve(wtPath, match[1]);
    try {
        if (!lstatSync(adminDir).isDirectory())
            return null;
    }
    catch {
        return null;
    }
    const gitdir = readPlainFile(join(adminDir, 'gitdir'));
    const commondir = readPlainFile(join(adminDir, 'commondir'));
    const configWorktree = configWorktreeState(adminDir);
    if (gitdir === null || commondir === null || configWorktree === null)
        return null;
    return { adminDir, dotGit, gitdir, commondir, configWorktree };
}
/** The hash of the admin dir's regular-file `config.worktree`, `absent`, or null when it is anything else (a link, a directory). */
function configWorktreeState(adminDir) {
    const path = join(adminDir, 'config.worktree');
    try {
        return lstatSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
    }
    catch (err) {
        return err.code === 'ENOENT' ? 'absent' : null;
    }
}
function sameGitLinks(now, expected) {
    return now !== null && ['adminDir', 'dotGit', 'gitdir', 'commondir', 'configWorktree'].every((k) => now[k] === expected[k]);
}
/**
 * The worktree, links and empty tree (GIT_ATTR_SOURCE) behind each recorded
 * git dir (recordWorktreeGitLinks), re-checked by runHostGit before every command.
 */
const recordedGitDirs = new Map();
const pathKey = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
function recordedEntry(wtPath) {
    return [...recordedGitDirs.values()].find((e) => pathKey(e.wtPath) === pathKey(wtPath));
}
/**
 * Record a worktree's git links once, when it is created (before any agent
 * ran in it): later host git uses only this record (worktreeGitDirArgs), and
 * a second record of other links throws instead of replacing it. Also reads
 * the repository's object format, for the empty tree runHostGit names in
 * GIT_ATTR_SOURCE; throws when git cannot tell.
 */
export function recordWorktreeGitLinks(wtPath, links) {
    const existing = recordedEntry(wtPath) ?? recordedGitDirs.get(resolve(links.adminDir));
    if (existing) {
        if (pathKey(existing.wtPath) === pathKey(wtPath) && sameGitLinks(existing.links, links))
            return;
        throw new Error(`sandbox-escaped: other git links are already recorded for ${wtPath}; the record is never replaced`);
    }
    const args = ['--git-dir', links.adminDir, '--work-tree', wtPath];
    const format = execFileSync('git', [...hostGitHardeningArgs(), ...args, 'rev-parse', '--show-object-format'], { cwd: wtPath, env: hostGitEnv(args), encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();
    const emptyTree = EMPTY_TREE[format];
    if (!emptyTree)
        throw new Error(`host git: unknown object format ${JSON.stringify(format)} in ${wtPath}`);
    recordedGitDirs.set(resolve(links.adminDir), { wtPath, links, emptyTree });
}
/** The links recorded for `wtPath` at its creation, or null. */
export function recordedWorktreeGitLinks(wtPath) {
    return recordedEntry(wtPath)?.links ?? null;
}
/** Drop the record of a removed worktree. */
export function forgetWorktreeGitLinks(wtPath) {
    const entry = recordedEntry(wtPath);
    if (entry)
        recordedGitDirs.delete(resolve(entry.links.adminDir));
}
/** Whether `adminDir` is a direct child of `<commonGitDir>/worktrees`. */
function isAdminDirOf(commonGitDir, adminDir) {
    const rel = relative(resolve(commonGitDir, 'worktrees'), adminDir);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep);
}
/**
 * Whether the worktree's git links still hold exactly what was recorded, and
 * the recorded admin dir lies in the repository's own `worktrees/` dir.
 */
export function worktreeGitLinksIntact(wtPath, expected, commonGitDir) {
    return isAdminDirOf(commonGitDir, expected.adminDir) && sameGitLinks(readWorktreeGitLinks(wtPath), expected);
}
/**
 * Host git arguments that name the worktree's recorded git dir and work tree
 * (recordWorktreeGitLinks) instead of discovering them; runHostGit checks the
 * record again before every command that passes them. Throws when nothing
 * was recorded for `wtPath`.
 */
export function worktreeGitDirArgs(wtPath) {
    const entry = recordedEntry(wtPath);
    if (!entry)
        throw new Error(`host git: no git links were recorded for ${wtPath} at its creation`);
    return ['--git-dir', entry.links.adminDir, '--work-tree', entry.wtPath];
}
function isInsideGitRepo(repoRoot) {
    try {
        git(repoRoot, ['rev-parse', '--show-toplevel']);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Untracked OMC state in the leader is our own metadata, not a user edit.
 * Built from OmcPaths.ROOT so it cannot drift from the actual state directory
 * name; git reports porcelain paths with forward slashes on every platform.
 */
const UNTRACKED_OMC_STATE = new RegExp(`^\\?\\? ${OmcPaths.ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`);
function assertCleanLeaderWorktree(repoRoot) {
    const status = git(repoRoot, ['status', '--porcelain'])
        .split('\n')
        .filter(line => line.trim() !== '' && !UNTRACKED_OMC_STATE.test(line))
        .join('\n')
        .trim();
    if (status.length > 0) {
        const error = new Error('leader_worktree_dirty: commit, stash, or clean changes before enabling team worktree mode');
        error.code = 'leader_worktree_dirty';
        throw error;
    }
}
/**
 * Win32 paths compare case-insensitively: git and callers may spell the same
 * directory differently. A path that does not exist (a deleted worker
 * directory) is canonicalized through its nearest existing parent, so an
 * aliased repo root still matches the path git recorded.
 */
function canonicalPathForComparison(path) {
    let existing = resolve(path);
    const missingTail = [];
    let canonical;
    for (;;) {
        try {
            canonical = join(realpathSync.native(existing), ...missingTail);
            break;
        }
        catch {
            const parent = dirname(existing);
            if (parent === existing) {
                canonical = resolve(path);
                break;
            }
            missingTail.unshift(basename(existing));
            existing = parent;
        }
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
function getRegisteredWorktreeBranch(repoRoot, wtPath) {
    try {
        const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
        const resolvedWtPath = canonicalPathForComparison(wtPath);
        let currentMatches = false;
        for (const line of output.split('\n')) {
            if (line.startsWith('worktree ')) {
                currentMatches = canonicalPathForComparison(line.slice('worktree '.length).trim()) === resolvedWtPath;
                continue;
            }
            if (!currentMatches)
                continue;
            if (line.startsWith('branch '))
                return line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
            if (line === 'detached')
                return 'HEAD';
        }
    }
    catch {
        // Best-effort check only.
    }
    return undefined;
}
/**
 * The `git worktree list` entry for wtPath (its recorded HEAD and branch), or
 * null when git does not list it. Throws when git cannot list worktrees.
 */
function findRegisteredWorktree(repoRoot, wtPath) {
    const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
    const resolvedWtPath = canonicalPathForComparison(wtPath);
    let entry = null;
    for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
            if (entry)
                return entry;
            if (canonicalPathForComparison(line.slice('worktree '.length).trim()) === resolvedWtPath)
                entry = { head: null, branch: null };
            continue;
        }
        if (!entry)
            continue;
        if (line.startsWith('HEAD '))
            entry.head = line.slice('HEAD '.length).trim();
        if (line.startsWith('branch '))
            entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
    return entry;
}
/** Whether git lists wtPath as a worktree; true when git cannot tell, so nothing is deleted on a guess. */
function isRegisteredWorktreePath(repoRoot, wtPath) {
    try {
        return findRegisteredWorktree(repoRoot, wtPath) !== null;
    }
    catch {
        return true;
    }
}
function isDetached(wtPath) {
    try {
        const branch = runHostGit(wtPath, ['branch', '--show-current']).trim();
        return branch.length === 0;
    }
    catch {
        return false;
    }
}
function isWorktreeDirty(wtPath) {
    return isWorktreeDirtyExcept(wtPath).dirty;
}
function normalizeStatusPath(rawPath) {
    const trimmed = rawPath.trim();
    if (trimmed.startsWith('\"') && trimmed.endsWith('\"')) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}
function statusEntryPath(line) {
    const payload = line.slice(3);
    const renameSeparator = ' -> ';
    // Only a rename or copy entry (`R`/`C` in either column) names two paths.
    const renameIndex = /[RC]/.test(line.slice(0, 2)) ? payload.indexOf(renameSeparator) : -1;
    return normalizeStatusPath(renameIndex >= 0 ? payload.slice(renameIndex + renameSeparator.length) : payload);
}
/**
 * OMC directories whose untracked files are a worker session's operational
 * state, never worker output, each with the part of its path that must match:
 * all of `state/` (SessionEnd job records) and the flat `sessions/*.json` (the
 * SessionEnd session summary, written with no team-worker gate).
 */
const WORKTREE_RUNTIME_STATE_DIRS = [['state', /^/], ['sessions', /^[^/]+\.json$/]];
/**
 * The worktree's own OMC runtime state directories as `git status` names the
 * files under them (`.omg/state/`, `.omg/sessions/`), or an empty list when the
 * OMC root is not a top-level directory of the worktree (OMC_STATE_DIR, a
 * workspace marker above it).
 */
function worktreeRuntimeStatePrefixes(wtPath) {
    const root = resolve(wtPath);
    const omcRel = relative(root, resolve(getOmcRoot(wtPath))).split(sep).join('/');
    if (!omcRel || omcRel.startsWith('..') || isAbsolute(omcRel) || omcRel.includes('/'))
        return [];
    return WORKTREE_RUNTIME_STATE_DIRS.map(([dir, rest]) => [`${relative(root, resolveOmcPath(dir, wtPath)).split(sep).join('/')}/`, rest]);
}
/**
 * Dirty unless every `git status` entry is ignored. Untracked files under the
 * worktree's own OMC runtime state directories never count: a copilot worker's
 * SessionEnd hook keeps its job records and session summary there
 * (operational state, never worker output), and treating them as dirty
 * preserved every worktree a copilot worker ran in, failing the team shutdown.
 * `runtimeState` reports them so removal can take them along. Status lists
 * every untracked file (a plain status folds a new `.omg/` into one entry), so
 * anything else under `.omg/` (skills, plans, notepad, project memory, wiki)
 * keeps the worktree.
 */
function isWorktreeDirtyExcept(wtPath, ignoredRootPaths = [], gitDirArgs = []) {
    try {
        const ignored = new Set(ignoredRootPaths);
        const runtimePrefixes = worktreeRuntimeStatePrefixes(wtPath);
        const entries = runHostGit(wtPath, [...gitDirArgs, 'status', '--porcelain', '--untracked-files=all'])
            .split('\n')
            .filter(line => line.trim().length > 0);
        const isRuntime = (line) => line.startsWith('?? ') && runtimePrefixes.some(([prefix, rest]) => {
            const path = statusEntryPath(line);
            return path.startsWith(prefix) && rest.test(path.slice(prefix.length));
        });
        const relevantEntries = entries.filter(line => !ignored.has(statusEntryPath(line)) && !isRuntime(line));
        return { dirty: relevantEntries.length > 0, entries: relevantEntries, runtimeState: entries.some(isRuntime) };
    }
    catch {
        return { dirty: true, entries: ['git_status_failed'], runtimeState: false };
    }
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** How long a busy runtime-state leftover (win32) is retried before it is left for later cleanup. */
const RUNTIME_LEFTOVER_RETRY_MS = 15_000;
/**
 * Delete what a half-finished forced removal left: only OMC runtime state
 * (checked before the removal), still held by a process finishing in it.
 * Retried while busy; past the window it stays on disk with a warning,
 * because no worker output is in it and it must not fail the shutdown.
 */
function removeRuntimeLeftover(wtPath, retryMs = RUNTIME_LEFTOVER_RETRY_MS) {
    const deadline = Date.now() + retryMs;
    for (;;) {
        try {
            rmSync(wtPath, { recursive: true, force: true });
            return;
        }
        catch (err) {
            if (Date.now() >= deadline) {
                process.stderr.write(`[omc] warning: left OMC runtime state of a removed worker worktree at ${wtPath} (still in use): ${err instanceof Error ? err.message : String(err)}\n`);
                return;
            }
            sleepSync(500);
        }
    }
}
/**
 * Unlink the symlinks and junctions git does not track inside a worktree
 * (`.git` skipped, links not followed) before `git worktree remove`: git
 * deletes ignored entries with the tree, and on win32 it recurses through a
 * junction (a linked node_modules) and empties its target. Only the link goes;
 * the target is untouched. Tracked symlinks are left to git. Throws
 * `worktree_link_unremovable` when a link cannot be unlinked.
 */
function unlinkUntrackedWorktreeLinks(wtPath, gitDirArgs = [], keepTracked = true) {
    const tracked = new Set((keepTracked ? gitOrNull([...gitDirArgs, 'ls-files', '-z', '--stage'], wtPath) ?? '' : '')
        .split('\0')
        .filter((entry) => entry.startsWith('120000 '))
        .map((entry) => resolve(wtPath, entry.slice(entry.indexOf('\t') + 1))));
    const pending = [wtPath];
    while (pending.length > 0) {
        const dir = pending.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (keepTracked && dir === wtPath && entry.name === '.git')
                continue;
            let stat;
            try {
                stat = lstatSync(path);
            }
            catch {
                continue;
            }
            if (stat.isSymbolicLink()) {
                if (tracked.has(resolve(path)))
                    continue;
                try {
                    unlinkSync(path);
                }
                catch {
                    // A junction or directory symlink on win32: rmdir removes the link itself.
                    try {
                        rmdirSync(path);
                    }
                    catch (err) {
                        const error = new Error(`worktree_link_unremovable: preserving worker worktree at ${wtPath}; cannot unlink ${path}: ${err instanceof Error ? err.message : String(err)}`);
                        error.code = 'worktree_link_unremovable';
                        throw error;
                    }
                }
            }
            else if (stat.isDirectory()) {
                pending.push(path);
            }
        }
    }
}
function gitOrNull(args, cwd) {
    try {
        return runHostGit(cwd, args).trim();
    }
    catch {
        return null;
    }
}
/**
 * Commits at the worktree's HEAD that the leader HEAD does not contain (and,
 * when recorded, that are newer than the worktree's base commit): worker work
 * a removal would destroy. Null when git cannot tell.
 */
function countUnmergedWorkerCommits(repoRoot, wtPath, baseCommit, gitDirArgs = [], contained = []) {
    return countUnmergedCommits(repoRoot, gitOrNull([...gitDirArgs, 'rev-parse', 'HEAD'], wtPath), baseCommit, contained);
}
function commitCheckFailedError(message) {
    const error = new Error(`worktree_commit_check_failed: ${message}`);
    error.code = 'worktree_commit_check_failed';
    return error;
}
/**
 * Whether git stores refs/heads/<branch> anywhere (a loose ref file or a
 * packed-refs entry), readable or not. Throws when git cannot say where.
 */
function branchRefStored(repoRoot, branch) {
    const commonDir = gitOrNull(['rev-parse', '--git-common-dir'], repoRoot);
    if (!commonDir)
        throw commitCheckFailedError(`keeping worker branch ${branch} (cannot locate the git directory)`);
    const gitDir = resolve(repoRoot, commonDir);
    if (existsSync(join(gitDir, 'refs', 'heads', ...branch.split('/'))))
        return true;
    try {
        return readFileSync(join(gitDir, 'packed-refs'), 'utf-8').split('\n').some((line) => line.trimEnd().endsWith(` refs/heads/${branch}`));
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return false;
        throw commitCheckFailedError(`keeping worker branch ${branch} (cannot read packed-refs)`);
    }
}
/**
 * The commit a local branch points at, or null when the branch does not
 * exist. Any other git failure throws `worktree_commit_check_failed`: an
 * unreadable branch is never taken for a missing one.
 */
function resolveBranchCommit(repoRoot, branch) {
    try {
        runHostGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    }
    catch (err) {
        // show-ref exits 1 for a missing ref, and also for a garbage or empty
        // loose ref file: only a ref stored nowhere counts as missing.
        if (err?.status === 1 && !branchRefStored(repoRoot, branch))
            return null;
        throw commitCheckFailedError(`keeping worker branch ${branch} (cannot read it)`);
    }
    const commit = gitOrNull(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repoRoot);
    if (!commit)
        throw commitCheckFailedError(`keeping worker branch ${branch} (it does not resolve to a commit)`);
    return commit;
}
/**
 * Delete a fully merged worker branch only while it still points at `commit`,
 * the commit the unmerged-commit check counted (`update-ref -d` with an old
 * value fails when the ref moved): that failure, or git failing to list
 * worktrees, throws `worktree_branch_delete_failed`, keeping the branch. A
 * branch some worktree (the leader) has checked out is kept with a warning
 * and no error: its commits are merged, so it must not fail the teardown.
 * @internal Exported for tests.
 */
export function deleteWorkerBranchAt(repoRoot, branch, commit) {
    const ref = `refs/heads/${branch}`;
    try {
        const checkedOut = git(repoRoot, ['worktree', 'list', '--porcelain']).split('\n').some((line) => line.trim() === `branch ${ref}`);
        if (checkedOut) {
            process.stderr.write(`[omc] warning: kept merged worker branch ${branch} (checked out in a worktree)\n`);
            return;
        }
        git(repoRoot, ['update-ref', '-d', ref, commit]);
    }
    catch (err) {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        const error = new Error(`worktree_branch_delete_failed: keeping worker branch ${branch} (it moved after the commit check or is in use)${detail}`);
        error.code = 'worktree_branch_delete_failed';
        throw error;
    }
}
/**
 * As countUnmergedWorkerCommits, for a commit resolved by the caller (null:
 * unknown). `contained`: further commits whose history counts as kept (a
 * caller-verified remote ref); one that does not resolve makes the count fail.
 */
function countUnmergedCommits(repoRoot, head, baseCommit, contained = []) {
    const leader = gitOrNull(['rev-parse', 'HEAD'], repoRoot);
    if (!head || !leader)
        return null;
    const count = (excludes) => gitOrNull(['rev-list', '--count', head, ...[...excludes, ...contained].map((ref) => `^${ref}`)], repoRoot);
    // A base commit that no longer resolves only narrows the count; drop it.
    const counted = (baseCommit ? count([leader, baseCommit]) : null) ?? count([leader]);
    const n = counted === null ? NaN : Number.parseInt(counted, 10);
    return Number.isFinite(n) ? n : null;
}
/**
 * Initialized submodules in a worktree (its own `modules` dir, or a populated
 * gitlink), which a plain `git worktree remove` refuses to drop and a forced
 * one would delete.
 */
function hasInitializedSubmodules(wtPath, gitDirArgs = []) {
    const modulesDir = gitOrNull([...gitDirArgs, 'rev-parse', '--git-path', 'modules'], wtPath);
    if (modulesDir && existsSync(resolve(wtPath, modulesDir)))
        return true;
    const staged = gitOrNull([...gitDirArgs, 'ls-files', '--stage'], wtPath) ?? '';
    return staged.split('\n').some((line) => {
        if (!line.startsWith('160000 '))
            return false;
        const tab = line.indexOf('\t');
        return tab >= 0 && existsSync(join(wtPath, normalizeStatusPath(line.slice(tab + 1)), '.git'));
    });
}
function unmergedCommitsError(info) {
    const what = existsSync(info.path) ? `worker worktree at ${info.path}` : `worker branch of the removed worktree ${info.path}`;
    const error = new Error(`worktree_unmerged_commits: preserving ${what} with ${info.commits} commit(s) not merged into the leader HEAD${info.branch ? ` (branch ${info.branch})` : ' (detached)'}`);
    Object.assign(error, { code: 'worktree_unmerged_commits', preservedWorktree: info });
    return error;
}
/** Where the worktrees a finished team kept for their unmerged commits are listed (outlives the team state). */
export function getPreservedWorktreesRecordPath(repoRoot, teamName) {
    return join(getOmcRoot(repoRoot), 'state', 'team-preserved-worktrees', `${sanitizeName(teamName)}.json`);
}
/** Record (or, when empty, clear) the worktrees a team shutdown kept for their unmerged commits. */
export function writePreservedWorktreesRecord(repoRoot, teamName, preserved) {
    const recordPath = getPreservedWorktreesRecordPath(repoRoot, teamName);
    if (preserved.length === 0) {
        rmSync(recordPath, { force: true });
        return;
    }
    ensureDirWithMode(join(getOmcRoot(repoRoot), 'state', 'team-preserved-worktrees'));
    atomicWriteJson(recordPath, { team: teamName, recorded_at: new Date().toISOString(), preserved_worktrees: preserved });
}
/** The recorded preserved worktrees of a team whose directory or kept branch still exists. */
export function readPreservedWorktreesRecord(repoRoot, teamName) {
    try {
        const record = JSON.parse(readFileSync(getPreservedWorktreesRecordPath(repoRoot, teamName), 'utf-8'));
        const list = Array.isArray(record.preserved_worktrees) ? record.preserved_worktrees : [];
        const branchMayExist = (branch) => {
            try {
                return resolveBranchCommit(repoRoot, branch) !== null;
            }
            catch {
                return true;
            }
        };
        return list.filter((entry) => entry && typeof entry.path === 'string'
            && (existsSync(entry.path) || (typeof entry.branch === 'string' && branchMayExist(entry.branch))));
    }
    catch {
        return [];
    }
}
/** Get worktree metadata path. */
function getMetadataPath(repoRoot, teamName) {
    return join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName), 'worktrees.json');
}
function getLegacyMetadataPath(repoRoot, teamName) {
    return join(getOmcRoot(repoRoot), 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}
function getWorkerStateDir(repoRoot, teamName, workerName) {
    return join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName), 'workers', sanitizeName(workerName));
}
function getRootAgentsBackupPath(repoRoot, teamName, workerName) {
    return join(getWorkerStateDir(repoRoot, teamName, workerName), 'worktree-root-agents.json');
}
function readRootAgentsBackup(repoRoot, teamName, workerName) {
    const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
    if (!existsSync(backupPath))
        return null;
    try {
        return JSON.parse(readFileSync(backupPath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omc] warning: worktree root AGENTS backup parse error: ${msg}\n`);
        const error = new Error(`worktree_root_agents_backup_unreadable:${backupPath}:${msg}`);
        error.code = 'worktree_root_agents_backup_unreadable';
        throw error;
    }
}
/**
 * Install the generated worker overlay into the root of a native worker worktree.
 * Existing root AGENTS.md content is backed up under leader-owned state so cleanup
 * can safely restore it. Reinstalling preserves the first original backup instead
 * of treating an older managed overlay as user content.
 */
export function installWorktreeRootAgents(teamName, workerName, repoRoot, worktreePath, overlayContent) {
    // The worker worktree, its root AGENTS.md, and the backup all live under
    // getOmcRoot(repoRoot) — which in a .omc-workspace layout sits ABOVE repoRoot.
    // Validate against the shared OMC root (and the worktree itself for AGENTS.md),
    // not the sub-repo, or multi-repo writes throw false path-traversal errors.
    const omcRoot = getOmcRoot(repoRoot);
    validateResolvedPath(worktreePath, omcRoot);
    const agentsPath = join(worktreePath, 'AGENTS.md');
    validateResolvedPath(agentsPath, worktreePath);
    const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
    validateResolvedPath(backupPath, omcRoot);
    ensureDirWithMode(getWorkerStateDir(repoRoot, teamName, workerName));
    const previous = readRootAgentsBackup(repoRoot, teamName, workerName);
    const currentContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
    if (previous && currentContent !== undefined && currentContent !== previous.installedContent) {
        const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${agentsPath}`);
        error.code = 'agents_dirty';
        throw error;
    }
    const backup = previous
        ? { ...previous, worktreePath, installedContent: overlayContent, installedAt: new Date().toISOString() }
        : {
            worktreePath,
            hadOriginal: currentContent !== undefined,
            ...(currentContent !== undefined ? { originalContent: currentContent } : {}),
            installedContent: overlayContent,
            installedAt: new Date().toISOString(),
        };
    atomicWriteJson(backupPath, backup);
    writeFileSync(agentsPath, overlayContent, 'utf-8');
}
/**
 * Restore or remove a managed worktree-root AGENTS.md when it is still unchanged.
 * If a worker edited AGENTS.md, leave it and report agents_dirty so cleanup can
 * preserve the worktree instead of overwriting user changes.
 */
export function restoreWorktreeRootAgents(teamName, workerName, repoRoot, worktreePath) {
    const omcRoot = getOmcRoot(repoRoot);
    const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
    validateResolvedPath(backupPath, omcRoot);
    const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
    if (!backup)
        return { restored: false, reason: 'no_backup' };
    const resolvedWorktreePath = worktreePath ?? backup.worktreePath;
    validateResolvedPath(resolvedWorktreePath, omcRoot);
    if (!existsSync(resolvedWorktreePath)) {
        try {
            unlinkSync(backupPath);
        }
        catch { /* backup already gone */ }
        return { restored: false, reason: 'worktree_missing' };
    }
    const agentsPath = join(resolvedWorktreePath, 'AGENTS.md');
    validateResolvedPath(agentsPath, resolvedWorktreePath);
    const currentContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
    const isPartialInstallOriginal = backup.hadOriginal && currentContent === (backup.originalContent ?? '');
    if (currentContent !== undefined && currentContent !== backup.installedContent && !isPartialInstallOriginal) {
        return { restored: false, reason: 'agents_dirty' };
    }
    if (backup.hadOriginal) {
        writeFileSync(agentsPath, backup.originalContent ?? '', 'utf-8');
    }
    else if (existsSync(agentsPath)) {
        unlinkSync(agentsPath);
    }
    try {
        unlinkSync(backupPath);
    }
    catch { /* backup already gone */ }
    return { restored: true };
}
/** Read worktree metadata, including legacy metadata for cleanup compatibility. */
function readMetadataResult(repoRoot, teamName) {
    const paths = [getMetadataPath(repoRoot, teamName), getLegacyMetadataPath(repoRoot, teamName)];
    const byWorker = new Map();
    const issues = [];
    for (const metaPath of paths) {
        if (!existsSync(metaPath))
            continue;
        try {
            const entries = JSON.parse(readFileSync(metaPath, 'utf-8'));
            for (const entry of entries)
                byWorker.set(entry.workerName, entry);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            issues.push({ path: metaPath, message });
            process.stderr.write(`[omc] warning: worktrees.json parse error at ${metaPath}: ${message}
`);
        }
    }
    return { entries: [...byWorker.values()], issues };
}
function readMetadata(repoRoot, teamName) {
    return readMetadataResult(repoRoot, teamName).entries;
}
function listRootAgentsBackupIssues(repoRoot, teamName, entries) {
    const workersDir = join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName), 'workers');
    if (!existsSync(workersDir))
        return [];
    const knownWorkers = new Set(entries.map((entry) => sanitizeName(entry.workerName)));
    const issues = [];
    for (const workerName of readdirSync(workersDir)) {
        const backupPath = join(workersDir, workerName, 'worktree-root-agents.json');
        if (!existsSync(backupPath))
            continue;
        try {
            JSON.parse(readFileSync(backupPath, 'utf-8'));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            issues.push({ path: backupPath, message: `worktree_root_agents_backup_unreadable:${workerName}:${message}` });
            continue;
        }
        if (!knownWorkers.has(sanitizeName(workerName))) {
            issues.push({
                path: backupPath,
                message: `orphaned_worktree_root_agents_backup:${workerName}`,
            });
        }
    }
    return issues;
}
/** Write native worktree metadata. */
function writeMetadata(repoRoot, teamName, entries) {
    const metaPath = getMetadataPath(repoRoot, teamName);
    validateResolvedPath(metaPath, join(getOmcRoot(repoRoot), 'state', 'team'));
    ensureDirWithMode(join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName)));
    atomicWriteJson(metaPath, entries);
}
function recordMetadata(repoRoot, teamName, info) {
    const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
    withFileLockSync(metaLockPath, () => {
        const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== info.workerName);
        writeMetadata(repoRoot, teamName, [...existing, info]);
    });
}
function forgetMetadataUnlocked(repoRoot, teamName, workerName) {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== workerName);
    writeMetadata(repoRoot, teamName, existing);
}
function assertCompatibleExistingWorktree(repoRoot, wtPath, expectedBranch, mode) {
    const registeredBranch = getRegisteredWorktreeBranch(repoRoot, wtPath);
    if (!registeredBranch) {
        const error = new Error(`worktree_path_mismatch: existing path is not a registered git worktree: ${wtPath}`);
        error.code = 'worktree_path_mismatch';
        throw error;
    }
    if (isWorktreeDirty(wtPath)) {
        const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
        error.code = 'worktree_dirty';
        throw error;
    }
    if (mode === 'named' && registeredBranch !== expectedBranch) {
        const error = new Error(`worktree_mismatch: expected branch ${expectedBranch} at ${wtPath}, found ${registeredBranch}`);
        error.code = 'worktree_mismatch';
        throw error;
    }
    if (mode === 'detached' && registeredBranch !== 'HEAD') {
        const error = new Error(`worktree_mismatch: expected detached worktree at ${wtPath}, found ${registeredBranch}`);
        error.code = 'worktree_mismatch';
        throw error;
    }
}
export function normalizeTeamWorktreeMode(value) {
    if (typeof value !== 'string')
        return 'disabled';
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled', 'detached'].includes(normalized))
        return 'detached';
    if (['branch', 'named', 'named-branch'].includes(normalized))
        return 'named';
    return 'disabled';
}
/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export function ensureWorkerWorktree(teamName, workerName, repoRoot, options = {}) {
    const mode = options.mode ?? 'disabled';
    if (mode === 'disabled')
        return null;
    if (!isInsideGitRepo(repoRoot)) {
        throw new Error(`not_a_git_repository: ${repoRoot}`);
    }
    if (options.requireCleanLeader !== false) {
        assertCleanLeaderWorktree(repoRoot);
    }
    const wtPath = getWorktreePath(repoRoot, teamName, workerName);
    const branch = mode === 'named' ? getBranchName(teamName, workerName) : 'HEAD';
    validateResolvedPath(wtPath, join(getOmcRoot(repoRoot), 'team'));
    try {
        runHostGit(repoRoot, ['worktree', 'prune']);
    }
    catch { /* ignore */ }
    if (existsSync(wtPath)) {
        assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode);
        const previousBase = readMetadata(repoRoot, teamName).find((entry) => entry.workerName === workerName)?.baseCommit;
        const info = {
            ...(previousBase ? { baseCommit: previousBase } : {}),
            path: wtPath,
            branch,
            workerName,
            teamName,
            createdAt: new Date().toISOString(),
            repoRoot,
            mode,
            detached: isDetached(wtPath),
            created: false,
            reused: true,
        };
        recordMetadata(repoRoot, teamName, info);
        return info;
    }
    const wtDir = join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees');
    ensureDirWithMode(wtDir);
    const args = mode === 'named'
        ? ['worktree', 'add', '-b', branch, wtPath, options.baseRef ?? 'HEAD']
        : ['worktree', 'add', '--detach', wtPath, options.baseRef ?? 'HEAD'];
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
    const baseCommit = gitOrNull(['rev-parse', 'HEAD'], wtPath);
    const info = {
        ...(baseCommit ? { baseCommit } : {}),
        path: wtPath,
        branch,
        workerName,
        teamName,
        createdAt: new Date().toISOString(),
        repoRoot,
        mode,
        detached: mode === 'detached',
        created: true,
        reused: false,
    };
    recordMetadata(repoRoot, teamName, info);
    return info;
}
/** Legacy creation helper: create or reuse a named-branch worker worktree. */
export function createWorkerWorktree(teamName, workerName, repoRoot, baseBranch) {
    const info = ensureWorkerWorktree(teamName, workerName, repoRoot, {
        mode: 'named',
        baseRef: baseBranch,
        requireCleanLeader: false,
    });
    if (!info)
        throw new Error('worktree creation unexpectedly disabled');
    return info;
}
/**
 * Dry-run validation for worker worktree removal. This does not restore/remove
 * managed root AGENTS.md and does not delete backup state.
 */
export function checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, worktreePath, gitDirArgs = []) {
    const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
    const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
    if (!existsSync(wtPath))
        return;
    validateWorktreeRemovalTarget({
        candidatePath: wtPath,
        expectedRoots: [join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees')],
        mainRepoRoots: [repoRoot],
    });
    let ignoreRootAgents = false;
    if (backup) {
        const agentsPath = join(wtPath, 'AGENTS.md');
        validateResolvedPath(agentsPath, wtPath);
        const currentContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
        const isPartialInstallOriginal = backup.hadOriginal && currentContent === (backup.originalContent ?? '');
        if (currentContent !== undefined && currentContent !== backup.installedContent && !isPartialInstallOriginal) {
            const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${agentsPath}`);
            error.code = 'agents_dirty';
            throw error;
        }
        ignoreRootAgents = true;
    }
    const dirtyCheck = isWorktreeDirtyExcept(wtPath, ignoreRootAgents ? ['AGENTS.md'] : [], gitDirArgs);
    if (dirtyCheck.dirty) {
        const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
        error.code = 'worktree_dirty';
        throw error;
    }
}
/**
 * Prepare a worker worktree for later removal without deleting the worktree.
 *
 * This is transactional with respect to managed root AGENTS.md overlays: it first
 * validates the overlay is restorable and that no non-overlay files are dirty.
 * Only after that dry-run succeeds does it restore/remove AGENTS.md and delete
 * the backup. If any other dirty file exists, the worker pane/config can remain
 * intact with the managed overlay and backup still available for a later retry.
 */
export function prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, worktreePath, gitDirArgs = []) {
    const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
    checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, wtPath, gitDirArgs);
    const agentsRestore = restoreWorktreeRootAgents(teamName, workerName, repoRoot, wtPath);
    if (agentsRestore.reason === 'agents_dirty') {
        const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${join(wtPath, 'AGENTS.md')}`);
        error.code = 'agents_dirty';
        throw error;
    }
}
/**
 * Remove a worker's worktree and branch, preserving dirty worktrees and
 * worktrees holding commits the leader HEAD does not contain (thrown as
 * `worktree_unmerged_commits`, carrying `preservedWorktree`; the branch is kept).
 * With the worktree directory already gone, the named branch is checked the
 * same way and kept when it holds unmerged worker commits. `contained`: commits
 * (full shas the caller verified, e.g. a fetched remote branch) whose history
 * also counts as merged.
 */
export function removeWorkerWorktree(teamName, workerName, repoRoot, options = {}) {
    const contained = options.contained ?? [];
    if (!contained.every((sha) => /^[0-9a-f]{40}$/.test(sha)))
        throw new Error('removeWorkerWorktree: contained must be full commit shas');
    const wtPath = getWorktreePath(repoRoot, teamName, workerName);
    const branch = getBranchName(teamName, workerName);
    const metaLockPath = `${getMetadataPath(repoRoot, teamName)}.lock`;
    return withFileLockSync(metaLockPath, () => {
        // With recorded git links, git runs in the worktree only while they are
        // intact, and then on the recorded git dir, never a discovered one.
        let gitDirArgs = [];
        let laneCommonDir = null;
        if (options.gitLinks) {
            const commonDir = gitOrNull(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
            if (!commonDir)
                throw commitCheckFailedError(`preserving worker worktree at ${wtPath} (cannot locate the git directory)`);
            if (!worktreeGitLinksIntact(wtPath, options.gitLinks, commonDir)) {
                const tampered = removeTamperedWorktree(repoRoot, teamName, workerName, wtPath, options.gitLinks, commonDir);
                forgetWorktreeGitLinks(wtPath);
                return { tampered };
            }
            recordWorktreeGitLinks(wtPath, options.gitLinks);
            gitDirArgs = worktreeGitDirArgs(wtPath);
            laneCommonDir = commonDir;
        }
        prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, wtPath, gitDirArgs);
        const baseCommit = readMetadata(repoRoot, teamName).find((entry) => entry.workerName === workerName)?.baseCommit;
        let registered;
        try {
            registered = findRegisteredWorktree(repoRoot, wtPath);
        }
        catch {
            throw commitCheckFailedError(`preserving worker worktree at ${wtPath} (cannot list git worktrees)`);
        }
        const wasRegisteredWorktree = registered !== null;
        if (registered && existsSync(wtPath)) {
            // Counts run with cwd=wtPath: only trust them when git resolves that
            // directory to the worktree itself, not to a repository around it.
            const toplevel = gitOrNull([...gitDirArgs, 'rev-parse', '--show-toplevel'], wtPath);
            if (!toplevel || canonicalPathForComparison(toplevel) !== canonicalPathForComparison(wtPath)) {
                throw commitCheckFailedError(`preserving worker worktree at ${wtPath} (git does not resolve it to its own worktree)`);
            }
            const commits = countUnmergedWorkerCommits(repoRoot, wtPath, baseCommit, gitDirArgs, contained);
            if (commits === null)
                throw commitCheckFailedError(`preserving worker worktree at ${wtPath} (cannot count its commits against the leader HEAD)`);
            if (commits > 0)
                throw unmergedCommitsError({ workerName, path: wtPath, branch: registered.branch, commits });
        }
        else if (registered) {
            // The directory is gone but git still records the worktree's HEAD,
            // which can be the only reference to detached worker commits.
            const commits = countUnmergedCommits(repoRoot, registered.head, baseCommit, contained);
            if (commits === null)
                throw commitCheckFailedError(`keeping the record of worker worktree ${wtPath} (cannot count its commits against the leader HEAD)`);
            if (commits > 0)
                throw unmergedCommitsError({ workerName, path: wtPath, branch: registered.branch, commits });
        }
        // The named branch is checked on its own: the worker may have switched
        // the worktree off it (detached or onto another branch), leaving commits
        // only the branch holds. A missing branch (detached mode) is fine.
        const branchHead = resolveBranchCommit(repoRoot, branch);
        if (branchHead) {
            const commits = countUnmergedCommits(repoRoot, branchHead, baseCommit, contained);
            if (commits === null)
                throw commitCheckFailedError(`keeping worker branch ${branch} (cannot count its commits against the leader HEAD)`);
            if (commits > 0)
                throw unmergedCommitsError({ workerName, path: wtPath, branch, commits });
        }
        // The safety check above passed, so the only untracked files left are OMC
        // runtime state, which git refuses to drop without --force. A worktree with
        // initialized submodules keeps the plain removal, which refuses it.
        const runtimeOnly = existsSync(wtPath) && isWorktreeDirtyExcept(wtPath, ['AGENTS.md'], gitDirArgs).runtimeState;
        const submodules = existsSync(wtPath) && hasInitializedSubmodules(wtPath, gitDirArgs);
        const force = runtimeOnly && !submodules;
        if (wasRegisteredWorktree && submodules) {
            // git refuses to remove it: refuse before unlinking, so the kept
            // worktree keeps its junctioned links.
            const error = new Error(`worktree_remove_failed: preserving metadata for registered worker worktree at ${wtPath}: initialized submodules`);
            error.code = 'worktree_remove_failed';
            throw error;
        }
        if (existsSync(wtPath))
            unlinkUntrackedWorktreeLinks(wtPath, gitDirArgs);
        try {
            if (options.gitLinks && laneCommonDir) {
                // An agent's worktree goes by path, not `git worktree remove`: that
                // spawns git in the worktree, under config (config.worktree) and
                // attributes the agent may have written. The checks above passed.
                if (existsSync(wtPath)) {
                    validateWorktreeRemovalTarget({
                        candidatePath: wtPath,
                        expectedRoots: [join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees')],
                        mainRepoRoots: [repoRoot],
                    });
                }
                try {
                    removeTreeByPath(wtPath);
                }
                catch (err) {
                    // Only OMC runtime state is left (checked above), maybe still busy on win32.
                    if (!force)
                        throw err;
                    removeRuntimeLeftover(wtPath);
                }
                if (isAdminDirOf(laneCommonDir, options.gitLinks.adminDir))
                    removeTreeByPath(options.gitLinks.adminDir);
            }
            else {
                runHostGit(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath]);
            }
        }
        catch (err) {
            // A forced removal can fail half way on win32 when a process (a worker's
            // SessionEnd action runner) still has its cwd in the runtime state: git
            // has then already unregistered the worktree, and what is left is a
            // plain directory for the stale-path cleanup below.
            if (wasRegisteredWorktree && (!force || isRegisteredWorktreePath(repoRoot, wtPath))) {
                const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
                const error = new Error(`worktree_remove_failed: preserving metadata for registered worker worktree at ${wtPath}${detail}`);
                error.code = 'worktree_remove_failed';
                throw error;
            }
            // Unregistered/absent stale paths are best-effort cleanup only.
        }
        try {
            runHostGit(repoRoot, ['worktree', 'prune']);
        }
        catch { /* ignore */ }
        if (branchHead)
            deleteWorkerBranchAt(repoRoot, branch, branchHead);
        // If a stale plain directory remains and git does not list it as a worktree
        // (when git cannot tell, it stays), remove it only after the shared path
        // guard proves it is an OMC team worktree child.
        if (existsSync(wtPath) && !isRegisteredWorktreePath(repoRoot, wtPath)) {
            validateWorktreeRemovalTarget({
                candidatePath: wtPath,
                expectedRoots: [join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees')],
                mainRepoRoots: [repoRoot],
            });
            if (force)
                removeRuntimeLeftover(wtPath);
            else
                rmSync(wtPath, { recursive: true, force: true });
        }
        forgetMetadataUnlocked(repoRoot, teamName, workerName);
        forgetWorktreeGitLinks(wtPath);
        return { tampered: null };
    });
}
/** Delete a directory without git: every link inside is unlinked first (targets untouched), a link itself is only unlinked. */
function removeTreeByPath(dir) {
    let stat;
    try {
        stat = lstatSync(dir);
    }
    catch {
        return;
    }
    if (stat.isSymbolicLink()) {
        try {
            unlinkSync(dir);
        }
        catch {
            rmdirSync(dir);
        }
        return;
    }
    unlinkUntrackedWorktreeLinks(dir, [], false);
    rmSync(dir, { recursive: true, force: true });
}
/**
 * Remove a worktree whose git links no longer match the record, without
 * running git in it: its git dir may be one the agent controls, with hooks
 * or an fsmonitor. Links inside are unlinked (targets untouched), then the
 * directory goes by path, and the recorded admin dir when it lies in the
 * repository's `worktrees/`. The branch is kept for inspection. Returns why.
 */
function removeTamperedWorktree(repoRoot, teamName, workerName, wtPath, links, commonDir) {
    const removeTree = removeTreeByPath;
    if (existsSync(wtPath)) {
        validateWorktreeRemovalTarget({
            candidatePath: wtPath,
            expectedRoots: [join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees')],
            mainRepoRoots: [repoRoot],
        });
    }
    removeTree(wtPath);
    if (isAdminDirOf(commonDir, links.adminDir))
        removeTree(links.adminDir);
    forgetMetadataUnlocked(repoRoot, teamName, workerName);
    return `the git links of ${wtPath} (its .git file, or its admin dir's gitdir, commondir or config.worktree) changed or are gone, so no git ran in it; `
        + `the worktree and its admin dir were removed by path and branch ${getBranchName(teamName, workerName)} was kept for inspection`;
}
/** List all worktrees for a team. */
export function listTeamWorktrees(teamName, repoRoot) {
    return readMetadata(repoRoot, teamName);
}
export function inspectTeamWorktreeCleanupSafety(teamName, repoRoot) {
    const metadata = readMetadataResult(repoRoot, teamName);
    const entries = metadata.entries;
    const backupIssues = listRootAgentsBackupIssues(repoRoot, teamName, entries);
    return {
        hasEvidence: entries.length > 0 || metadata.issues.length > 0 || backupIssues.length > 0,
        entries,
        blockers: [
            ...metadata.issues.map((issue, index) => ({
                workerName: `metadata-${index + 1}`,
                path: issue.path,
                reason: `worktree_metadata_unreadable:${issue.message}`,
            })),
            ...backupIssues.map((issue, index) => ({
                workerName: `agents-backup-${index + 1}`,
                path: issue.path,
                reason: issue.message,
            })),
        ],
    };
}
/**
 * Remove all clean worktrees for a team. Dirty or unverifiable ones are
 * `preserved` (a cleanup failure); clean ones holding unmerged worker commits
 * are `retained` (kept on purpose, not a failure).
 */
export function cleanupTeamWorktrees(teamName, repoRoot) {
    const safety = inspectTeamWorktreeCleanupSafety(teamName, repoRoot);
    const entries = safety.entries;
    const removed = [];
    const preserved = [...safety.blockers];
    const retained = [];
    if (preserved.length > 0) {
        return { removed, preserved, retained };
    }
    for (const entry of entries) {
        try {
            removeWorkerWorktree(teamName, entry.workerName, repoRoot);
            removed.push(entry.workerName);
        }
        catch (err) {
            const kept = err?.preservedWorktree;
            if (kept) {
                retained.push(kept);
                continue;
            }
            const reason = err instanceof Error ? err.message : String(err);
            preserved.push({ workerName: entry.workerName, path: entry.path, reason });
            process.stderr.write(`[omc] warning: preserved worktree ${entry.path}: ${reason}\n`);
        }
    }
    return { removed, preserved, retained };
}
//# sourceMappingURL=git-worktree.js.map