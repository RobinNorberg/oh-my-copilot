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
export declare function renderCopilotMode(mode: HudRenderContext['copilotMode'], allowAll: boolean | undefined): string | null;
//# sourceMappingURL=copilot-mode.d.ts.map