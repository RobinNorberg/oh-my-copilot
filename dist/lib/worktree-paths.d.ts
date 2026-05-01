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
/**
 * Standard .omcp subdirectories (formerly .omg).
 *
 * Two roots are exposed:
 * - ROOT (`.omcp`): plugin-private state owned by oh-my-copilot. Mode-state
 *   files, sessions, autoresearch outputs, logs — anything coupled to this
 *   plugin's runtime stays here so concurrent runs of oh-my-claudecode can't
 *   corrupt them.
 * - SHARED_ROOT (`.omc`): cross-plugin content shared with oh-my-claudecode.
 *   Notepad, project memory, plans, research, plan-scoped notepads. Format-
 *   stable, runtime-agnostic, and intentionally readable by either plugin.
 *
 * See migrateOmcpContentToOmc() for the one-time relocation that moves
 * pre-existing shared content from `.omcp/` into `.omc/`.
 */
export declare const OmgPaths: {
    readonly ROOT: ".omcp";
    readonly SHARED_ROOT: ".omc";
    readonly STATE: ".omcp/state";
    readonly SESSIONS: ".omcp/state/sessions";
    readonly PLANS: ".omc/plans";
    readonly RESEARCH: ".omc/research";
    readonly NOTEPAD: ".omc/notepad.md";
    readonly PROJECT_MEMORY: ".omc/project-memory.json";
    readonly DRAFTS: ".omcp/drafts";
    readonly NOTEPADS: ".omc/notepads";
    readonly LOGS: ".omcp/logs";
    readonly SCIENTIST: ".omcp/scientist";
    readonly AUTOPILOT: ".omcp/autopilot";
    readonly SKILLS: ".omcp/skills";
    readonly SHARED_MEMORY: ".omcp/state/shared-memory";
};
/**
 * Get the git worktree root for the current or specified directory.
 * Returns null if not in a git repository.
 */
export declare function getWorktreeRoot(cwd?: string): string | null;
/**
 * Validate that a path is safe (no traversal attacks).
 *
 * @throws Error if path contains traversal sequences
 */
export declare function validatePath(inputPath: string): void;
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
export declare function migrateOmgToOmcp(worktreeRoot: string): boolean;
/**
 * Clear the dual-directory warning cache (useful for testing).
 * @internal
 */
export declare function clearDualDirWarnings(): void;
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
export declare function getProjectIdentifier(worktreeRoot?: string): string;
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
export declare function getOmcRoot(worktreeRoot?: string): string;
/**
 * Get the cross-plugin shared content root.
 *
 * This is the directory shared with oh-my-claudecode for content that is
 * meaningfully runtime-agnostic: notepad, project memory, plans, research,
 * plan-scoped notepads. Always resolves to `<worktree>/.omc/` (or the
 * centralized equivalent under `OMC_STATE_DIR`) regardless of which plugin
 * is calling, so a plan written in one CLI is visible to the other.
 *
 * Plugin-private state (mode-state.json, sessions/, autoresearch/, logs/)
 * stays under getOmcRoot() to avoid cross-plugin runtime contention.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the shared content root
 */
export declare function getSharedOmcRoot(worktreeRoot?: string): string;
/**
 * One-time relocation of shared content from `.omcp/` to `.omc/`.
 *
 * Mirrors the pattern of migrateOmgToOmcp(). For each item in:
 *   - notepad.md, project-memory.json
 *   - plans/, research/, notepads/
 * if the source exists under `.omcp/` and the corresponding target under
 * `.omc/` does not, move it. Conflicts (both exist) keep the `.omc/` copy
 * and warn once. Idempotent — repeated calls are no-ops.
 *
 * Skipped when `OMC_STATE_DIR` is set (no `.omcp/` to migrate from in the
 * centralized layout for this PR; centralized-mode reshuffling will be
 * handled in a follow-up if needed).
 *
 * @param worktreeRoot - The worktree root directory
 * @returns true if any item was moved, false otherwise
 */
export declare function migrateOmcpContentToOmc(worktreeRoot: string): boolean;
/**
 * Clear the omcp→omc content migration warning cache (testing only).
 * @internal
 */
export declare function clearOmcpContentWarnings(): void;
/**
 * Resolve a relative path under .omcp/ to an absolute path.
 * Validates the path is within the omc boundary.
 *
 * @param relativePath - Path relative to .omcp/ (e.g., "state/ralph.json")
 * @param worktreeRoot - Optional worktree root (auto-detected if not provided)
 * @returns Absolute path
 * @throws Error if path would escape omc boundary
 */
