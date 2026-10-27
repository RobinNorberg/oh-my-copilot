/**
 * OMC HUD - Copilot Mode Element
 *
 * Copilot CLI's native agent mode (events.jsonl `session.mode_changed`) and its
 * allow-all state (payload `allow_all_enabled`): `mode:plan`, `mode:autopilot`,
 * `mode:yolo`, combined as `mode:plan+yolo`. The prefix keeps it apart from the
 * OMC autopilot element.
 * Hidden in interactive mode without allow-all.
 */

import type { HudRenderContext } from '../types.js';
import { RESET } from '../colors.js';

const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';

export function renderCopilotMode(
  mode: HudRenderContext['copilotMode'],
  allowAll: boolean | undefined,
): string | null {
  const parts: string[] = [];
  if (mode === 'plan') parts.push(`${CYAN}plan${RESET}`);
  if (mode === 'autopilot') parts.push(`${MAGENTA}autopilot${RESET}`);
  if (allowAll === true) parts.push(`${RED}yolo${RESET}`);
  return parts.length > 0 ? `mode:${parts.join('+')}` : null;
}
