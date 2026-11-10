/**
 * The factory engine's private git store (item 2: a private repository per
 * run; design i23 4/8 and 6/8, audit-gitstore 6/6). This module only builds
 * and checks the store; the engine wiring (lane cwd, prepare checkout,
 * import before push, clean) is a separate change.
 *
 * Layout under the work root (privateWorkRoot), never under the repository
 * or the OMC state root:
 *
 *   <work>/<repo8>/seed.git          engine-only object seed (bare)
 *   <work>/<repo8>/<slug>/repo       private clone (git dir repo/.git, nothing checked out)
 *   <work>/<repo8>/<slug>/w/<n>      lane worktrees and `prep`
 *   <work>/<repo8>/<slug>/jobs       copilot_run job dirs
 *   <work>/<repo8>/<slug>/run.lock
 *
 * Objects travel only by sealed sha: user repository -> seed -> private on
 * the way in (ensureSeed, fetchIntoPrivate), private -> user repository on
 * the way out (importFromPrivate, the audit 6/6 import minus the push).
 *
 * Every git command here runs with privateGitPins on its own command line,
 * an engine-owned empty global config, no system config, replace objects and
 * grafts off (privateGitEnv), and, on a transport, the stock upload-pack with
 * its own pins (uploadPackCommand): git drops `-c` and GIT_NO_REPLACE_OBJECTS
 * for the process it spawns on the other side of a local transport, so only
 * the upload-pack command line can pin that side. Before a transport each
 * repository is checked for a redirect (a `.git`, `commondir`, `gitdir` or
 * `config.worktree` entry, or a link: review-476 HIGH-1 / 476b B2), replace
 * refs, grafts, shallow and unexpected alternates; the engine-made
 * repositories also for a config the engine did not write.
 *
 * Errors: setup functions throw PrivateStoreError with fixed text plus
 * engine-derived paths and shas only (git's stderr goes in `detail`, never in
 * the message). importFromPrivate returns a typed result whose reasons are
 * fixed text: nothing a lane wrote (paths, ref names, git output) is in them.
 */

import { createHash } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

import { defaultExec, type Exec, type ExecResult } from '../../ship/exec.js';
import { protectedChanges } from '../../ship/merge.js';
import { isUnderRoot } from '../../team/sdk-policy.js';
import { mirrorNamedRemoteKeys, mirrorRewriteKeys, REMOTE_CONFIG_ARGS, sameFsPath, URL_REWRITE_CONFIG_ARGS } from './exec.js';
import { LANE_PROTECTED_PATHS } from './lane-commit.js';
import { emptyHooksDir } from './ledger.js';

export class PrivateStoreError extends Error {
  /** git's stderr or other tool output: diagnostics only, never part of `message`. */
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'PrivateStoreError';
    this.detail = detail;
  }
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_KEY = /^[0-9a-f]{8,64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN_LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------------------
// Work root and layout

export interface WorkRootInput {
  /** The trusted user config (userConfigLayers().trustedUser): factory.run.workDir is read from it only, never from a repository. */
  userConfig: unknown;
  /** The user's checkout. */
  root: string;
  /** The OMC state root of that checkout (getOmcRoot(root)). */
  omcRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** The path with its deepest existing ancestor resolved through links (realpath), the rest appended. */
function canonicalExisting(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.unshift(basename(head));
      head = up;
    }
  }
}

/**
 * The private store's work root: factory.run.workDir from the trusted user
 * config, else %LOCALAPPDATA%\omg\fw on Windows and $XDG_CACHE_HOME/omg/fw
 * (fallback ~/.cache/omg/fw) elsewhere. Throws when it is not absolute, or
 * when it and the repository or the OMC state root contain one another
 * (links resolved): the sandbox un-denies the whole state root once a grant
 * sits inside it (sandbox.ts), and a lane worktree inside the checkout would
 * be the shared-git-dir layout again.
 */
export function privateWorkRoot(input: WorkRootInput): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const cfg = (input.userConfig as { factory?: { run?: { workDir?: unknown } } } | null | undefined)?.factory?.run?.workDir;
  let work: string;
  if (cfg !== undefined) {
    if (typeof cfg !== 'string' || !cfg.trim() || !isAbsolute(cfg.trim())) throw new PrivateStoreError('factory.run.workDir must be an absolute path');
    work = cfg.trim();
  } else if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim();
    if (!base || !isAbsolute(base)) throw new PrivateStoreError('the private store needs LOCALAPPDATA (an absolute path) or factory.run.workDir in the user config');
    work = join(base, 'omg', 'fw');
  } else {
    const xdg = env.XDG_CACHE_HOME?.trim();
    const base = xdg && isAbsolute(xdg) ? xdg : join(input.home ?? homedir(), '.cache');
    work = join(base, 'omg', 'fw');
  }
  work = resolve(work);
  const w = canonicalExisting(work);
  for (const [name, p] of [['the repository', input.root], ['the OMC state root', input.omcRoot]] as const) {
    const c = canonicalExisting(p);
    if (isUnderRoot(w, c, platform) || isUnderRoot(c, w, platform)) throw new PrivateStoreError(`the private work root ${work} and ${name} ${resolve(p)} must not contain one another; set factory.run.workDir elsewhere`);
  }
  return work;
}

export interface PrivateRunLayout {
  work: string;
  repo8: string;
  /** <work>/<repo8> */
  repoDir: string;
  /** <work>/<repo8>/seed.git */
  seed: string;
  /** <work>/<repo8>/<slug> */
  runDir: string;
  /** <work>/<repo8>/<slug>/repo (nothing checked out) */
  repo: string;
  /** <work>/<repo8>/<slug>/repo/.git */
  gitDir: string;
  /** <work>/<repo8>/<slug>/w */
  worktrees: string;
  /** <work>/<repo8>/<slug>/jobs */
  jobs: string;
  /** <work>/<repo8>/<slug>/run.lock */
  lock: string;
}

