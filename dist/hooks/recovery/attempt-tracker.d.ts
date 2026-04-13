/**
 * Attempt Tracker
 *
 * Persists per-task attempt history for orchestration recovery.
 * Stored in .omcp/state/sessions/{sessionId}/attempt-history.json
 */
import type { AttemptHistory, OrchestrationFailureType, RecoveryAction } from './types.js';
/**
 * Read attempt history from session state
 */
export declare function readAttemptHistory(directory: string, sessionId?: string): AttemptHistory | null;
/**
 * Write attempt history to session state
 */
export declare function writeAttemptHistory(directory: string, state: AttemptHistory, sessionId?: string): boolean;
/**
 * Record an attempt for a task
 */
export declare function recordAttempt(directory: string, sessionId: string, taskId: string, failureType: OrchestrationFailureType, errorMessage: string, actionTaken: RecoveryAction): void;
/**
 * Get the number of recent attempts for a task (within rolling window)
 */
export declare function getAttemptCount(directory: string, sessionId: string, taskId: string): number;
/**
 * Clear attempt history for a task or all tasks
 */
export declare function clearAttemptHistory(directory: string, sessionId: string, taskId?: string): void;
//# sourceMappingURL=attempt-tracker.d.ts.map