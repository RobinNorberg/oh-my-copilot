/**
 * Unified Recovery Types
 *
 * Type definitions for all recovery mechanisms in Copilot CLI.
 */
/**
 * Configuration for retry behavior
 */
export const RETRY_CONFIG = {
    /** Maximum retry attempts */
    maxAttempts: 2,
    /** Initial delay between retries in ms */
    initialDelayMs: 2000,
    /** Backoff factor for exponential backoff */
    backoffFactor: 2,
    /** Maximum delay between retries in ms */
    maxDelayMs: 30000,
};
/**
 * Configuration for truncation behavior
 */
export const TRUNCATE_CONFIG = {
    /** Maximum truncation attempts */
    maxTruncateAttempts: 20,
    /** Minimum output size (chars) to attempt truncation */
    minOutputSizeToTruncate: 500,
    /** Target token ratio after truncation */
    targetTokenRatio: 0.5,
    /** Average characters per token estimate */
    charsPerToken: 4,
};
/**
 * Configuration for orchestration recovery
 */
export const ORCHESTRATION_RECOVERY_CONFIG = {
    /** Max retry attempts per task before escalating */
    maxRetries: 3,
    /** Initial backoff delay in ms */
    initialBackoffMs: 2000,
    /** Backoff multiplier */
    backoffMultiplier: 2,
    /** Max backoff delay in ms */
    maxBackoffMs: 30000,
    /** Rolling window for attempt history in ms (2 hours) */
    rollingWindowMs: 2 * 60 * 60 * 1000,
    /** Max attempt records per task */
    maxAttemptsPerTask: 20,
};
//# sourceMappingURL=types.js.map