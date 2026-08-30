import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
 * Read .omg/config.json from the given directory (or cwd).
 * Returns null if the file doesn't exist.
 */
export function readOmpConfig(dir?: string): OmpConfig | null {
  const base = dir || process.cwd();
  const configPath = join(base, '.omg', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
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
