/**
 * Think Mode Detector
 *
 * Detects think/ultrathink keywords in prompts.
 * Supports multiple languages for global accessibility.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */
/** English patterns for think keywords */
const ENGLISH_PATTERNS = [/\bultrathink\b/i, /\bthink\b/i];
const THINK_PATTERNS = ENGLISH_PATTERNS;
/** Regex patterns for code blocks */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;
/**
 * Remove code blocks from text to avoid false positive keyword detection.
 */
export function removeCodeBlocks(text) {
    return text.replace(CODE_BLOCK_PATTERN, '').replace(INLINE_CODE_PATTERN, '');
}
/**
 * Detect if text contains a think keyword (excluding code blocks).
 */
export function detectThinkKeyword(text) {
    const textWithoutCode = removeCodeBlocks(text);
    return THINK_PATTERNS.some((pattern) => pattern.test(textWithoutCode));
}
/**
 * Extract text content from message parts.
 */
export function extractPromptText(parts) {
    return parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('');
}
/**
 * Check if the text contains the ultrathink keyword specifically.
 */
export function detectUltrathinkKeyword(text) {
    const textWithoutCode = removeCodeBlocks(text);
    return /\bultrathink\b/i.test(textWithoutCode);
}
//# sourceMappingURL=detector.js.map