/** The layout of one run; `repoKey` is claimRepoKey (its first 8 hex name the repository dir), `slug` e.g. `issue-12` or `heal-0a1b2c3d`. */
export function privateRunLayout(work: string, repoKey: string, slug: string): PrivateRunLayout {
  if (!isAbsolute(work)) throw new PrivateStoreError('the private work root must be absolute');
  if (!REPO_KEY.test(repoKey)) throw new PrivateStoreError('the repository key must be hex (claimRepoKey)');
  if (!SLUG.test(slug)) throw new PrivateStoreError('the run slug must be lower-case letters, digits and dashes');
  const repo8 = repoKey.slice(0, 8);
  const repoDir = join(resolve(work), repo8);
  const runDir = join(repoDir, slug);
  const repo = join(runDir, 'repo');
  return { work: resolve(work), repo8, repoDir, seed: join(repoDir, 'seed.git'), runDir, repo, gitDir: join(repo, '.git'), worktrees: join(runDir, 'w'), jobs: join(runDir, 'jobs'), lock: join(runDir, 'run.lock') };
}

/** A lane worktree (`n`) or the prepare/gate checkout (`prep`) of the run. */
export function privateWorktreePath(layout: PrivateRunLayout, n: number | 'prep'): string {
  if (n !== 'prep' && !(Number.isSafeInteger(n) && n >= 0)) throw new PrivateStoreError('a lane worktree number must be a non-negative integer');
  return join(layout.worktrees, String(n));
}

/**
 * Git for Windows handles long paths with core.longpaths=true (set on every
 * command here and in the private config), but its MSYS tools (sh, the
 * `true` of core.alternateRefsCommand) stop at PATH_MAX.
 */
export const WINDOWS_GIT_PATH_MAX = 4095;

/** Null, or why `dir` + `/` + a repository path of `longest` characters is too long for git on Windows. */
export function longPathProblem(dir: string, longest: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const total = resolve(dir).length + 1 + longest;
  return total > WINDOWS_GIT_PATH_MAX
    ? `the private checkout ${resolve(dir)} plus the longest tracked path (${longest} characters) is ${total} characters, over the ${WINDOWS_GIT_PATH_MAX} git for Windows handles; set factory.run.workDir to a shorter path`
    : null;
}

// ---------------------------------------------------------------------------
// Hardened git

/** The engine-owned empty hooks dir and empty global config every command here runs with. */
export interface PrivateGitTools {
  hooksDir: string;
  globalConfig: string;
}

/** Make (or reuse) the tools under `dir` (the engine's ledger dir: its `empty-hooks` is the engine's own, emptyHooksDir). */
export function privateGitTools(dir: string): PrivateGitTools {
  const hooksDir = emptyHooksDir(dir);
  const globalConfig = join(dir, 'empty-gitconfig');
  if (!existsSync(globalConfig)) writeFileSync(globalConfig, '', { mode: 0o600 });
  return { hooksDir, globalConfig };
}

function toolsProblem(t: PrivateGitTools): string | null {
  try {
    const h = lstatSync(t.hooksDir);
    if (!h.isDirectory() || h.isSymbolicLink() || readdirSync(t.hooksDir).length > 0) return `the engine's empty hooks directory ${t.hooksDir} is not an empty directory`;
    const c = lstatSync(t.globalConfig);
    if (!c.isFile() || c.size !== 0) return `the engine's empty git config ${t.globalConfig} is not an empty file`;
  } catch {
    return `the engine's empty hooks directory ${t.hooksDir} or git config ${t.globalConfig} is missing`;
  }
  return null;
}

export interface PrivateStoreContext {
  tools: PrivateGitTools;
  /** Default defaultExec (scrubShipEnv environment). Not the engine's guarded exec: these shapes are not on its allowlist. */
  exec?: Exec;
  platform?: NodeJS.Platform;
}

/**
 * `-c` pairs on every command here (the git process itself). Hooks,
 * fsmonitor, pager, external diff, alternate-ref commands off; commit-graph
 * and multi-pack-index not read or written (a forged one could answer
 * ancestry: audit M2), no auto gc or maintenance; fsck on every object
 * received; only the file protocol (a rewrite to ext:: or a remote helper
 * cannot run); no bundle URI, no submodule recursion, no credential helper;
 * long paths on.
 */
export function privateGitPins(tools: PrivateGitTools): string[] {
  return [
    `core.hooksPath=${tools.hooksDir}`, 'core.fsmonitor=false', 'core.pager=cat', 'diff.external=',
    'core.alternateRefsCommand=true', 'core.alternateRefsPrefixes=', 'core.useReplaceRefs=false',
    'core.commitGraph=false', 'core.multiPackIndex=false', 'fetch.writeCommitGraph=false', 'gc.auto=0', 'maintenance.auto=false',
    'core.longpaths=true', 'core.protectNTFS=true', 'core.protectHFS=true',
    'transfer.fsckObjects=true', 'fetch.fsckObjects=true',
    'protocol.allow=never', 'protocol.file.allow=always', 'protocol.ext.allow=never',
    'transfer.bundleURI=false', 'fetch.recurseSubmodules=false', 'submodule.recurse=false', 'credential.helper=',
  ].flatMap((kv) => ['-c', kv]);
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `--upload-pack` of every transport here. Git runs it through the
 * shell in the repository on the other side, without our `-c` (local
 * transport drops GIT_CONFIG_PARAMETERS), so its pins are on its own command
 * line, where they beat that repository's config files (also a config
 * rewritten after the checks). uploadpack.packObjectsHook is read from
 * protected config only (system, global, command line): system is off and
 * the global config is the engine's empty file.
 */
