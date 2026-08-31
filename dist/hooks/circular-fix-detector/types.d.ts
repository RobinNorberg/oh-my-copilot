/**
 * Circular Fix Detector Types
 */
/** A single recorded error occurrence */
export interface ErrorRecord {
    /** Hash of the normalized error string */
    hash: string;
    /** Original error message (truncated to 500 chars) */
    message: string;
    /** Task/story ID this error is associated with */
    taskId: string;
    /** ISO timestamp of when this error occurred */
    timestamp: string;
}
/** Persisted state for circular fix detection */
export interface CircularFixState {
    /** Error records keyed by taskId */
    errors: Record<string, ErrorRecord[]>;
    /** When the state was last updated */
    lastUpdated: string;
}
/** Configuration for circular fix detection */
export declare const CIRCULAR_FIX_CONFIG: {
    /** Number of identical errors before declaring circular fix */
    readonly threshold: 3;
    /** Rolling window in milliseconds (2 hours) */
    readonly rollingWindowMs: number;
    /** Maximum error records per task */
    readonly maxRecordsPerTask: 50;
    /** Maximum length of stored error message */
    readonly maxMessageLength: 500;
};
//# sourceMappingURL=types.d.ts.map