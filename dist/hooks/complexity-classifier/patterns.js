/**
 * Complexity Classifier Patterns
 *
 * Pattern definitions for heuristic complexity classification.
 * Adapted from Aperant's assessComplexityHeuristic().
 */
/** Patterns that indicate a SIMPLE task (zero-cost classification) */
export const SIMPLE_PATTERNS = [
    /\b(fix|correct)\s+(a\s+)?typo/i,
    /\b(bump|update)\s+(the\s+)?version/i,
    /\brename\s+\w+\s+(to|->|=>)\s+\w+/i,
    /\b(add|insert)\s+(a\s+)?(missing\s+)?(import|export|semicolon|comma|bracket|brace|paren)/i,
    /\b(remove|delete)\s+(unused|dead)\s+(code|import|variable|function)/i,
    /\bupdate\s+(readme|changelog|license|\.md)/i,
    /\b(fix|correct)\s+(spelling|grammar|whitespace|indentation|formatting)/i,
    /\bchange\s+\w+\s+to\s+\w+$/i, // simple renames like "change X to Y"
    /\badd\s+(a\s+)?comment/i,
    /\bfix\s+(lint|linting)\s+(error|warning|issue)/i,
];
/** Patterns that indicate a COMPLEX task (needs thorough planning) */
export const COMPLEX_PATTERNS = [
    /\b(auth|authentication|authorization|oauth|saml|jwt)\b/i,
    /\b(migrat|schema\s+change|database\s+migration)/i,
    /\b(security|vulnerability|cve|owasp)/i,
    /\b(architect|redesign|rearchitect|refactor.*entire|rewrite)/i,
    /\b(api|rest|graphql|grpc)\s+(design|redesign|from\s+scratch)/i,
    /\b(multi-?tenant|rbac|access\s+control)/i,
    /\b(distributed|microservice|event[\s-]?driven)/i,
    /\b(caching|rate[\s-]?limit|circuit[\s-]?break)/i,
    /\b(ci[\s\/]?cd|pipeline|deploy|infrastructure)/i,
    /\b(compliance|gdpr|pii|hipaa|sox)/i,
];
/** Word count thresholds for heuristic classification */
export const WORD_COUNT_THRESHOLDS = {
    /** Tasks with <= this many words are likely simple */
    simpleMax: 8,
    /** Tasks with >= this many words may be complex */
    complexMin: 30,
};
/** Default model for AI-based complexity assessment when heuristics fail */
export const DEFAULT_COMPLEXITY_MODEL = 'haiku';
//# sourceMappingURL=patterns.js.map