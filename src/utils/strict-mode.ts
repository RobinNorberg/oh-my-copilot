import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCopilotConfigDir } from './config-dir.js';

interface OmcConfig {
  strictMode?: boolean;
}

let _cachedStrictMode: boolean | undefined;

function readOmcConfig(): OmcConfig {
  try {
    const configPath = join(getCopilotConfigDir(), '.omc-config.json');
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as OmcConfig;
  } catch {
    return {};
  }
}

/**
 * Returns true if strict mode is enabled.
 * Checks OMC_STRICT_MODE env var first, then ~/.copilot/.omc-config.json (default: false).
 * Users opt in by setting `strictMode: true` or OMC_STRICT_MODE=true.
 */
export function isStrictMode(): boolean {
  // Always honour the env var (overrides config file and skips cache)
  const envVar = process.env.OMC_STRICT_MODE;
  if (envVar !== undefined) {
    return envVar === 'true';
  }

  if (_cachedStrictMode !== undefined) {
    return _cachedStrictMode;
  }
  const config = readOmcConfig();
  _cachedStrictMode = config.strictMode === true;
  return _cachedStrictMode;
}
