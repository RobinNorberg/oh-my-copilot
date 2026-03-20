/**
 * Orchestration Recovery Manager
 *
 * Classifies orchestration-level failures and determines recovery actions
 * for multi-agent workflows (ralph, ultrawork, team).
 *
 * Integrates with the circular fix detector (Feature 2) for the
 * escalation path when the same error recurs.
 */
import type { OrchestrationFailureType, RecoveryActionResult } from './types.js';
/**
 * Classify an orchestration-level failure from an error message.
 */
export declare function classifyOrchestrationFailure(error: string): OrchestrationFailureType;
/**
 * Determine the recovery action for a given failure.
 *
 * Takes into account:
 * - The failure type classification
 * - Number of previous attempts for this task
 * - Whether a circular fix has been detected (Feature 2 integration)
 *
 * @param taskId - The task identifier
 * @param error - The error message
 * @param attemptCount - Number of previous attempts for this task
 * @param directory - Project directory for circular fix check
 * @param sessionId - Session ID for circular fix check
 */
export declare function determineRecoveryAction(taskId: string, error: string, attemptCount: number, directory?: string, sessionId?: string): RecoveryActionResult;
//# sourceMappingURL=orchestration-recovery.d.ts.map