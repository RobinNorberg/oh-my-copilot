// src/team/git-worktree.ts

/**
 * Git worktree manager for team worker isolation.
 *
 * Each MCP worker gets its own git worktree at:
 *   {repoRoot}/.omcp/worktrees/{team}/{worker}
 * Branch naming: omc-team/{teamName}/{workerName}
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

/** Get branch name for a worker */
function getBranchName(teamName: string, workerName: string): string {
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
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe' }).trim().length > 0;
  } catch {
    return true;
  }
}

/** Get worktree metadata path. */
function getMetadataPath(repoRoot: string, teamName: string): string {
  return join(repoRoot, '.omcp', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}

/** Read worktree metadata */
function readMetadata(repoRoot: string, teamName: string): WorktreeInfo[] {
  const metaPath = getMetadataPath(repoRoot, teamName);
  if (!existsSync(metaPath)) return [];
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    // Log corruption instead of silently returning empty (which would lose all entries)
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[omc] warning: worktrees.json parse error: ${msg}\n`);
    return [];
  }
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
 * Remove a worker's worktree and branch.
 */
export function removeWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string
): void {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);

  // Remove worktree
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

/**
 * Remove all worktrees for a team (cleanup on shutdown).
 */
export function cleanupTeamWorktrees(
  teamName: string,
  repoRoot: string
): void {
  const entries = readMetadata(repoRoot, teamName);
  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
    } catch { /* best effort */ }
  }
}