export function uploadPackCommand(tools: PrivateGitTools): string {
  const pins = [
    `core.hooksPath=${tools.hooksDir.replace(/\\/g, '/')}`, 'core.fsmonitor=false', 'core.alternateRefsCommand=true', 'core.alternateRefsPrefixes=',
    'core.useReplaceRefs=false', 'core.commitGraph=false', 'core.multiPackIndex=false', 'gc.auto=0', 'core.longpaths=true',
    'uploadpack.allowAnySHA1InWant=true', 'uploadpack.allowFilter=false',
  ];
  return ['git', ...pins.flatMap((kv) => ['-c', sq(kv)]), 'upload-pack'].join(' ');
}

/** The environment on top of scrubShipEnv: no system config, the empty global config, no replace objects, no grafts, no prompts, no LFS download. */
export function privateGitEnv(tools: PrivateGitTools): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: tools.globalConfig, GIT_NO_REPLACE_OBJECTS: '1',
    // Inside the hooks dir, which is checked empty before every command: no graft file can exist there.
    GIT_GRAFT_FILE: join(tools.hooksDir, 'grafts'),
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', GIT_ATTR_NOSYSTEM: '1',
  };
}

function git(ctx: PrivateStoreContext, cwd: string, args: string[]): ExecResult {
  const problem = toolsProblem(ctx.tools);
  if (problem) throw new PrivateStoreError(problem);
  return (ctx.exec ?? defaultExec)('git', [...privateGitPins(ctx.tools), ...args], { cwd, env: privateGitEnv(ctx.tools) });
}

function gitOk(ctx: PrivateStoreContext, cwd: string, args: string[], what: string): string {
  const r = git(ctx, cwd, args);
  if (r.status !== 0) throw new PrivateStoreError(`${what} failed (git exit ${r.status})`, r.stderr.trim().slice(-2000));
  return r.stdout;
}

/** `fetch` from `url` (a git dir path) with no tags, no FETCH_HEAD, no refmap, no submodules, the pinned upload-pack. */
function fetchArgs(gitDir: string, tools: PrivateGitTools, url: string, refspecs: string[]): string[] {
  return [`--git-dir=${gitDir}`, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-prune', '--refmap=', `--upload-pack=${uploadPackCommand(tools)}`, url, ...refspecs];
}

// ---------------------------------------------------------------------------
// Repository checks

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const isPlainDir = (p: string): boolean => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Fixed-text reason when `gitDir` is a link, not a directory, or holds an entry that sends git to another repository. */
function redirectProblem(gitDir: string, what: string, entries: readonly string[]): string | null {
  if (!isPlainDir(gitDir)) return `${what} is not a plain directory`;
  if (entries.some((e) => lexists(join(gitDir, e)))) return `${what} has a ${entries.join(', ')} entry in its git dir (a redirect)`;
  try {
    const c = lstatSync(join(gitDir, 'config'));
    if (!c.isFile()) return `${what} config is not a regular file`;
  } catch {
    return `${what} has no config`;
  }
  if (!isPlainDir(join(gitDir, 'objects'))) return `${what} objects dir is not a plain directory`;
  return null;
}

/** Fixed-text reason when the repository has grafts or a shallow file. */
function graftProblem(gitDir: string, what: string): string | null {
  if (lexists(join(gitDir, 'info', 'grafts'))) return `${what} has info/grafts`;
  if (lexists(join(gitDir, 'shallow'))) return `${what} is shallow`;
  return null;
}

function replaceProblem(ctx: PrivateStoreContext, gitDir: string, what: string): string | null {
  const r = git(ctx, gitDir, [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', 'refs/replace/']);
  if (r.status !== 0) return `${what} refs cannot be listed`;
  return r.stdout.trim() ? `${what} has replace refs (refs/replace/*)` : null;
}

/** `key -> value` of one config file, no includes followed; null when git cannot read it. */
function configFile(ctx: PrivateStoreContext, gitDir: string): Map<string, string[]> | null {
  const r = git(ctx, gitDir, ['config', '--file', join(gitDir, 'config'), '--list', '-z']);
  if (r.status !== 0) return null;
  const out = new Map<string, string[]>();
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const nl = rec.indexOf('\n');
    const key = (nl < 0 ? rec : rec.slice(0, nl)).toLowerCase();
    out.set(key, [...(out.get(key) ?? []), nl < 0 ? '' : rec.slice(nl + 1)]);
  }
  return out;
}

const BOOL = ['true', 'false'];
/** The keys `git init`/`git clone` write and the engine adds (core.longpaths), with the values each may hold; core.bare is checked by the caller. */
const ENGINE_CONFIG: Readonly<Record<string, readonly string[]>> = {
  'core.repositoryformatversion': ['0', '1'], 'core.filemode': BOOL, 'core.bare': BOOL, 'core.symlinks': BOOL,
  'core.ignorecase': BOOL, 'core.precomposeunicode': BOOL, 'core.logallrefupdates': BOOL, 'core.longpaths': ['true'],
  'extensions.objectformat': ['sha1', 'sha256'],
};

/** Fixed-text reason when an engine-made repository's config has a key or value the engine did not write, or the wrong core.bare. */
function engineConfigProblem(ctx: PrivateStoreContext, gitDir: string, what: string, bare: boolean): string | null {
  const cfg = configFile(ctx, gitDir);
  if (!cfg) return `${what} config cannot be read`;
  for (const [key, values] of cfg) {
    const allowed = ENGINE_CONFIG[key];
    if (!allowed || values.length !== 1 || !allowed.includes(values[0].toLowerCase())) return `${what} config has a key the engine did not write`;
  }
  if (cfg.get('core.bare')?.[0]?.toLowerCase() !== String(bare)) return `${what} config does not say core.bare=${bare}`;
  return null;
}

/** sha256 of a directory listing, recursive, links not followed: relative path, kind, and content (or link target) hash. */
function listingHash(dir: string, skip: (rel: string) => boolean = () => false): string {
  const h = createHash('sha256');
  const walk = (abs: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      h.update(`${rel}\0unreadable\0`);
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const p = join(abs, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`${r}\0link\0${safeReadlink(p)}\0`);
      else if (st.isDirectory()) {
        h.update(`${r}\0dir\0`);
        walk(p, r);
      } else h.update(`${r}\0file\0${createHash('sha256').update(readFileSync(p)).digest('hex')}\0`);
    }
  };
  if (!lexists(dir)) return 'absent';
  if (lstatSync(dir).isSymbolicLink()) return `link:${safeReadlink(dir)}`;
  walk(dir, '');
  return h.digest('hex');
}

function safeReadlink(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return '?';
  }
}

