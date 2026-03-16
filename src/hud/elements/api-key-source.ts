/**
 * OMG HUD - API Key Source Element
 *
 * Detects and renders where the active ANTHROPIC_API_KEY comes from:
 * - 'project': set in .copilot/settings.local.json (project-level)
 * - 'global': set in ~/.copilot/settings.json (user-level)
 * - 'env': present only as an environment variable
 *
 * Never displays the actual key value.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { dim, cyan } from '../colors.js';
import { getCopilotConfigDir } from '../../utils/paths.js';

export type ApiKeySource = 'project' | 'global' | 'env';

/**
 * Check whether a settings file defines ANTHROPIC_API_KEY in its env block.
 */
function settingsFileHasApiKey(filePath: string): boolean {
  // Normalize to forward slashes for cross-platform mock compatibility
  const normalizedPath = filePath.replace(/\\/g, '/');
  try {
    if (!existsSync(normalizedPath)) return false;
    const content = readFileSync(normalizedPath, 'utf-8');
    const settings = JSON.parse(content);
    const env = settings?.env;
    if (typeof env !== 'object' || env === null) return false;
    return 'ANTHROPIC_API_KEY' in env;
  } catch {
    return false;
  }
}

/**
 * Detect where the active ANTHROPIC_API_KEY comes from.
 *
 * Priority:
 * 1. Project-level: .copilot/settings.local.json in cwd
 * 2. Global-level: ~/.copilot/settings.json
 * 3. Environment variable
 *
 * @param cwd - Current working directory (project root)
 * @returns The source identifier, or null if no key is found
 */
export function detectApiKeySource(cwd?: string): ApiKeySource | null {
  // 1. Project-level config
  if (cwd) {
    const projectSettings = join(cwd, '.copilot', 'settings.local.json');
    if (settingsFileHasApiKey(projectSettings)) return 'project';
  }

  // 2. Global config
  const globalSettings = join(getCopilotConfigDir(), 'settings.json');
  if (settingsFileHasApiKey(globalSettings)) return 'global';

  // 3. Environment variable
  if (process.env.ANTHROPIC_API_KEY) return 'env';

  return null;
}

/**
 * Render API key source element.
 *
 * Format: key:project / key:global / key:env
 */
export function renderApiKeySource(source: ApiKeySource | null): string | null {
  if (!source) return null;
  return `${dim('key:')}${cyan(source)}`;
}