export declare function resolveOmcPath(relativePath: string, worktreeRoot?: string): string;
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
export declare function resolveStatePath(stateName: string, worktreeRoot?: string): string;
/**
 * Ensure a directory exists under .omcp/.
 * Creates parent directories as needed.
 *
 * @param relativePath - Path relative to .omcp/
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the created directory
 */
export declare function ensureOmcDir(relativePath: string, worktreeRoot?: string): string;
/**
 * Get the absolute path to the notepad file.
 *
 * Lives under the cross-plugin shared root (`.omc/`) so the notepad
 * compounds across oh-my-copilot and oh-my-claudecode sessions in the
 * same worktree.
 *
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes
 * `directory` (required). This version auto-detects worktree root.
 */
export declare function getWorktreeNotepadPath(worktreeRoot?: string): string;
/**
 * Get the absolute path to the project memory file.
 *
 * Lives under the cross-plugin shared root (`.omc/`) so the detected
 * tech stack and conventions are shared with oh-my-claudecode.
 */
export declare function getWorktreeProjectMemoryPath(worktreeRoot?: string): string;
/**
 * Resolve a plan file path.
 *
 * Plans live under the cross-plugin shared root (`.omc/plans/`). A plan
 * authored by either CLI is visible to the other.
 *
 * @param planName - Plan name (without .md extension)
 */
export declare function resolvePlanPath(planName: string, worktreeRoot?: string): string;
/**
 * Resolve a research directory path.
 *
 * Research artifacts live under the cross-plugin shared root
 * (`.omc/research/`).
 *
 * @param name - Research folder name
 */
export declare function resolveResearchPath(name: string, worktreeRoot?: string): string;
/**
 * Resolve the logs directory path.
 */
export declare function resolveLogsPath(worktreeRoot?: string): string;
/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 *
 * Plan-scoped notepads live under the cross-plugin shared root
 * (`.omc/notepads/`) alongside the plan they annotate.
 *
 * @param planName - Plan name for the scoped notepad
 */
export declare function resolveWisdomPath(planName: string, worktreeRoot?: string): string;
/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export declare function isPathUnderOmc(absolutePath: string, worktreeRoot?: string): boolean;
/**
 * Ensure all standard OMC subdirectories exist.
 *
 * Creates entries under both roots:
 * - Private (`.omcp/`): state, logs, drafts — runtime-coupled
 * - Shared (`.omc/`): plans, research, notepads — cross-plugin content
 */
export declare function ensureAllOmcDirs(worktreeRoot?: string): void;
/**
 * Clear the worktree cache (useful for testing).
 */
export declare function clearWorktreeCache(): void;
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
export declare function getProcessSessionId(): string;
/**
 * Reset the process session ID (for testing only).
 * @internal
 */
export declare function resetProcessSessionId(): void;
/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if session ID is invalid
 */
export declare function validateSessionId(sessionId: string): void;
/**
 * Validate a transcript path to prevent arbitrary file reads.
 * Transcript files should only be read from known Copilot directories.
 *
 * @param transcriptPath - The transcript path to validate
 * @returns true if path is valid, false otherwise
 */
export declare function isValidTranscriptPath(transcriptPath: string): boolean;
/**
 * Resolve a session-scoped state file path.
 * Path: {omcRoot}/state/sessions/{sessionId}/{mode}-state.json
 *
 * @param stateName - State name (e.g., "ralph", "ultrawork")
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session-scoped state file
 */
export declare function resolveSessionStatePath(stateName: string, sessionId: string, worktreeRoot?: string): string;
/**
 * Get the session state directory path.
 * Path: {omcRoot}/state/sessions/{sessionId}/
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session state directory
 */
export declare function getSessionStateDir(sessionId: string, worktreeRoot?: string): string;
/**
 * List all session IDs that have state directories.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Array of session IDs
 */
export declare function listSessionIds(worktreeRoot?: string): string[];
/**
 * Ensure the session state directory exists.
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the session state directory
 */
export declare function ensureSessionStateDir(sessionId: string, worktreeRoot?: string): string;
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
export declare function resolveToWorktreeRoot(directory?: string): string;
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
export declare function resolveTranscriptPath(transcriptPath: string | undefined, cwd?: string): string | undefined;
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
export declare function validateWorkingDirectory(workingDirectory?: string): string;
//# sourceMappingURL=worktree-paths.d.ts.map