import { homedir } from "node:os";
import { join } from "node:path";
export function getConfigDir() {
    return process.env.COPILOT_CONFIG_DIR || join(homedir(), ".copilot");
}
/** Alias for getConfigDir — matches upstream's getClaudeConfigDir rename */
export { getConfigDir as getCopilotConfigDir };
/** Alias for getConfigDir — matches upstream's getClaudeConfigDir name used in ported modules */
export { getConfigDir as getClaudeConfigDir };
//# sourceMappingURL=config-dir.js.map