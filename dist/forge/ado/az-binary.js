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
/**
 * Resolve the az entry point once. Windows: the first absolute PATH entry
 * holding az.cmd wins (a relative entry would resolve against the checkout,
 * which a lane controls), and `<that dir>\..\python.exe` must exist.
 */
export function resolveAzEntry(deps) {
    if (deps.platform !== 'win32')
        return { command: 'az', prefix: [], env: {} };
    const dirs = pathEnv(deps.env, deps.platform)
        .split(';')
        .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
        .filter((d) => d !== '' && win32.isAbsolute(d) && !d.startsWith('\\\\?\\'));
    const azCmd = dirs.map((d) => win32.join(d, 'az.cmd')).find((p) => deps.isFile(p));
    if (!azCmd)
        throw new AzBinaryError('Azure CLI not found: no az.cmd on an absolute PATH entry. Install it with the MSI (https://aka.ms/installazurecliwindows).');
    const python = win32.resolve(win32.dirname(azCmd), '..', 'python.exe');
    if (!deps.isFile(python)) {
        throw new AzBinaryError(`Azure CLI at ${azCmd} has no bundled ${python} (not the MSI layout). omg runs az through that python, never through cmd.exe; reinstall the Azure CLI with the MSI (https://aka.ms/installazurecliwindows).`);
    }
    return { command: python, prefix: AZ_PYTHON_PREFIX, env: { AZ_INSTALLER: 'MSI' } };
}
//# sourceMappingURL=az-binary.js.map