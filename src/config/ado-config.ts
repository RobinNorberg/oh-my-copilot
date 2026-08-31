import { readFileSync, existsSync } from 'node:fs';
import { resolveOmcPath } from '../lib/worktree-paths.js';

export interface AdoConfig {
  org?: string;
  project?: string;
  defaultWorkItemType?: string;
  areaPath?: string;
  iterationPath?: string;
  /** When code repo and work items live in different ADO projects */
  workItemOrg?: string;
  workItemProject?: string;
}

export interface OmpConfig {
  version?: number;
  platform?: string;
  ado?: AdoConfig;
}

/**
 * Read config.json from the OMC state root for the given directory (or cwd).
 * Resolution goes through resolveOmcPath so OMC_STATE_DIR and .omc-workspace
 * anchoring apply, rather than assuming a literal `<dir>/.omg`.
 * Returns null if the file doesn't exist or cannot be read.
 */
export function readOmpConfig(dir?: string): OmpConfig | null {
  try {
    const configPath = resolveOmcPath('config.json', dir);
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as OmpConfig;
  } catch {
    return null;
  }
}

/**
 * Get ADO config, merging .omg/config.json with git remote detection.
 * Config file values take precedence over auto-detected values.
 */
export function getAdoConfig(dir?: string): AdoConfig {
  const config = readOmpConfig(dir);
  return config?.ado ?? {};
}
