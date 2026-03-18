/**
 * OMC HUD - Context Limit Warning Element
 *
 * Renders a prominent warning banner when context usage exceeds the configured
 * threshold. Supports an autoCompact mode that queues a /compact request.
 */
/**
 * Render a context limit warning banner.
 *
 * Returns a warning string when contextPercent >= threshold, null otherwise.
 *
 * @param contextPercent - Current context usage (0-100)
 * @param threshold - Configured threshold to trigger warning (default 80)
 * @param autoCompact - Whether autoCompact is enabled (affects message copy)
 */
export declare function renderContextLimitWarning(contextPercent: number, threshold: number, autoCompact: boolean): string | null;
//# sourceMappingURL=context-warning.d.ts.map