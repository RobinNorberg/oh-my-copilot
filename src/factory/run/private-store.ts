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
 * The private repository is a full copy of the seed (no alternates), and
 * the seed, like `<work>/<repo8>` as a whole, must stay read-only to lanes.
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

import { createHash, randomBytes } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, type BigIntStats, type Stats } from 'fs';
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

/**
 * The path with its deepest existing ancestor resolved through links
 * (realpath), the rest appended. A dangling link or any error other than a
 * missing path is a PrivateStoreError (review-481 L9).
 */
function canonicalExisting(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new PrivateStoreError(`the path ${resolve(p)} cannot be resolved`, String((err as Error).message));
      if (lexists(head)) throw new PrivateStoreError(`the path ${resolve(p)} holds a dangling link at ${head}`);
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.unshift(basename(head));
      head = up;
    }
  }
}

/**
 * isUnderRoot that folds case on darwin as on win32 (APFS and HFS+ are
 * case-insensitive by default; review-481 L8; isUnderRoot folds on win32
 * only, so darwin is passed as win32, which changes nothing but the fold),
 * and whose errors (a dangling link) are PrivateStoreErrors (L9).
 */
function under(p: string, root: string, platform: NodeJS.Platform): boolean {
  try {
    return isUnderRoot(p, root, platform === 'darwin' ? 'win32' : platform);
  } catch (err) {
    throw new PrivateStoreError(`the path ${resolve(p)} or ${resolve(root)} cannot be resolved`, String((err as Error).message));
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
    if (under(w, c, platform) || under(c, w, platform)) throw new PrivateStoreError(`the private work root ${work} and ${name} ${resolve(p)} must not contain one another; set factory.run.workDir elsewhere`);
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
  /** Kill any git command here after this many milliseconds (default PRIVATE_GIT_TIMEOUT_MS); a timeout is a refusal (PrivateGitTimeout). */
  timeoutMs?: number;
}

/** Ten minutes: a first seed fetch or clone of a large repository fits; a hung pack or a FIFO include does not hang the engine (review-481 L7). */
export const PRIVATE_GIT_TIMEOUT_MS = 600_000;

/** resolveUserGitDir's budget (review-481c N5): a plain rev-parse, which a FIFO include holds no longer than this. */
export const RESOLVE_TIMEOUT_MS = 30_000;

/** A git command here ran out of time and was killed; fixed text. */
export class PrivateGitTimeout extends PrivateStoreError {
  constructor(ms: number) {
    super(`a private store git command timed out after ${ms} ms and was killed`);
    this.name = 'PrivateGitTimeout';
  }
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

/**
 * The environment on top of scrubShipEnv: no system config, the empty global
 * config, no replace objects, no grafts, no prompts, no LFS download, and no
 * lazy fetch: a promisor remote planted in a repository's config (its
 * uploadpack a command) would otherwise run on any read of a missing object,
 * a plain `ls-tree` or `cat-file -e` included (review-481 HIGH-1); with it a
 * missing object is an error, and a partial-clone user repository fails
 * closed.
 */
export function privateGitEnv(tools: PrivateGitTools): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: tools.globalConfig, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    // Inside the hooks dir, which is checked empty before every command: no graft file can exist there.
    GIT_GRAFT_FILE: join(tools.hooksDir, 'grafts'),
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', GIT_ATTR_NOSYSTEM: '1',
  };
}

function git(ctx: PrivateStoreContext, cwd: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): ExecResult {
  const problem = toolsProblem(ctx.tools);
  if (problem) throw new PrivateStoreError(problem);
  const timeoutMs = ctx.timeoutMs ?? PRIVATE_GIT_TIMEOUT_MS;
  const started = Date.now();
  const r = (ctx.exec ?? defaultExec)('git', [...privateGitPins(ctx.tools), ...args], { cwd, env: { ...extraEnv, ...privateGitEnv(ctx.tools) }, timeoutMs });
  // spawnSync kills the child at the timeout and reports a failure; a failure that took the whole budget is that kill.
  if (r.status !== 0 && Date.now() - started >= timeoutMs) throw new PrivateGitTimeout(timeoutMs);
  return r;
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

/**
 * `key -> value` of one config file (default `<gitDir>/config`), no includes
 * followed; null when git cannot read it. `--git-dir` is the engine's empty
 * hooks dir (not a repository): without it git discovers a repository from
 * its cwd and reads that one's merged config, includes and all, even for
 * `--file` (probe, git 2.51; review-481b: a FIFO include would block it).
 */
function configFile(ctx: PrivateStoreContext, gitDir: string, file = join(gitDir, 'config')): Map<string, string[]> | null {
  const r = git(ctx, ctx.tools.hooksDir, [`--git-dir=${ctx.tools.hooksDir}`, 'config', '--file', file, '--list', '-z']);
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
  // A partial clone (extensions.partialClone, a promisor remote) lazy-fetches through a remote's uploadpack command: review-481 HIGH-1.
  if ([...cfg.keys()].some((k) => k === 'extensions.partialclone' || /^remote\..*\.(?:promisor|partialclonefilter)$/.test(k))) return `${what} config makes it a partial clone (promisor remote)`;
  // Format version 1 exactly when the one extension the engine allows (the object format) is set, else 0; any other extension is refused below.
  if (cfg.get('core.repositoryformatversion')?.[0] !== (cfg.has('extensions.objectformat') ? '1' : '0')) return `${what} config has a repository format version the engine did not write`;
  for (const [key, values] of cfg) {
    const allowed = ENGINE_CONFIG[key];
    if (!allowed || values.length !== 1 || !allowed.includes(values[0].toLowerCase())) return `${what} config has a key the engine did not write`;
  }
  if (cfg.get('core.bare')?.[0]?.toLowerCase() !== String(bare)) return `${what} config does not say core.bare=${bare}`;
  return null;
}

/** What listingHash returns when a capped walk goes deeper or wider than its cap, or meets a file over HOOK_FILE_MAX_BYTES. */
const TOO_LARGE = 'too-large';

/** A file in a capped (hooks) listing larger than this is not read: the listing is TOO_LARGE (review-481c N1). */
export const HOOK_FILE_MAX_BYTES = 1024 * 1024;

/**
 * sha256 of a directory listing, recursive, links not followed: relative
 * path, kind, and content (or link target) hash. With `cap`, a walk deeper
 * than `cap.depth` directory levels or past `cap.entries` entries stops and
 * returns TOO_LARGE (review-481b: a hooksPath such as `.` would hash the
 * whole checkout at every snapshot).
 */
function listingHash(dir: string, cap?: { depth: number; entries: number }): string {
  const h = createHash('sha256');
  let seen = 0;
  const walk = (abs: string, rel: string, depth: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      h.update(`${rel}\0unreadable\0`);
      return true;
    }
    for (const name of names) {
      if (cap && ++seen > cap.entries) return false;
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`${r}\0link\0${safeReadlink(p)}\0`);
      else if (st.isDirectory()) {
        if (cap && depth + 1 > cap.depth) return false;
        h.update(`${r}\0dir\0`);
        if (!walk(p, r, depth + 1)) return false;
      } else if (!st.isFile()) {
        // review-481c N1: a FIFO, socket or device (core.hooksPath=/dev) is never read: readFileSync would block on it.
        h.update(`${r}\0other\0`);
      } else if (cap && st.size > HOOK_FILE_MAX_BYTES) {
        return false;
      } else h.update(`${r}\0file\0${createHash('sha256').update(readFileSync(p)).digest('hex')}\0`);
    }
    return true;
  };
  if (!lexists(dir)) return 'absent';
  if (lstatSync(dir).isSymbolicLink()) return `link:${safeReadlink(dir)}`;
  return walk(dir, '', 0) ? h.digest('hex') : TOO_LARGE;
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
  // review-481c N5: this first git command in the checkout reads its merged config before any file-level check, so a
  // FIFO include there would hold it for the whole PRIVATE_GIT_TIMEOUT_MS; it gets a short budget of its own.
  const short: PrivateStoreContext = { ...ctx, timeoutMs: Math.min(ctx.timeoutMs ?? RESOLVE_TIMEOUT_MS, RESOLVE_TIMEOUT_MS) };
  const out = gitOk(short, root,['rev-parse', '--path-format=absolute', '--git-common-dir'], `git rev-parse in ${root}`).trim();
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
  // review-481b: every git command in the repository (for-each-ref too) reads its merged config, following includes, where a FIFO include would block until the timeout.
  if (!configFilesReadable(ctx, gitDir)) return `${what} config or a file it includes cannot be read (not a regular file, unreadable, or nested more than ${MAX_INCLUDE_DEPTH} deep)`;
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

