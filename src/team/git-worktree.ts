// src/team/git-worktree.ts

/**
 * Git worktree manager for team worker isolation.
 *
 * Each MCP worker gets its own git worktree at:
 *   {repoRoot}/.omcp/worktrees/{team}/{worker}
 * Branch naming: omc-team/{teamName}/{workerName}
 */

import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  workerName: string;
  teamName: string;
  createdAt: string;
}

/** Get worktree path for a worker */
function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string {
  return join(repoRoot, '.omcp', 'worktrees', sanitizeName(teamName), sanitizeName(workerName));
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
  preserved: Array<{ workerName: string; path: string; reason: string }>;
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
  return join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees', sanitizeName(workerName));
}

/** Get branch name for a worker. */
export function getBranchName(teamName: string, workerName: string): string {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}

function isRegisteredWorktreePath(repoRoot: string, wtPath: string): boolean {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const resolvedWtPath = wtPath.trim();
    for (const line of output.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      if (line.slice('worktree '.length).trim() === resolvedWtPath) {
        return true;
      }
    }
  } catch {
    // Best-effort check only.
  }
  return false;
}


function isRegisteredWorktreePath(repoRoot: string, wtPath: string): boolean {
  try {
    const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
    const resolvedWtPath = resolve(wtPath);
    return output.split('\n').some(line => (
      line.startsWith('worktree ') && resolve(line.slice('worktree '.length).trim()) === resolvedWtPath
    ));
  } catch {
    return false;
  }
}


function isDetached(wtPath: string): boolean {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
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

function isWorktreeDirtyExcept(wtPath: string, ignoredRootPaths: string[] = []): { dirty: boolean; entries: string[] } {
  try {
    const ignored = new Set(ignoredRootPaths);
    const entries = execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe' })
      .split('\n')
      .filter(line => line.trim().length > 0);
    const relevantEntries = entries.filter(line => !ignored.has(statusEntryPath(line)));
    return { dirty: relevantEntries.length > 0, entries: relevantEntries };
  } catch {
    return { dirty: true, entries: ['git_status_failed'] };
  }
}

/** Get worktree metadata path. */
function getMetadataPath(repoRoot: string, teamName: string): string {
  return join(repoRoot, '.omcp', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}

function getLegacyMetadataPath(repoRoot: string, teamName: string): string {
  return join(repoRoot, '.omc', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}


function getWorkerStateDir(repoRoot: string, teamName: string, workerName: string): string {
  return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'workers', sanitizeName(workerName));
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
  validateResolvedPath(worktreePath, repoRoot);
  const agentsPath = join(worktreePath, 'AGENTS.md');
  validateResolvedPath(agentsPath, repoRoot);
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  validateResolvedPath(backupPath, repoRoot);
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
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  validateResolvedPath(backupPath, repoRoot);
  const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
  if (!backup) return { restored: false, reason: 'no_backup' };

  const resolvedWorktreePath = worktreePath ?? backup.worktreePath;
  validateResolvedPath(resolvedWorktreePath, repoRoot);
  if (!existsSync(resolvedWorktreePath)) {
    try {
      unlinkSync(backupPath);
    } catch { /* backup already gone */ }
    return { restored: false, reason: 'worktree_missing' };
  }

  const agentsPath = join(resolvedWorktreePath, 'AGENTS.md');
  validateResolvedPath(agentsPath, repoRoot);
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
  const workersDir = join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'workers');
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

/** Write worktree metadata */
function writeMetadata(repoRoot: string, teamName: string, entries: WorktreeInfo[]): void {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, repoRoot);
  const dir = join(repoRoot, '.omcp', 'state', 'team-bridge', sanitizeName(teamName));
  ensureDirWithMode(dir);
  atomicWriteJson(metaPath, entries);
}

function recordMetadata(repoRoot: string, teamName: string, info: WorktreeInfo): void {
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== info.workerName);
    writeMetadata(repoRoot, teamName, [...existing, info]);
  });
}

function forgetMetadata(repoRoot: string, teamName: string, workerName: string): void {
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== workerName);
    writeMetadata(repoRoot, teamName, existing);
  });
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

function assertLeaderRepoClean(repoRoot: string): void {
  const status = git(repoRoot, ['status', '--porcelain'])
    .split('\n')
    .filter(line => line.trim() !== '' && !/^\?\? \.omc(?:\/|$)/.test(line))
    .join('\n')
    .trim();
  if (status !== '') {
    const err = new Error('leader_worktree_dirty: refusing to provision team worktrees from a dirty leader repository');
    err.name = 'leader_worktree_dirty';
    throw err;
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
 * Create a git worktree for a team worker.
 * Path: {repoRoot}/.omcp/worktrees/{team}/{worker}
 * Branch: omc-team/{teamName}/{workerName}
 */
export function createWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
  baseBranch?: string
): WorktreeInfo {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);

  validateResolvedPath(wtPath, repoRoot);

  // Prune stale worktrees first
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  // Remove stale worktree if it exists
  if (existsSync(wtPath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot, stdio: 'pipe' });
    } catch {
      if (isRegisteredWorktreePath(repoRoot, wtPath)) {
        throw new Error(
          `Stale worktree still registered at ${wtPath}. ` +
          `Run \`git worktree prune\` or remove it manually before retrying.`,
        );
      }
      rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Delete stale branch if it exists
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* branch doesn't exist, fine */ }

  // Create worktree directory
  const wtDir = join(repoRoot, '.omcp', 'worktrees', sanitizeName(teamName));
  ensureDirWithMode(wtDir);

  // Create worktree with new branch
  const args = ['worktree', 'add', '-b', branch, wtPath];
  if (baseBranch) args.push(baseBranch);
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });

  const info: WorktreeInfo = {
    path: wtPath,
    branch,
    workerName,
    teamName,
    createdAt: new Date().toISOString(),
  };

  // Update metadata (locked to prevent concurrent read-modify-write races)
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName);
    const updated = existing.filter(e => e.workerName !== workerName);
    updated.push(info);
    writeMetadata(repoRoot, teamName, updated);
  });

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

  let ignoreRootAgents = false;
  if (backup) {
    const agentsPath = join(wtPath, 'AGENTS.md');
    validateResolvedPath(agentsPath, repoRoot);
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

/** Remove a worker's worktree and branch, preserving dirty worktrees. */
export function removeWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string
): void {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);

  prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, wtPath);

  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* may not exist */ }

  // Prune to clean up
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  // Delete branch
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* branch may not exist */ }

  // Update metadata (locked to prevent concurrent read-modify-write races)
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName);
    const updated = existing.filter(e => e.workerName !== workerName);
    writeMetadata(repoRoot, teamName, updated);
  });
}

/**
 * List all worktrees for a team.
 */
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

/** Remove all clean worktrees for a team, preserving dirty worktrees. */
export function cleanupTeamWorktrees(
  teamName: string,
  repoRoot: string
): CleanupTeamWorktreesResult {
  const safety = inspectTeamWorktreeCleanupSafety(teamName, repoRoot);
  const entries = safety.entries;
  const removed: string[] = [];
  const preserved: Array<{ workerName: string; path: string; reason: string }> = [...safety.blockers];

  if (preserved.length > 0) {
    return { removed, preserved };
  }

  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
    } catch { /* best effort */ }
  }
}