function fileHash(p: string): string {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `link:${safeReadlink(p)}`;
    if (!st.isFile()) return 'not-a-file';
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return 'absent';
  }
}

// ---------------------------------------------------------------------------
// The user repository

/**
 * The user repository's common git dir, resolved once (at run start) from
 * the checkout and then passed to every function here, so a later rewrite of
 * the checkout's `.git` cannot move it; userRepoGuardSnapshot records it.
 */
export function resolveUserGitDir(root: string, ctx: PrivateStoreContext): string {
  const out = gitOk(ctx, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], `git rev-parse in ${root}`).trim();
  if (!out || !isAbsolute(out) || /[\r\n]/.test(out)) throw new PrivateStoreError(`the common git dir of ${root} cannot be resolved`);
  return resolve(out);
}

/**
 * Fixed-text reason to refuse a transport with the user repository: a
 * redirect, alternates, grafts, shallow, replace refs, a config that changes
 * fsck severities or skip lists (fetch.fsck.* beats our transfer pins), or a
 * url rewrite / remote named after one of `paths` (the private git dir it
 * fetches from: a rewrite to another protocol or repository).
 */
export function userRepoProblem(gitDir: string, ctx: PrivateStoreContext, paths: readonly string[] = []): string | null {
  const what = 'the repository';
  const redirect = redirectProblem(gitDir, what, ['.git', 'commondir']);
  if (redirect) return redirect;
  if (lexists(join(gitDir, 'objects', 'info', 'alternates')) || lexists(join(gitDir, 'objects', 'info', 'http-alternates'))) return `${what} has alternates`;
  const graft = graftProblem(gitDir, what);
  if (graft) return graft;
  const replace = replaceProblem(ctx, gitDir, what);
  if (replace) return replace;
  // The merged repository config (local, worktree, includes; system off, global empty), like the transport reads it.
  const fsck = git(ctx, gitDir, [`--git-dir=${gitDir}`, 'config', '-z', '--name-only', '--get-regexp', '^(fsck|fetch\\.fsck|receive\\.fsck|transfer\\.fsck)\\.']);
  if (fsck.status > 1) return `${what} config cannot be read`;
  if (fsck.status === 0 && fsck.stdout.trim()) return `${what} config changes fsck severities or skip lists`;
  if (paths.length > 0) {
    const rewrites = git(ctx, gitDir, [`--git-dir=${gitDir}`, ...URL_REWRITE_CONFIG_ARGS]);
    const remotes = git(ctx, gitDir, [`--git-dir=${gitDir}`, ...REMOTE_CONFIG_ARGS]);
    if (rewrites.status > 1 || remotes.status > 1) return `${what} config cannot be read`;
    if (paths.some((p) => mirrorRewriteKeys(rewrites.stdout, p).length > 0 || mirrorNamedRemoteKeys(remotes.stdout, p).length > 0)) return `${what} config rewrites or names the private store path`;
  }
  return null;
}

export type UserGuardItem = 'gitdir' | 'redirect' | 'config' | 'config.worktree' | 'includes' | 'hooks' | 'hooksPath' | 'info' | 'shallow' | 'alternates' | 'http-alternates' | 'replace';

export interface UserRepoGuard {
  gitDir: string;
  items: Record<UserGuardItem, string>;
}

/**
 * The narrow user-repository guard the engine takes under the import lock
 * (design 6/8): hashes of what can make git (or the user's next git command)
 * run something or answer differently: hooks/, the core.hooksPath dir,
 * config, config.worktree, the files config includes (one level), info/
 * (minus info/refs), shallow, alternates, http-alternates, refs/replace/*,
 * and redirect entries. Not commit-graph, multi-pack-index, bitmaps,
 * objects/info/packs or info/refs: the user's own gc and maintenance rewrite
 * them, and every command here pins them off (review-476 M-E).
 */
