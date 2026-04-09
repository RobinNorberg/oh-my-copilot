/**
 * Host CLI Detection
 *
 * Detects which CLI host this plugin is running under.
 * Enables host-agnostic behavior so oh-my-copilot can work
 * inside both Copilot CLI and Claude Code.
 */
/**
 * Detect which CLI host this plugin is running under.
 *
 * Detection order:
 * 1. CLAUDE_CODE_ENTRYPOINT — set by Claude Code when running plugins
 * 2. Default — 'copilot' (this fork's identity)
 */
export function getHostCliType() {
    if (process.env.CLAUDE_CODE_ENTRYPOINT)
        return 'claude';
    return 'copilot';
}
//# sourceMappingURL=host-detection.js.map