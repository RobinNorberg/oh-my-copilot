/**
 * Context Accumulator Hook
 *
 * Captures key outputs after each autopilot phase or ralph story completion,
 * and injects them into the next phase's agent prompt via a
 * <prior-phase-context> XML block.
 *
 * Stored in .omcp/state/sessions/{sessionId}/phase-context.json
 */
import type { AccumulatedContext } from './types.js';
export type { PhaseContext, AccumulatedContext } from './types.js';
export { CONTEXT_ACCUMULATOR_CONFIG } from './types.js';
/**
 * Read accumulated context from session state
 */
export declare function readAccumulatedContext(directory: string, sessionId?: string): AccumulatedContext | null;
/**
 * Write accumulated context to session state
 */
export declare function writeAccumulatedContext(directory: string, context: AccumulatedContext, sessionId?: string): boolean;
/**
 * Capture a phase output and add it to the accumulated context.
 */
export declare function capturePhaseOutput(directory: string, sessionId: string, phaseId: string, phaseName: string, content: string, filesChanged?: string[], decisions?: string[]): boolean;
/**
 * Generate the <prior-phase-context> XML block for injection into the next agent's prompt.
 *
 * Returns null if no accumulated context exists.
 */
export declare function generateContextInjection(directory: string, sessionId?: string): string | null;
/**
 * Clear accumulated context for a session.
 * Called on /cancel or session end.
 */
export declare function clearAccumulatedContext(directory: string, sessionId?: string): boolean;
/**
 * Get summary of accumulated context (for HUD/status display)
 */
export declare function getContextSummary(directory: string, sessionId?: string): {
    phaseCount: number;
    totalSize: number;
    phases: string[];
} | null;
//# sourceMappingURL=index.d.ts.map