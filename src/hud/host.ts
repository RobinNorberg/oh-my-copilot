/**
 * OMC HUD - Host detection
 *
 * Decides which host CLI fed the statusline payload. The payload shape is the
 * primary signal because `--watch` mode replays a cached payload outside any
 * host process, where the environment says nothing about the original host.
 */

import { detectHostCliSignal } from '../utils/host-signal.js';
import type { StatuslineStdin } from './types.js';

export type HudHost = 'claude' | 'copilot';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detect the HUD host.
 *
 * 1. Payload shape. Fields only Copilot CLI's statusline builder emits
 *    (1.0.103) mean `copilot`; fields only Claude Code emits, or a
 *    `.claude/projects/...jsonl` transcript, mean `claude`.
 * 2. The host env signal (COPILOT_CLI / COPILOT_AGENT_SESSION_ID first, then
 *    CLAUDE_CODE_ENTRYPOINT).
 * 3. `claude`. Unlike detectHostCliType, the HUD does not default to copilot:
 *    an unknown payload keeps upstream Claude Code behaviour (parity).
 */
export function detectHudHost(
  stdin: StatuslineStdin | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HudHost {
  const payload: Record<string, unknown> = isObject(stdin) ? (stdin as Record<string, unknown>) : {};
  const cost = isObject(payload.cost) ? payload.cost : {};
  const contextWindow = isObject(payload.context_window) ? payload.context_window : {};
  const remote = isObject(payload.remote) ? payload.remote : {};

  if (
    'ai_used' in payload ||
    'allow_all_enabled' in payload ||
    'connected' in remote ||
    'total_premium_requests' in cost ||
    'current_context_used_percentage' in contextWindow
  ) {
    return 'copilot';
  }

  const transcriptPath = typeof payload.transcript_path === 'string'
    ? payload.transcript_path.replace(/\\/g, '/')
    : '';
  if (
    'output_style' in payload ||
    'exceeds_200k_tokens' in payload ||
    'rate_limits' in payload ||
    (/\/\.claude\/projects\//.test(transcriptPath) && transcriptPath.endsWith('.jsonl'))
  ) {
    return 'claude';
  }

  return detectHostCliSignal(env) ?? 'claude';
}
