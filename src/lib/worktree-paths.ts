/**
 * Worktree Path Enforcement
 *
 * Provides strict path validation and resolution for .omcp/ paths,
 * ensuring all operations stay within the worktree boundary.
 *
 * Supports OMC_STATE_DIR environment variable for centralized state storage.
 * When set, state is stored at $OMC_STATE_DIR/{project-identifier}/ instead
 * of {worktree}/.omcp/. This preserves state across worktree deletions.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, readdirSync, renameSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { resolve, normalize, relative, sep, join, isAbsolute, basename, dirname } from 'path';
import { getCopilotConfigDir } from '../utils/config-dir.js';

/** Standard .omcp subdirectories (formerly .omg) */
export const OmgPaths = {
  ROOT: '.omcp',
  STATE: '.omcp/state',
  SESSIONS: '.omcp/state/sessions',
  PLANS: '.omcp/plans',
  RESEARCH: '.omcp/research',
  NOTEPAD: '.omcp/notepad.md',
  PROJECT_MEMORY: '.omcp/project-memory.json',
  DRAFTS: '.omcp/drafts',
  NOTEPADS: '.omcp/notepads',
  LOGS: '.omcp/logs',
  SCIENTIST: '.omcp/scientist',
  AUTOPILOT: '.omcp/autopilot',
  SKILLS: '.omcp/skills',
  SHARED_MEMORY: '.omcp/state/shared-memory',
} as const;

/**
 * LRU cache for worktree root lookups to avoid repeated git subprocess calls.
 * Bounded to MAX_WORKTREE_CACHE_SIZE entries to prevent memory growth when
 * alternating between many different cwds (cache thrashing).
 */
const MAX_WORKTREE_CACHE_SIZE = 8;
const worktreeCacheMap = new Map<string, string>();

/**
 * Get the git worktree root for the current or specified directory.
 * Returns null if not in a git repository.
 */
export function getWorktreeRoot(cwd?: string): string | null {
  const effectiveCwd = cwd || process.cwd();

  // Return cached value if present (LRU: move to end on access)
  if (worktreeCacheMap.has(effectiveCwd)) {
    const root = worktreeCacheMap.get(effectiveCwd)!;
    // Refresh insertion order for LRU eviction
    worktreeCacheMap.delete(effectiveCwd);
    worktreeCacheMap.set(effectiveCwd, root);
    return root || null;
  }

  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();

    // Evict oldest entry when at capacity
    if (worktreeCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = worktreeCacheMap.keys().next().value;
      if (oldest !== undefined) {
        worktreeCacheMap.delete(oldest);
      }
    }
    worktreeCacheMap.set(effectiveCwd, root);
    return root;
  } catch {
    // Not in a git repository - do NOT cache fallback
    // so that if directory becomes a git repo later, we re-detect
    return null;
  }
}

/**
 * Validate that a path is safe (no traversal attacks).
 *
 * @throws Error if path contains traversal sequences
 */
export function validatePath(inputPath: string): void {
  // Reject explicit path traversal
  if (inputPath.includes('..')) {
    throw new Error(`Invalid path: path traversal not allowed (${inputPath})`);
  }

  // Reject absolute paths - use isAbsolute() for cross-platform coverage
  // Covers: /unix, ~/home, C:\windows, D:/windows, \\UNC
  if (inputPath.startsWith('~') || isAbsolute(inputPath)) {
    throw new Error(`Invalid path: absolute paths not allowed (${inputPath})`);
  }
}

// ============================================================================
// OMC_STATE_DIR SUPPORT (Issue #1014)
// ============================================================================

/** Track which dual-dir warnings have been logged to avoid repeated warnings */
const dualDirWarnings = new Set<string>();

/** Track which .omg migration warnings have been logged */
const omgMigrationWarnings = new Set<string>();

/**
 * Migrate a legacy .omg/ directory to .omcp/.
 *
 * If .omg/ exists and .omcp/ does not, renames .omg/ → .omcp/ in place.
 * If both exist, logs a warning and uses .omcp/.
 * If only .omcp/ exists (or neither), no action taken.
 *
 * @param worktreeRoot - The worktree root directory
 * @returns true if migration was performed, false otherwise
 */
