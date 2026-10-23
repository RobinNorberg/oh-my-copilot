/**
 * Which host CLI is running this hook script.
 *
 * Copilot CLI runs the fork's hooks only through copilot/hooks.json, which
 * sets OMC_HOOK_EVENT for every entry (scripts/copilot/build-hooks.mjs,
 * scripts/copilot/dispatch.cjs). Claude Code never sets it
 * (scripts/lib/copilot-hook-adapter.cjs relies on the same contract). The
 * COPILOT_CLI env var is not used here: a Claude Code session started from a
 * Copilot shell inherits it, while it cannot inherit OMC_HOOK_EVENT from a
 * hook process.
 */
export function isCopilotHookHost(env = process.env) {
  return typeof env.OMC_HOOK_EVENT === 'string' && env.OMC_HOOK_EVENT.trim() !== '';
}

/** Copilot's skill tool is lowercase `skill`; Claude Code's is `Skill`. */
export function isSkillToolName(toolName) {
  return typeof toolName === 'string' && toolName.toLowerCase() === 'skill';
}
