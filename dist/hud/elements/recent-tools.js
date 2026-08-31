/**
 * OMC HUD - Recent Tools Element
 *
 * Renders a rolling list of recently called tools with status icons,
 * target summaries, and deduplication of consecutive calls.
 */
import { dim, green, red, yellow } from '../colors.js';
const STATUS_ICONS = {
    running: yellow('~'),
    success: green('+'),
    failure: red('x'),
};
const SAFE_STATUS_ICONS = {
    running: '~',
    success: '+',
    failure: 'x',
};
/**
 * Collapse consecutive identical tool names into single entries with count.
 */
function collapseTools(tools) {
    const collapsed = [];
    for (const tool of tools) {
        const last = collapsed[collapsed.length - 1];
        if (last && last.name === tool.name) {
            last.count++;
            last.status = tool.status;
            last.target = tool.target;
        }
        else {
            collapsed.push({
                name: tool.name,
                target: tool.target,
                status: tool.status,
                count: 1,
            });
        }
    }
    return collapsed;
}
/**
 * Render recent tools list.
 *
 * Format: +Read:auth.ts | +Bash x3 | ~Edit:config.ts
 * Safe:   +Read:auth.ts | +Bash x3 | ~Edit:config.ts
 */
export function renderRecentTools(tools, max = 5, showTarget = true, safeMode) {
    if (!tools.length)
        return null;
    const icons = safeMode ? SAFE_STATUS_ICONS : STATUS_ICONS;
    const display = tools.slice(-(max * 3));
    const collapsed = collapseTools(display).slice(-max);
    const parts = collapsed.map((t) => {
        const icon = icons[t.status];
        const count = t.count > 1 ? ` ${dim(`x${t.count}`)}` : '';
        if (showTarget && t.target && t.target !== '...') {
            return `${icon}${t.name}${dim(':')}${t.target}${count}`;
        }
        return `${icon}${t.name}${count}`;
    });
    return parts.join(dim(' | '));
}
//# sourceMappingURL=recent-tools.js.map