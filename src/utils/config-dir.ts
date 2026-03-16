import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigDir(): string {
  return process.env.COPILOT_CONFIG_DIR || join(homedir(), ".copilot");
}
