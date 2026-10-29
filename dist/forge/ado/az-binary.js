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
 * refused with a clear error; there is no cmd.exe fallback. POSIX runs the
 * absolute real path of the first trusted `az` on PATH.
 */
import { posix, win32 } from 'path';
export const AZ_PYTHON_PREFIX = Object.freeze(['-IBm', 'azure.cli']);
export class AzBinaryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AzBinaryError';
    }
}
function pathEnv(env, platform) {
    if (platform !== 'win32')
        return env.PATH ?? '';
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    return (key ? env[key] : undefined) ?? '';
}
const fold = (p) => win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const within = (dir, root) => {
    const d = fold(dir), r = fold(root);
    return d === r || d.startsWith(`${r}\\`);
};
/** The real path, or undefined when it does not resolve. */
function real(deps, path) {
    try {
        return deps.realpath(path);
    }
    catch {
        return undefined;
    }
}
/**
 * Whether a PATH entry may be searched: a drive-absolute path (a relative,
 * drive-relative or `\\` UNC/device entry is refused: it resolves against the
 * checkout or a share), no segment ending in `.` or a space (Windows strips
 * those, so `C:\repo.\wbin` is `C:\repo\wbin`; `.` and `..` are refused too),
 * and a real path that resolves, has no `node_modules` segment (a dependency
 * can plant `.bin\az.cmd`) and is not at or under an untrusted root.
 */
function searchable(dir, deps, roots) {
    if (!/^[A-Za-z]:[\\/]/.test(dir))
        return undefined;
    if (dir.slice(3).split(/[\\/]+/).some((s) => s.endsWith('.') || s.endsWith(' ')))
        return undefined;
    const resolved = real(deps, dir);
    if (resolved === undefined || !/^[A-Za-z]:[\\/]/.test(resolved))
        return undefined;
    return trustedPath(resolved, roots) ? win32.resolve(resolved) : undefined;
}
const trustedPath = (path, roots) => !win32.resolve(path).split('\\').some((s) => s.toLowerCase() === 'node_modules') && !roots.some((root) => within(path, root));
const posixWithin = (path, root) => {
    const p = posix.resolve(path), r = posix.resolve(root);
    return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
};
const posixTrusted = (path, roots) => !path.split('/').includes('node_modules') && !roots.some((root) => posixWithin(path, root));
/**
 * POSIX: the first absolute PATH entry (no `.`/`..` segment) whose real
 * path is outside node_modules and the untrusted roots and holds `az`; the
 * entry is that file's real path, itself outside them, so what was checked
 * is what spawns (never a bare `az` looked up again at spawn time).
 */
function resolvePosixAz(deps, given) {
    const roots = given.flatMap((r) => [posix.resolve(r), real(deps, r)].filter((x) => x !== undefined));
    for (const dir of (deps.env.PATH ?? '').split(':')) {
        if (!dir.startsWith('/') || dir.split('/').some((s) => s === '.' || s === '..'))
            continue;
        const realDir = real(deps, dir);
        if (realDir === undefined || !posixTrusted(realDir, roots))
            continue;
        const candidate = posix.join(realDir, 'az');
        if (!deps.isFile(candidate))
            continue;
        const realAz = real(deps, candidate);
        if (realAz === undefined || !realAz.startsWith('/') || !posixTrusted(realAz, roots))
            continue;
        return { command: realAz, prefix: [], env: {} };
    }
    throw new AzBinaryError('Azure CLI not found: no az on an absolute PATH entry outside node_modules and the repository, lane and job roots.');
}
/**
 * Resolve the az entry point once. Windows: the first searchable PATH entry
 * holding az.cmd wins, and it must be the MSI layout: `<dir>\..\python.exe`
 * next to `<dir>\..\Lib\site-packages\azure\cli` (checked through its
 * `__main__.py`, the module `-m azure.cli` runs). PATH entries and roots
 * compare by real path, so an 8.3 short name or a junction cannot alias a
 * root, and the python.exe found must itself be outside the roots.
 */
export function resolveAzEntry(deps) {
    const given = deps.untrustedRoots.filter((r) => r.trim() !== '');
    if (given.length === 0)
        throw new AzBinaryError('Azure CLI resolution needs the repository, worktree, lane and job roots (untrustedRoots)');
    if (deps.platform !== 'win32')
        return resolvePosixAz(deps, given);
    // A root that does not exist yet still counts, at its resolved path.
    const roots = given.flatMap((r) => [win32.resolve(r), real(deps, r)].filter((x) => x !== undefined));
    const dirs = pathEnv(deps.env, deps.platform)
        .split(';')
        .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
        .filter((d) => d !== '')
        .map((d) => searchable(d, deps, roots))
        .filter((d) => d !== undefined);
    const azCmd = dirs.map((d) => win32.join(d, 'az.cmd')).find((p) => deps.isFile(p));
    if (!azCmd) {
        throw new AzBinaryError('Azure CLI not found: no az.cmd on a drive-absolute PATH entry outside node_modules and the repository, lane and job roots. Install it with the MSI (https://aka.ms/installazurecliwindows).');
    }
    const python = win32.resolve(win32.dirname(azCmd), '..', 'python.exe');
    const cliPackage = win32.resolve(win32.dirname(azCmd), '..', 'Lib', 'site-packages', 'azure', 'cli');
    if (!deps.isFile(python) || !deps.isFile(win32.join(cliPackage, '__main__.py'))) {
        throw new AzBinaryError(`Azure CLI at ${azCmd} has no bundled ${python} with ${cliPackage} (not the MSI layout). omg runs az through that python, never through cmd.exe; reinstall the Azure CLI with the MSI (https://aka.ms/installazurecliwindows).`);
    }
    const realPython = real(deps, python);
    if (realPython === undefined || !trustedPath(realPython, roots)) {
        throw new AzBinaryError(`Azure CLI python ${python} resolves into node_modules or a repository, lane or job root`);
    }
    return { command: python, prefix: AZ_PYTHON_PREFIX, env: { AZ_INSTALLER: 'MSI' } };
}
//# sourceMappingURL=az-binary.js.map