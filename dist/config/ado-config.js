import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Read .omcp/config.json from the given directory (or cwd).
 * Returns null if the file doesn't exist.
 */
export function readOmpConfig(dir) {
    const base = dir || process.cwd();
    const configPath = join(base, '.omcp', 'config.json');
    if (!existsSync(configPath))
        return null;
    try {
        const raw = readFileSync(configPath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Get ADO config, merging .omcp/config.json with git remote detection.
 * Config file values take precedence over auto-detected values.
 */
export function getAdoConfig(dir) {
    const config = readOmpConfig(dir);
    return config?.ado ?? {};
}
//# sourceMappingURL=ado-config.js.map