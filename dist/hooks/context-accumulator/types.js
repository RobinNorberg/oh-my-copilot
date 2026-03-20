/**
 * Context Accumulator Types
 *
 * Types for capturing and injecting phase outputs between
 * autopilot phases and ralph stories.
 */
/** Configuration for context accumulation */
export const CONTEXT_ACCUMULATOR_CONFIG = {
    /** Maximum size per phase output in bytes (12KB) */
    maxPhaseOutputSize: 12 * 1024,
    /** Truncation marker appended when content exceeds limit */
    truncationMarker: '\n\n... (truncated to 12KB)',
    /** Maximum number of phases to retain */
    maxPhases: 10,
};
//# sourceMappingURL=types.js.map