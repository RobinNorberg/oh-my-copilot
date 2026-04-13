/**
 * Circular Fix Detector
 *
 * Tracks error patterns across QA iterations and detects when the same
 * error recurs 3+ times (circular fix). When detected, generates a
 * structured escalation report instead of continuing to retry.
 *
 * Error history stored in .omcp/state/sessions/{sessionId}/error-history.json
 */
import { writeModeState, readModeState } from '../../lib/mode-state-io.js';
import { CIRCULAR_FIX_CONFIG } from './types.js';
export { CIRCULAR_FIX_CONFIG } from './types.js';
/**
 * Simple hash function (djb2 algorithm).
 * Produces a consistent base36 hash from a normalized error string.
 *
 * Adapted from Aperant's recovery-manager.ts simpleHash().
 */
export function simpleHash(input) {
    const normalized = input
        .toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '') // ISO timestamps
        .replace(/:\d+:\d+/g, '') // line:col numbers
        .replace(/\d+ms/g, '') // timing
        .replace(/0x[0-9a-f]+/gi, '') // hex addresses
        .replace(/\s+/g, ' ')
        .trim();
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
        hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}
/**
 * Read error history from session state
 */
export function readErrorHistory(directory, sessionId) {
    return readModeState('error-history', directory, sessionId);
}
/**
 * Write error history to session state
 */
export function writeErrorHistory(directory, state, sessionId) {
    return writeModeState('error-history', state, directory, sessionId);
}
/**
 * Record an error occurrence for a task.
 * Automatically prunes old errors outside the rolling window.
 */
export function recordError(directory, sessionId, taskId, errorMessage) {
    let state = readErrorHistory(directory, sessionId);
    if (!state) {
        state = { errors: {}, lastUpdated: new Date().toISOString() };
    }
    const now = Date.now();
    const cutoff = now - CIRCULAR_FIX_CONFIG.rollingWindowMs;
    // Initialize task error list if needed
    if (!state.errors[taskId]) {
        state.errors[taskId] = [];
    }
    // Prune old errors outside rolling window
    state.errors[taskId] = state.errors[taskId].filter((e) => new Date(e.timestamp).getTime() > cutoff);
    // Add new error
    const truncatedMessage = errorMessage.length > CIRCULAR_FIX_CONFIG.maxMessageLength
        ? errorMessage.slice(0, CIRCULAR_FIX_CONFIG.maxMessageLength) + '...'
        : errorMessage;
    state.errors[taskId].push({
        hash: simpleHash(errorMessage),
        message: truncatedMessage,
        taskId,
        timestamp: new Date().toISOString(),
    });
    // Cap at max records per task
    if (state.errors[taskId].length > CIRCULAR_FIX_CONFIG.maxRecordsPerTask) {
        state.errors[taskId] = state.errors[taskId].slice(-CIRCULAR_FIX_CONFIG.maxRecordsPerTask);
    }
    state.lastUpdated = new Date().toISOString();
    writeErrorHistory(directory, state, sessionId);
}
/**
 * Check if a circular fix has been detected for a task.
 * Returns true if the same error hash appears >= threshold times
 * within the rolling window.
 */
export function isCircularFix(directory, sessionId, taskId) {
    const state = readErrorHistory(directory, sessionId);
    if (!state || !state.errors[taskId]) {
        return false;
    }
    const now = Date.now();
    const cutoff = now - CIRCULAR_FIX_CONFIG.rollingWindowMs;
    // Filter to recent errors only
    const recentErrors = state.errors[taskId].filter((e) => new Date(e.timestamp).getTime() > cutoff);
    // Count occurrences of each hash
    const hashCounts = new Map();
    for (const error of recentErrors) {
        hashCounts.set(error.hash, (hashCounts.get(error.hash) ?? 0) + 1);
    }
    // Check if any hash exceeds threshold
    for (const count of hashCounts.values()) {
        if (count >= CIRCULAR_FIX_CONFIG.threshold) {
            return true;
        }
    }
    return false;
}
/**
 * Get the most recurring error for a task (for escalation reports).
 */
function getMostRecurringError(errors, cutoff) {
    const recentErrors = errors.filter((e) => new Date(e.timestamp).getTime() > cutoff);
    const hashCounts = new Map();
    for (const error of recentErrors) {
        const existing = hashCounts.get(error.hash);
        if (existing) {
            existing.count += 1;
        }
        else {
            hashCounts.set(error.hash, { count: 1, message: error.message });
        }
    }
    let maxEntry = null;
    for (const [hash, data] of hashCounts) {
        if (!maxEntry || data.count > maxEntry.count) {
            maxEntry = { hash, count: data.count, message: data.message };
        }
    }
    return maxEntry;
}
/**
 * Generate a structured escalation report for a circular fix.
 * Returns markdown-formatted report.
 */
export function getEscalationReport(directory, sessionId, taskId) {
    const state = readErrorHistory(directory, sessionId);
    if (!state || !state.errors[taskId]) {
        return '# Escalation Report\n\nNo error history found for this task.';
    }
    const now = Date.now();
    const cutoff = now - CIRCULAR_FIX_CONFIG.rollingWindowMs;
    const recentErrors = state.errors[taskId].filter((e) => new Date(e.timestamp).getTime() > cutoff);
    const recurring = getMostRecurringError(state.errors[taskId], cutoff);
    const uniqueHashes = new Set(recentErrors.map((e) => e.hash));
    const lines = [
        '# Circular Fix Escalation Report',
        '',
        `**Task:** ${taskId}`,
        `**Generated:** ${new Date().toISOString()}`,
        `**Total errors in window:** ${recentErrors.length}`,
        `**Unique error patterns:** ${uniqueHashes.size}`,
        '',
        '## Recurring Error Pattern',
        '',
    ];
    if (recurring) {
        lines.push(`**Hash:** ${recurring.hash}`, `**Occurrences:** ${recurring.count}`, `**Error:**`, '```', recurring.message, '```', '');
    }
    lines.push('## Recommended Actions', '', '1. **Stop automated retries** — the same fix is being attempted repeatedly', '2. **Review the root cause** — the error pattern suggests a fundamental issue that automated fixes cannot resolve', '3. **Consider manual intervention** — examine the affected files and error context', '4. **Check for environmental issues** — missing dependencies, configuration, or permissions', '', '## Error Timeline', '', '| Time | Hash | Message |', '|------|------|---------|');
    for (const error of recentErrors.slice(-10)) {
        const time = new Date(error.timestamp).toISOString().slice(11, 19);
        const shortMsg = error.message.slice(0, 80).replace(/\|/g, '\\|');
        lines.push(`| ${time} | ${error.hash.slice(0, 8)} | ${shortMsg} |`);
    }
    return lines.join('\n');
}
/**
 * Clear error history for a task or all tasks.
 */
export function clearErrorHistory(directory, sessionId, taskId) {
    if (!taskId) {
        // Clear all
        writeErrorHistory(directory, { errors: {}, lastUpdated: new Date().toISOString() }, sessionId);
        return;
    }
    const state = readErrorHistory(directory, sessionId);
    if (state && state.errors[taskId]) {
        delete state.errors[taskId];
        state.lastUpdated = new Date().toISOString();
        writeErrorHistory(directory, state, sessionId);
    }
}
//# sourceMappingURL=index.js.map