/**
 * Review-lane tamper check (owner override of design §5). The review profile's
 * shell denylist is a denylist: `git $p`, `echo >> .git/config` and friends
 * get past it, and review lanes read untrusted PR content. So the engine
 * snapshots the repository's shared git state before the lane starts and
 * again after it ends, and any difference fails the review as
 * `awaiting-human: review-tampered` (its verdict is discarded).
 *
 * Snapshot, all from the COMMON git dir (`git rev-parse --git-common-dir`, the
 * one every worktree shares):
 * - every ref (`git for-each-ref`: loose, packed-refs and refs/stash);
 * - a hash of `config`, `config.worktree` and each `worktrees/<id>/config.worktree`;
 * - a listing hash (names and contents) of `hooks/` and `info/`;
 * - the main checkout's HEAD (sha and symbolic ref) and its status, untracked
 *   files included, so a deleted untracked file shows.
 * After the lane, also: the lane worktree's HEAD equals the reviewed sha, its
 * `changes` summary is empty, and its status is clean.
 *
 * The only ref allowed to appear is the lane's own branch, at the reviewed sha
 * (copilot_run creates it with the worktree).
 */

import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import type { LaneResult } from './lane.js';
import { FOR_EACH_REF_FORMAT } from './exec.js';

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
  hooks: string;
  info: string;
  mainHead: string;
  mainSymbolic: string;
  /** `git status --porcelain=v1 -z --untracked-files=all` of the main checkout (stableStatus). */
  mainStatus: string;
}

export class SnapshotError extends Error {}

function run(exec: Exec, cwd: string, args: string[]): string {
  const res = exec('git', args, { cwd, env: TRUSTED_READ_ENV });
  if (res.status !== 0) throw new SnapshotError(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr.trim().split('\n')[0]}`);
  return res.stdout;
}

function fileHash(path: string): string {
  if (!existsSync(path)) return 'absent';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/**
 * Porcelain `-z` status entries, sorted, minus untracked entries under the
 * engine's own state root (`.omg/`: state, progress, job dirs and lane
 * worktrees are written there while the lane runs). Untracked files under
 * `.omg/skills/` (committable) still count, and so does every tracked change.
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

export function snapshotRepo(exec: Exec, root: string, stateRootRel: string | null = '.omg'): RepoSnapshot {
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
  if (worktreeIds.length > 0) {
    for (const id of worktreeIds) {
      const p = join(wtDir, id, 'config.worktree');
      if (existsSync(p)) worktreeConfigs[id] = fileHash(p);
    }
  }
  return {
    commonDir,
    refs,
    config: fileHash(join(commonDir, 'config')),
    configWorktree: fileHash(join(commonDir, 'config.worktree')),
    worktreeConfigs,
    worktreeIds,
    hooks: treeHash(join(commonDir, 'hooks')),
    info: treeHash(join(commonDir, 'info')),
    mainHead: run(exec, root, ['rev-parse', 'HEAD']).trim(),
    mainSymbolic: run(exec, root, ['rev-parse', '--symbolic-full-name', 'HEAD']).trim(),
    mainStatus: stableStatus(run(exec, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), stateRootRel),
  };
}

/** Differences between two snapshots; `allowedNewRefs` may appear (or stay absent) at exactly the given sha. */
export function compareSnapshots(before: RepoSnapshot, after: RepoSnapshot, allowedNewRefs: Readonly<Record<string, string>> = {}): string[] {
  const problems: string[] = [];
  if (before.commonDir !== after.commonDir) problems.push(`common git dir moved (${before.commonDir} -> ${after.commonDir})`);
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  for (const name of [...names].sort()) {
    const was = before.refs[name];
    const now = after.refs[name];
    if (was === now) continue;
    if (was === undefined && name in allowedNewRefs && now === allowedNewRefs[name]) continue;
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
  if (before.hooks !== after.hooks) problems.push('the hooks/ directory changed');
  if (before.info !== after.info) problems.push('the info/ directory changed');
  if (before.mainHead !== after.mainHead) problems.push(`the main checkout's HEAD moved ${before.mainHead.slice(0, 12)} -> ${after.mainHead.slice(0, 12)}`);
  if (before.mainSymbolic !== after.mainSymbolic) problems.push(`the main checkout's HEAD switched ${before.mainSymbolic} -> ${after.mainSymbolic}`);
  if (before.mainStatus !== after.mainStatus) problems.push('the main checkout\'s working tree changed (modified, added or deleted files, untracked included)');
  return problems;
}

/** The lane's own worktree after it ended: at the reviewed sha, nothing changed. */
export function verifyReviewWorktree(exec: Exec, result: LaneResult, head: string): string[] {
  const problems: string[] = [];
  if (result.baseSha !== head) problems.push(`the lane started at ${result.baseSha?.slice(0, 12) ?? 'unknown'}, not the head ${head.slice(0, 12)}`);
  if (!result.worktree) return [...problems, 'the lane reported no worktree to verify'];
  let laneHead = '';
  let status = '';
  try {
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
