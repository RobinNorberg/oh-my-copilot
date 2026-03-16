import { homedir } from "node:os";
import { join } from "node:path";
export function getConfigDir() {
    return process.env.COPILOT_CONFIG_DIR || join(homedir(), ".copilot");
}
//# sourceMappingURL=config-dir.js.map