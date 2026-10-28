/**
 * The Azure CLI entry point the ADO adapter spawns (factory forges design §6
 * "Windows spawn", §10.4). Resolution only: nothing here spawns.
 *
 * On Windows `az` is `az.cmd`, and the guards refuse `.cmd`/`.bat` shims
 * (the cmd.exe injection class fixed in v5.12.1). The MSI layout's az.cmd
 * (`<CLI2>\wbin\az.cmd`) is two lines of batch:
 *
 *   SET AZ_INSTALLER=MSI
 *   "%~dp0\..\python.exe" -IBm azure.cli %*
 *
 * so the adapter runs that python.exe with `-IBm azure.cli` itself and sets
 * AZ_INSTALLER=MSI in the env as az.cmd does (az reads it for telemetry and
 * `az upgrade`). A pip or winget layout without the bundled python.exe is
 * refused with a clear error; there is no cmd.exe fallback. POSIX runs `az`.
 */

import { win32 } from 'path';

export interface AzEntry {
  /** Absolute python.exe on Windows; `az` elsewhere. */
  command: string;
  /** Arguments before the az ones: `-IBm azure.cli` on Windows. */
  prefix: readonly string[];
  /** Env additions az.cmd would have made. */
  env: Readonly<Record<string, string>>;
}

export interface AzBinaryDeps {
  platform: NodeJS.Platform;
  /** PATH (Windows: `Path` is accepted too). */
  env: Readonly<Record<string, string | undefined>>;
  isFile(path: string): boolean;
  /**
   * Roots a lane or job can write: the repository and its worktrees, lane and
   * job roots. A PATH entry at or under one is never searched for az.cmd.
   */
  untrustedRoots: readonly string[];
}

export const AZ_PYTHON_PREFIX: readonly string[] = Object.freeze(['-IBm', 'azure.cli']);

export class AzBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzBinaryError';
  }
}

function pathEnv(env: AzBinaryDeps['env'], platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key ? env[key] : undefined) ?? '';
}

const fold = (p: string): string => win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const within = (dir: string, root: string): boolean => {
  const d = fold(dir), r = fold(root);
  return d === r || d.startsWith(`${r}\\`);
};

/**
 * Whether a PATH entry may be searched: a drive-absolute path (a relative,
 * drive-relative or `\\` UNC/device entry is refused: it resolves against the
 * checkout or a share), no `node_modules` segment (a dependency can plant
 * `.bin\az.cmd`), and not at or under an untrusted root.
 */
function searchable(dir: string, untrustedRoots: readonly string[]): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(dir)) return false;
  if (win32.resolve(dir).split('\\').some((s) => s.toLowerCase() === 'node_modules')) return false;
  return !untrustedRoots.some((root) => root.trim() !== '' && within(dir, root));
}

/**
 * Resolve the az entry point once. Windows: the first searchable PATH entry
 * holding az.cmd wins, and it must be the MSI layout: `<dir>\..\python.exe`
 * next to `<dir>\..\Lib\site-packages\azure\cli` (checked through its
 * `__main__.py`, the module `-m azure.cli` runs).
 */
export function resolveAzEntry(deps: AzBinaryDeps): AzEntry {
  if (deps.platform !== 'win32') return { command: 'az', prefix: [], env: {} };
  const dirs = pathEnv(deps.env, deps.platform)
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && searchable(d, deps.untrustedRoots));
  const azCmd = dirs.map((d) => win32.join(win32.resolve(d), 'az.cmd')).find((p) => deps.isFile(p));
  if (!azCmd) {
    throw new AzBinaryError(
      'Azure CLI not found: no az.cmd on a drive-absolute PATH entry outside node_modules and the repository, lane and job roots. Install it with the MSI (https://aka.ms/installazurecliwindows).',
    );
  }
  const python = win32.resolve(win32.dirname(azCmd), '..', 'python.exe');
  const cliPackage = win32.resolve(win32.dirname(azCmd), '..', 'Lib', 'site-packages', 'azure', 'cli');
  if (!deps.isFile(python) || !deps.isFile(win32.join(cliPackage, '__main__.py'))) {
    throw new AzBinaryError(
      `Azure CLI at ${azCmd} has no bundled ${python} with ${cliPackage} (not the MSI layout). omg runs az through that python, never through cmd.exe; reinstall the Azure CLI with the MSI (https://aka.ms/installazurecliwindows).`,
    );
  }
  return { command: python, prefix: AZ_PYTHON_PREFIX, env: { AZ_INSTALLER: 'MSI' } };
}
