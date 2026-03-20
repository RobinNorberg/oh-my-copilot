/**
 * Context Accumulator Types
 *
 * Types for capturing and injecting phase outputs between
 * autopilot phases and ralph stories.
 */
/** A single captured phase output */
export interface PhaseContext {
    /** Phase identifier (e.g., 'phase-0-expansion', 'ralph-story-3') */
    phaseId: string;
    /** Human-readable phase name */
    phaseName: string;
    /** Captured output content (truncated to MAX_PHASE_OUTPUT_SIZE) */
    content: string;
    /** Size in bytes before truncation */
    originalSize: number;
    /** Whether the content was truncated */
    truncated: boolean;
    /** Files changed during this phase */
    filesChanged: string[];
    /** Key decisions made */
    decisions: string[];
    /** Timestamp of capture */
    capturedAt: string;
}
/** Accumulated context across phases for a session */
export interface AccumulatedContext {
    /** Phase contexts in order of capture */
    phases: PhaseContext[];
    /** Session this context belongs to */
    sessionId: string;
    /** When the context was last updated */
    lastUpdated: string;
}
/** Configuration for context accumulation */
export declare const CONTEXT_ACCUMULATOR_CONFIG: {
    /** Maximum size per phase output in bytes (12KB) */
    readonly maxPhaseOutputSize: number;
    /** Truncation marker appended when content exceeds limit */
    readonly truncationMarker: "\n\n... (truncated to 12KB)";
    /** Maximum number of phases to retain */
    readonly maxPhases: 10;
};
//# sourceMappingURL=types.d.ts.map