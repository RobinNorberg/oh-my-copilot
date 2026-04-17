/**
 * Unified Recovery Types
 *
 * Type definitions for all recovery mechanisms in Copilot CLI.
 */
/**
 * Recovery error types
 */
export type RecoveryErrorType = 'context_window_limit' | 'edit_error' | 'tool_result_missing' | 'thinking_block_order' | 'thinking_disabled_violation' | 'empty_content' | null;
/**
 * Recovery result
 */
export interface RecoveryResult {
    /** Whether recovery was attempted */
    attempted: boolean;
    /** Whether recovery was successful */
    success: boolean;
    /** Recovery message to inject */
    message?: string;
    /** Error type detected */
    errorType?: string;
}
/**
 * Parsed token limit error information
 */
export interface ParsedTokenLimitError {
    /** Current number of tokens in the conversation */
    currentTokens: number;
    /** Maximum allowed tokens */
    maxTokens: number;
    /** Request ID from the API response */
    requestId?: string;
    /** Type of error detected */
    errorType: string;
    /** Provider ID (e.g., 'anthropic') */
    providerID?: string;
    /** Model ID (e.g., 'claude-opus-4-7') */
    modelID?: string;
    /** Index of the problematic message */
    messageIndex?: number;
}
/**
 * Retry state for recovery attempts
 */
export interface RetryState {
    /** Number of retry attempts made */
    attempt: number;
    /** Timestamp of last retry attempt */
    lastAttemptTime: number;
}
/**
 * Truncation state for progressive truncation
 */
export interface TruncateState {
    /** Number of truncation attempts made */
    truncateAttempt: number;
    /** ID of the last truncated part */
    lastTruncatedPartId?: string;
}
/**
 * Message data structure
 */
export interface MessageData {
    info?: {
        id?: string;
        role?: string;
        sessionID?: string;
        parentID?: string;
        error?: unknown;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        system?: string;
        tools?: Record<string, boolean>;
    };
    parts?: Array<{
        type: string;
        id?: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: Record<string, unknown>;
        callID?: string;
    }>;
}
/**
 * Stored message metadata
 */
export interface StoredMessageMeta {
    id: string;
    sessionID: string;
    role: 'user' | 'assistant';
    parentID?: string;
    time?: {
        created: number;
        completed?: number;
    };
    error?: unknown;
}
/**
 * Stored text part
 */
export interface StoredTextPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'text';
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
}
/**
 * Stored tool part
 */
export interface StoredToolPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'tool';
    callID: string;
    tool: string;
    state: {
        status: 'pending' | 'running' | 'completed' | 'error';
        input: Record<string, unknown>;
        output?: string;
        error?: string;
    };
}
/**
 * Stored reasoning/thinking part
 */
export interface StoredReasoningPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'reasoning';
    text: string;
}
/**
 * Union of all stored part types
 */
export type StoredPart = StoredTextPart | StoredToolPart | StoredReasoningPart | {
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    [key: string]: unknown;
};
/**
 * Unified recovery configuration
 */
export interface RecoveryConfig {
    /** Whether to enable context window limit recovery */
    contextWindowRecovery?: boolean;
    /** Whether to enable edit error recovery */
    editErrorRecovery?: boolean;
    /** Whether to enable session recovery */
    sessionRecovery?: boolean;
    /** Whether to show detailed recovery messages */
    detailed?: boolean;
    /** Custom recovery messages */
    customMessages?: Partial<Record<RecoveryErrorType & string, string>>;
    /** Whether to enable auto-resume after recovery */
    autoResume?: boolean;
    /** Whether to enable detailed logging */
    debug?: boolean;
}
/**
 * Configuration for retry behavior
 */
export declare const RETRY_CONFIG: {
    /** Maximum retry attempts */
    readonly maxAttempts: 2;
    /** Initial delay between retries in ms */
    readonly initialDelayMs: 2000;
    /** Backoff factor for exponential backoff */
    readonly backoffFactor: 2;
    /** Maximum delay between retries in ms */
    readonly maxDelayMs: 30000;
};
/**
 * Configuration for truncation behavior
 */
export declare const TRUNCATE_CONFIG: {
    /** Maximum truncation attempts */
    readonly maxTruncateAttempts: 20;
    /** Minimum output size (chars) to attempt truncation */
    readonly minOutputSizeToTruncate: 500;
    /** Target token ratio after truncation */
    readonly targetTokenRatio: 0.5;
    /** Average characters per token estimate */
    readonly charsPerToken: 4;
};
/**
 * Orchestration-level failure types for multi-agent workflows.
 * These classify errors at the orchestration level (ralph, ultrawork, team)
 * rather than the individual tool level.
 */
export type OrchestrationFailureType = 'rate_limited' | 'auth_failure' | 'tool_execution_error' | 'build_error' | 'verification_failed' | 'context_exhausted' | 'network_error' | 'circular_fix' | 'unknown';
/**
 * Recovery action to take for a given failure type
 */
export type RecoveryAction = 'retry' | 'retry_with_backoff' | 'retry_with_context' | 'skip' | 'escalate';
/**
 * A single attempt record for tracking retry history
 */
export interface AttemptRecord {
    /** Task/story ID */
    taskId: string;
    /** Classified failure type */
    failureType: OrchestrationFailureType;
    /** Original error message (truncated) */
    errorMessage: string;
    /** Timestamp of attempt */
    timestamp: string;
    /** Recovery action taken */
    actionTaken: RecoveryAction;
}
/**
 * Persisted attempt history for a session
 */
export interface AttemptHistory {
    /** Attempts keyed by taskId */
    attempts: Record<string, AttemptRecord[]>;
    /** Last updated timestamp */
    lastUpdated: string;
}
/**
 * Result of determining a recovery action
 */
export interface RecoveryActionResult {
    /** The action to take */
    action: RecoveryAction;
    /** Human-readable reason */
    reason: string;
    /** Suggested backoff delay in ms (for retry_with_backoff) */
    backoffMs?: number;
    /** Whether this is a circular fix (integrates with Feature 2) */
    isCircularFix?: boolean;
}
/**
 * Configuration for orchestration recovery
 */
export declare const ORCHESTRATION_RECOVERY_CONFIG: {
    /** Max retry attempts per task before escalating */
    readonly maxRetries: 3;
    /** Initial backoff delay in ms */
    readonly initialBackoffMs: 2000;
    /** Backoff multiplier */
    readonly backoffMultiplier: 2;
    /** Max backoff delay in ms */
    readonly maxBackoffMs: 30000;
    /** Rolling window for attempt history in ms (2 hours) */
    readonly rollingWindowMs: number;
    /** Max attempt records per task */
    readonly maxAttemptsPerTask: 20;
};
//# sourceMappingURL=types.d.ts.map