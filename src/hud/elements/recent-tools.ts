/**
 * OMC HUD - Recent Tools Element
 *
 * Renders a rolling list of recently called tools with status icons and optional target info.
 */

import { dim, green, red, yellow } from '../colors.js';
import type { RecentTool } from '../types.js';

const STATUS_ICONS: Record<RecentTool['status'], string> = {
  running: yellow('~'),
  success: green('+'),
  failure: red('x'),
};

const SAFE_STATUS_ICONS: Record<RecentTool['status'], string> = {
  running: '~',
  success: '+',
  failure: 'x',
};

/**
 * Render recent tools list.
 *
 * Format: [+Read(auth.ts) +Edit ~Bash]
 */
export function renderRecentTools(
  tools: RecentTool[],
  max: number = 5,
  showTarget: boolean = true,
  safeMode?: boolean,
): string | null {
  if (!tools.length) return null;

  const icons = safeMode ? SAFE_STATUS_ICONS : STATUS_ICONS;
  const display = tools.slice(-max).map((t) => {
    const icon = icons[t.status];
    const target = showTarget && t.target ? `(${t.target})` : '';
    return `${icon}${t.name}${target}`;
  });

  return `[${display.join(' ')}]`;
}
