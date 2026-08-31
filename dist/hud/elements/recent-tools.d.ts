/**
 * OMC HUD - Recent Tools Element
 *
 * Renders a rolling list of recently called tools with status icons,
 * target summaries, and deduplication of consecutive calls.
 */
import type { RecentTool } from '../types.js';
/**
 * Render recent tools list.
 *
 * Format: +Read:auth.ts | +Bash x3 | ~Edit:config.ts
 * Safe:   +Read:auth.ts | +Bash x3 | ~Edit:config.ts
 */
export declare function renderRecentTools(tools: RecentTool[], max?: number, showTarget?: boolean, safeMode?: boolean): string | null;
//# sourceMappingURL=recent-tools.d.ts.map