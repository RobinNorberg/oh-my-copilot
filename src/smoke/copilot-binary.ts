/**
 * Locate the GitHub Copilot CLI binary for `omg smoke copilot`.
 *
 * Order: explicit override, PATH (+PATHEXT on win32), COPILOT_CLI_PATH, then
 * on win32 the WinGet package directory (WinGet installs do not always land on
 * PATH for every shell).
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveExecutable } from '../platform/executable-resolution.js';

export interface BinaryResolution {
  bin: string | null;
  source: 'override' | 'path' | 'COPILOT_CLI_PATH' | 'winget' | null;
}

export interface BinaryResolverDeps {
  resolveExecutable?: (name: string) => string | undefined;
  existsSync?: (p: string) => boolean;
  readdirSync?: (p: string) => string[];
  platform?: NodeJS.Platform;
}

export function resolveCopilotBinary(
  override: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: BinaryResolverDeps = {},
): BinaryResolution {
  const exists = deps.existsSync ?? existsSync;
  const resolve = deps.resolveExecutable ?? ((name: string) => resolveExecutable(name));
  const list = deps.readdirSync ?? ((p: string) => readdirSync(p));
  const platform = deps.platform ?? process.platform;

  if (override) {
    if (exists(override)) return { bin: override, source: 'override' };
    const found = resolve(override);
    return found ? { bin: found, source: 'override' } : { bin: null, source: null };
  }

  const onPath = resolve('copilot');
  if (onPath) return { bin: onPath, source: 'path' };

  const envPath = env.COPILOT_CLI_PATH?.trim();
  if (envPath && exists(envPath)) return { bin: envPath, source: 'COPILOT_CLI_PATH' };

  if (platform === 'win32' && env.LOCALAPPDATA) {
    const packagesDir = join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of list(packagesDir).filter((name) => /^GitHub\.Copilot/i.test(name)).sort()) {
        const candidate = join(packagesDir, entry, 'copilot.exe');
        if (exists(candidate)) return { bin: candidate, source: 'winget' };
      }
    } catch { /* no WinGet packages dir */ }
  }

  return { bin: null, source: null };
}

/** The Copilot CLI the fork's hooks and smoke are verified against. */
export const TARGET_COPILOT_VERSION = '1.0.91';
/** The newest Copilot CLI the docs audit read (2026-10-23); not yet verified live. */
export const LATEST_DOCUMENTED_COPILOT_VERSION = '1.0.103';

/** Numeric x.y.z comparison (prerelease suffixes ignored): <0, 0, >0. */
export function compareCopilotVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Extract `x.y.z` from `copilot --version` output ("GitHub Copilot CLI 1.0.91."). */
export function parseCopilotVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
  return match ? match[1] : null;
}
