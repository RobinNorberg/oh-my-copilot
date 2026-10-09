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

import { existsSync, realpathSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { validateWorktreeRemovalTarget } from '../lib/worktree-cleanup-safety.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';
import { getOmcRoot, OmcPaths, resolveOmcPath } from '../lib/worktree-paths.js';

export type TeamWorktreeMode = 'disabled' | 'detached' | 'named';

export interface WorktreeInfo {
  path: string;
  branch: string;
  workerName: string;
  teamName: string;
  createdAt: string;
  repoRoot?: string;
  detached?: boolean;
  created?: boolean;
  reused?: boolean;
  /** The commit the worktree was created at; worker commits are counted on top of it. */
  baseCommit?: string;
}

/** A clean worker worktree kept because it holds commits the leader HEAD does not contain. */
export interface PreservedWorktree {
  workerName: string;
  path: string;
  /** Named-mode branch, kept; null for a detached worktree. */
  branch: string | null;
  /** Worker commits not merged into the leader HEAD. */
  commits: number;
}

export interface EnsureWorkerWorktreeOptions {
  mode?: TeamWorktreeMode;
  baseRef?: string;
  requireCleanLeader?: boolean;
}

export interface EnsureWorkerWorktreeResult extends WorktreeInfo {
  mode: TeamWorktreeMode;
  repoRoot: string;
  detached: boolean;
  created: boolean;
  reused: boolean;
}

export interface CleanupTeamWorktreesResult {
  removed: string[];
  /** Kept because removal was unsafe or failed: blocks the team state disposal. */
  preserved: Array<{ workerName: string; path: string; reason: string }>;
  /** Kept on purpose, with unmerged worker commits: the work outlives the team. */
  retained: PreservedWorktree[];
}

export interface TeamWorktreeCleanupSafety {
  hasEvidence: boolean;
  entries: WorktreeInfo[];
  blockers: Array<{ workerName: string; path: string; reason: string }>;
}

interface WorktreeMetadataReadIssue {
  path: string;
  message: string;
}

interface WorktreeMetadataReadResult {
  entries: WorktreeInfo[];
  issues: WorktreeMetadataReadIssue[];
}

interface WorktreeRootAgentsBackup {
  worktreePath: string;
  hadOriginal: boolean;
  originalContent?: string;
  installedContent: string;
  installedAt: string;
}

export interface WorktreeRootAgentsRestoreResult {
  restored: boolean;
  reason?: string;
}

/** Get canonical native team worktree path for a worker. */
export function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string {
  return join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees', sanitizeName(workerName));
}

/** Get branch name for a worker. */
export function getBranchName(teamName: string, workerName: string): string {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}

function git(repoRoot: string, args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();
}

function isInsideGitRepo(repoRoot: string): boolean {
  try {
    git(repoRoot, ['rev-parse', '--show-toplevel']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Untracked OMC state in the leader is our own metadata, not a user edit.
 * Built from OmcPaths.ROOT so it cannot drift from the actual state directory
 * name; git reports porcelain paths with forward slashes on every platform.
 */
const UNTRACKED_OMC_STATE = new RegExp(
  `^\\?\\? ${OmcPaths.ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`,
);

function assertCleanLeaderWorktree(repoRoot: string): void {
  const status = git(repoRoot, ['status', '--porcelain'])
    .split('\n')
    .filter(line => line.trim() !== '' && !UNTRACKED_OMC_STATE.test(line))
    .join('\n')
    .trim();
  if (status.length > 0) {
    const error = new Error('leader_worktree_dirty: commit, stash, or clean changes before enabling team worktree mode');
    (error as Error & { code?: string }).code = 'leader_worktree_dirty';
    throw error;
  }
}

function canonicalPathForComparison(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function getRegisteredWorktreeBranch(repoRoot: string, wtPath: string): string | undefined {
  try {
    const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
    const resolvedWtPath = canonicalPathForComparison(wtPath);
    let currentMatches = false;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentMatches = canonicalPathForComparison(line.slice('worktree '.length).trim()) === resolvedWtPath;
        continue;
      }
      if (!currentMatches) continue;
      if (line.startsWith('branch ')) return line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      if (line === 'detached') return 'HEAD';
    }
  } catch {
    // Best-effort check only.
  }
  return undefined;
}


function isRegisteredWorktreePath(repoRoot: string, wtPath: string): boolean {
  try {
    const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
    const resolvedWtPath = canonicalPathForComparison(wtPath);
    return output.split('\n').some(line => (
      line.startsWith('worktree ') && canonicalPathForComparison(line.slice('worktree '.length).trim()) === resolvedWtPath
    ));
  } catch {
    return false;
  }
}


function isDetached(wtPath: string): boolean {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();
    return branch.length === 0;
  } catch {
    return false;
  }
}

function isWorktreeDirty(wtPath: string): boolean {
  return isWorktreeDirtyExcept(wtPath).dirty;
}

function normalizeStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('\"') && trimmed.endsWith('\"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function statusEntryPath(line: string): string {
  const payload = line.slice(3);
  const renameSeparator = ' -> ';
  const renameIndex = payload.indexOf(renameSeparator);
  return normalizeStatusPath(renameIndex >= 0 ? payload.slice(renameIndex + renameSeparator.length) : payload);
}

/**
 * OMC directories whose untracked files are a worker session's operational
 * state, never worker output, each with the part of its path that must match:
 * all of `state/` (SessionEnd job records) and the flat `sessions/*.json` (the
 * SessionEnd session summary, written with no team-worker gate).
 */
const WORKTREE_RUNTIME_STATE_DIRS: ReadonlyArray<readonly [string, RegExp]> = [['state', /^/], ['sessions', /^[^/]+\.json$/]];

/**
 * The worktree's own OMC runtime state directories as `git status` names the
 * files under them (`.omg/state/`, `.omg/sessions/`), or an empty list when the
 * OMC root is not a top-level directory of the worktree (OMC_STATE_DIR, a
 * workspace marker above it).
 */
function worktreeRuntimeStatePrefixes(wtPath: string): Array<readonly [string, RegExp]> {
  const root = resolve(wtPath);
  const omcRel = relative(root, resolve(getOmcRoot(wtPath))).split(sep).join('/');
  if (!omcRel || omcRel.startsWith('..') || isAbsolute(omcRel) || omcRel.includes('/')) return [];
  return WORKTREE_RUNTIME_STATE_DIRS.map(([dir, rest]) => [`${relative(root, resolveOmcPath(dir, wtPath)).split(sep).join('/')}/`, rest] as const);
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
function isWorktreeDirtyExcept(wtPath: string, ignoredRootPaths: string[] = []): { dirty: boolean; entries: string[]; runtimeState: boolean } {
  try {
    const ignored = new Set(ignoredRootPaths);
    const runtimePrefixes = worktreeRuntimeStatePrefixes(wtPath);
    const entries = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe', windowsHide: true })
      .split('\n')
      .filter(line => line.trim().length > 0);
    const isRuntime = (line: string) => line.startsWith('?? ') && runtimePrefixes.some(([prefix, rest]) => {
      const path = statusEntryPath(line);
      return path.startsWith(prefix) && rest.test(path.slice(prefix.length));
    });
    const relevantEntries = entries.filter(line => !ignored.has(statusEntryPath(line)) && !isRuntime(line));
    return { dirty: relevantEntries.length > 0, entries: relevantEntries, runtimeState: entries.some(isRuntime) };
  } catch {
    return { dirty: true, entries: ['git_status_failed'], runtimeState: false };
  }
}

function sleepSync(ms: number): void {
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
function removeRuntimeLeftover(wtPath: string, retryMs = RUNTIME_LEFTOVER_RETRY_MS): void {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      rmSync(wtPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        process.stderr.write(`[omc] warning: left OMC runtime state of a removed worker worktree at ${wtPath} (still in use): ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }
      sleepSync(500);
    }
  }
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/**
 * Commits at the worktree's HEAD that the leader HEAD does not contain (and,
 * when recorded, that are newer than the worktree's base commit): worker work
 * a removal would destroy. Null when git cannot tell.
 */
function countUnmergedWorkerCommits(repoRoot: string, wtPath: string, baseCommit?: string): number | null {
  return countUnmergedCommits(repoRoot, gitOrNull(['rev-parse', 'HEAD'], wtPath), baseCommit);
}

/** The commit a local branch points at, or null when it does not exist. */
function resolveBranchCommit(repoRoot: string, branch: string): string | null {
  return gitOrNull(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repoRoot) || null;
}

/** As countUnmergedWorkerCommits, for a commit resolved by the caller (null: unknown). */
function countUnmergedCommits(repoRoot: string, head: string | null, baseCommit?: string): number | null {
  const leader = gitOrNull(['rev-parse', 'HEAD'], repoRoot);
  if (!head || !leader) return null;
  const count = (excludes: string[]) => gitOrNull(['rev-list', '--count', head, ...excludes.map((ref) => `^${ref}`)], repoRoot);
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
function hasInitializedSubmodules(wtPath: string): boolean {
  const modulesDir = gitOrNull(['rev-parse', '--git-path', 'modules'], wtPath);
  if (modulesDir && existsSync(resolve(wtPath, modulesDir))) return true;
  const staged = gitOrNull(['ls-files', '--stage'], wtPath) ?? '';
  return staged.split('\n').some((line) => {
    if (!line.startsWith('160000 ')) return false;
    const tab = line.indexOf('\t');
    return tab >= 0 && existsSync(join(wtPath, normalizeStatusPath(line.slice(tab + 1)), '.git'));
  });
}

function unmergedCommitsError(info: PreservedWorktree): Error {
  const what = existsSync(info.path) ? `worker worktree at ${info.path}` : `worker branch of the removed worktree ${info.path}`;
  const error = new Error(
    `worktree_unmerged_commits: preserving ${what} with ${info.commits} commit(s) not merged into the leader HEAD${info.branch ? ` (branch ${info.branch})` : ' (detached)'}`,
  );
  Object.assign(error, { code: 'worktree_unmerged_commits', preservedWorktree: info });
  return error;
}

/** Where the worktrees a finished team kept for their unmerged commits are listed (outlives the team state). */
export function getPreservedWorktreesRecordPath(repoRoot: string, teamName: string): string {
  return join(getOmcRoot(repoRoot), 'state', 'team-preserved-worktrees', `${sanitizeName(teamName)}.json`);
}

/** Record (or, when empty, clear) the worktrees a team shutdown kept for their unmerged commits. */
export function writePreservedWorktreesRecord(repoRoot: string, teamName: string, preserved: PreservedWorktree[]): void {
  const recordPath = getPreservedWorktreesRecordPath(repoRoot, teamName);
  if (preserved.length === 0) {
    rmSync(recordPath, { force: true });
    return;
  }
  ensureDirWithMode(join(getOmcRoot(repoRoot), 'state', 'team-preserved-worktrees'));
  atomicWriteJson(recordPath, { team: teamName, recorded_at: new Date().toISOString(), preserved_worktrees: preserved });
}

/** The recorded preserved worktrees of a team whose directory or kept branch still exists. */
export function readPreservedWorktreesRecord(repoRoot: string, teamName: string): PreservedWorktree[] {
  try {
    const record = JSON.parse(readFileSync(getPreservedWorktreesRecordPath(repoRoot, teamName), 'utf-8')) as { preserved_worktrees?: unknown };
    const list = Array.isArray(record.preserved_worktrees) ? record.preserved_worktrees as PreservedWorktree[] : [];
    return list.filter((entry) => entry && typeof entry.path === 'string'
      && (existsSync(entry.path) || (typeof entry.branch === 'string' && resolveBranchCommit(repoRoot, entry.branch) !== null)));
  } catch {
    return [];
  }
}

/** Get worktree metadata path. */
function getMetadataPath(repoRoot: string, teamName: string): string {
  return join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName), 'worktrees.json');
}

function getLegacyMetadataPath(repoRoot: string, teamName: string): string {
  return join(getOmcRoot(repoRoot), 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}


function getWorkerStateDir(repoRoot: string, teamName: string, workerName: string): string {
  return join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName), 'workers', sanitizeName(workerName));
}

function getRootAgentsBackupPath(repoRoot: string, teamName: string, workerName: string): string {
  return join(getWorkerStateDir(repoRoot, teamName, workerName), 'worktree-root-agents.json');
}

function readRootAgentsBackup(
  repoRoot: string,
  teamName: string,
  workerName: string,
): WorktreeRootAgentsBackup | null {
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  if (!existsSync(backupPath)) return null;
  try {
    return JSON.parse(readFileSync(backupPath, 'utf-8')) as WorktreeRootAgentsBackup;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[omc] warning: worktree root AGENTS backup parse error: ${msg}\n`);
    const error = new Error(`worktree_root_agents_backup_unreadable:${backupPath}:${msg}`);
    (error as Error & { code?: string }).code = 'worktree_root_agents_backup_unreadable';
    throw error;
  }
}

/**
 * Install the generated worker overlay into the root of a native worker worktree.
 * Existing root AGENTS.md content is backed up under leader-owned state so cleanup
 * can safely restore it. Reinstalling preserves the first original backup instead
 * of treating an older managed overlay as user content.
 */
export function installWorktreeRootAgents(
  teamName: string,
  workerName: string,
  repoRoot: string,
  worktreePath: string,
  overlayContent: string,
): void {
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
    (error as Error & { code?: string }).code = 'agents_dirty';
    throw error;
  }

  const backup: WorktreeRootAgentsBackup = previous
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
export function restoreWorktreeRootAgents(
  teamName: string,
  workerName: string,
  repoRoot: string,
  worktreePath?: string,
): WorktreeRootAgentsRestoreResult {
  const omcRoot = getOmcRoot(repoRoot);
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  validateResolvedPath(backupPath, omcRoot);
  const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
  if (!backup) return { restored: false, reason: 'no_backup' };

  const resolvedWorktreePath = worktreePath ?? backup.worktreePath;
  validateResolvedPath(resolvedWorktreePath, omcRoot);
  if (!existsSync(resolvedWorktreePath)) {
    try {
      unlinkSync(backupPath);
    } catch { /* backup already gone */ }
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
  } else if (existsSync(agentsPath)) {
    unlinkSync(agentsPath);
  }

  try {
    unlinkSync(backupPath);
  } catch { /* backup already gone */ }
  return { restored: true };
}

/** Read worktree metadata, including legacy metadata for cleanup compatibility. */
function readMetadataResult(repoRoot: string, teamName: string): WorktreeMetadataReadResult {
  const paths = [getMetadataPath(repoRoot, teamName), getLegacyMetadataPath(repoRoot, teamName)];
  const byWorker = new Map<string, WorktreeInfo>();
  const issues: WorktreeMetadataReadIssue[] = [];
  for (const metaPath of paths) {
    if (!existsSync(metaPath)) continue;
    try {
      const entries = JSON.parse(readFileSync(metaPath, 'utf-8')) as WorktreeInfo[];
      for (const entry of entries) byWorker.set(entry.workerName, entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({ path: metaPath, message });
      process.stderr.write(`[omc] warning: worktrees.json parse error at ${metaPath}: ${message}
`);
    }
  }
  return { entries: [...byWorker.values()], issues };
}

function readMetadata(repoRoot: string, teamName: string): WorktreeInfo[] {
  return readMetadataResult(repoRoot, teamName).entries;
}


function listRootAgentsBackupIssues(repoRoot: string, teamName: string, entries: WorktreeInfo[]): WorktreeMetadataReadIssue[] {
  const workersDir = join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName), 'workers');
  if (!existsSync(workersDir)) return [];
  const knownWorkers = new Set(entries.map((entry) => sanitizeName(entry.workerName)));
  const issues: WorktreeMetadataReadIssue[] = [];
  for (const workerName of readdirSync(workersDir)) {
    const backupPath = join(workersDir, workerName, 'worktree-root-agents.json');
    if (!existsSync(backupPath)) continue;
    try {
      JSON.parse(readFileSync(backupPath, 'utf-8')) as WorktreeRootAgentsBackup;
    } catch (error) {
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
function writeMetadata(repoRoot: string, teamName: string, entries: WorktreeInfo[]): void {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, join(getOmcRoot(repoRoot), 'state', 'team'));
  ensureDirWithMode(join(getOmcRoot(repoRoot), 'state', 'team', sanitizeName(teamName)));
  atomicWriteJson(metaPath, entries);
}

function recordMetadata(repoRoot: string, teamName: string, info: WorktreeInfo): void {
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== info.workerName);
    writeMetadata(repoRoot, teamName, [...existing, info]);
  });
}

function forgetMetadataUnlocked(repoRoot: string, teamName: string, workerName: string): void {
  const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== workerName);
  writeMetadata(repoRoot, teamName, existing);
}
function assertCompatibleExistingWorktree(
  repoRoot: string,
  wtPath: string,
  expectedBranch: string,
  mode: TeamWorktreeMode,
): void {
  const registeredBranch = getRegisteredWorktreeBranch(repoRoot, wtPath);
  if (!registeredBranch) {
    const error = new Error(`worktree_path_mismatch: existing path is not a registered git worktree: ${wtPath}`);
    (error as Error & { code?: string }).code = 'worktree_path_mismatch';
    throw error;
  }

  if (isWorktreeDirty(wtPath)) {
    const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
    (error as Error & { code?: string }).code = 'worktree_dirty';
    throw error;
  }

  if (mode === 'named' && registeredBranch !== expectedBranch) {
    const error = new Error(`worktree_mismatch: expected branch ${expectedBranch} at ${wtPath}, found ${registeredBranch}`);
    (error as Error & { code?: string }).code = 'worktree_mismatch';
    throw error;
  }

  if (mode === 'detached' && registeredBranch !== 'HEAD') {
    const error = new Error(`worktree_mismatch: expected detached worktree at ${wtPath}, found ${registeredBranch}`);
    (error as Error & { code?: string }).code = 'worktree_mismatch';
    throw error;
  }
}

export function normalizeTeamWorktreeMode(value: unknown): TeamWorktreeMode {
  if (typeof value !== 'string') return 'disabled';
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'detached'].includes(normalized)) return 'detached';
  if (['branch', 'named', 'named-branch'].includes(normalized)) return 'named';
  return 'disabled';
}