export function userRepoGuardSnapshot(gitDir: string, ctx: PrivateStoreContext): UserRepoGuard {
  const configPath = join(gitDir, 'config');
  const cfg = lexists(configPath) ? configFile(ctx, gitDir) : new Map<string, string[]>();
  const base = dirname(gitDir);
  const expand = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
  const includes = cfg === null ? 'unreadable' : createHash('sha256').update([...cfg].filter(([k]) => /^include(?:if\..*)?\.path$/.test(k)).flatMap(([, vs]) => vs)
    .map((v) => `${v}\0${fileHash(resolve(gitDir, expand(v)))}`).join('\0')).digest('hex');
  const hooksPath = cfg?.get('core.hookspath')?.at(-1);
  const replace = git(ctx, gitDir, [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/replace/']);
  return {
    gitDir,
    items: {
      gitdir: resolve(gitDir),
      redirect: ['.git', 'commondir', 'gitdir'].map((e) => `${e}:${fileHash(join(gitDir, e))}`).join(','),
      config: fileHash(configPath),
      'config.worktree': fileHash(join(gitDir, 'config.worktree')),
      includes,
      hooks: listingHash(join(gitDir, 'hooks')),
      hooksPath: hooksPath ? `${hooksPath}\0${listingHash(resolve(base, expand(hooksPath)))}` : 'unset',
      info: listingHash(join(gitDir, 'info'), (rel) => rel === 'refs'),
      shallow: fileHash(join(gitDir, 'shallow')),
      alternates: fileHash(join(gitDir, 'objects', 'info', 'alternates')),
      'http-alternates': fileHash(join(gitDir, 'objects', 'info', 'http-alternates')),
      replace: replace.status === 0 ? createHash('sha256').update(replace.stdout).digest('hex') : 'unreadable',
    },
  };
}

/** The items that differ (fixed names); empty = unchanged. */
export function compareUserRepoGuard(before: UserRepoGuard, after: UserRepoGuard): UserGuardItem[] {
  return (Object.keys(before.items) as UserGuardItem[]).filter((k) => before.items[k] !== after.items[k] || before.items[k] === 'unreadable');
}

// ---------------------------------------------------------------------------
// Seed

const seedRef = (sha: string): string => `refs/heads/omg-${sha}`;

/** Fixed-text reason to refuse the seed: a redirect, a config the engine did not write, alternates, grafts, shallow, replace refs. */
export function seedProblem(seed: string, ctx: PrivateStoreContext): string | null {
  const what = 'the private store seed';
  return redirectProblem(seed, what, ['.git', 'commondir', 'gitdir', 'config.worktree'])
    ?? engineConfigProblem(ctx, seed, what, true)
    ?? (lexists(join(seed, 'objects', 'info', 'alternates')) || lexists(join(seed, 'objects', 'info', 'http-alternates')) ? `${what} has alternates` : null)
    ?? graftProblem(seed, what)
    ?? replaceProblem(ctx, seed, what);
}

function hasCommit(ctx: PrivateStoreContext, gitDir: string, sha: string): boolean {
  return git(ctx, gitDir, [`--git-dir=${gitDir}`, 'cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

/**
 * Make the seed (`git init --bare --template=`) when it is missing, check
 * it, then fetch `sha` by sha from the user repository into
 * `refs/heads/omg-<sha>` (a ref per sha, so runs on other bases never race).
 * The user repository is checked first (userRepoProblem); its upload-pack
 * runs pinned (uploadPackCommand). The seed never gets refs/replace or tags:
 * the one refspec names its destination.
 */
export function ensureSeed(layout: PrivateRunLayout, userGitDir: string, sha: string, ctx: PrivateStoreContext): void {
  if (!SHA.test(sha)) throw new PrivateStoreError('the seed fetch needs a full commit sha');
  if (!lexists(layout.seed)) {
    mkdirSync(layout.repoDir, { recursive: true });
    gitOk(ctx, layout.repoDir, ['-c', 'init.defaultBranch=omg-seed', 'init', '-q', '--bare', '--template=', layout.seed], `git init of the seed ${layout.seed}`);
  }
  const seedBad = seedProblem(layout.seed, ctx);
  if (seedBad) throw new PrivateStoreError(`${seedBad} (${layout.seed}); remove it (omg factory run clean --seed)`);
  const ref = seedRef(sha);
  const have = git(ctx, layout.seed, [`--git-dir=${layout.seed}`, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (have.status === 0 && have.stdout.trim() === sha) return;
  const userBad = userRepoProblem(userGitDir, ctx);
  if (userBad) throw new PrivateStoreError(`${userBad} (${userGitDir}); the private store refuses to fetch from it`);
  gitOk(ctx, layout.repoDir, fetchArgs(layout.seed, ctx.tools, userGitDir, [`+${sha}:${ref}`]), `the seed fetch of ${sha}`);
  const got = gitOk(ctx, layout.seed, [`--git-dir=${layout.seed}`, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], `the seed ref of ${sha}`).trim();
  if (got !== sha) throw new PrivateStoreError(`the seed ref for ${sha} names another commit`);
}

// ---------------------------------------------------------------------------
// The private repository

export interface PrivateRepo {
  /** <slug>/repo */
  repo: string;
  /** <slug>/repo/.git */
  gitDir: string;
  /** The seed its alternates name. */
  seed: string;
  baseSha: string;
  /** privateRepoConfigHash at creation (or the engine's last own config write). */
  configHash: string;
  /** The longest tracked path at the base, for longPathProblem on lane worktrees. */
  longestPath: number;
}

/**
 * sha256 over the private git dir's config, config.worktree, hooks/ and
 * info/ (listings with content). The engine records it after its own last
 * config write and compares it before every transport.
 */
export function privateRepoConfigHash(gitDir: string): string {
  return createHash('sha256').update([
    `config\0${fileHash(join(gitDir, 'config'))}`,
    `config.worktree\0${fileHash(join(gitDir, 'config.worktree'))}`,
    `hooks\0${listingHash(join(gitDir, 'hooks'))}`,
    `info\0${listingHash(join(gitDir, 'info'))}`,
  ].join('\0')).digest('hex');
}

/** Null when `gitDir`'s alternates are exactly one line naming `<seed>/objects`. */
function alternatesProblem(gitDir: string, seed: string, what: string): string | null {
  if (lexists(join(gitDir, 'objects', 'info', 'http-alternates'))) return `${what} has http-alternates`;
  let text: string;
  try {
    if (!lstatSync(join(gitDir, 'objects', 'info', 'alternates')).isFile()) return `${what} alternates is not a regular file`;
    text = readFileSync(join(gitDir, 'objects', 'info', 'alternates'), 'utf8');
  } catch {
    return `${what} has no alternates to the seed`;
  }
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  return lines.length === 1 && isAbsolute(lines[0]) && sameFsPath(lines[0], join(seed, 'objects')) ? null : `${what} alternates do not name exactly the seed`;
}

/**
 * Fixed-text reason to refuse a transport with the private repository: a
 * redirect, a config/hooks/info hash other than the recorded one, a config
 * the engine did not write (core.bare must be false, no core.worktree),
 * alternates other than exactly the seed, grafts, shallow, replace refs.
 */
export function privateRepoProblem(p: PrivateRepo, ctx: PrivateStoreContext): string | null {
  const what = 'the private repository';
  return redirectProblem(p.gitDir, what, ['.git', 'commondir', 'gitdir', 'config.worktree'])
    ?? (privateRepoConfigHash(p.gitDir) !== p.configHash ? `${what} config, hooks or info changed since the engine wrote them` : null)
    ?? engineConfigProblem(ctx, p.gitDir, what, false)
    ?? alternatesProblem(p.gitDir, p.seed, what)
    ?? graftProblem(p.gitDir, what)
    ?? replaceProblem(ctx, p.gitDir, what);
}

/**
 * Clone the run's private repository from the seed: `--no-local` (only
 * reachable objects, no refs/replace, no copied info/), `--no-checkout
 * --no-tags --single-branch --template=`, `--reference <seed>` so its
 * alternates point only at the engine-owned seed (verified: exactly that one
 * line). Then HEAD == baseSha (detached; the clone's branch deleted), the
 * origin remote removed, core.longpaths=true written, the config checked
 * against what the engine wrote, and its hash recorded.
 */
export function createPrivateRepo(layout: PrivateRunLayout, baseSha: string, ctx: PrivateStoreContext): PrivateRepo {
  if (!SHA.test(baseSha)) throw new PrivateStoreError('the private repository needs a full base sha');
  if (lexists(layout.repo)) throw new PrivateStoreError(`the private repository ${layout.repo} already exists; remove the run dir first`);
  const seedBad = seedProblem(layout.seed, ctx);
  if (seedBad) throw new PrivateStoreError(`${seedBad} (${layout.seed})`);
  const ref = seedRef(baseSha);
  const at = git(ctx, layout.seed, [`--git-dir=${layout.seed}`, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (at.status !== 0 || at.stdout.trim() !== baseSha) throw new PrivateStoreError(`the seed has no ${baseSha} (ensureSeed first)`);
  const names = gitOk(ctx, layout.seed, [`--git-dir=${layout.seed}`, 'ls-tree', '-r', '-z', '--name-only', '--full-tree', baseSha], `the path listing of ${baseSha}`);
  const longestPath = names.split('\0').reduce((m, n) => Math.max(m, n.length), 0);
  const tooLong = longPathProblem(join(layout.worktrees, 'prep'), longestPath, ctx.platform);
  if (tooLong) throw new PrivateStoreError(tooLong);
  mkdirSync(layout.runDir, { recursive: true });
  gitOk(ctx, layout.runDir, ['clone', '-q', '--no-local', '--no-checkout', '--no-tags', '--single-branch', '--branch', `omg-${baseSha}`, '--template=',
    '--reference', layout.seed, `--upload-pack=${uploadPackCommand(ctx.tools)}`, layout.seed, layout.repo], `the private clone of ${baseSha}`);
  const g = layout.gitDir;
  gitOk(ctx, layout.repo, [`--git-dir=${g}`, 'remote', 'remove', 'origin'], 'removing the private clone\'s origin');
  gitOk(ctx, layout.repo, [`--git-dir=${g}`, 'update-ref', '--no-deref', '-m', 'omg private store', 'HEAD', baseSha], 'detaching the private HEAD');
  gitOk(ctx, layout.repo, [`--git-dir=${g}`, 'update-ref', '--no-deref', '-d', `refs/heads/omg-${baseSha}`, baseSha], 'deleting the clone branch');
  gitOk(ctx, layout.repo, [`--git-dir=${g}`, 'config', 'core.longpaths', 'true'], 'writing core.longpaths');
  const head = gitOk(ctx, layout.repo, [`--git-dir=${g}`, 'rev-parse', '--verify', 'HEAD^{commit}'], 'reading the private HEAD').trim();
  if (head !== baseSha) throw new PrivateStoreError(`the private repository HEAD is not the sealed base ${baseSha}`);
  const refs = gitOk(ctx, layout.repo, [`--git-dir=${g}`, 'for-each-ref', '--format=%(refname)'], 'listing the private refs').trim();
  if (refs) throw new PrivateStoreError('the private clone has refs the engine did not expect');
  const repo: PrivateRepo = { repo: layout.repo, gitDir: g, seed: layout.seed, baseSha, configHash: privateRepoConfigHash(g), longestPath };
  const bad = privateRepoProblem(repo, ctx);
  if (bad) throw new PrivateStoreError(`${bad} (${g})`);
  return repo;
}

/**
 * Objects in (a moved base, an adopted head): `sha` by sha from the user
 * repository into the seed (ensureSeed), then from the seed into the
 * private repository (no ref, no FETCH_HEAD: the objects stay reachable
 * through the seed's ref), both checked first; then the private repository
 * must have the commit.
 */
export function fetchIntoPrivate(layout: PrivateRunLayout, p: PrivateRepo, userGitDir: string, sha: string, ctx: PrivateStoreContext): void {
  if (!SHA.test(sha)) throw new PrivateStoreError('objects in need a full commit sha');
  ensureSeed(layout, userGitDir, sha, ctx);
  const bad = privateRepoProblem(p, ctx);
  if (bad) throw new PrivateStoreError(`${bad} (${p.gitDir})`);
  gitOk(ctx, p.repo, fetchArgs(p.gitDir, ctx.tools, p.seed, [sha]), `the private fetch of ${sha}`);
  if (!hasCommit(ctx, p.gitDir, sha)) throw new PrivateStoreError(`the private repository does not have ${sha} after the fetch`);
}

// ---------------------------------------------------------------------------
// Objects out: the import

export interface ImportInput {
  /** The user repository's common git dir (resolveUserGitDir at run start). */
  userGitDir: string;
  privateRepo: PrivateRepo;
  /** The sealed commit to import (the engine's commit-tree output). */
  sha: string;
  /** Its parents, in order, exactly. */
  expectedParents: readonly string[];
  /** The tree the protected-path diff starts from (the lane's start: base or the previous head). */
  startSha: string;
  /** Run label (ref component): `refs/omg-import/<run>/<n>`. */
  run: string;
  n: number;
  /** Configured protected paths (factory/ship config), on top of ship PROTECTED_PATHS and LANE_PROTECTED_PATHS. */
  extraProtected?: readonly string[];
}

export type ImportRefusalCode = 'bad-input' | 'user-repo' | 'private-repo' | 'fetch-failed' | 'ref-mismatch' | 'parents-mismatch' | 'diff-failed' | 'protected-path' | 'gitlink' | 'symlink';

export type ImportResult =
  | { ok: true; ref: string; files: string[] }
  | { ok: false; code: ImportRefusalCode; reason: string };

/** The user-repository ref an import lands on; never a branch. */
export function importRef(run: string, n: number): string {
  if (!RUN_LABEL.test(run) || run.endsWith('.lock') || !(Number.isSafeInteger(n) && n >= 0)) throw new PrivateStoreError('the import ref needs a plain run label and a non-negative number');
  return `refs/omg-import/${run}/${n}`;
}

const refuse = (code: ImportRefusalCode, reason: string): ImportResult => ({ ok: false, code, reason });

interface RawChange { srcMode: string; dstMode: string; status: string; path: string }

/** `diff-tree -r -z --raw` records: `:<src> <dst> <srcoid> <dstoid> <status>\0<path>\0` (no renames, so one path each). */
function parseRawDiff(out: string): RawChange[] | null {
  const parts = out.split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i === parts.length - 1) break;
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMDT])$/.exec(parts[i]);
    if (!m || i + 1 >= parts.length) return null;
    changes.push({ srcMode: m[1], dstMode: m[2], status: m[3], path: parts[++i] });
  }
  return changes;
}

/**
 * Import `sha` from the private repository into the user repository (audit
 * 6/6 steps 1-4): both repositories checked (userRepoProblem with the url
 * rewrite check on the private path; privateRepoProblem), then a hardened
 * `fetch +<sha>:refs/omg-import/<run>/<n>` in the user repository (fsck on
 * every object, no FETCH_HEAD, no tags, no submodules, pinned upload-pack),
 * then the ref must name `sha`, `rev-list --parents` must equal
 * `expectedParents` exactly, and the two-tree `diff-tree -r --no-renames
 * <startSha> <sha>` may touch no protected path (ship + lane + configured)
 * and add or change no gitlink (160000) or symlink (120000). Any refusal
 * after the fetch deletes the import ref. The push and dropImportRef are the
 * caller's.
 */
export function importFromPrivate(input: ImportInput, ctx: PrivateStoreContext): ImportResult {
  const { userGitDir: user, privateRepo: p, sha, startSha } = input;
  if (!SHA.test(sha) || !SHA.test(startSha) || input.expectedParents.some((x) => !SHA.test(x)) || !RUN_LABEL.test(input.run) || !(Number.isSafeInteger(input.n) && input.n >= 0)) {
    return refuse('bad-input', 'the import needs full shas, a plain run label and a non-negative number');
  }
  const ref = importRef(input.run, input.n);
  const userBad = userRepoProblem(user, ctx, [p.gitDir, p.repo]);
  if (userBad) return refuse('user-repo', userBad);
  const privateBad = privateRepoProblem(p, ctx);
  if (privateBad) return refuse('private-repo', privateBad);
  const fetched = git(ctx, user, fetchArgs(user, ctx.tools, p.gitDir, [`+${sha}:${ref}`]));
  const drop = (r: ImportResult): ImportResult => {
    git(ctx, user, [`--git-dir=${user}`, 'update-ref', '--no-deref', '-d', ref]);
    return r;
  };
  if (fetched.status !== 0) return drop(refuse('fetch-failed', 'the import fetch failed (an object failed fsck, or the commit is missing from the private repository)'));
  const at = git(ctx, user, [`--git-dir=${user}`, 'rev-parse', '--verify', '--end-of-options', ref]);
  if (at.status !== 0 || at.stdout.trim() !== sha) return drop(refuse('ref-mismatch', 'the import ref does not name the sealed commit'));
  const type = git(ctx, user, [`--git-dir=${user}`, 'cat-file', '-t', sha]);
  if (type.status !== 0 || type.stdout.trim() !== 'commit') return drop(refuse('ref-mismatch', 'the imported object is not a commit'));
  const parents = git(ctx, user, [`--git-dir=${user}`, 'rev-list', '--parents', '-n', '1', sha]);
  const got = parents.status === 0 ? parents.stdout.trim().split(/\s+/) : [];
  if (got[0] !== sha || JSON.stringify(got.slice(1)) !== JSON.stringify([...input.expectedParents])) return drop(refuse('parents-mismatch', 'the imported commit does not have exactly the expected parents'));
  const diff = git(ctx, user, [`--git-dir=${user}`, 'diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--full-index', startSha, sha]);
  const changes = diff.status === 0 ? parseRawDiff(diff.stdout) : null;
  if (!changes) return drop(refuse('diff-failed', 'the import diff against the start commit cannot be read'));
  const files = changes.map((c) => c.path);
  if (protectedChanges(files, [...LANE_PROTECTED_PATHS, ...(input.extraProtected ?? [])]).length > 0) return drop(refuse('protected-path', 'the imported commit changes a protected path'));
  if (changes.some((c) => c.status !== 'D' && c.dstMode === '160000')) return drop(refuse('gitlink', 'the imported commit adds or changes a gitlink (submodule)'));
  if (changes.some((c) => c.status !== 'D' && c.dstMode === '120000')) return drop(refuse('symlink', 'the imported commit adds or changes a symlink'));
  return { ok: true, ref, files };
}

/** Delete the import ref (after the push, or to clean up). */
export function dropImportRef(userGitDir: string, run: string, n: number, ctx: PrivateStoreContext): void {
  const ref = importRef(run, n);
  gitOk(ctx, userGitDir, [`--git-dir=${userGitDir}`, 'update-ref', '--no-deref', '-d', ref], `deleting ${ref}`);
}

// ---------------------------------------------------------------------------
// Removal

/** Unlink a symlink or junction itself (on win32 a directory link may need rmdir); the target is never touched. */
function unlinkLink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

function findLink(dir: string): string | null {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st: Stats = lstatSync(p);
    if (st.isSymbolicLink()) return p;
    if (st.isDirectory()) {
      const deeper = findLink(p);
      if (deeper) return deeper;
    }
  }
  return null;
}

function unlinkLinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) unlinkLink(p);
    else if (st.isDirectory()) unlinkLinks(p);
  }
}

/** Remove a tree that holds no link: files (read-only ones too: git's objects), then directories; a link found refuses. */
function removeTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new PrivateStoreError(`a link appeared under ${dir} during removal; nothing more removed`);
    if (st.isDirectory()) removeTree(p);
    else {
      try {
        unlinkSync(p);
      } catch {
        chmodSync(p, 0o666);
        unlinkSync(p);
      }
    }
  }
  rmdirSync(dir);
}

