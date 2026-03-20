/**
 * Complexity Classifier Hook
 *
 * Classifies task complexity as simple/standard/complex using heuristic patterns.
 * When heuristics are inconclusive (returns null), the orchestrating agent should
 * spawn an explore agent (haiku) for AI-based assessment.
 *
 * Complexity result is stored in .omc/state/sessions/{sessionId}/complexity.json
 */
import { SIMPLE_PATTERNS, COMPLEX_PATTERNS, WORD_COUNT_THRESHOLDS, DEFAULT_COMPLEXITY_MODEL } from './patterns.js';
import { writeModeState, readModeState } from '../../lib/mode-state-io.js';
/**
 * Classify task complexity using heuristic patterns (zero-cost).
 *
 * Returns a ComplexityTier if heuristics are confident, or null if AI assessment is needed.
 *
 * @param prompt - The task description to classify
 * @returns 'simple' | 'standard' | 'complex' | null
 */
export function classifyComplexityHeuristic(prompt) {
    if (!prompt || !prompt.trim()) {
        return null;
    }
    const normalized = prompt.trim();
    const wordCount = normalized.split(/\s+/).length;
    // Check simple patterns first
    for (const pattern of SIMPLE_PATTERNS) {
        if (pattern.test(normalized)) {
            return 'simple';
        }
    }
    // Very short prompts without complex signals are likely simple
    if (wordCount <= WORD_COUNT_THRESHOLDS.simpleMax) {
        // But only if no complex patterns match
        const hasComplexSignal = COMPLEX_PATTERNS.some(p => p.test(normalized));
        if (!hasComplexSignal) {
            return 'simple';
        }
    }
    // Check complex patterns
    for (const pattern of COMPLEX_PATTERNS) {
        if (pattern.test(normalized)) {
            return 'complex';
        }
    }
    // Long prompts without clear signals suggest complexity
    if (wordCount >= WORD_COUNT_THRESHOLDS.complexMin) {
        return 'complex';
    }
    // Heuristics inconclusive - defer to AI
    return null;
}
/**
 * Store complexity result in session state
 */
export function writeComplexityResult(directory, result, sessionId) {
    return writeModeState('complexity', result, directory, sessionId);
}
/**
 * Read complexity result from session state
 */
export function readComplexityResult(directory, sessionId) {
    return readModeState('complexity', directory, sessionId);
}
/**
 * Get the configured complexity assessment model.
 * Defaults to haiku if not configured.
 */
export function getComplexityModel() {
    return DEFAULT_COMPLEXITY_MODEL;
}
// Re-export patterns for testing
export { SIMPLE_PATTERNS, COMPLEX_PATTERNS, WORD_COUNT_THRESHOLDS, DEFAULT_COMPLEXITY_MODEL } from './patterns.js';
//# sourceMappingURL=index.js.map