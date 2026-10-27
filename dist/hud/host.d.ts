/**
 * OMC HUD - Host detection
 *
 * Decides which host CLI fed the statusline payload. The payload shape is the
 * primary signal because `--watch` mode replays a cached payload outside any
 * host process, where the environment says nothing about the original host.
 */
import type { StatuslineStdin } from './types.js';
export type HudHost = 'claude' | 'copilot';
/**
 * Detect the HUD host.
 *
 * 1. Payload shape. Fields only Copilot CLI's statusline builder emits
 *    (1.0.103) mean `copilot`; fields only Claude Code emits, or a
 *    `.claude/projects/...jsonl` transcript, mean `claude`.
 * 2. The host env signal (COPILOT_CLI / COPILOT_AGENT_SESSION_ID first, then
 *    CLAUDE_CODE_ENTRYPOINT). The hooks rank these the other way round:
 *    scripts/lib/hook-host.mjs and session-start.mjs let CLAUDE_CODE_ENTRYPOINT
 *    win over an inherited COPILOT_CLI. The HUD can afford the payload shape
 *    deciding first, because the statusline payload comes from the host that
 *    is rendering it, while a hook process may be spawned from a shell that
 *    inherited the other host's variables.
 * 3. `claude`. Unlike detectHostCliType, the HUD does not default to copilot:
 *    an unknown payload keeps upstream Claude Code behaviour (parity).
 */
export declare function detectHudHost(stdin: StatuslineStdin | null | undefined, env?: NodeJS.ProcessEnv): HudHost;
//# sourceMappingURL=host.d.ts.map