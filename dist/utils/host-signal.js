/**
 * Pure host-CLI signal detection, free of imports so both
 * team/model-contract.ts and utils/host-detection.ts can use it without a cycle.
 */
/**
 * Detect the host CLI from an environment.
 *
 * 1. COPILOT_CLI / COPILOT_AGENT_SESSION_ID — set by Copilot CLI (1.0.88)
 *    for every process it spawns. Checked first because Copilot sessions
 *    started from a Claude Code shell inherit CLAUDE_CODE_ENTRYPOINT.
 * 2. CLAUDE_CODE_ENTRYPOINT — set by Claude Code (and by this fork's own
 *    child processes). CLAUDECODE is deliberately not consulted: it adds no
 *    signal beyond CLAUDE_CODE_ENTRYPOINT inside Claude Code and would leak
 *    into more child environments.
 * 3. Default — 'copilot' (this fork's identity).
 */
export function detectHostCliType(env = process.env) {
    if (env.COPILOT_CLI || env.COPILOT_AGENT_SESSION_ID)
        return 'copilot';
    if (env.CLAUDE_CODE_ENTRYPOINT)
        return 'claude';
    return 'copilot';
}
//# sourceMappingURL=host-signal.js.map