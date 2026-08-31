/**
 * Circular Fix Detector Types
 */
/** Configuration for circular fix detection */
export const CIRCULAR_FIX_CONFIG = {
    /** Number of identical errors before declaring circular fix */
    threshold: 3,
    /** Rolling window in milliseconds (2 hours) */
    rollingWindowMs: 2 * 60 * 60 * 1000,
    /** Maximum error records per task */
    maxRecordsPerTask: 50,
    /** Maximum length of stored error message */
    maxMessageLength: 500,
};
//# sourceMappingURL=types.js.map