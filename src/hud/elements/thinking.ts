/**
 * OMG HUD - Thinking Indicator Element
 *
 * Renders extended thinking mode indicator with configurable format.
 */

import type { ThinkingState, ThinkingFormat } from '../types.js';
import { RESET } from '../colors.js';

const CYAN = '\x1b[36m';

/**
 * Render thinking indicator based on format.
 *
 * @param state - Thinking state from transcript
 * @param format - Display format (bubble, brain, face, text)
 * @returns Formatted thinking indicator or null if not active
 */
export function renderThinking(
  state: ThinkingState | null,
  format: ThinkingFormat = 'text'
): string | null {
  if (!state?.active) return null;

  switch (format) {
    case 'bubble':
      return '💭';
    case 'brain':
      return '🧠';
    case 'face':
      return '🤔';
    case 'text':
      return `${CYAN}thinking${RESET}`;
    default:
      return '💭';
  }
}
