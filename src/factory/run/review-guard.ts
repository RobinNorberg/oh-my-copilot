/**
 * Lane tamper check (owner override of design §5, extended to write lanes).
 * The review profile's shell denylist is a denylist: `git $p`,
 * `echo >> .git/config` and friends get past it, and every lane reads
 * untrusted issue or PR content. So the engine snapshots the repository's
 * shared git state before a lane starts and again after it ends, and any
 * difference the lane may not make parks the run (`review-tampered`,
 * `lane-tampered`).
 *
 * Snapshot, all from the COMMON git dir (`git rev-parse --git-common-dir`, the
 * one every worktree shares):
 * - every ref (`git for-each-ref`: loose, packed-refs and refs/stash);
 * - a hash of `config`, `config.worktree` and each `worktrees/<id>/config.worktree`;
 * - a listing hash (names and contents) of `hooks/` and `info/`;
 * - per `worktrees/<id>`: `HEAD`, `gitdir`, `commondir` and its per-worktree
 *   `refs/` (bisect, worktree, rewritten). Lock files, the index and logs are
 *   left out because git itself rewrites them;
 * - per submodule git dir under `modules/` (nested ones too): `config`,
 *   `config.worktree`, `hooks/`, `info/` and its alternates;
 * - `objects/info/alternates` and `objects/info/http-alternates`;
 * - the global git config the engine's own git reads (GIT_CONFIG_GLOBAL, else
 *   `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`), the user-level ignore
 *   files (`$XDG_CONFIG_HOME/git/ignore`, `core.excludesFile`) and every file an
 *   `include.path` / `includeIf.*.path` in it or in the repository's config
 *   names, followed {@link MAX_INCLUDE_DEPTH} levels deep: a lane's shell can
 *   reach the home directory and plant `credential.helper=!cmd`,
 *   `core.sshCommand`, `url.*.pushInsteadOf` or a `filter.*.clean` there. The
 *   system config needs admin rights to write and is left out;
 * - every `worktrees/<id>` and `modules/` entry must be a real directory
 *   (lstat: a symlink or Windows junction is reported), and an entry that
 *   disappears is reported unless it was already stale (its worktree gone,
 *   the kind `git worktree prune` removes);
 * - the main checkout's HEAD (sha and symbolic ref) and its status, untracked
 *   files included, so a deleted untracked file shows;
 * - the content of a bounded list of ignored main-checkout paths that tools
 *   load or run: top-level `.env*`, `.npmrc`, `.yarnrc`, `.yarnrc.yml` and
 *   `node_modules/.bin`. A full `--ignored` status would walk `node_modules/`
 *   and the lane worktrees under `.omg/` on every check, and it shows only
 *   presence, not content, so the list is hashed instead.
 *
 * Not snapshotted: `logs/` (reflogs). The engine never resolves reflog syntax
 * (`@{n}`), and a lane's own commits append to its branch's reflog, so a
 * reflog change cannot steer an engine command.
 *
 * When the config, `info/` or a submodule's files already differ from the
 * snapshot being compared against, the new snapshot skips `git status`:
 * status may run a clean filter that the changed config names.
 *
 * After a review lane, also: the lane worktree's common dir is the repo's, its
 * HEAD equals the reviewed sha, its `changes` summary is empty, and its status
 * is clean.
 *
 * The only ref allowed to appear is the lane's own branch (at the reviewed
 * sha for a review lane, at the lane's head for a write lane), and the only
 * worktree entry allowed to appear is the lane's own.
 */

import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { recordedWorktreeGitLinks, runHostGit, worktreeGitDirArgs } from '../../team/git-worktree.js';
import type { LaneResult } from './lane.js';
import { FOR_EACH_REF_FORMAT } from './exec.js';

export interface WorktreeEntry {
  /** Hash of HEAD, gitdir, commondir and the per-worktree refs/. */
  meta: string;
  /** Content of `gitdir` (the worktree's `.git` file path). */
  gitdir: string;
  /** Content of `commondir` (`../..` for every `git worktree add`). */
  commondir: string;
  /** The worktree its `gitdir` names is gone (`git worktree prune` may drop the entry). */
  stale?: boolean;
  /** Set when the entry is not a real directory (symlink, junction, file): what it is instead. */
  notDir?: string;
}