export type UserGuardItem = 'gitdir' | 'redirect' | 'config' | 'hooks' | 'hooksPath' | 'modules' | 'worktrees' | 'grafts' | 'shallow' | 'alternates' | 'http-alternates' | 'replace';

/**
 * What one guard entry is (machine-readable, for the engine's park message):
 * - `config-key`: a dangerous key in a config file (`path` the file, `key` its name);
 * - `config-link`: a config or included file that is a link (`path` the link);
 * - `include-not-followed`: a conditional include (includeIf) whose target is
 *   a directory or cannot be read; git skips it while the condition is false
 *   and fails while it is true, so it is recorded, not counted as unreadable;
 * - `unreadable`: what could not be read (`path`), or the snapshot failed;
 * - `hooks-dir`: a hooks dir listing (`path` the dir); `hooks-path`: a
 *   core.hooksPath value's dir (`path` the resolved dir, `key` core.hookspath);
 * - `hooks-too-large`: a hooks dir deeper than 3 levels or over 2 000
 *   entries; `hooks-path-root`: a hooksPath that resolves to the work tree
 *   root or the git dir;
 * - `module`: a submodule git dir (`path` modules/<name>); `worktree`: a
 *   worktrees/<id> entry that is not stock;
 * - `redirect-entry`, `grafts`, `shallow`, `alternates`, `http-alternates`:
 *   that file (`path`); `replace-ref`: a refs/replace/* ref (`path` its name);
 *   `gitdir`: the git dir itself.
 */
export type UserGuardKind =
  | 'gitdir' | 'redirect-entry' | 'config-key' | 'config-link' | 'include-not-followed' | 'unreadable'
  | 'hooks-dir' | 'hooks-path' | 'hooks-too-large' | 'hooks-path-root'
  | 'module' | 'worktree' | 'grafts' | 'shallow' | 'alternates' | 'http-alternates' | 'replace-ref';

/** One guard entry as the engine may print it: never a config value (values may hold secrets); URL userinfo in a key name is masked. */
export interface UserGuardDetail {
  item: UserGuardItem;
  kind: UserGuardKind;
  path: string;
  key?: string;
}

/** A guard entry with its fingerprint (a sha256 over what it covers, values included: compare only, never print). */
export interface UserGuardEntry extends UserGuardDetail {
  fingerprint: string;
}

export interface UserRepoGuard {
  gitDir: string;
  items: Record<UserGuardItem, string>;
  entries: UserGuardEntry[];
}

/** Item values that always count as changed: nothing could be compared. */
const GUARD_UNREADABLE = 'unreadable';
const GUARD_TOO_LARGE = 'too-large';

/**
 * The config keys (lower case) the user guard hashes: those that make git
 * run a program, load more config, or redirect a transport or the
 * repository (the lead's rule on review-481 L5/M4), plus the other
 * program-running keys git has (core.editor/pager/askpass, sequence.editor,
 * pager.*, difftool/mergetool cmds, submodule.*.update, http proxies, and
 * config-based hooks `hook.<name>.*` of newer git). Not branch.*,
 * remote.*.url/fetch/pushurl, user.*, core.sparseCheckout or
 * extensions.worktreeConfig (config.worktree files are hashed whether or not
 * it is on): the user's own `push -u`, `remote add`, `sparse-checkout` write
 * those, and the guard must not park on the user's ordinary git activity.
 */
const DANGEROUS_CONFIG: readonly RegExp[] = [
  /^core\.(?:hookspath|fsmonitor|sshcommand|gitproxy|alternaterefscommand|worktree|bare|editor|pager|askpass)$/,
  /^extensions\.(?!worktreeconfig$)/, /^filter\./, /^diff\..+\.(?:textconv|command)$/, /^diff\.external$/, /^merge\..+\.driver$/, /^gpg\./,
  /^credential\.(?:.+\.)?helper$/, /^url\..+\.(?:insteadof|pushinsteadof)$/, /^uploadpack\./, /^receive\./,
  /^remote\..+\.(?:uploadpack|receivepack|promisor|proxy)$/, /^include\./, /^includeif\./, /^protocol\./, /^alias\./,
  /^sequence\.editor$/, /^pager\./, /^(?:diff|merge)tool\..+\.cmd$/, /^submodule\..+\.update$/, /^http\.(?:.+\.)?proxy$/, /^hook\./,
];

/** git's own include depth limit: deeper is refused (the item reads `unreadable`, which always counts as changed). */
const MAX_INCLUDE_DEPTH = 10;

