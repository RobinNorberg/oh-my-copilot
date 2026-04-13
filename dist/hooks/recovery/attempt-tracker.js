/**
 * Attempt Tracker
 *
 * Persists per-task attempt history for orchestration recovery.
 * Stored in .omcp/state/sessions/{sessionId}/attempt-history.json
 */
import { writeModeState, readModeState } from '../../lib/mode-state-io.js';
import { ORCHESTRATION_RECOVERY_CONFIG } from './types.js';
/**
 * Read attempt history from session state
 */
export function readAttemptHistory(directory, sessionId) {
    return readModeState('attempt-history', directory, sessionId);
}
/**
 * Write attempt history to session state
 */
export function writeAttemptHistory(directory, state, sessionId) {
    return writeModeState('attempt-history', state, directory, sessionId);
}
/**
 * Record an attempt for a task
 */
export function recordAttempt(directory, sessionId, taskId, failureType, errorMessage, actionTaken) {
    let history = readAttemptHistory(directory, sessionId);
    if (!history) {
        history = { attempts: {}, lastUpdated: new Date().toISOString() };
    }
    if (!history.attempts[taskId]) {
        history.attempts[taskId] = [];
    }
    const now = Date.now();
    const cutoff = now - ORCHESTRATION_RECOVERY_CONFIG.rollingWindowMs;
    // Prune old attempts outside rolling window
    history.attempts[taskId] = history.attempts[taskId].filter((a) => new Date(a.timestamp).getTime() > cutoff);
    // Add new attempt
    const truncatedMessage = errorMessage.length > 500
        ? errorMessage.slice(0, 500) + '...'
        : errorMessage;
    history.attempts[taskId].push({
        taskId,
        failureType,
        errorMessage: truncatedMessage,
        timestamp: new Date().toISOString(),
        actionTaken,
    });
    // Cap at max attempts per task
    if (history.attempts[taskId].length > ORCHESTRATION_RECOVERY_CONFIG.maxAttemptsPerTask) {
        history.attempts[taskId] = history.attempts[taskId].slice(-ORCHESTRATION_RECOVERY_CONFIG.maxAttemptsPerTask);
    }
    history.lastUpdated = new Date().toISOString();
    writeAttemptHistory(directory, history, sessionId);
}
/**
 * Get the number of recent attempts for a task (within rolling window)
 */
export function getAttemptCount(directory, sessionId, taskId) {
    const history = readAttemptHistory(directory, sessionId);
    if (!history || !history.attempts[taskId]) {
        return 0;
    }
    const now = Date.now();
    const cutoff = now - ORCHESTRATION_RECOVERY_CONFIG.rollingWindowMs;
    return history.attempts[taskId].filter((a) => new Date(a.timestamp).getTime() > cutoff).length;
}
/**
 * Clear attempt history for a task or all tasks
 */
export function clearAttemptHistory(directory, sessionId, taskId) {
    if (!taskId) {
        writeAttemptHistory(directory, { attempts: {}, lastUpdated: new Date().toISOString() }, sessionId);
        return;
    }
    const history = readAttemptHistory(directory, sessionId);
    if (history && history.attempts[taskId]) {
        delete history.attempts[taskId];
        history.lastUpdated = new Date().toISOString();
        writeAttemptHistory(directory, history, sessionId);
    }
}
//# sourceMappingURL=attempt-tracker.js.map