export interface RepoSnapshot {
  commonDir: string;
  /** `refname sha` per ref, sorted. */
  refs: Record<string, string>;
  config: string;
  configWorktree: string;
  /** `worktrees/<id>/config.worktree` hash per worktree that has one. */
  worktreeConfigs: Record<string, string>;
  /** Every `worktrees/<id>` entry (copilot_run's `git worktree prune` may drop a stale one). */
  worktreeIds: string[];
  worktrees: Record<string, WorktreeEntry>;
  hooks: string;
  info: string;
  /** Submodule git dir (relative to `modules/`) -> hash of its config, hooks, info and alternates. */
  modules: Record<string, string>;
  alternates: string;
  /** Hash of the global git config files and every include target (see the module comment). */
  globalConfig: string;
  /** Hash of the bounded list of ignored main-checkout paths (see the module comment). */
  ignored: string;
  mainHead: string;
  mainSymbolic: string;
  /** `git status --porcelain=v1 -z --untracked-files=all` of the main checkout (stableStatus). */
  mainStatus: string;
}

export class SnapshotError extends Error {}

/** Top-level ignored files and directories the snapshot hashes by content. */
export const SENSITIVE_IGNORED = ['.npmrc', '.yarnrc', '.yarnrc.yml', 'node_modules/.bin'] as const;
const STATUS_SKIPPED = 'skipped: the config, info/ or a submodule changed';

