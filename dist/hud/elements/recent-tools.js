/**
 * OMC HUD - Recent Tools Element
 *
 * Renders a rolling list of recently called tools with status icons and optional target info.
 */
import { green, red, yellow } from '../colors.js';
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
 * Render recent tools list.
 *
 * Format: [+Read(auth.ts) +Edit ~Bash]
 */
export function renderRecentTools(tools, max = 5, showTarget = true, safeMode) {
    if (!tools.length)
        return null;
    const icons = safeMode ? SAFE_STATUS_ICONS : STATUS_ICONS;
    const display = tools.slice(-max).map((t) => {
        const icon = icons[t.status];
        const target = showTarget && t.target ? `(${t.target})` : '';
        return `${icon}${t.name}${target}`;
    });
    return `[${display.join(' ')}]`;
}
//# sourceMappingURL=recent-tools.js.map