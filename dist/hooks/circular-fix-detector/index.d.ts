/**
 * Circular Fix Detector
 *
 * Tracks error patterns across QA iterations and detects when the same
 * error recurs 3+ times (circular fix). When detected, generates a
 * structured escalation report instead of continuing to retry.
 *
 * Error history stored in .omc/state/sessions/{sessionId}/error-history.json
 */
import type { CircularFixState } from './types.js';
export type { ErrorRecord, CircularFixState } from './types.js';
export { CIRCULAR_FIX_CONFIG } from './types.js';
/**
 * Simple hash function (djb2 algorithm).
 * Produces a consistent base36 hash from a normalized error string.
 *
 * Adapted from Aperant's recovery-manager.ts simpleHash().
 */
export declare function simpleHash(input: string): string;
/**
 * Read error history from session state
 */
export declare function readErrorHistory(directory: string, sessionId?: string): CircularFixState | null;
/**
 * Write error history to session state
 */
export declare function writeErrorHistory(directory: string, state: CircularFixState, sessionId?: string): boolean;
/**
 * Record an error occurrence for a task.
 * Automatically prunes old errors outside the rolling window.
 */
export declare function recordError(directory: string, sessionId: string, taskId: string, errorMessage: string): void;
/**
 * Check if a circular fix has been detected for a task.
 * Returns true if the same error hash appears >= threshold times
 * within the rolling window.
 */
export declare function isCircularFix(directory: string, sessionId: string, taskId: string): boolean;
/**
 * Generate a structured escalation report for a circular fix.
 * Returns markdown-formatted report.
 */
export declare function getEscalationReport(directory: string, sessionId: string, taskId: string): string;
/**
 * Clear error history for a task or all tasks.
 */
export declare function clearErrorHistory(directory: string, sessionId: string, taskId?: string): void;
//# sourceMappingURL=index.d.ts.map