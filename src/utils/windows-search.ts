/**
 * Windows executable search hardening.
 *
 * On Windows a child spawned by bare name (`git`, `npm`, `gh`) is looked up in
 * the current directory before PATH unless NoDefaultCurrentDirectoryInExePath
 * is set, so a `git.exe` or `git.cmd` planted in the project folder runs
 * instead of the real one. cmd.exe (`shell: true`, exec) reads the child's env
 * block and honours the variable on every version. libuv's own lookup (no
 * shell) reads the parent's environment but honours it only from libuv 1.48
 * (Node 22); on Node 20 a bare no-shell spawn still searches the current
 * directory, so those spawns also go through resolveBareExe().
 * Every entry point therefore hardens its own environment first, and any
 * explicit `env:` built without process.env goes through childEnv().
 * ESM evaluates every import before the entry's body calls the hardening, so
 * nothing an entry point imports may spawn at module-load time.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/windows-search.cjs   — CJS hook/script runtime
 *   scripts/lib/windows-search.mjs   — ESM re-export of the CJS runtime
 */

import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

function isVariable(key: string): boolean {
  return key.toUpperCase() === VARIABLE.toUpperCase();
}

/** Turn off the current-directory search for this process and every child that inherits its env. No-op off win32. */
export function hardenWindowsExeSearch(): void {
  if (process.platform !== 'win32') return;
  for (const key of Object.keys(process.env)) {
    if (isVariable(key)) delete process.env[key];
  }
  process.env[VARIABLE] = '1';
}

/** A copy of `env` that keeps the current-directory search off in the child (win32 only). */
export function childEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (process.platform !== 'win32' || !isVariable(key)) out[key] = value;
  }
  if (process.platform === 'win32') out[VARIABLE] = '1';
  return out as T;
}

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  const value = key === undefined ? undefined : env[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * `name` on `env`'s PATH (PATHEXT on win32), or null. Empty and relative
 * entries are skipped, and so is any entry under a `node_modules` dir (npx
 * and npm scripts put `node_modules/.bin` first, so a package's shim would
 * stand in for the host git that `git --exec-path` runs).
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean = isFile): string | null {
  const P = platform === 'win32' ? win32 : posix;
  const exts = platform === 'win32' ? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const inNodeModules = platform === 'win32' ? /(^|[\\/])node_modules([\\/]|$)/i : /(^|\/)node_modules(\/|$)/;
  for (const raw of (envValue(env, 'PATH') ?? '').split(P.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !P.isAbsolute(dir) || inNodeModules.test(dir)) continue;
    for (const ext of exts) if (exists(P.join(dir, name + ext))) return P.join(dir, name + ext);
  }
  return null;
}

/**
 * Absolute path of a bare `cmd` for a no-shell spawn on win32, or null when
 * no PATH entry holds a directly runnable one. libuv before 1.48 (Node 20)
 * searches the current directory for a bare name even with
 * NoDefaultCurrentDirectoryInExePath set, so the name is resolved against
 * absolute PATH entries first. `.cmd`/`.bat` are not candidates: they need
 * cmd.exe, which honours the variable on every version. Off win32, or for a
 * name that already has a path, `cmd` comes back unchanged.
 */
export function resolveBareExe(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32' || /[\\/:]/.test(cmd)) return cmd;
  const pathext = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e && !/^\.(cmd|bat)$/i.test(e)).join(';');
  return findOnPath(cmd, { ...env, PATHEXT: pathext }, 'win32');
}