function run(exec: Exec, cwd: string, args: string[]): string {
  const res = exec('git', args, { cwd, env: TRUSTED_READ_ENV });
  if (res.status !== 0) throw new SnapshotError(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr.trim().split('\n')[0]}`);
  return res.stdout;
}

/** `core.excludesFile` as the engine's own git resolves it (guarded env); undefined when unset. */
function excludesFileOf(exec: Exec, cwd: string): string | undefined {
  const res = exec('git', ['config', '--get', 'core.excludesFile'], { cwd, env: TRUSTED_READ_ENV });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : undefined;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function fileHash(path: string): string {
  if (!existsSync(path)) return 'absent';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

/** Hash of every entry under `dir` (relative name, kind and content); `absent` when there is none. */
export function treeHash(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  const entries: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) entries.push(`l ${r} ${readlinkSync(p)}`);
      else if (st.isDirectory()) { entries.push(`d ${r}`); walk(p, r); }
      else entries.push(`f ${r} ${st.mode & 0o111 ? 'x' : '-'} ${fileHash(p)}`);
    }
  };
  walk(dir, '');
  return sha(entries.join('\n'));
}

function pathHash(path: string): string {
  if (!existsSync(path)) return 'absent';
  return lstatSync(path).isDirectory() ? `d ${treeHash(path)}` : `f ${fileHash(path)}`;
}

function alternatesHash(gitDir: string): string {
  return `${fileHash(join(gitDir, 'objects', 'info', 'alternates'))} ${fileHash(join(gitDir, 'objects', 'info', 'http-alternates'))}`;
}

/** What a path is when it is not a real directory (lstat, so a symlink or junction is never followed); null for a directory. */
function notADirectory(path: string): string | null {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isDirectory()) return null;
  if (st.isSymbolicLink()) {
    let target = '?';
    try { target = readlinkSync(path); } catch { /* unreadable link */ }
    return `a symlink or junction to ${target}`;
  }
  return st.isFile() ? 'a file' : 'not a directory';
}

const NOT_A_DIR = 'not a directory: ';

function worktreeEntries(commonDir: string, ids: readonly string[]): Record<string, WorktreeEntry> {
  const out: Record<string, WorktreeEntry> = {};
  for (const id of ids) {
    const dir = join(commonDir, 'worktrees', id);
    const odd = notADirectory(dir);
    if (odd) { out[id] = { meta: `${NOT_A_DIR}${odd}`, gitdir: '', commondir: '', notDir: odd }; continue; }
    if (!existsSync(dir)) continue;
    const head = fileText(join(dir, 'HEAD'));
    const gitdir = fileText(join(dir, 'gitdir'));
    const commondir = fileText(join(dir, 'commondir'));
    const stale = !gitdir || !existsSync(isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir));
    out[id] = { meta: sha([head, gitdir, commondir, treeHash(join(dir, 'refs'))].join('\n')), gitdir, commondir, ...(stale ? { stale } : {}) };
  }
  return out;
}

/** Every submodule git dir under `modules/` (module names may hold slashes; submodules nest); a non-directory entry is kept as such. */
export function moduleEntries(commonDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    const oddDir = notADirectory(dir);
    if (oddDir) { out[rel || '.'] = `${NOT_A_DIR}${oddDir}`; return; }
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const odd = notADirectory(p);
      if (odd) { out[r] = `${NOT_A_DIR}${odd}`; continue; }
      if (existsSync(join(p, 'HEAD')) || existsSync(join(p, 'config'))) {
        out[r] = sha([fileHash(join(p, 'config')), fileHash(join(p, 'config.worktree')), treeHash(join(p, 'hooks')), treeHash(join(p, 'info')), alternatesHash(p)].join('\n'));
        walk(join(p, 'modules'), `${r}/modules`);
      } else {
        walk(p, r);
      }
    }
  };
  walk(join(commonDir, 'modules'), '');
  return out;
}

/** git's own include depth limit. */
export const MAX_INCLUDE_DEPTH = 10;

/** The global config files git reads: GIT_CONFIG_GLOBAL when set, else `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`. */
export function globalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.GIT_CONFIG_GLOBAL?.trim()) return [resolve(env.GIT_CONFIG_GLOBAL)];
  const home = env.HOME?.trim() || homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return [join(home, '.gitconfig'), join(xdg, 'git', 'config')];
}

/**
 * The `path` values of `[include]` and `[includeIf "..."]` sections in a git
 * config text, resolved like git does (`~/` from the home directory, a
 * relative path from the including file's directory). Every includeIf is
 * followed whatever its condition: the snapshot over-approximates.
 */
export function includeTargets(text: string, fromFile: string, home: string): string[] {
  const out: string[] = [];
  let inInclude = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const section = /^\[([^\]]*)\](.*)$/.exec(line);
    if (section) {
      const name = section[1].trim().split(/[\s"]/)[0].toLowerCase();
      inInclude = name === 'include' || name === 'includeif';
      line = section[2].trim();
    }
    if (!inInclude || !line) continue;
    const kv = /^path\s*=\s*(.*)$/i.exec(line);
    if (!kv) continue;
    let value = kv[1].trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    value = quoted ? quoted[1].replace(/\\(.)/g, '$1') : value.replace(/\s*[;#].*$/, '').trim();
    if (!value) continue;
    const path = value === '~' || value.startsWith('~/') ? join(home, value.slice(2)) : isAbsolute(value) ? value : join(dirname(fromFile), value);
    out.push(resolve(path));
  }
  return out;
}

function safeFileHash(path: string): string {
  try {
    return existsSync(path) && statSync(path).isDirectory() ? 'a directory' : fileHash(path);
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Hash of the global config files and of every file an include in them, or
 * in `repoConfigs` (hashed elsewhere themselves), names, up to
 * {@link MAX_INCLUDE_DEPTH} levels.
 */
export function globalConfigHash(repoConfigs: readonly string[], env: NodeJS.ProcessEnv = process.env, excludesFile?: string): string {
  const home = env.HOME?.trim() || homedir();
  const seen = new Map<string, string>();
  const follow = (file: string, depth: number) => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    for (const target of includeTargets(text, file, home)) visit(target, depth);
  };
  const visit = (file: string, depth: number) => {
    const path = resolve(file);
    if (seen.has(path)) return;
    seen.set(path, safeFileHash(path));
    follow(path, depth + 1);
  };
  for (const f of globalConfigFiles(env)) visit(f, 0);
  for (const f of repoConfigs) follow(resolve(f), 1);
  // The user-level ignore files change what `git status` reports (a lane can hide a file with them).
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  const excludes = excludesFile ? [excludesFile === '~' || excludesFile.startsWith('~/') ? join(home, excludesFile.slice(2)) : excludesFile] : [];
  for (const f of [join(xdg, 'git', 'ignore'), ...excludes]) seen.set(resolve(f), safeFileHash(resolve(f)));
  return sha([...seen].sort(([a], [b]) => a.localeCompare(b)).map(([p, h]) => `${p} ${h}`).join('\n'));
}

function ignoredHash(root: string): string {
  const names = existsSync(root) ? readdirSync(root).filter((n) => /^\.env/i.test(n)) : [];
  const paths = [...new Set([...names, ...SENSITIVE_IGNORED])].sort();
  return sha(paths.map((p) => `${p} ${pathHash(join(root, p))}`).join('\n'));
}

/**
 * Porcelain `-z` status entries, sorted, minus untracked entries under the
 * engine's own state root (`.omg/`: state, progress, job dirs and lane
 * worktrees are written there while the lane runs; the engine-owned state
 * files there are covered by the engine ledger, ledger.ts). Untracked files
 * under `.omg/skills/` (committable) still count, and so does every tracked
 * change.
 */
export function stableStatus(raw: string, stateRootRel: string | null): string {
  const prefix = stateRootRel ? `${stateRootRel.replace(/\\/g, '/').replace(/\/+$/, '')}/` : null;
  const entries: string[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename / copy carries its source path as the next entry.
    if (code[0] === 'R' || code[0] === 'C') { entries.push(`${entry} <- ${parts[i + 1] ?? ''}`); i++; continue; }
    if (code === '??' && prefix && path.startsWith(prefix) && !path.startsWith(`${prefix}skills/`)) continue;
    entries.push(entry);
  }
  return entries.sort().join('\n');
}

/**
 * Snapshot the shared git state. With `against`, `git status` is skipped
 * when a file that can configure status (config, info/, a submodule) already
 * differs from it; the comparison then reports that file.
 */
export function snapshotRepo(exec: Exec, root: string, stateRootRel: string | null = '.omg', against?: RepoSnapshot): RepoSnapshot {
  const rawCommon = run(exec, root, ['rev-parse', '--git-common-dir']).trim();
  const commonDir = isAbsolute(rawCommon) ? rawCommon : resolve(root, rawCommon);
  const refs: Record<string, string> = {};
  for (const line of run(exec, root, ['for-each-ref', FOR_EACH_REF_FORMAT]).split(/\r?\n/)) {
    const m = /^(\S+) ([0-9a-f]{40,64})$/.exec(line.trim());
    if (m) refs[m[1]] = m[2];
  }
  const worktreeConfigs: Record<string, string> = {};
  const wtDir = join(commonDir, 'worktrees');
  // `worktrees/` itself replaced by a symlink or junction: one entry `.` that reports it, nothing read through it.
  const worktreeIds = notADirectory(wtDir) ? ['.'] : existsSync(wtDir) ? readdirSync(wtDir).sort() : [];
  for (const id of worktreeIds) {
    if (id === '.') continue;
    const p = join(wtDir, id, 'config.worktree');
    if (existsSync(p)) worktreeConfigs[id] = fileHash(p);
  }
  const files = {
    config: fileHash(join(commonDir, 'config')),
    configWorktree: fileHash(join(commonDir, 'config.worktree')),
    info: treeHash(join(commonDir, 'info')),
    modules: moduleEntries(commonDir),
    globalConfig: globalConfigHash([
      join(commonDir, 'config'), join(commonDir, 'config.worktree'),
      ...worktreeIds.filter((id) => id !== '.').map((id) => join(wtDir, id, 'config.worktree')),
    ], process.env, excludesFileOf(exec, root)),
  };
  const statusUnsafe = against !== undefined && (files.config !== against.config || files.configWorktree !== against.configWorktree
    || files.info !== against.info || JSON.stringify(files.modules) !== JSON.stringify(against.modules) || files.globalConfig !== against.globalConfig);
  return {
    commonDir,
    refs,
    ...files,
    worktreeConfigs,
    worktreeIds,
    worktrees: worktreeEntries(commonDir, worktreeIds),
    hooks: treeHash(join(commonDir, 'hooks')),
    alternates: alternatesHash(commonDir),
    ignored: ignoredHash(root),
    mainHead: run(exec, root, ['rev-parse', 'HEAD']).trim(),
    mainSymbolic: run(exec, root, ['rev-parse', '--symbolic-full-name', 'HEAD']).trim(),
    mainStatus: statusUnsafe ? STATUS_SKIPPED : stableStatus(run(exec, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), stateRootRel),
  };
}

/** Same file system path (realpath when both exist; case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let out = resolve(p);
    try { out = realpathSync.native(out); } catch { /* compare the resolved path */ }
    return process.platform === 'win32' ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

export interface CompareAllowance {
  /** Created refs a predicate allows (a lost lane's branch, whose sha the engine never saw). */
  refAllowed?: (name: string, sha: string) => boolean;
  /** The lane's own new worktree entry, by its worktree path or by its entry id. */
  newWorktree?: { path?: string | null; id?: string };
}

/**
 * Differences between two snapshots. `allowedNewRefs` may appear (or stay
 * absent) at exactly the given sha (`*`: any sha).
 */
export function compareSnapshots(before: RepoSnapshot, after: RepoSnapshot, allowedNewRefs: Readonly<Record<string, string>> = {}, allow: CompareAllowance = {}): string[] {
  const problems: string[] = [];
  if (before.commonDir !== after.commonDir) problems.push(`common git dir moved (${before.commonDir} -> ${after.commonDir})`);
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  for (const name of [...names].sort()) {
    const was = before.refs[name];
    const now = after.refs[name];
    if (was === now) continue;
    if (was === undefined && name in allowedNewRefs && (allowedNewRefs[name] === '*' || now === allowedNewRefs[name])) continue;
    if (was === undefined && now !== undefined && allow.refAllowed?.(name, now)) continue;
    if (was === undefined) problems.push(`ref ${name} was created (${now.slice(0, 12)})`);
    else if (now === undefined) problems.push(`ref ${name} was deleted (was ${was.slice(0, 12)})`);
    else problems.push(`ref ${name} moved ${was.slice(0, 12)} -> ${now.slice(0, 12)}`);
  }
  if (before.config !== after.config) problems.push('the common git config changed');
  if (before.configWorktree !== after.configWorktree) problems.push('config.worktree changed');
  const ids = new Set([...Object.keys(before.worktreeConfigs), ...Object.keys(after.worktreeConfigs)]);
  for (const id of [...ids].sort()) {
    // A stale worktree pruned with its whole entry (copilot_run prunes before adding the lane's) is not a change to live config.
    if (after.worktreeConfigs[id] === undefined && !after.worktreeIds.includes(id)) continue;
    if (before.worktreeConfigs[id] !== after.worktreeConfigs[id]) problems.push(`worktrees/${id}/config.worktree changed`);
  }
  const ownNew = (id: string, entry: WorktreeEntry) => {
    const own = allow.newWorktree;
    if (!own) return false;
    if (own.id !== undefined && own.id === id) return true;
    return Boolean(own.path) && Boolean(entry.gitdir) && samePath(dirname(entry.gitdir), own.path!);
  };
  const entries = new Set([...Object.keys(before.worktrees ?? {}), ...Object.keys(after.worktrees ?? {})]);
  for (const id of [...entries].sort()) {
    const was = before.worktrees?.[id];
    const now = after.worktrees?.[id];
    if (now?.notDir) {
      problems.push(`worktrees/${id} is not a real directory (${now.notDir})`);
      continue;
    }
    if (!now) {
      // `git worktree prune` drops an entry whose worktree is gone; any other removal is a change.
      if (was && !was.stale) problems.push(`worktree entry worktrees/${id} was removed or is no longer a directory`);
      continue;
    }
    if (!was) {
      if (!ownNew(id, now)) problems.push(`worktree entry worktrees/${id} was added`);
      else if (now.commondir !== '../..') problems.push(`the lane's worktree entry worktrees/${id} points its commondir at ${now.commondir}`);
      continue;
    }
    if (was.meta !== now.meta) problems.push(`worktrees/${id} changed (HEAD, gitdir, commondir or per-worktree refs)`);
  }
  if (before.hooks !== after.hooks) problems.push('the hooks/ directory changed');
  if (before.info !== after.info) problems.push('the info/ directory changed');
  const mods = new Set([...Object.keys(before.modules ?? {}), ...Object.keys(after.modules ?? {})]);
  for (const m of [...mods].sort()) {
    const was = before.modules?.[m];
    const now = after.modules?.[m];
    if (was === now) continue;
    if (now?.startsWith(NOT_A_DIR)) { problems.push(`modules/${m} is not a real directory (${now.slice(NOT_A_DIR.length)})`); continue; }
    problems.push(was === undefined ? `submodule git dir modules/${m} was added` : now === undefined ? `submodule git dir modules/${m} was removed` : `modules/${m} changed (config, hooks, info or alternates)`);
  }
  if (before.alternates !== after.alternates) problems.push('objects/info/alternates changed');
  if (before.globalConfig !== after.globalConfig) problems.push('the global git config or a file a git config includes changed (~/.gitconfig, $XDG_CONFIG_HOME/git/config, include.path / includeIf targets)');
  if (before.ignored !== after.ignored) problems.push(`an ignored file in the main checkout changed (.env*, ${SENSITIVE_IGNORED.join(', ')})`);
  if (before.mainHead !== after.mainHead) problems.push(`the main checkout's HEAD moved ${before.mainHead.slice(0, 12)} -> ${after.mainHead.slice(0, 12)}`);
  if (before.mainSymbolic !== after.mainSymbolic) problems.push(`the main checkout's HEAD switched ${before.mainSymbolic} -> ${after.mainSymbolic}`);
  if (before.mainStatus !== after.mainStatus && after.mainStatus !== STATUS_SKIPPED) problems.push('the main checkout\'s working tree changed (modified, added or deleted files, untracked included)');
  return problems;
}

