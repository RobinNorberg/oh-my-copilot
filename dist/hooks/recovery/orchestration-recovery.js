/**
 * Orchestration Recovery Manager
 *
 * Classifies orchestration-level failures and determines recovery actions
 * for multi-agent workflows (ralph, ultrawork, team).
 *
 * Integrates with the circular fix detector (Feature 2) for the
 * escalation path when the same error recurs.
 */
import { ORCHESTRATION_RECOVERY_CONFIG } from './types.js';
import { isCircularFix } from '../circular-fix-detector/index.js';
/** Pattern-based failure classification */
const FAILURE_PATTERNS = [
    {
        type: 'rate_limited',
        patterns: [
            /429/,
            /rate\s*limit/i,
            /too\s*many\s*requests/i,
            /throttl/i,
            /quota\s*exceeded/i,
        ],
    },
    {
        type: 'auth_failure',
        patterns: [
            /401/,
            /403/,
            /unauthorized/i,
            /forbidden/i,
            /authentication\s*failed/i,
            /invalid\s*(api[_\s]?key|token|credential)/i,
        ],
    },
    {
        type: 'context_exhausted',
        patterns: [
            /token\s*limit/i,
            /maximum\s*(context\s*)?length/i,
            /context\s*window/i,
            /too\s*many\s*tokens/i,
            /max_tokens/i,
        ],
    },
    {
        type: 'network_error',
        patterns: [
            /ECONNREFUSED/i,
            /ECONNRESET/i,
            /ETIMEDOUT/i,
            /ENOTFOUND/i,
            /network\s*error/i,
            /DNS\s*(resolution\s*)?fail/i,
            /socket\s*hang\s*up/i,
            /fetch\s*failed/i,
        ],
    },
    {
        type: 'build_error',
        patterns: [
            /syntax\s*error/i,
            /cannot\s*find\s*module/i,
            /module\s*not\s*found/i,
            /compilation\s*error/i,
            /type\s*error.*ts\(\d+\)/i,
            /build\s*failed/i,
            /tsc.*error/i,
            /eslint.*error/i,
        ],
    },
    {
        type: 'verification_failed',
        patterns: [
            /test\s*(suite\s*)?failed/i,
            /assertion\s*error/i,
            /expect.*received/i,
            /FAIL\s+\w/,
            /\d+\s*(test|spec)s?\s*failed/i,
        ],
    },
    {
        type: 'tool_execution_error',
        patterns: [
            /tool\s*execution\s*failed/i,
            /tool\s*error/i,
            /command\s*failed/i,
            /exit\s*code\s*[1-9]/i,
            /non-?zero\s*exit/i,
        ],
    },
];
/**
 * Classify an orchestration-level failure from an error message.
 */
export function classifyOrchestrationFailure(error) {
    if (!error || !error.trim()) {
        return 'unknown';
    }
    for (const { type, patterns } of FAILURE_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(error)) {
                return type;
            }
        }
    }
    return 'unknown';
}
/** Recovery action mapping per failure type */
const ACTION_MAP = {
    rate_limited: 'retry_with_backoff',
    auth_failure: 'escalate',
    tool_execution_error: 'retry',
    build_error: 'retry_with_context',
    verification_failed: 'retry',
    context_exhausted: 'retry_with_context',
    network_error: 'retry_with_backoff',
    circular_fix: 'escalate',
    unknown: 'retry',
};
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
export function determineRecoveryAction(taskId, error, attemptCount, directory, sessionId) {
    // Check circular fix first (integrates with Feature 2)
    if (directory && sessionId) {
        if (isCircularFix(directory, sessionId, taskId)) {
            return {
                action: 'escalate',
                reason: `Circular fix detected for task ${taskId}: the same error has recurred ${ORCHESTRATION_RECOVERY_CONFIG.maxRetries}+ times. Automated fixes are not resolving this issue.`,
                isCircularFix: true,
            };
        }
    }
    const failureType = classifyOrchestrationFailure(error);
    // Auth failures always escalate immediately
    if (failureType === 'auth_failure') {
        return {
            action: 'escalate',
            reason: 'Authentication/authorization failure requires user intervention (check credentials, permissions, or API keys).',
        };
    }
    // If max retries exceeded, escalate
    if (attemptCount >= ORCHESTRATION_RECOVERY_CONFIG.maxRetries) {
        return {
            action: 'escalate',
            reason: `Max retries (${ORCHESTRATION_RECOVERY_CONFIG.maxRetries}) exceeded for task ${taskId}. Error type: ${failureType}.`,
        };
    }
    const baseAction = ACTION_MAP[failureType];
    // Calculate backoff for retry_with_backoff
    if (baseAction === 'retry_with_backoff') {
        const backoffMs = Math.min(ORCHESTRATION_RECOVERY_CONFIG.initialBackoffMs * Math.pow(ORCHESTRATION_RECOVERY_CONFIG.backoffMultiplier, attemptCount), ORCHESTRATION_RECOVERY_CONFIG.maxBackoffMs);
        return {
            action: baseAction,
            reason: `${failureType}: retrying with ${backoffMs}ms backoff (attempt ${attemptCount + 1}/${ORCHESTRATION_RECOVERY_CONFIG.maxRetries}).`,
            backoffMs,
        };
    }
    return {
        action: baseAction,
        reason: `${failureType}: ${baseAction} (attempt ${attemptCount + 1}/${ORCHESTRATION_RECOVERY_CONFIG.maxRetries}).`,
    };
}
//# sourceMappingURL=orchestration-recovery.js.map