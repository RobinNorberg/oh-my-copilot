/**
 * Mode Registry Types
 *
 * Defines the supported execution modes and their state file locations.
 */

export type ExecutionMode =
  | 'autopilot'
  | 'team'
  | 'ralph'
  | 'ultrawork'
  | 'ultraqa';

export interface ModeConfig {
  /** Display name for the mode */
  name: string;
  /** Primary state file path (relative to .omg/state/) */
  stateFile: string;
  /** Alternative/marker file path (relative to .omg/state/) */
  markerFile?: string;
  /** Property to check in JSON state (if JSON-based) */
  activeProperty?: string;
  /** Whether state is SQLite-based (requires marker file) */
  isSqlite?: boolean;
  /** Whether mode has global state in ~/.copilot/ */
  hasGlobalState?: boolean;
}

export interface ModeStatus {
  mode: ExecutionMode;
  active: boolean;
  stateFilePath: string;
}

export interface CanStartResult {
  allowed: boolean;
  blockedBy?: ExecutionMode;
  message?: string;
}