export function migrateOmgToOmcp(worktreeRoot: string): boolean {
  const legacyPath = join(worktreeRoot, '.omg');
  const newPath = join(worktreeRoot, '.omcp');

  if (!existsSync(legacyPath)) {
    return false;
  }

  if (existsSync(newPath)) {
    // Both exist — warn once
    if (!omgMigrationWarnings.has(worktreeRoot)) {
      omgMigrationWarnings.add(worktreeRoot);
      console.warn(
        `[omg] Both .omg/ and .omcp/ exist in ${worktreeRoot}. ` +
        `Using .omcp/. Remove .omg/ manually after verifying no data loss.`
      );
    }
    return false;
  }

  // .omg/ exists, .omcp/ does not — migrate
  try {
    renameSync(legacyPath, newPath);
    console.log(`[omg] Migrated state directory: .omg/ → .omcp/ in ${worktreeRoot}`);
    return true;
  } catch (err) {
    console.warn(
      `[omg] Failed to migrate .omg/ → .omcp/ in ${worktreeRoot}: ${err instanceof Error ? err.message : err}. ` +
      `Rename manually: mv .omg .omcp`
    );
    return false;
  }
}

/**
 * Clear the dual-directory warning cache (useful for testing).
 * @internal
 */
export function clearDualDirWarnings(): void {
  dualDirWarnings.clear();
}

/**
 * Get a stable project identifier for centralized state storage.
 *
 * Uses a hybrid strategy:
 * 1. Git remote URL hash (stable across worktrees and clones of the same repo)
 * 2. Fallback to worktree root path hash (for local-only repos without remotes)
 *
 * Format: `{dirName}-{hash}` where hash is first 16 chars of SHA-256.
 * Example: `my-project-a1b2c3d4e5f6g7h8`
 *
 * @param worktreeRoot - Optional worktree root path
 * @returns A stable project identifier string
 */
