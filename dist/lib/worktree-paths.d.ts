/**
 * Worktree Path Enforcement
 *
 * Provides strict path validation and resolution for .omg/ paths,
 * ensuring all operations stay within the worktree boundary.
 *
 * Supports OMC_STATE_DIR environment variable for centralized state storage.
 * When set, state is stored at $OMC_STATE_DIR/{project-identifier}/ instead
 * of {worktree}/.omg/. This preserves state across worktree deletions.
 */
/** Standard .omc subdirectories */
export declare const OmgPaths: {
    readonly ROOT: ".omg";
    readonly STATE: ".omg/state";
    readonly SESSIONS: ".omg/state/sessions";
    readonly PLANS: ".omg/plans";
    readonly RESEARCH: ".omg/research";
    readonly NOTEPAD: ".omg/notepad.md";
    readonly PROJECT_MEMORY: ".omg/project-memory.json";
    readonly DRAFTS: ".omg/drafts";
    readonly NOTEPADS: ".omg/notepads";
    readonly LOGS: ".omg/logs";
    readonly SCIENTIST: ".omg/scientist";
    readonly AUTOPILOT: ".omg/autopilot";
    readonly SKILLS: ".omg/skills";
    readonly SHARED_MEMORY: ".omg/state/shared-memory";
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
 * instead of {worktree}/.omg/. This allows centralized state storage that
 * survives worktree deletion.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the omc root directory
 */
export declare function getOmcRoot(worktreeRoot?: string): string;
/**
 * Resolve a relative path under .omg/ to an absolute path.
 * Validates the path is within the omc boundary.
 *
 * @param relativePath - Path relative to .omg/ (e.g., "state/ralph.json")
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
 * Ensure a directory exists under .omg/.
 * Creates parent directories as needed.
 *
 * @param relativePath - Path relative to .omg/
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the created directory
 */
export declare function ensureOmcDir(relativePath: string, worktreeRoot?: string): string;
/**
 * Get the absolute path to the notepad file.
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes `directory` (required).
 * This version auto-detects worktree root.
 */
export declare function getWorktreeNotepadPath(worktreeRoot?: string): string;
/**
 * Get the absolute path to the project memory file.
 */
export declare function getWorktreeProjectMemoryPath(worktreeRoot?: string): string;
/**
 * Resolve a plan file path.
 * @param planName - Plan name (without .md extension)
 */
export declare function resolvePlanPath(planName: string, worktreeRoot?: string): string;
/**
 * Resolve a research directory path.
 * @param name - Research folder name
 */
export declare function resolveResearchPath(name: string, worktreeRoot?: string): string;
/**
 * Resolve the logs directory path.
 */
export declare function resolveLogsPath(worktreeRoot?: string): string;
/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 * @param planName - Plan name for the scoped notepad
 */
export declare function resolveWisdomPath(planName: string, worktreeRoot?: string): string;
/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export declare function isPathUnderOmc(absolutePath: string, worktreeRoot?: string): boolean;
/**
 * Ensure all standard .omc subdirectories exist.
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
 * This ensures .omg/ state is always written at the worktree root,
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
 * This prevents .omg/state/ from being created in subdirectories (#576).
 *
 * @param workingDirectory - User-supplied working directory
 * @returns The validated worktree root
 * @throws Error if workingDirectory is outside trusted root
 */
export declare function validateWorkingDirectory(workingDirectory?: string): string;
//# sourceMappingURL=worktree-paths.d.ts.map