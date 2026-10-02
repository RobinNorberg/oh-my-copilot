/**
 * Host CLI Detection
 *
 * Detects which CLI host this plugin is running under.
 * Enables host-agnostic behavior so oh-my-copilot can work
 * inside both Copilot CLI and Claude Code.
 */
import type { CliAgentType } from '../team/model-contract.js';
export { detectHostCliType } from './host-signal.js';
/**
 * Detect which CLI host this plugin is running under.
 * See detectHostCliType for the signal order.
 */
export declare function getHostCliType(): CliAgentType;
/**
 * Get the binary name for the detected host CLI.
 * Convenience wrapper over getContract(getHostCliType()).binary.
 */
export declare function getHostCliBinary(): string;
//# sourceMappingURL=host-detection.d.ts.map