/**
 * OMC HUD - Recent Tools Element
 *
 * Renders a rolling list of recently called tools with status icons and optional target info.
 */
import type { RecentTool } from '../types.js';
/**
 * Render recent tools list.
 *
 * Format: [+Read(auth.ts) +Edit ~Bash]
 */
export declare function renderRecentTools(tools: RecentTool[], max?: number, showTarget?: boolean, safeMode?: boolean): string | null;
//# sourceMappingURL=recent-tools.d.ts.map