import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCopilotConfigDir } from './config-dir.js';
let _cachedStrictMode;
function readOmcConfig() {
    try {
        const configPath = join(getCopilotConfigDir(), '.omc-config.json');
        if (!existsSync(configPath))
            return {};
        const raw = readFileSync(configPath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
/**
 * Returns true if strict mode is enabled.
 * Reads `strictMode` from ~/.copilot/.omc-config.json (default: true).
 * Users opt out by setting `strictMode: false`.
 */
export function isStrictMode() {
    if (_cachedStrictMode !== undefined) {
        return _cachedStrictMode;
    }
    const config = readOmcConfig();
    _cachedStrictMode = config.strictMode !== false;
    return _cachedStrictMode;
}
//# sourceMappingURL=strict-mode.js.map