/**
 * Remove a run dir under the work root without ever following a link (a
 * worktree removal once emptied the TARGET of a node_modules junction):
 * unlink every symlink and junction at any depth, prove by an lstat walk that
 * none remains (refuse otherwise), then delete files and directories bottom
 * up, refusing at any link that appeared meanwhile. PR #478's helper is not
 * on dev; switch to it when it lands if it covers the same walk.
 */
export function removeRunDir(dir: string, work: string, platform: NodeJS.Platform = process.platform): void {
  const d = resolve(dir);
  if (!isUnderRoot(d, work, platform) || sameFsPath(d, work)) throw new PrivateStoreError(`${d} is not under the private work root ${resolve(work)}`);
  if (!lexists(d)) return;
  if (lstatSync(d).isSymbolicLink()) {
    unlinkLink(d);
    return;
  }
  unlinkLinks(d);
  const left = findLink(d);
  if (left) throw new PrivateStoreError(`a link remains under ${d} after unlinking; nothing removed`);
  removeTree(d);
}

// ---------------------------------------------------------------------------
// node_modules rule

/** The lockfiles whose bytes decide the node_modules policy, at the repository root. */
export const LOCKFILES: readonly string[] = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

export interface LockfileRule {
  /** `junction`: the main checkout's node_modules may be linked read-only; `park`: factory.run.gateInstall decides. */
  policy: 'junction' | 'park';
  /** The lockfiles at the base. */
  lockfiles: string[];
  /** Lockfiles changed, removed or added at the head (fixed names from LOCKFILES). */
  changed: string[];
}