/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export function ensureWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
  options: EnsureWorkerWorktreeOptions = {},
): EnsureWorkerWorktreeResult | null {
  const mode = options.mode ?? 'disabled';
  if (mode === 'disabled') return null;

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
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
  } catch { /* ignore */ }

  if (existsSync(wtPath)) {
    assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode);
    const previousBase = readMetadata(repoRoot, teamName).find((entry) => entry.workerName === workerName)?.baseCommit;
    const info: EnsureWorkerWorktreeResult = {
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

  const info: EnsureWorkerWorktreeResult = {
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
export function createWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
  baseBranch?: string,
): WorktreeInfo {
  const info = ensureWorkerWorktree(teamName, workerName, repoRoot, {
    mode: 'named',
    baseRef: baseBranch,
    requireCleanLeader: false,
  });
  if (!info) throw new Error('worktree creation unexpectedly disabled');
  return info;
}

/**
 * Dry-run validation for worker worktree removal. This does not restore/remove
 * managed root AGENTS.md and does not delete backup state.
 */
export function checkWorkerWorktreeRemovalSafety(
  teamName: string,
  workerName: string,
  repoRoot: string,
  worktreePath?: string,
): void {
  const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
  const backup = readRootAgentsBackup(repoRoot, teamName, workerName);

  if (!existsSync(wtPath)) return;

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
      (error as Error & { code?: string }).code = 'agents_dirty';
      throw error;
    }
    ignoreRootAgents = true;
  }

  const dirtyCheck = isWorktreeDirtyExcept(wtPath, ignoreRootAgents ? ['AGENTS.md'] : []);
  if (dirtyCheck.dirty) {
    const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
    (error as Error & { code?: string }).code = 'worktree_dirty';
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
export function prepareWorkerWorktreeForRemoval(
  teamName: string,
  workerName: string,
  repoRoot: string,
  worktreePath?: string,
): void {
  const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
  checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, wtPath);

  const agentsRestore = restoreWorktreeRootAgents(teamName, workerName, repoRoot, wtPath);
  if (agentsRestore.reason === 'agents_dirty') {
    const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${join(wtPath, 'AGENTS.md')}`);
    (error as Error & { code?: string }).code = 'agents_dirty';
    throw error;
  }
}

/**
 * Remove a worker's worktree and branch, preserving dirty worktrees and
 * worktrees holding commits the leader HEAD does not contain (thrown as
 * `worktree_unmerged_commits`, carrying `preservedWorktree`; the branch is kept).
 * With the worktree directory already gone, the named branch is checked the
 * same way and kept when it holds unmerged worker commits.
 */
export function removeWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
): void {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);
  const metaLockPath = `${getMetadataPath(repoRoot, teamName)}.lock`;

  withFileLockSync(metaLockPath, () => {
    prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, wtPath);

    const wasRegisteredWorktree = isRegisteredWorktreePath(repoRoot, wtPath);
    const baseCommit = readMetadata(repoRoot, teamName).find((entry) => entry.workerName === workerName)?.baseCommit;
    if (!wasRegisteredWorktree || !existsSync(wtPath)) {
      // The worktree directory is gone (or a stale plain directory), so the
      // checks above saw nothing; the named branch can still hold worker
      // commits, which the `branch -D` below would destroy.
      const branchHead = resolveBranchCommit(repoRoot, branch);
      if (branchHead) {
        const commits = countUnmergedCommits(repoRoot, branchHead, baseCommit);
        if (commits === null) {
          const error = new Error(`worktree_commit_check_failed: keeping worker branch ${branch} (cannot count its commits against the leader HEAD)`);
          (error as Error & { code?: string }).code = 'worktree_commit_check_failed';
          throw error;
        }
        if (commits > 0) throw unmergedCommitsError({ workerName, path: wtPath, branch, commits });
      }
    } else {
      const commits = countUnmergedWorkerCommits(repoRoot, wtPath, baseCommit);
      if (commits === null) {
        const error = new Error(`worktree_commit_check_failed: preserving worker worktree at ${wtPath} (cannot count its commits against the leader HEAD)`);
        (error as Error & { code?: string }).code = 'worktree_commit_check_failed';
        throw error;
      }
      if (commits > 0) {
        const registeredBranch = getRegisteredWorktreeBranch(repoRoot, wtPath);
        throw unmergedCommitsError({
          workerName,
          path: wtPath,
          branch: registeredBranch && registeredBranch !== 'HEAD' ? registeredBranch : null,
          commits,
        });
      }
    }
    // The safety check above passed, so the only untracked files left are OMC
    // runtime state, which git refuses to drop without --force. A worktree with
    // initialized submodules keeps the plain removal, which refuses it.
    const runtimeOnly = existsSync(wtPath) && isWorktreeDirtyExcept(wtPath, ['AGENTS.md']).runtimeState;
    const force = runtimeOnly && !hasInitializedSubmodules(wtPath);
    try {
      execFileSync('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath], { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
    } catch (err) {
      // A forced removal can fail half way on win32 when a process (a worker's
      // SessionEnd action runner) still has its cwd in the runtime state: git
      // has then already unregistered the worktree, and what is left is a
      // plain directory for the stale-path cleanup below.
      if (wasRegisteredWorktree && (!force || isRegisteredWorktreePath(repoRoot, wtPath))) {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        const error = new Error(`worktree_remove_failed: preserving metadata for registered worker worktree at ${wtPath}${detail}`);
        (error as Error & { code?: string }).code = 'worktree_remove_failed';
        throw error;
      }
      // Unregistered/absent stale paths are best-effort cleanup only.
    }

    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
    } catch { /* ignore */ }

    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
    } catch { /* branch may not exist */ }

    // If a stale plain directory remains and it is not a registered worktree, remove it
    // only after the shared path guard proves it is an OMC team worktree child.
    if (existsSync(wtPath) && !isRegisteredWorktreePath(repoRoot, wtPath)) {
      validateWorktreeRemovalTarget({
        candidatePath: wtPath,
        expectedRoots: [join(getOmcRoot(repoRoot), 'team', sanitizeName(teamName), 'worktrees')],
        mainRepoRoots: [repoRoot],
      });
      if (force) removeRuntimeLeftover(wtPath);
      else rmSync(wtPath, { recursive: true, force: true });
    }

    forgetMetadataUnlocked(repoRoot, teamName, workerName);
  });
}

/** List all worktrees for a team. */
export function listTeamWorktrees(
  teamName: string,
  repoRoot: string
): WorktreeInfo[] {
  return readMetadata(repoRoot, teamName);
}


export function inspectTeamWorktreeCleanupSafety(
  teamName: string,
  repoRoot: string,
): TeamWorktreeCleanupSafety {
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
export function cleanupTeamWorktrees(
  teamName: string,
  repoRoot: string
): CleanupTeamWorktreesResult {
  const safety = inspectTeamWorktreeCleanupSafety(teamName, repoRoot);
  const entries = safety.entries;
  const removed: string[] = [];
  const preserved: Array<{ workerName: string; path: string; reason: string }> = [...safety.blockers];
  const retained: PreservedWorktree[] = [];

  if (preserved.length > 0) {
    return { removed, preserved, retained };
  }

  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
      removed.push(entry.workerName);
    } catch (err) {
      const kept = (err as { preservedWorktree?: PreservedWorktree } | null)?.preservedWorktree;
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
