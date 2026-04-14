/**
 * Complexity Classifier Hook
 *
 * Classifies task complexity as simple/standard/complex using heuristic patterns.
 * When heuristics are inconclusive (returns null), the orchestrating agent should
 * spawn an explore agent (haiku) for AI-based assessment.
 *
 * Complexity result is stored in .omcp/state/sessions/{sessionId}/complexity.json
 */
export type ComplexityTier = 'simple' | 'standard' | 'complex';
export interface ComplexityResult {
    /** The determined complexity tier */
    tier: ComplexityTier;
    /** How the classification was made */
    method: 'heuristic' | 'ai';
    /** Confidence level (0-1) for heuristic, always 1 for AI */
    confidence: number;
    /** Which pattern matched (if heuristic) */
    matchedPattern?: string;
    /** Timestamp of classification */
    classifiedAt: string;
}
/**
 * Classify task complexity using heuristic patterns (zero-cost).
 *
 * Returns a ComplexityTier if heuristics are confident, or null if AI assessment is needed.
 *
 * @param prompt - The task description to classify
 * @returns 'simple' | 'standard' | 'complex' | null
 */
export declare function classifyComplexityHeuristic(prompt: string): ComplexityTier | null;
/**
 * Store complexity result in session state
 */
export declare function writeComplexityResult(directory: string, result: ComplexityResult, sessionId?: string): boolean;
/**
 * Read complexity result from session state
 */
export declare function readComplexityResult(directory: string, sessionId?: string): ComplexityResult | null;
/**
 * Get the configured complexity assessment model.
 * Defaults to haiku if not configured.
 */
export declare function getComplexityModel(): string;
export { SIMPLE_PATTERNS, COMPLEX_PATTERNS, WORD_COUNT_THRESHOLDS, DEFAULT_COMPLEXITY_MODEL } from './patterns.js';
//# sourceMappingURL=index.d.ts.map