function lockEntries(ctx: PrivateStoreContext, gitDir: string, sha: string): Map<string, string> {
  const out = gitOk(ctx, gitDir, [`--git-dir=${gitDir}`, 'ls-tree', '-z', '--full-tree', '--full-name', sha, '--', ...LOCKFILES], `the lockfile listing of ${sha}`);
  const map = new Map<string, string>();
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const name = rec.slice(tab + 1);
    if (tab > 0 && LOCKFILES.includes(name)) map.set(name, rec.slice(0, tab));
  }
  return map;
}

/**
 * The design 4/8 node_modules rule: `junction` only when the base has at
 * least one lockfile and every lockfile entry at the head is identical to
 * the base's (mode and blob id: git's ids are content hashes, so equal ids
 * are equal bytes), no lockfile added, and each is a regular file; `park`
 * otherwise. Both shas are sealed and read from `gitDir` (the private
 * repository holds both).
 */
export function lockfileUnchanged(gitDir: string, baseSha: string, headSha: string, ctx: PrivateStoreContext): LockfileRule {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new PrivateStoreError('the lockfile rule needs full shas');
  const base = lockEntries(ctx, gitDir, baseSha);
  const head = lockEntries(ctx, gitDir, headSha);
  const lockfiles = LOCKFILES.filter((f) => base.has(f));
  const changed = LOCKFILES.filter((f) => base.get(f) !== head.get(f) || (base.has(f) && !/^100(?:644|755) blob /.test(base.get(f)!)));
  return { policy: lockfiles.length > 0 && changed.length === 0 ? 'junction' : 'park', lockfiles, changed };
}
