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
import { delimiter, isAbsolute, join } from 'path';
import { pathToFileURL } from 'url';
export const IS_WIN = process.platform === 'win32';
let symlinkProbe;
let junctionProbe;
const executableCache = new Map();
function probe(create) {
    let dir;
    try {
        dir = mkdtempSync(join(tmpdir(), 'omc-platform-probe-'));
        create(dir);
        return true;
    }
    catch {
        return false;
    }
    finally {
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
}
/**
 * Directory and file symlinks both work. Windows without Developer Mode or
 * elevation refuses both with EPERM.
 */
export function canCreateSymlinks() {
    symlinkProbe ??= probe(dir => {
        writeFileSync(join(dir, 'file'), '');
        symlinkSync(join(dir, 'file'), join(dir, 'file-link'), 'file');
        symlinkSync(dir, join(dir, 'dir-link'), 'dir');
    });
    return symlinkProbe;
}
/** Directory junctions work (unprivileged on Windows; a plain dir symlink elsewhere). */
export function canCreateJunctions() {
    junctionProbe ??= probe(dir => symlinkSync(dir, join(dir, 'junction'), 'junction'));
    return junctionProbe;
}
/** The Microsoft Store python alias opens the Store instead of running Python. */
function isWindowsAppsPythonStub(dir, name) {
    return /[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(dir) && /^python(3(\.\d+)?)?(\.exe)?$/i.test(name);
}
/** `name` resolves on PATH (with PATHEXT on Windows), without spawning a shell. */
export function hasExecutable(name) {
    const path = process.env.PATH ?? process.env.Path ?? '';
    const pathExt = IS_WIN ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD') : '';
    const key = `${name}\0${path}\0${pathExt}`;
    const cached = executableCache.get(key);
    if (cached !== undefined)
        return cached;
    const pathExts = pathExt.split(';').filter(Boolean);
    const ownExt = /\.[^\\/.]+$/.exec(name)?.[0].toLowerCase();
    const hasPathExt = ownExt !== undefined && pathExts.some(ext => ext.toLowerCase() === ownExt);
    const extensions = IS_WIN && !hasPathExt ? ['', ...pathExts] : [''];
    const isRunnable = (file) => {
        try {
            if (!statSync(file).isFile())
                return false;
            if (!IS_WIN)
                accessSync(file, constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    };
    const found = isAbsolute(name)
        ? extensions.some(ext => isRunnable(`${name}${ext}`))
        : path.split(delimiter).filter(Boolean).some(dir => extensions.some(ext => {
            const candidate = `${name}${ext}`;
            if (IS_WIN && isWindowsAppsPythonStub(dir, candidate))
                return false;
            return isRunnable(join(dir, candidate));
        }));
    executableCache.set(key, found);
    return found;
}
/** `file://` URL string for a native path (`file:///C:/...` on Windows). */
export function toFileUrl(path) {
    return pathToFileURL(path).href;
}
/** Forward-slash form of a native path, for separator-agnostic assertions. */
export function toPosix(path) {
    return path.replace(/\\/g, '/');
}
/** Multiplier for wall-clock ceilings tuned on Linux; process spawn and fs calls are several times slower on Windows. */
export const TIMING_SCALE = IS_WIN ? 4 : 1;
/** Scale a Linux-tuned wall-clock ceiling for the host. Identity on Linux and macOS. */
export function scaleTiming(ms) {
    return ms * TIMING_SCALE;
}
/**
 * Skip on Windows. `reason` names the POSIX-only behavior so the call site
 * documents itself, e.g. `posixOnly('NTFS has no POSIX mode bits')`.
 */
export function posixOnly(reason) {
    void reason;
    return IS_WIN;
}
/** Skip when the host cannot create symlinks. */
export function requiresSymlinks() {
    return !canCreateSymlinks();
}
/** Skip when `name` is not on PATH. */
export function requiresExecutable(name) {
    return !hasExecutable(name);
}
//# sourceMappingURL=platform.js.map