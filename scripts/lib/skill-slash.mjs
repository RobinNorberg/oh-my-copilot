/**
 * Hook-script twin of src/utils/skill-slash.ts: the slash command the running
 * host resolves for a bundled skill. Copilot CLI registers plugin skills by
 * their bare name (`/cancel`) and rejects `/oh-my-copilot:cancel`; Claude Code
 * registers them as `/oh-my-copilot:<name>`. The host comes from hook-host.mjs.
 */
import { isCopilotHookHost } from './hook-host.mjs';

export function skillSlash(name, env = process.env) {
  return isCopilotHookHost(env) ? `/${name}` : `/oh-my-copilot:${name}`;
}
