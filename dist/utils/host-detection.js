/**
 * Host CLI Detection
 *
 * Detects which CLI host this plugin is running under.
 * Enables host-agnostic behavior so oh-my-copilot can work
 * inside both Copilot CLI and Claude Code.
 */
import { getContract } from '../team/model-contract.js';
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
/**
 * Get the binary name for the detected host CLI.
 * Convenience wrapper over getContract(getHostCliType()).binary.
 */
export function getHostCliBinary() {
    return getContract(getHostCliType()).binary;
}
//# sourceMappingURL=host-detection.js.map