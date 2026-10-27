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
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import type { LaneResult } from './lane.js';
import { FOR_EACH_REF_FORMAT } from './exec.js';

export interface WorktreeEntry {
  /** Hash of HEAD, gitdir, commondir and the per-worktree refs/. */
  meta: string;
  /** Content of `gitdir` (the worktree's `.git` file path). */
  gitdir: string;
  /** Content of `commondir` (`../..` for every `git worktree add`). */
  commondir: string;
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

function worktreeEntries(commonDir: string, ids: readonly string[]): Record<string, WorktreeEntry> {
  const out: Record<string, WorktreeEntry> = {};
  for (const id of ids) {
    const dir = join(commonDir, 'worktrees', id);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    const head = fileText(join(dir, 'HEAD'));
    const gitdir = fileText(join(dir, 'gitdir'));
    const commondir = fileText(join(dir, 'commondir'));
    out[id] = { meta: sha([head, gitdir, commondir, treeHash(join(dir, 'refs'))].join('\n')), gitdir, commondir };
  }
  return out;
}

/** Every submodule git dir under `modules/` (module names may hold slashes; submodules nest). */
function moduleEntries(commonDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (!lstatSync(p).isDirectory()) continue;
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
  const worktreeIds = existsSync(wtDir) ? readdirSync(wtDir).sort() : [];
  for (const id of worktreeIds) {
    const p = join(wtDir, id, 'config.worktree');
    if (existsSync(p)) worktreeConfigs[id] = fileHash(p);
  }
  const files = {
    config: fileHash(join(commonDir, 'config')),
    configWorktree: fileHash(join(commonDir, 'config.worktree')),
    info: treeHash(join(commonDir, 'info')),
    modules: moduleEntries(commonDir),
  };
  const statusUnsafe = against !== undefined && (files.config !== against.config || files.configWorktree !== against.configWorktree
    || files.info !== against.info || JSON.stringify(files.modules) !== JSON.stringify(against.modules));
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
  for (const id of Object.keys(after.worktrees ?? {}).sort()) {
    const was = before.worktrees?.[id];
    const now = after.worktrees[id];
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
    problems.push(was === undefined ? `submodule git dir modules/${m} was added` : now === undefined ? `submodule git dir modules/${m} was removed` : `modules/${m} changed (config, hooks, info or alternates)`);
  }
  if (before.alternates !== after.alternates) problems.push('objects/info/alternates changed');
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
 */
export function verifyReviewWorktree(exec: Exec, result: LaneResult, head: string, commonDir?: string): string[] {
  const problems: string[] = [];
  if (result.baseSha !== head) problems.push(`the lane started at ${result.baseSha?.slice(0, 12) ?? 'unknown'}, not the head ${head.slice(0, 12)}`);
  if (!result.worktree) return [...problems, 'the lane reported no worktree to verify'];
  let laneHead = '';
  let status = '';
  try {
    if (commonDir !== undefined) {
      const raw = run(exec, result.worktree, ['rev-parse', '--git-common-dir']).trim();
      const laneCommon = isAbsolute(raw) ? raw : resolve(result.worktree, raw);
      if (!samePath(laneCommon, commonDir)) return [...problems, `the lane worktree's git dir is ${laneCommon}, not the repository's ${commonDir}`];
    }
    laneHead = run(exec, result.worktree, ['rev-parse', 'HEAD']).trim();
    status = run(exec, result.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
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