export function getProjectIdentifier(worktreeRoot?: string): string {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();

  let source: string;
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    source = remoteUrl || root;
  } catch {
    // No git remote (local-only repo or not a git repo) — use path
    source = root;
  }

  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dirName = basename(root).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${dirName}-${hash}`;
}

/**
 * Get the .omc root directory path.
 *
 * When OMC_STATE_DIR is set, returns $OMC_STATE_DIR/{project-identifier}/
 * instead of {worktree}/.omcp/. This allows centralized state storage that
 * survives worktree deletion.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the omc root directory
 */
export function getOmcRoot(worktreeRoot?: string): string {
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    const root = worktreeRoot || getWorktreeRoot() || process.cwd();
    const projectId = getProjectIdentifier(root);
    const centralizedPath = join(customDir, projectId);

    // Log notice if both legacy .omcp/ and new centralized dir exist
    const legacyPath = join(root, OmgPaths.ROOT);
    const warningKey = `${legacyPath}:${centralizedPath}`;
    if (!dualDirWarnings.has(warningKey) && existsSync(legacyPath) && existsSync(centralizedPath)) {
      dualDirWarnings.add(warningKey);
      console.warn(
        `[omg] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. ` +
        `Using centralized dir. Consider migrating data from the legacy dir and removing it.`
      );
    }

    return centralizedPath;
  }
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();

  // Auto-migrate legacy .omg/ → .omcp/ if needed
  migrateOmgToOmcp(root);

  return join(root, OmgPaths.ROOT);
}

/**
 * Resolve a relative path under .omcp/ to an absolute path.
 * Validates the path is within the omc boundary.
 *
 * @param relativePath - Path relative to .omcp/ (e.g., "state/ralph.json")
 * @param worktreeRoot - Optional worktree root (auto-detected if not provided)
 * @returns Absolute path
 * @throws Error if path would escape omc boundary
 */
export function resolveOmcPath(relativePath: string, worktreeRoot?: string): string {
  validatePath(relativePath);

  const omcDir = getOmcRoot(worktreeRoot);
  const fullPath = normalize(resolve(omcDir, relativePath));

  // Verify resolved path is still under omc directory
  const relativeToOmc = relative(omcDir, fullPath);
  if (relativeToOmc.startsWith('..') || relativeToOmc.startsWith(sep + '..')) {
    throw new Error(`Path escapes omc boundary: ${relativePath}`);
  }

  return fullPath;
}

/**
 * Resolve a state file path.
 *
 * State files follow the naming convention: {mode}-state.json
 * Examples: ralph-state.json, ultrawork-state.json, autopilot-state.json
 *
 * @param stateName - State name (e.g., "ralph", "ultrawork", or "ralph-state")
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to state file
 */
export function resolveStatePath(stateName: string, worktreeRoot?: string): string {
  // Normalize: ensure -state suffix is present, then add .json
  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  return resolveOmcPath(`state/${normalizedName}.json`, worktreeRoot);
}

/**
 * Ensure a directory exists under .omcp/.
 * Creates parent directories as needed.
 *
 * @param relativePath - Path relative to .omcp/
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the created directory
 */
export function ensureOmcDir(relativePath: string, worktreeRoot?: string): string {
  const fullPath = resolveOmcPath(relativePath, worktreeRoot);

  if (!existsSync(fullPath)) {
    try {
      mkdirSync(fullPath, { recursive: true });
    } catch (err) {
      // On Windows, concurrent hooks can race past the existsSync check and
      // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  return fullPath;
}

/**
 * Get the absolute path to the notepad file.
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes `directory` (required).
 * This version auto-detects worktree root.
 */
export function getWorktreeNotepadPath(worktreeRoot?: string): string {
  return join(getOmcRoot(worktreeRoot), 'notepad.md');
}

/**
 * Get the absolute path to the project memory file.
 */
export function getWorktreeProjectMemoryPath(worktreeRoot?: string): string {
  return join(getOmcRoot(worktreeRoot), 'project-memory.json');
}

/**
 * Resolve a plan file path.
 * @param planName - Plan name (without .md extension)
 */
export function resolvePlanPath(planName: string, worktreeRoot?: string): string {
  validatePath(planName);
  return join(getOmcRoot(worktreeRoot), 'plans', `${planName}.md`);
}

/**
 * Resolve a research directory path.
 * @param name - Research folder name
 */
export function resolveResearchPath(name: string, worktreeRoot?: string): string {
  validatePath(name);
  return join(getOmcRoot(worktreeRoot), 'research', name);
}

/**
 * Resolve the logs directory path.
 */
export function resolveLogsPath(worktreeRoot?: string): string {
  return join(getOmcRoot(worktreeRoot), 'logs');
}

/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 * @param planName - Plan name for the scoped notepad
 */
export function resolveWisdomPath(planName: string, worktreeRoot?: string): string {
  validatePath(planName);
  return join(getOmcRoot(worktreeRoot), 'notepads', planName);
}

/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export function isPathUnderOmc(absolutePath: string, worktreeRoot?: string): boolean {
  const omcRoot = getOmcRoot(worktreeRoot);
  const normalizedPath = normalize(absolutePath);
  const normalizedOmc = normalize(omcRoot);
  return normalizedPath.startsWith(normalizedOmc + sep) || normalizedPath === normalizedOmc;
}

/**
 * Ensure all standard .omc subdirectories exist.
 */
export function ensureAllOmcDirs(worktreeRoot?: string): void {
  const omcRoot = getOmcRoot(worktreeRoot);
  const subdirs = ['', 'state', 'plans', 'research', 'logs', 'notepads', 'drafts'];
  for (const subdir of subdirs) {
    const fullPath = subdir ? join(omcRoot, subdir) : omcRoot;
    if (!existsSync(fullPath)) {
      try {
        mkdirSync(fullPath, { recursive: true });
      } catch (err) {
        // On Windows, concurrent hooks can race past the existsSync check and
        // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
}

/**
 * Clear the worktree cache (useful for testing).
 */
export function clearWorktreeCache(): void {
  worktreeCacheMap.clear();
}

// ============================================================================
// SESSION-SCOPED STATE PATHS
// ============================================================================

/** Regex for valid session IDs: alphanumeric, hyphens, underscores, max 256 chars */
const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

// ============================================================================
// AUTOMATIC PROCESS SESSION ID (Issue #456)
// ============================================================================

/**
 * Auto-generated session ID for the current process.
 * Uses PID + process start timestamp to be unique even if PIDs are reused.
 * Generated once at module load time and stable for the process lifetime.
 */
let processSessionId: string | null = null;

/**
 * Get or generate a unique session ID for the current process.
 *
 * Format: `pid-{PID}-{startTimestamp}`
 * Example: `pid-12345-1707350400000`
 *
 * This prevents concurrent Copilot CLI instances in the same repo from
 * sharing state files (Issue #456). The ID is stable for the process
 * lifetime and unique across concurrent processes.
 *
 * @returns A unique session ID for the current process
 */
export function getProcessSessionId(): string {
  if (!processSessionId) {
    // process.pid is unique among concurrent processes.
    // Adding a timestamp handles PID reuse after process exit.
    const pid = process.pid;
    const startTime = Date.now();
    processSessionId = `pid-${pid}-${startTime}`;
  }
  return processSessionId;
}

/**
 * Reset the process session ID (for testing only).
 * @internal
 */
export function resetProcessSessionId(): void {
  processSessionId = null;
}

/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if session ID is invalid
 */
export function validateSessionId(sessionId: string): void {
  if (!sessionId) {
    throw new Error('Session ID cannot be empty');
  }
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new Error(`Invalid session ID: path traversal not allowed (${sessionId})`);
  }
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(`Invalid session ID: must be alphanumeric with hyphens/underscores, max 256 chars (${sessionId})`);
  }
}

/**
 * Validate a transcript path to prevent arbitrary file reads.
 * Transcript files should only be read from known Copilot directories.
 *
 * @param transcriptPath - The transcript path to validate
 * @returns true if path is valid, false otherwise
 */
export function isValidTranscriptPath(transcriptPath: string): boolean {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return false;
  }

  // Reject path traversal
  if (transcriptPath.includes('..')) {
    return false;
  }

  // Must be absolute
  if (!isAbsolute(transcriptPath) && !transcriptPath.startsWith('~')) {
    return false;
  }

  // Expand home directory if present
  let expandedPath = transcriptPath;
  if (transcriptPath.startsWith('~')) {
    expandedPath = join(homedir(), transcriptPath.slice(1));
  }

  // Normalize and check it's within allowed directories
  const normalized = normalize(expandedPath);
  const home = homedir();

  // Allowed: ~/.copilot/..., ~/.omcp/..., /tmp/..., os.tmpdir() (cross-platform)
  // Allowed: [$COPILOT_CONFIG_DIR|~/.copilot], ~/.omcp/..., /tmp/...
  const allowedPrefixes = [
    getCopilotConfigDir(),
    join(home, '.omcp'),
    '/tmp',
    '/var/folders', // macOS temp
    tmpdir(),       // cross-platform: covers Windows %TEMP%, macOS /var/folders, Linux /tmp
  ];

  return allowedPrefixes.some((prefix) => {
    const rel = relative(prefix, normalized);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}


/**
 * Resolve a session-scoped state file path.
 * Path: {omcRoot}/state/sessions/{sessionId}/{mode}-state.json
 *
 * @param stateName - State name (e.g., "ralph", "ultrawork")
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session-scoped state file
 */
export function resolveSessionStatePath(stateName: string, sessionId: string, worktreeRoot?: string): string {
  validateSessionId(sessionId);

  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  return resolveOmcPath(`state/sessions/${sessionId}/${normalizedName}.json`, worktreeRoot);
}

/**
 * Get the session state directory path.
 * Path: {omcRoot}/state/sessions/{sessionId}/
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session state directory
 */
export function getSessionStateDir(sessionId: string, worktreeRoot?: string): string {
  validateSessionId(sessionId);
  return join(getOmcRoot(worktreeRoot), 'state', 'sessions', sessionId);
}

/**
 * List all session IDs that have state directories.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Array of session IDs
 */
export function listSessionIds(worktreeRoot?: string): string[] {
  const sessionsDir = join(getOmcRoot(worktreeRoot), 'state', 'sessions');

  if (!existsSync(sessionsDir)) {
    return [];
  }

  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && SESSION_ID_REGEX.test(entry.name))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * Ensure the session state directory exists.
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the session state directory
 */
export function ensureSessionStateDir(sessionId: string, worktreeRoot?: string): string {
  const sessionDir = getSessionStateDir(sessionId, worktreeRoot);

  if (!existsSync(sessionDir)) {
    try {
      mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      // On Windows, concurrent hooks can race past the existsSync check and
      // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  return sessionDir;
}

/**
 * Resolve a directory path to its git worktree root.
 *
 * Walks up from `directory` using `git rev-parse --show-toplevel`.
 * Falls back to `getWorktreeRoot(process.cwd())`, then `process.cwd()`.
 *
 * This ensures .omcp/ state is always written at the worktree root,
 * even when called from a subdirectory (fixes #576).
 *
 * @param directory - Any directory inside a git worktree (optional)
 * @returns The worktree root (never a subdirectory)
 */
export function resolveToWorktreeRoot(directory?: string): string {
  if (directory) {
    const resolved = resolve(directory);
    const root = getWorktreeRoot(resolved);
    if (root) return root;

    console.error('[worktree] non-git directory provided, falling back to process root', {
      directory: resolved,
    });
  }
  // Fallback: derive from process CWD (the MCP server / CLI entry point)
  return getWorktreeRoot(process.cwd()) || process.cwd();
}

// ============================================================================
// TRANSCRIPT PATH RESOLUTION (Issue #1094)
// ============================================================================

/**
 * Resolve a Copilot CLI transcript path that may be mismatched in worktree sessions.
 *
 * When Copilot CLI runs inside a worktree (.copilot/worktrees/X), it encodes the
 * worktree CWD into the project directory path, creating a transcript_path like:
 *   ~/.copilot/projects/-path-to-project--copilot-worktrees-X/<session>.jsonl
 *
 * But the actual transcript lives at the original project's path:
 *   ~/.copilot/projects/-path-to-project/<session>.jsonl
 *
 * Copilot CLI encodes `/` as `-` (dots are preserved). The `.copilot/worktrees/`
 * segment becomes `-copilot-worktrees-`, preceded by a `-` from the path
 * separator, yielding the distinctive `--copilot-worktrees-` pattern in the
 * encoded directory name.
 *
 * This function detects the mismatch and resolves to the correct path.
 *
 * @param transcriptPath - The transcript_path from Copilot CLI hook input
 * @param cwd - Optional CWD for fallback detection
 * @returns The resolved transcript path (original if already correct or no resolution found)
 */
export function resolveTranscriptPath(transcriptPath: string | undefined, cwd?: string): string | undefined {
  if (!transcriptPath) return undefined;

  // Fast path: if the file already exists, no resolution needed
  if (existsSync(transcriptPath)) return transcriptPath;

  // Strategy 1: Detect worktree-encoded segment in the transcript path itself.
  // The pattern `--copilot-worktrees-` appears when Copilot CLI encodes a CWD
  // containing `/.copilot/worktrees/` (separator `/` → `-`, dot `.` → `-`).
  // Strip everything from this pattern to the next `/` to recover the original
  // project directory encoding.
  const worktreeSegmentPattern = /--copilot-worktrees-[^/\\]+/;
  if (worktreeSegmentPattern.test(transcriptPath)) {
    const resolved = transcriptPath.replace(worktreeSegmentPattern, '');
    if (existsSync(resolved)) return resolved;
  }

  // Strategy 2: Use CWD to detect worktree and reconstruct the path.
  // When the CWD contains `/.copilot/worktrees/`, we can derive the main
  // project root and look for the transcript there.
  const effectiveCwd = cwd || process.cwd();
  const worktreeMarker = '.copilot/worktrees/';
  const markerIdx = effectiveCwd.indexOf(worktreeMarker);
  if (markerIdx !== -1) {
    // Adjust index to exclude the preceding path separator
    const mainProjectRoot = effectiveCwd.substring(
      0,
      markerIdx > 0 && effectiveCwd[markerIdx - 1] === sep ? markerIdx - 1 : markerIdx,
    );

    // Extract session filename from the original path
    const lastSep = Math.max(transcriptPath.lastIndexOf('/'), transcriptPath.lastIndexOf('\\'));
    const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
    if (sessionFile) {
      // The projects directory is under the Copilot config dir
      const projectsDir = join(getCopilotConfigDir(), 'projects');

      if (existsSync(projectsDir)) {
        // Encode the main project root the same way Copilot CLI does:
        // replace path separators with `-`, replace dots with `-`.
        // Also replace `:` for Windows drive letters (e.g. C: → C-).
        const encodedMain = mainProjectRoot.replace(/[/\\:]/g, '-');
        const resolvedPath = join(projectsDir, encodedMain, sessionFile);
        if (existsSync(resolvedPath)) return resolvedPath;
      }
    }
  }

  // Strategy 3: Detect native git worktree via git-common-dir.
  // When CWD is a linked worktree (created by `git worktree add`), the
  // transcript path encodes the worktree CWD, but the file lives under
  // the main repo's encoded path. Use `git rev-parse --git-common-dir`
  // to find the main repo root and re-encode.
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const absoluteCommonDir = resolve(effectiveCwd, gitCommonDir);
    // For linked worktrees, git-common-dir is <repo>/.git/worktrees/<name>
    // so dirname gives <repo>/.git/worktrees — navigate up to the actual repo root
    let mainRepoRoot = dirname(absoluteCommonDir);
    if (mainRepoRoot.endsWith(join('.git', 'worktrees'))) {
      mainRepoRoot = dirname(dirname(mainRepoRoot));
    }
    // Resolve symlinks for consistent comparison (e.g. /tmp -> /private/tmp on macOS,
    // ecryptfs $HOME on Linux, autofs /home, etc.)
    try { mainRepoRoot = realpathSync(mainRepoRoot); } catch { /* keep as-is */ }

    const worktreeTop = execSync('git rev-parse --show-toplevel', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (mainRepoRoot !== worktreeTop) {
      const lastSep = Math.max(transcriptPath.lastIndexOf('/'), transcriptPath.lastIndexOf('\\'));
      const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
      if (sessionFile) {
        const projectsDir = join(getCopilotConfigDir(), 'projects');
        if (existsSync(projectsDir)) {
          const encodedMain = mainRepoRoot.replace(/[/\\:]/g, '-');
          const resolvedPath = join(projectsDir, encodedMain, sessionFile);
          if (existsSync(resolvedPath)) return resolvedPath;
        }
      }
    }
  } catch {
    // Not in a git repo or git not available — skip
  }

  // No resolution found — return original path.
  // Callers should handle non-existent paths gracefully.
  return transcriptPath;
}

/**
 * Validate that a workingDirectory is within the trusted worktree root.
 * The trusted root is derived from process.cwd(), NOT from user input.
 *
 * Always returns a git worktree root — never a subdirectory.
 * This prevents .omcp/state/ from being created in subdirectories (#576).
 *
 * @param workingDirectory - User-supplied working directory
 * @returns The validated worktree root
 * @throws Error if workingDirectory is outside trusted root
 */
export function validateWorkingDirectory(workingDirectory?: string): string {
  const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();

  if (!workingDirectory) {
    return trustedRoot;
  }

  // Resolve to absolute
  const resolved = resolve(workingDirectory);

  let trustedRootReal: string;
  try {
    trustedRootReal = realpathSync(trustedRoot);
  } catch {
    trustedRootReal = trustedRoot;
  }

  // Try to resolve the provided directory to a git worktree root.
  const providedRoot = getWorktreeRoot(resolved);

  if (providedRoot) {
    // Git resolution succeeded — require exact worktree identity.
    let providedRootReal: string;
    try {
      providedRootReal = realpathSync(providedRoot);
    } catch {
      throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
    }

    if (providedRootReal !== trustedRootReal) {
      console.error('[worktree] workingDirectory resolved to different git worktree root, using trusted root', {
        workingDirectory: resolved,
        providedRoot: providedRootReal,
        trustedRoot: trustedRootReal,
      });
      return trustedRoot;
    }

    return providedRoot;
  }

  // Git resolution failed (lock contention, env issues, non-repo dir).
  // Validate that the raw directory is under the trusted root before falling
  // back — otherwise reject it as truly outside (#576).
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch {
    throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
  }

  const rel = relative(trustedRootReal, resolvedReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workingDirectory '${workingDirectory}' is outside the trusted worktree root '${trustedRoot}'.`);
  }

  // Directory is under trusted root but git failed — return trusted root,
  // never the subdirectory, to prevent .omcp/ creation in subdirs (#576).
  return trustedRoot;
}