/** The hooks dir walk cap (review-481b): deeper or wider is the fixed `hooks-too-large` entry. */
const HOOKS_CAP = { depth: 3, entries: 2000 };

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const fingerprint = (...parts: readonly string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex');

/**
 * A config key name fit to print: URL userinfo in a subsection
 * (`url.https://user:token@host/.insteadof`) and a URL query or fragment up to
 * the key name (`url.https://h/?t=X.insteadof`: review-481c N4) masked.
 */
export const printableKey = (key: string): string => key.replace(/\/\/[^/@\s]*@/g, '//***@').replace(/[?#].*(?=\.[^.]*$)/, '?***');

interface ConfigWalk {
  item: UserGuardItem;
  out: UserGuardEntry[];
  hooksPaths: Set<string>;
}

/**
 * Entries for the dangerous keys in `file` and every file it includes
 * (include.path and includeIf.*.path whatever the condition, relative to the
 * including file's dir), depth-bounded; files with no dangerous key add
 * nothing, so a new worktree or an empty config.worktree changes nothing.
 * Returns false when a file is unreadable, not a regular file, or the depth
 * is exceeded; a CONDITIONAL include (or anything it includes) whose target
 * is a directory or cannot be read is recorded as `include-not-followed`
 * instead (git skips it while its condition is false; review-481b). Its
 * condition is not evaluated: onbranch:, gitdir: and hasconfig: can turn
 * true without any config write (a checkout, another worktree, a
 * `remote add`), so the content of every include is hashed. A FIFO or other
 * special file stays unreadable either way: git would block on it if the
 * condition held. Collects every core.hooksPath value it meets.
 */
function dangerousConfig(ctx: PrivateStoreContext, file: string, w: ConfigWalk, depth = 0, conditional = false): boolean {
  const entry = (kind: UserGuardKind, fp: string, key?: string) => w.out.push({ item: w.item, kind, path: file, ...(key ? { key: printableKey(key) } : {}), fingerprint: fp });
  if (depth > MAX_INCLUDE_DEPTH) {
    entry('unreadable', 'depth');
    return false;
  }
  let st: Stats;
  try {
    st = lstatSync(file);
  } catch {
    return true; // absent: git ignores a missing include and a missing config.
  }
  if (st.isSymbolicLink()) {
    entry('config-link', fingerprint(safeReadlink(file)));
    try {
      st = statSync(file);
    } catch {
      return true;
    }
  }
  if (!st.isFile()) {
    if (conditional && st.isDirectory()) {
      entry('include-not-followed', 'dir');
      return true;
    }
    entry('unreadable', st.isDirectory() ? 'dir' : 'not-a-file'); // a FIFO or a dir: git would hang or fail on it.
    return false;
  }
  // configFile pins --git-dir to the engine's empty hooks dir: no repository is discovered, from the include's dir or anywhere else.
  const cfg = configFile(ctx, ctx.tools.hooksDir, file);
  if (!cfg) {
    entry(conditional ? 'include-not-followed' : 'unreadable', 'unreadable');
    return conditional;
  }
  let ok = true;
  for (const [key, values] of cfg) {
    if (!DANGEROUS_CONFIG.some((re) => re.test(key))) continue;
    entry('config-key', fingerprint(key, ...values), key);
    if (key === 'core.hookspath') for (const v of values) w.hooksPaths.add(v);
    if (/^include(?:if\..*)?\.path$/.test(key)) {
      const cond = conditional || key.startsWith('includeif.');
      for (const v of values) ok = dangerousConfig(ctx, resolve(dirname(file), expandHome(v)), w, depth + 1, cond) && ok;
    }
  }
  return ok;
}

/** False when `gitDir`'s own config files, or a file they include, cannot be read (dangerousConfig): a merged `git config` there would follow it (a FIFO blocks git). */
function configFilesReadable(ctx: PrivateStoreContext, gitDir: string): boolean {
  const w: ConfigWalk = { item: 'config', out: [], hooksPaths: new Set() };
  return dangerousConfig(ctx, join(gitDir, 'config'), w) && dangerousConfig(ctx, join(gitDir, 'config.worktree'), w);
}

/** An entry for a hooks dir listing: `hooks-too-large` past HOOKS_CAP. */
function hooksEntry(item: UserGuardItem, dir: string, key?: string, value?: string): UserGuardEntry {
  const h = listingHash(dir, HOOKS_CAP);
  if (h === TOO_LARGE) return { item, kind: 'hooks-too-large', path: dir, ...(key ? { key } : {}), fingerprint: TOO_LARGE };
  return { item, kind: key ? 'hooks-path' : 'hooks-dir', path: dir, ...(key ? { key } : {}), fingerprint: fingerprint(value ?? '', h) };
}

/** Entries for the submodule git dirs under `dir` (modules/<name>, names may hold `/`, nested modules/ too): each one's hooks/ listing and dangerous config. */
function modulesRecords(ctx: PrivateStoreContext, dir: string, w: ConfigWalk, depth = 0): boolean {
  if (!lexists(dir)) return true;
  if (!isPlainDir(dir) || depth > 32) {
    w.out.push({ item: 'modules', kind: 'module', path: dir, fingerprint: fingerprint('not-a-plain-dir', fileHash(dir)) });
    return true;
  }
  if (lexists(join(dir, 'HEAD')) || lexists(join(dir, 'config'))) {
    w.out.push(hooksEntry('modules', join(dir, 'hooks')));
    const ok = dangerousConfig(ctx, join(dir, 'config'), w) && dangerousConfig(ctx, join(dir, 'config.worktree'), w);
    return modulesRecords(ctx, join(dir, 'modules'), w, depth + 1) && ok;
  }
  let ok = true;
  for (const name of readdirSync(dir).sort()) ok = modulesRecords(ctx, join(dir, name), w, depth + 1) && ok;
  return ok;
}

const GUARD_ITEMS: readonly UserGuardItem[] = ['gitdir', 'redirect', 'config', 'hooks', 'hooksPath', 'modules', 'worktrees', 'grafts', 'shallow', 'alternates', 'http-alternates', 'replace'];

/** Each item's value from its entries: `unreadable` / `too-large` when any entry says so (always counts as changed), else a digest. */
function guardItems(entries: readonly UserGuardEntry[]): Record<UserGuardItem, string> {
  const items = {} as Record<UserGuardItem, string>;
  for (const item of GUARD_ITEMS) {
    const mine = entries.filter((e) => e.item === item);
    items[item] = mine.some((e) => e.kind === 'unreadable') ? GUARD_UNREADABLE
      : mine.some((e) => e.kind === 'hooks-too-large' || e.kind === 'hooks-path-root') ? GUARD_TOO_LARGE
        : fingerprint(...mine.map((e) => `${e.kind}\0${e.path}\0${e.key ?? ''}\0${e.fingerprint}`));
  }
  return items;
}

/**
 * The narrow user-repository guard the engine takes under the import lock
 * (design 6/8; review-481 M4 with the lead's L5 rule): hashes of only what
 * can make git (or the user's next git command) run something or go
 * elsewhere:
 * - `config`: the dangerous keys (DANGEROUS_CONFIG) of config,
 *   config.worktree, worktrees/<id>/config.worktree and every file they
 *   include (depth-bounded);
 * - `hooks`: hooks/; `hooksPath`: the effective core.hooksPath (merged
 *   config: local, worktree, includes) and every value met in the files
 *   above, each with its dir's listing (capped: HOOKS_CAP; a hooksPath at
 *   the work tree root or the git dir is its own `hooks-path-root` entry);
 * - `modules`: each submodule git dir's hooks/ and dangerous config;
 * - `worktrees`: entries whose commondir is not the stock `../..` or whose
 *   commondir/gitdir is not a regular file (a redirect); a plain
 *   `git worktree add` changes nothing;
 * - `grafts`, `shallow`, alternates, http-alternates, refs/replace/*, and
 *   redirect entries.
 * Not branch.*, remote urls, user.*, info/exclude, info/sparse-checkout,
 * commit-graph, multi-pack-index, packs or info/refs: the user's own
 * `push -u`, `remote add`, `sparse-checkout`, gc and maintenance write those,
 * and every command here pins the graph files off (review-476 M-E).
 * The git commands in the repository (the effective hooksPath read and the
 * refs/replace listing, which read the merged config) are skipped when a
 * config file or an include cannot be read (a FIFO include would block
 * them); those items are then `unreadable`. It never
 * throws: a timeout or any other error makes every item `unreadable`, with
 * one `unreadable` entry for the git dir. `entries` carry each entry's kind
 * and path for the park message (userRepoGuardChanges).
 */
export function userRepoGuardSnapshot(gitDir: string, ctx: PrivateStoreContext): UserRepoGuard {
  try {
    return guardSnapshot(gitDir, ctx);
  } catch {
    const entries: UserGuardEntry[] = GUARD_ITEMS.map((item) => ({ item, kind: 'unreadable', path: gitDir, fingerprint: 'snapshot-failed' }));
    return { gitDir, items: guardItems(entries), entries };
  }
}

function guardSnapshot(gitDir: string, ctx: PrivateStoreContext): UserRepoGuard {
  const base = dirname(gitDir);
  const out: UserGuardEntry[] = [];
  const cfg: ConfigWalk = { item: 'config', out, hooksPaths: new Set() };
  let cfgOk = dangerousConfig(ctx, join(gitDir, 'config'), cfg) && dangerousConfig(ctx, join(gitDir, 'config.worktree'), cfg);
  const wtDir = join(gitDir, 'worktrees');
  const wt = (path: string, fp: string) => out.push({ item: 'worktrees', kind: 'worktree', path, fingerprint: fp });
  if (lexists(wtDir) && !isPlainDir(wtDir)) wt(wtDir, fingerprint('not-a-plain-dir', fileHash(wtDir)));
  else if (lexists(wtDir)) {
    for (const id of readdirSync(wtDir).sort()) {
      const d = join(wtDir, id);
      if (!isPlainDir(d)) {
        wt(d, fingerprint('not-a-plain-dir', fileHash(d)));
        continue;
      }
      cfgOk = dangerousConfig(ctx, join(d, 'config.worktree'), cfg) && cfgOk;
      const commondir = fileHash(join(d, 'commondir'));
      let stock = false;
      try {
        stock = lstatSync(join(d, 'commondir')).isFile() && readFileSync(join(d, 'commondir'), 'utf8').trim() === '../..';
      } catch { /* absent: hashed below */ }
      const gitdirKind = lexists(join(d, 'gitdir')) ? (lstatSync(join(d, 'gitdir')).isFile() ? 'file' : `not-a-file:${fileHash(join(d, 'gitdir'))}`) : 'absent';
      if (!stock || gitdirKind.startsWith('not-a-file')) wt(d, fingerprint('commondir', commondir, 'gitdir', gitdirKind));
    }
  }
  modulesRecords(ctx, join(gitDir, 'modules'), { item: 'modules', out, hooksPaths: new Set() });
  // The effective value, as the user's git reads it: merged config minus the engine's own command-line pin.
  // Skipped when a file the merge would follow cannot be read: the config item already says unreadable (review-481b).
  let effective: string | null = null;
  if (cfgOk) {
    const eff = git(ctx, gitDir, [`--git-dir=${gitDir}`, 'config', '-z', '--show-scope', '--get-all', 'core.hookspath']);
    if (eff.status <= 1) {
      effective = 'unset';
      const parts = eff.stdout.split('\0');
      const values: string[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] !== 'command') values.push(parts[i + 1]);
      if (values.length > 0) {
        effective = values[values.length - 1];
        cfg.hooksPaths.add(effective);
      }
    }
  }
  const hooksPathDir = (v: string) => resolve(base, expandHome(v));
  if (effective === null) out.push({ item: 'hooksPath', kind: 'unreadable', path: join(gitDir, 'config'), key: 'core.hookspath', fingerprint: 'merged-config' });
  else out.push({ item: 'hooksPath', kind: 'hooks-path', path: effective === 'unset' ? join(gitDir, 'hooks') : hooksPathDir(effective), key: 'core.hookspath', fingerprint: fingerprint('effective', effective) });
  for (const v of [...cfg.hooksPaths].sort()) {
    const d = hooksPathDir(v);
    if (sameFsPath(d, base) || sameFsPath(d, gitDir)) out.push({ item: 'hooksPath', kind: 'hooks-path-root', path: d, key: 'core.hookspath', fingerprint: 'root' });
    else out.push(hooksEntry('hooksPath', d, 'core.hookspath', v));
  }
  out.push(hooksEntry('hooks', join(gitDir, 'hooks')));
  out.push({ item: 'gitdir', kind: 'gitdir', path: resolve(gitDir), fingerprint: fingerprint(resolve(gitDir)) });
  for (const e of ['.git', 'commondir', 'gitdir']) out.push({ item: 'redirect', kind: 'redirect-entry', path: join(gitDir, e), fingerprint: fileHash(join(gitDir, e)) });
  for (const [item, file] of [['grafts', join(gitDir, 'info', 'grafts')], ['shallow', join(gitDir, 'shallow')], ['alternates', join(gitDir, 'objects', 'info', 'alternates')], ['http-alternates', join(gitDir, 'objects', 'info', 'http-alternates')]] as const) {
    out.push({ item, kind: item, path: file, fingerprint: fileHash(file) });
  }
  // Any git command in the repository reads the merged config: skipped like the hooksPath read.
  const replace = cfgOk ? git(ctx, gitDir, [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/replace/']) : null;
  if (!replace || replace.status !== 0) out.push({ item: 'replace', kind: 'unreadable', path: join(gitDir, 'refs', 'replace'), fingerprint: 'unreadable' });
  else {
    for (const line of replace.stdout.split('\n').filter(Boolean)) {
      const sp = line.lastIndexOf(' ');
      out.push({ item: 'replace', kind: 'replace-ref', path: line.slice(0, sp), fingerprint: line.slice(sp + 1) });
    }
  }
  return { gitDir, items: guardItems(out), entries: out };
}

/** The items that differ (fixed names); empty = unchanged. An `unreadable` or `too-large` item always counts as changed. */
export function compareUserRepoGuard(before: UserRepoGuard, after: UserRepoGuard): UserGuardItem[] {
  const always = (v: string) => v === GUARD_UNREADABLE || v === GUARD_TOO_LARGE;
  return (Object.keys(before.items) as UserGuardItem[]).filter((k) => before.items[k] !== after.items[k] || always(before.items[k]) || always(after.items[k]));
}

/**
 * The entries behind compareUserRepoGuard, for an actionable park message
 * (kind, path, key name; no values, no fingerprints): those added or changed
 * in `after`, those gone from it, and every `unreadable`, `include-not-followed`,
 * `hooks-too-large` or `hooks-path-root` entry of a changed item.
 */
export function userRepoGuardChanges(before: UserRepoGuard, after: UserRepoGuard): UserGuardDetail[] {
  const changed = new Set(compareUserRepoGuard(before, after));
  const id = (e: UserGuardEntry) => `${e.item}\0${e.kind}\0${e.path}\0${e.key ?? ''}\0${e.fingerprint}`;
  const had = new Set(before.entries.map(id));
  const has = new Set(after.entries.map(id));
  const sticky = new Set<UserGuardKind>(['unreadable', 'include-not-followed', 'hooks-too-large', 'hooks-path-root']);
  const seen = new Set<string>();
  const result: UserGuardDetail[] = [];
  for (const e of [...after.entries.filter((x) => !had.has(id(x)) || sticky.has(x.kind)), ...before.entries.filter((x) => !has.has(id(x)))]) {
    if (!changed.has(e.item)) continue;
    const d: UserGuardDetail = { item: e.item, kind: e.kind, path: e.path, ...(e.key ? { key: e.key } : {}) };
    const k = JSON.stringify(d);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(d);
    }
  }
  return result;
}

/**
 * A fresh snapshot of `before.gitDir` compared with `before` (review-481
 * M3). The publish order under the import lock is:
 *   1. checkUserRepoGuard(baseline) must be empty (else park, no push);
 *   2. importFromPrivate, then the hardened push, then dropImportRef;
 *   3. checkUserRepoGuard(baseline) must be empty again: anything planted
 *      during the import window parks the run instead of becoming the
 *      baseline;
 *   4. only then baseline = userRepoGuardSnapshot(userGitDir) for the next import.
 * For the park message, take a snapshot and userRepoGuardChanges(baseline, it).
 */
export function checkUserRepoGuard(before: UserRepoGuard, ctx: PrivateStoreContext): UserGuardItem[] {
  return compareUserRepoGuard(before, userRepoGuardSnapshot(before.gitDir, ctx));
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

/**
 * True when the user repository is a partial clone (review-481b m): its own
 * config files (no includes; extensions are read from the repository config
 * only) name extensions.partialClone or a promisor remote / filter, or a
 * `.promisor` pack exists. Its missing objects can never be fetched here
 * (GIT_NO_LAZY_FETCH), so the seed fetch would fail on them.
 */
function partialClone(ctx: PrivateStoreContext, gitDir: string): boolean {
  for (const file of [join(gitDir, 'config'), join(gitDir, 'config.worktree')]) {
    if (!lexists(file)) continue;
    const cfg = configFile(ctx, gitDir, file);
    if (cfg && [...cfg.keys()].some((k) => k === 'extensions.partialclone' || /^remote\..*\.(?:promisor|partialclonefilter)$/.test(k))) return true;
  }
  try {
    return readdirSync(join(gitDir, 'objects', 'pack')).some((n) => n.endsWith('.promisor'));
  } catch {
    return false;
  }
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
  if (partialClone(ctx, userGitDir)) throw new PrivateStoreError(`the repository ${userGitDir} is a partial clone (extensions.partialClone, a promisor remote or a promisor pack); partial clones are not supported by the factory's private store: use a full clone`);
  if (!lexists(layout.seed)) {
    mkdirSync(layout.repoDir, { recursive: true });
    gitOk(ctx, layout.repoDir, ['-c', 'init.defaultBranch=omg-seed', 'init', '-q', '--bare', '--template=', layout.seed], `git init of the seed ${layout.seed}`);
  }
  const seedBad = seedProblem(layout.seed, ctx);
  if (seedBad) throw new PrivateStoreError(`${seedBad} (${layout.seed}); delete the seed dir ${layout.seed} and start the run again`);
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
  /** The seed it was cloned from and fetches from (no alternates: a full copy). */
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

/** Null when `gitDir` has no alternates of any kind (an empty alternates file counts as none). */
function alternatesProblem(gitDir: string, what: string): string | null {
  if (lexists(join(gitDir, 'objects', 'info', 'http-alternates'))) return `${what} has http-alternates`;
  const alt = join(gitDir, 'objects', 'info', 'alternates');
  if (!lexists(alt)) return null;
  try {
    if (lstatSync(alt).isFile() && readFileSync(alt, 'utf8').trim() === '') return null;
  } catch { /* unreadable: refused */ }
  return `${what} has alternates`;
}

/**
 * Fixed-text reason to refuse the private repository: a redirect, a
 * config/hooks/info hash other than the recorded one, a config the engine
 * did not write (core.bare must be false, no core.worktree, no partial clone
 * or promisor remote, no extension beyond the object format), any
 * alternates, grafts, shallow, replace refs. Run it before every engine
 * command in the private repository, reads included (lockfileUnchanged).
 */
export function privateRepoProblem(p: PrivateRepo, ctx: PrivateStoreContext): string | null {
  const what = 'the private repository';
  return redirectProblem(p.gitDir, what, ['.git', 'commondir', 'gitdir', 'config.worktree'])
    ?? (privateRepoConfigHash(p.gitDir) !== p.configHash ? `${what} config, hooks or info changed since the engine wrote them` : null)
    ?? engineConfigProblem(ctx, p.gitDir, what, false)
    ?? alternatesProblem(p.gitDir, what)
    ?? graftProblem(p.gitDir, what)
    ?? replaceProblem(ctx, p.gitDir, what);
}

/**
 * Clone the run's private repository from the seed: a `--no-local` clone
 * (every object sent as a pack and re-hashed by index-pack with fsck on, so
 * a replaced seed object arrives under another id and the clone fails: no
 * separate seed fsck is needed; review-481b 1); only reachable objects, no
 * refs/replace, no copied info/), `--no-checkout --no-tags --single-branch
 * --template=`, and NO `--reference`: no alternates at all, so nothing in
 * the seed is read unverified later (review-481 M1). Then HEAD == baseSha
 * (detached; the clone's branch deleted), the origin remote removed,
 * core.longpaths=true written, the config checked against what the engine
 * wrote, and its hash recorded.
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
  const cloned = git(ctx, layout.runDir, ['clone', '-q', '--no-local', '--no-checkout', '--no-tags', '--single-branch', '--branch', `omg-${baseSha}`, '--template=',
    `--upload-pack=${uploadPackCommand(ctx.tools)}`, layout.seed, layout.repo]);
  // index-pack re-hashes every object it receives (fsck on): a seed object whose bytes were replaced arrives under another id and the clone fails.
  if (cloned.status !== 0) throw new PrivateStoreError(`the private clone of ${baseSha} failed (git exit ${cloned.status}); the seed may be damaged: delete the seed dir ${layout.seed} and start the run again`, cloned.stderr.trim().slice(-2000));
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
  const after = privateRepoProblem(p, ctx);
  if (after) throw new PrivateStoreError(`${after} (${p.gitDir})`);
  if (!hasCommit(ctx, p.gitDir, sha)) throw new PrivateStoreError(`the private repository does not have ${sha} after the fetch`);
}

// ---------------------------------------------------------------------------
// Engine commands in the private repository (B1b wiring)

/** privateRepoProblem refused an engine command: the private repository changed outside the engine (the engine parks). */
export class PrivateRepoTampered extends PrivateStoreError {
  constructor(problem: string, gitDir: string) {
    super(`${problem} (${gitDir})`);
    this.name = 'PrivateRepoTampered';
  }
}

/** Throws PrivateRepoTampered unless privateRepoProblem passes. */
export function assertPrivateRepo(p: PrivateRepo, ctx: PrivateStoreContext): void {
  const bad = privateRepoProblem(p, ctx);
  if (bad) throw new PrivateRepoTampered(bad, p.gitDir);
}

export interface PrivateGitOptions {
  /** The work tree: a lane worktree, `prep` or the clone dir (default: the clone dir). */
  workTree?: string;
  /** The git dir to name (a worktree's admin dir as recorded at its creation; default: the private git dir). */
  gitDir?: string;
  /** Extra environment (the engine's commit identity); never GIT_* that redirects (the pins and privateGitEnv win). */
  env?: Readonly<Record<string, string>>;
}

/**
 * One engine git command in the private repository (review-481 B1b a/b):
 * privateRepoProblem first (PrivateRepoTampered), then git with the pins and
 * privateGitEnv, and the git dir and work tree named on the command line,
 * never discovered from a lane-writable `.git` file.
 */
export function privateGit(p: PrivateRepo, ctx: PrivateStoreContext, args: readonly string[], o: PrivateGitOptions = {}): ExecResult {
  assertPrivateRepo(p, ctx);
  const workTree = o.workTree ?? p.repo;
  return git(ctx, workTree, [`--git-dir=${o.gitDir ?? p.gitDir}`, `--work-tree=${workTree}`, ...args], o.env);
}

/** privateGit that throws PrivateStoreError (fixed text `what`, stderr in detail) on a non-zero exit; returns stdout. */
export function privateGitOk(p: PrivateRepo, ctx: PrivateStoreContext, args: readonly string[], what: string, o: PrivateGitOptions = {}): string {
  const r = privateGit(p, ctx, args, o);
  if (r.status !== 0) throw new PrivateStoreError(`${what} failed (git exit ${r.status})`, r.stderr.trim().slice(-2000));
  return r.stdout;
}

/**
 * An Exec for code that runs plain `git <args>` with a cwd (snapshotRepo,
 * ship's runPrepare) against the private repository: every call goes through
 * privateGit with the git dir `gitDirOf(cwd)` names (a recorded admin dir, or
 * the private git dir for the clone dir); a cwd it does not know, or any
 * other program, is refused (exit 127), so nothing runs by discovery.
 */
export function privateExec(p: PrivateRepo, ctx: PrivateStoreContext, gitDirOf: (cwd: string) => string | null, env: Readonly<Record<string, string>> = {}): Exec {
  return (cmd, args, opts) => {
    if (cmd !== 'git') return { status: 127, stdout: '', stderr: `the private store runs git only, not ${cmd}` };
    const cwd = opts?.cwd ? resolve(opts.cwd) : null;
    const gitDir = cwd ? (sameFsPath(cwd, p.repo) ? p.gitDir : gitDirOf(cwd)) : null;
    if (!cwd || !gitDir) return { status: 127, stdout: '', stderr: `the private store has no recorded git dir for ${cwd ?? 'no cwd'}` };
    return privateGit(p, ctx, args, { workTree: cwd, gitDir, env: { ...env, ...(opts?.env ?? {}) } });
  };
}

/** git 2.44 is the first that knows GIT_NO_LAZY_FETCH (older git ignores it silently: review-481b j). */
export const PRIVATE_GIT_MIN_VERSION = [2, 44] as const;

/** Null, or why the git on PATH is too old for the private store (or its version cannot be read). */
export function gitVersionProblem(exec: Exec = defaultExec): string | null {
  const r = exec('git', ['--version'], {});
  const m = /git version (\d+)\.(\d+)/.exec(r.stdout);
  const want = `${PRIVATE_GIT_MIN_VERSION[0]}.${PRIVATE_GIT_MIN_VERSION[1]}`;
  if (r.status !== 0 || !m) return `the private layout needs git ${want} or later, and \`git --version\` could not be read`;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > PRIVATE_GIT_MIN_VERSION[0] || (major === PRIVATE_GIT_MIN_VERSION[0] && minor >= PRIVATE_GIT_MIN_VERSION[1])) return null;
  return `the private layout needs git ${want} or later (GIT_NO_LAZY_FETCH), and this git is ${major}.${minor}`;
}

/**
 * Re-record the config hash after an engine-made config write (review-481
 * h): the allowlist (engineConfigProblem) still applies, so a write the
 * engine did not mean to make is refused, not accepted.
 */
export function rerecordConfigHash(p: PrivateRepo, ctx: PrivateStoreContext): PrivateRepo {
  const next = { ...p, configHash: privateRepoConfigHash(p.gitDir) };
  assertPrivateRepo(next, ctx);
  return next;
}

/** True when the private repository has `sha` as a commit (privateRepoProblem first). */
export function privateHasCommit(p: PrivateRepo, ctx: PrivateStoreContext, sha: string): boolean {
  assertPrivateRepo(p, ctx);
  return SHA.test(sha) && hasCommit(ctx, p.gitDir, sha);
}

/** The import refs (`refs/omg-import/<run>/*`) left in the user repository, with their values (a crash after an import). */
export function staleImportRefs(userGitDir: string, run: string, ctx: PrivateStoreContext): Array<{ ref: string; sha: string }> {
  if (!RUN_LABEL.test(run)) throw new PrivateStoreError('the import refs need a plain run label');
  const r = git(ctx, userGitDir, [`--git-dir=${userGitDir}`, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/omg-import/${run}/`]);
  if (r.status !== 0) throw new PrivateStoreError('the import refs cannot be listed', r.stderr.trim().slice(-2000));
  return r.stdout.split('\n').filter(Boolean).map((l) => ({ ref: l.slice(0, l.lastIndexOf(' ')), sha: l.slice(l.lastIndexOf(' ') + 1) })).filter((x) => SHA.test(x.sha));
}

/** Delete one stale import ref against the value it holds (staleImportRefs); false when it stays. */
export function dropStaleImportRef(userGitDir: string, ref: string, sha: string, ctx: PrivateStoreContext): boolean {
  if (!/^refs\/omg-import\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/\d+$/.test(ref) || !SHA.test(sha)) return false;
  return deleteImportRef(ctx, userGitDir, ref, sha);
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

export type ImportRefusalCode = 'bad-input' | 'user-repo' | 'private-repo' | 'fetch-failed' | 'ref-mismatch' | 'parents-mismatch' | 'diff-failed' | 'protected-path' | 'gitlink' | 'symlink' | 'ref-left' | 'timeout';

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
 * rewrite check on the private path; privateRepoProblem), `startSha` and
 * every expected parent already commits in the user repository (review-481
 * M2: no private-only history rides in), then a hardened
 * `fetch +<sha>:refs/omg-import/<run>/<n>` in the user repository (fsck on
 * every object, no FETCH_HEAD, no tags, no submodules, pinned upload-pack),
 * then the ref must name `sha`, `rev-list --parents` must equal
 * `expectedParents` exactly, `rev-list --count <sha> --not <parents>` must be
 * 1 (no allowance for more), and the two-tree `diff-tree -r --no-renames
 * <startSha> <sha>` may touch no protected path (ship + lane + configured)
 * and add or change no gitlink (160000) or symlink (120000). Any refusal
 * after the fetch deletes the import ref against its value (`ref-left` when
 * that fails); a git timeout is the `timeout` refusal. The push and
 * dropImportRef are the caller's.
 */
export function importFromPrivate(input: ImportInput, ctx: PrivateStoreContext): ImportResult {
  const { userGitDir: user, sha, startSha } = input;
  if (!SHA.test(sha) || !SHA.test(startSha) || input.expectedParents.some((x) => !SHA.test(x)) || !RUN_LABEL.test(input.run) || !(Number.isSafeInteger(input.n) && input.n >= 0)) {
    return refuse('bad-input', 'the import needs full shas, a plain run label and a non-negative number');
  }
  const ref = importRef(input.run, input.n);
  try {
    return importChecked(input, ref, ctx);
  } catch (err) {
    if (!(err instanceof PrivateGitTimeout)) throw err;
    try {
      deleteImportRef(ctx, user, ref);
    } catch { /* the ref may be left; the timeout is the reason given */ }
    return refuse('timeout', 'a git command of the import timed out and was killed');
  }
}

/** Delete `ref` in `user` against the value it holds now (none: nothing to do); false when it is still there. */
function deleteImportRef(ctx: PrivateStoreContext, user: string, ref: string, expected?: string): boolean {
  let old = expected;
  if (old === undefined) {
    const cur = git(ctx, user, [`--git-dir=${user}`, 'rev-parse', '--verify', '--quiet', '--end-of-options', ref]);
    // Absent (a failed fetch never made it): fine, unless a loose ref file git cannot read is there.
    if (cur.status !== 0) return !lexists(join(user, ...ref.split('/')));
    old = cur.stdout.trim();
    if (!SHA.test(old)) return false;
  }
  return git(ctx, user, [`--git-dir=${user}`, 'update-ref', '--no-deref', '-d', ref, old]).status === 0;
}

function importChecked(input: ImportInput, ref: string, ctx: PrivateStoreContext): ImportResult {
  const { userGitDir: user, privateRepo: p, sha, startSha } = input;
  const userBad = userRepoProblem(user, ctx, [p.gitDir, p.repo]);
  if (userBad) return refuse('user-repo', userBad);
  // review-481 M2: the start and every parent are already the user's, so the fetch brings exactly one new commit and no unchecked history.
  for (const x of [startSha, ...input.expectedParents]) {
    if (git(ctx, user, [`--git-dir=${user}`, 'cat-file', '-e', `${x}^{commit}`]).status !== 0) return refuse('bad-input', 'the start commit and every expected parent must already be commits in the repository');
  }
  const privateBad = privateRepoProblem(p, ctx);
  if (privateBad) return refuse('private-repo', privateBad);
  const fetched = git(ctx, user, fetchArgs(user, ctx.tools, p.gitDir, [`+${sha}:${ref}`]));
  const drop = (r: ImportResult): ImportResult => (deleteImportRef(ctx, user, ref) ? r : refuse('ref-left', `import ref left (refused: ${r.ok ? 'ok' : r.reason})`));
  if (fetched.status !== 0) return drop(refuse('fetch-failed', 'the import fetch failed (an object failed fsck, or the commit is missing from the private repository)'));
  const at = git(ctx, user, [`--git-dir=${user}`, 'rev-parse', '--verify', '--end-of-options', ref]);
  if (at.status !== 0 || at.stdout.trim() !== sha) return drop(refuse('ref-mismatch', 'the import ref does not name the sealed commit'));
  const type = git(ctx, user, [`--git-dir=${user}`, 'cat-file', '-t', sha]);
  if (type.status !== 0 || type.stdout.trim() !== 'commit') return drop(refuse('ref-mismatch', 'the imported object is not a commit'));
  const parents = git(ctx, user, [`--git-dir=${user}`, 'rev-list', '--parents', '-n', '1', sha]);
  const got = parents.status === 0 ? parents.stdout.trim().split(/\s+/) : [];
  if (got[0] !== sha || JSON.stringify(got.slice(1)) !== JSON.stringify([...input.expectedParents])) return drop(refuse('parents-mismatch', 'the imported commit does not have exactly the expected parents'));
  // Exactly one commit the parents do not reach: the sealed commit itself (no allowance for more; B1b imports one commit-tree output at a time).
  const count = git(ctx, user, [`--git-dir=${user}`, 'rev-list', '--count', sha, ...(input.expectedParents.length > 0 ? ['--not', ...input.expectedParents] : [])]);
  if (count.status !== 0 || count.stdout.trim() !== '1') return drop(refuse('parents-mismatch', 'the import brings more than the one sealed commit'));
  const diff = git(ctx, user, [`--git-dir=${user}`, 'diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--full-index', startSha, sha]);
  const changes = diff.status === 0 ? parseRawDiff(diff.stdout) : null;
  if (!changes) return drop(refuse('diff-failed', 'the import diff against the start commit cannot be read'));
  const files = changes.map((c) => c.path);
  if (protectedChanges(files, [...LANE_PROTECTED_PATHS, ...(input.extraProtected ?? [])]).length > 0) return drop(refuse('protected-path', 'the imported commit changes a protected path'));
  if (changes.some((c) => c.status !== 'D' && c.dstMode === '160000')) return drop(refuse('gitlink', 'the imported commit adds or changes a gitlink (submodule)'));
  if (changes.some((c) => c.status !== 'D' && c.dstMode === '120000')) return drop(refuse('symlink', 'the imported commit adds or changes a symlink'));
  return { ok: true, ref, files };
}

/** Delete the import ref (after the push, or to clean up) against its expected value `sha`; throws `import ref left` when it stays. */
export function dropImportRef(userGitDir: string, run: string, n: number, sha: string, ctx: PrivateStoreContext): void {
  const ref = importRef(run, n);
  if (!SHA.test(sha)) throw new PrivateStoreError('dropping the import ref needs its full sha');
  if (!deleteImportRef(ctx, userGitDir, ref, sha)) throw new PrivateStoreError(`import ref left (${ref})`);
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

/** Test seam for removeRunDir: called right before each directory's re-lstat and readdir (a swap there is the M5 race). */
export interface RemoveSeam {
  beforeReaddir?: (dir: string) => void;
}

const sameNode = (a: BigIntStats, b: BigIntStats): boolean => (a.ino !== 0n || b.ino !== 0n ? a.ino === b.ino && a.dev === b.dev : true);

/**
 * readdir of `dir`, which the walk saw as the plain directory `seen`: it is
 * lstat-ed again right before the read and must still be a plain directory
 * and the same node (dev/ino where the platform gives them, else the kind
 * alone), so a directory swapped for a junction or symlink between the walk's
 * steps is never read through (review-481 M5).
 */
function readdirChecked(dir: string, seen: BigIntStats, seam: RemoveSeam): string[] {
  seam.beforeReaddir?.(dir);
  const now = lstatSync(dir, { bigint: true });
  if (now.isSymbolicLink() || !now.isDirectory() || !sameNode(seen, now)) throw new PrivateStoreError(`a directory under removal was replaced (${dir}); nothing more removed`);
  return readdirSync(dir);
}

/** One pass over the tree: `onLink` for each link (never followed), `onFile` for each other non-directory, `onDir` after a directory's entries. */
function walkNoFollow(dir: string, seen: BigIntStats, seam: RemoveSeam, visit: { onLink: (p: string) => void; onFile?: (p: string) => void; onDir?: (p: string) => void }): void {
  for (const name of readdirChecked(dir, seen, seam)) {
    const p = join(dir, name);
    const st = lstatSync(p, { bigint: true });
    if (st.isSymbolicLink()) visit.onLink(p);
    else if (st.isDirectory()) walkNoFollow(p, st, seam, visit);
    else visit.onFile?.(p);
  }
  visit.onDir?.(dir);
}

/**
 * Remove a run dir (or the seed) under the work root without ever following
 * a link (a worktree removal once emptied the TARGET of a node_modules
 * junction). First the dir is renamed to an engine-only `.trash-<random>`
 * next to it (under the repository dir), so a process still holding the old
 * path cannot reach what is walked (and on Windows the rename fails while a
 * process has a cwd or open file there: refused). Then: unlink every symlink
 * and junction at any depth, prove by a second walk that none remains
 * (refuse otherwise), then delete files and directories bottom up, refusing
 * at any link that appeared meanwhile. Every directory is re-lstat-ed (same
 * node, still a plain directory) right before it is read. B1b calls it only
 * after every lane process tree is gone. The module keeps this walk rather
 * than PR #478's removal helper, which does not re-lstat before each read
 * and ends in a recursive rm (review-481b nit).
 */
export function removeRunDir(dir: string, work: string, platform: NodeJS.Platform = process.platform, seam: RemoveSeam = {}): void {
  const d = resolve(dir);
  if (!under(d, work, platform) || sameFsPath(d, work)) throw new PrivateStoreError(`${d} is not under the private work root ${resolve(work)}`);
  if (!lexists(d)) return;
  if (lstatSync(d).isSymbolicLink()) {
    unlinkLink(d);
    return;
  }
  const trash = join(dirname(d), `.trash-${randomBytes(8).toString('hex')}`);
  try {
    renameSync(d, trash);
  } catch (err) {
    throw new PrivateStoreError(`${d} cannot be moved aside for removal (a process may still use it); nothing removed`, String((err as Error).message));
  }
  const top = lstatSync(trash, { bigint: true });
  if (top.isSymbolicLink() || !top.isDirectory()) throw new PrivateStoreError(`${trash} is not a plain directory; nothing removed`);
  walkNoFollow(trash, top, seam, { onLink: unlinkLink });
  walkNoFollow(trash, top, seam, { onLink: () => { throw new PrivateStoreError(`a link remains under ${trash} after unlinking; nothing removed`); } });
  walkNoFollow(trash, top, seam, {
    onLink: () => { throw new PrivateStoreError(`a link appeared under ${trash} during removal; nothing more removed`); },
    onFile: (p) => {
      try {
        unlinkSync(p);
      } catch {
        chmodSync(p, 0o666);
        unlinkSync(p);
      }
    },
    onDir: (p) => rmdirSync(p),
  });
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
 * otherwise. Both shas are sealed and read from the private repository
 * (it holds both), which must pass privateRepoProblem first: its config is
 * what a read there obeys (review-481 HIGH-1).
 */
export function lockfileUnchanged(p: PrivateRepo, baseSha: string, headSha: string, ctx: PrivateStoreContext): LockfileRule {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new PrivateStoreError('the lockfile rule needs full shas');
  const bad = privateRepoProblem(p, ctx);
  if (bad) throw new PrivateStoreError(`${bad} (${p.gitDir})`);
  const base = lockEntries(ctx, p.gitDir, baseSha);
  const head = lockEntries(ctx, p.gitDir, headSha);
  const lockfiles = LOCKFILES.filter((f) => base.has(f));
  const changed = LOCKFILES.filter((f) => base.get(f) !== head.get(f) || (base.has(f) && !/^100(?:644|755) blob /.test(base.get(f)!)));
  return { policy: lockfiles.length > 0 && changed.length === 0 ? 'junction' : 'park', lockfiles, changed };
}
