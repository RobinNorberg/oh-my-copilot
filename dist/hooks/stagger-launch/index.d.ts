/**
 * Stagger Launch Hook
 *
 * PreToolUse hook that detects rapid-fire Task tool calls during ultrawork mode
 * and injects advisory stagger delay guidance. This prevents thundering herd
 * rate limits when launching many parallel agents.
 *
 * The stagger is advisory (via prompt injection) rather than blocking,
 * since OMC hooks cannot delay tool execution.
 */
export interface StaggerState {
    /** Timestamp of last Task launch (ms since epoch) */
    lastTaskLaunchMs: number;
    /** Number of rapid-fire launches detected in current burst */
    burstCount: number;
    /** Session ID */
    sessionId?: string;
}
declare const DEFAULT_STAGGER_DELAY_MS = 1000;
/**
 * Read stagger state from session
 */
export declare function readStaggerState(directory: string, sessionId?: string): StaggerState | null;
/**
 * Write stagger state to session
 */
export declare function writeStaggerState(directory: string, state: StaggerState, sessionId?: string): boolean;
/**
 * Check if stagger guidance should be injected for a Task tool call.
 *
 * Only active during ultrawork mode. Detects when Task calls arrive
 * within the stagger window of the last launch.
 *
 * @returns Stagger guidance message, or null if no stagger needed
 */
export declare function checkStaggerNeeded(directory: string, sessionId?: string): string | null;
/**
 * Clear stagger state (called on mode deactivation)
 */
export declare function clearStaggerState(directory: string, sessionId?: string): boolean;
export { DEFAULT_STAGGER_DELAY_MS };
//# sourceMappingURL=index.d.ts.map