/**
 * Host CLI Detection
 *
 * Detects which CLI host this plugin is running under.
 * Enables host-agnostic behavior so oh-my-copilot can work
 * inside both Copilot CLI and Claude Code.
 */
import { getContract } from '../team/model-contract.js';
import { detectHostCliType } from './host-signal.js';
export { detectHostCliType } from './host-signal.js';
/**
 * Detect which CLI host this plugin is running under.
 * See detectHostCliType for the signal order.
 */
export function getHostCliType() {
    return detectHostCliType(process.env);
}
/**
 * Get the binary name for the detected host CLI.
 * Convenience wrapper over getContract(getHostCliType()).binary.
 */
export function getHostCliBinary() {
    return getContract(getHostCliType()).binary;
}
//# sourceMappingURL=host-detection.js.map