/**
 * The review lane's own worktree after it ended: its git dir is the repo's,
 * it is at the reviewed sha, nothing changed. Run only after the shared-state
 * comparison passed (git here reads that shared config).
 *
 * The lane could write its `.git` file, its admin dir (`commondir`,
 * `config.worktree`) and its attributes, so git here never discovers the git
 * dir: it uses the links copilot_run recorded at the lane's creation
 * (recordWorktreeGitLinks), whose admin dir must be a direct child of the
 * repository's `worktrees/`, and runHostGit pins GIT_DIR, GIT_WORK_TREE and
 * GIT_COMMON_DIR to those paths, hardened, after comparing them (and
 * `config.worktree`) with the disk. No attribute applies there
 * (GIT_ATTR_SOURCE is the empty tree), so no filter, diff driver or git-lfs
 * runs whatever a config level defines, and no submodule is entered; the
 * shared-state comparison before this call and the driver blanking stay as
 * further layers.
 */
export function verifyReviewWorktree(result: LaneResult, head: string, commonDir?: string): string[] {
  const problems: string[] = [];
  if (result.baseSha !== head) problems.push(`the lane started at ${result.baseSha?.slice(0, 12) ?? 'unknown'}, not the head ${head.slice(0, 12)}`);
  if (!result.worktree) return [...problems, 'the lane reported no worktree to verify'];
  // The links recorded when copilot_run created the lane, never ones read now (runHostGit compares them with the disk).
  const links = recordedWorktreeGitLinks(result.worktree);
  if (!links) return [...problems, 'the lane worktree cannot be read: no git links were recorded for it at its creation'];
  const laneCommon = dirname(dirname(links.adminDir));
  if (basename(dirname(links.adminDir)) !== 'worktrees' || (commonDir !== undefined && !samePath(laneCommon, commonDir))) {
    return [...problems, `the lane worktree's git dir is ${links.adminDir}, not the repository's ${join(commonDir ?? laneCommon, 'worktrees')}/<name>`];
  }
  let laneHead = '';
  let status = '';
  try {
    const gitDirArgs = worktreeGitDirArgs(result.worktree);
    laneHead = runHostGit(result.worktree, [...gitDirArgs, 'rev-parse', 'HEAD']).trim();
    status = runHostGit(result.worktree, [...gitDirArgs, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch (error) {
    return [...problems, `the lane worktree cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (laneHead !== head || (result.headSha !== null && result.headSha !== head)) {
    problems.push(`the lane worktree's HEAD is ${(laneHead || result.headSha || 'unknown').slice(0, 12)}, not the reviewed ${head.slice(0, 12)}`);
  }
  const changes = result.changes;
  if (!changes) problems.push('the lane reported no change summary');
  else {
    const touched = [...changes.changedFiles, ...changes.untrackedFiles, ...changes.protectedChanges];
    if (touched.length > 0) problems.push(`the lane changed files: ${[...new Set(touched)].slice(0, 10).join(', ')}`);
  }
  if (status) problems.push('the lane worktree is not clean (modified, deleted or untracked files)');
  return problems;
}
