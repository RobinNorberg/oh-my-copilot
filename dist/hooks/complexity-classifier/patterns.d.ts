/**
 * Complexity Classifier Patterns
 *
 * Pattern definitions for heuristic complexity classification.
 * Adapted from Aperant's assessComplexityHeuristic().
 */
/** Patterns that indicate a SIMPLE task (zero-cost classification) */
export declare const SIMPLE_PATTERNS: RegExp[];
/** Patterns that indicate a COMPLEX task (needs thorough planning) */
export declare const COMPLEX_PATTERNS: RegExp[];
/** Word count thresholds for heuristic classification */
export declare const WORD_COUNT_THRESHOLDS: {
    /** Tasks with <= this many words are likely simple */
    readonly simpleMax: 8;
    /** Tasks with >= this many words may be complex */
    readonly complexMin: 30;
};
/** Default model for AI-based complexity assessment when heuristics fail */
export declare const DEFAULT_COMPLEXITY_MODEL: "haiku";
//# sourceMappingURL=patterns.d.ts.map