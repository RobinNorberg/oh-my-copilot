/**
 * Platform probes for tests that cannot run identically on every host.
 *
 * The skip helpers return true when the test must be skipped, so they read
 * directly inside `it.skipIf(...)` / `describe.skipIf(...)`. Gate only what the
 * host cannot do (POSIX mode bits, unprivileged symlinks, a missing binary);
 * a product path that is supposed to work on Windows gets a fix, not a gate.
 * See .omc/skills/windows-test-conventions.md.
 */
import { accessSync, constants, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { pathToFileURL } from 'url';

export const IS_WIN = process.platform === 'win32';

let symlinkProbe: boolean | undefined;
let junctionProbe: boolean | undefined;
const executableCache = new Map<string, boolean>();

function probe(create: (dir: string) => void): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'omc-platform-probe-'));
  try {
    create(dir);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Directory and file symlinks both work. Windows without Developer Mode or
 * elevation refuses both with EPERM.
 */
export function canCreateSymlinks(): boolean {
  symlinkProbe ??= probe(dir => {
    writeFileSync(join(dir, 'file'), '');
    symlinkSync(join(dir, 'file'), join(dir, 'file-link'), 'file');
    symlinkSync(dir, join(dir, 'dir-link'), 'dir');
  });
  return symlinkProbe;
}

/** Directory junctions work (unprivileged on Windows; a plain dir symlink elsewhere). */
export function canCreateJunctions(): boolean {
  junctionProbe ??= probe(dir => symlinkSync(dir, join(dir, 'junction'), 'junction'));
  return junctionProbe;
}

/** The Microsoft Store python alias opens the Store instead of running Python. */
function isWindowsAppsPythonStub(dir: string, name: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(dir) && /^python(3(\.\d+)?)?(\.exe)?$/i.test(name);
}

/** `name` resolves on PATH (with PATHEXT on Windows), without spawning a shell. */
export function hasExecutable(name: string): boolean {
  const path = process.env.PATH ?? process.env.Path ?? '';
  const pathExt = IS_WIN ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD') : '';
  const key = `${name}\0${path}\0${pathExt}`;
  const cached = executableCache.get(key);
  if (cached !== undefined) return cached;

  const extensions = IS_WIN && !/\.[^\\/]+$/.test(name) ? pathExt.split(';').filter(Boolean) : [''];
  const found = path.split(delimiter).filter(Boolean).some(dir => extensions.some(ext => {
    const candidate = `${name}${ext}`;
    if (IS_WIN && isWindowsAppsPythonStub(dir, candidate)) return false;
    try {
      const file = join(dir, candidate);
      if (!statSync(file).isFile()) return false;
      if (!IS_WIN) accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
  executableCache.set(key, found);
  return found;
}

/** `file://` URL string for a native path (`file:///C:/...` on Windows). */
export function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** Forward-slash form of a native path, for separator-agnostic assertions. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Skip on Windows. `reason` names the POSIX-only behavior so the call site
 * documents itself, e.g. `posixOnly('NTFS has no POSIX mode bits')`.
 */
export function posixOnly(reason: string): boolean {
  void reason;
  return IS_WIN;
}

/** Skip when the host cannot create symlinks. */
export function requiresSymlinks(): boolean {
  return !canCreateSymlinks();
}

/** Skip when `name` is not on PATH. */
export function requiresExecutable(name: string): boolean {
  return !hasExecutable(name);
}
