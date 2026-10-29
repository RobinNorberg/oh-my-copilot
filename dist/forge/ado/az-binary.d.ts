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
     * The real path of an existing file or directory (production:
     * fs.realpathSync.native, which resolves 8.3 short names, junctions and
     * symlinks); throws when it does not exist.
     */
    realpath(path: string): string;
    /**
     * Roots a lane or job can write: the repository and its worktrees, lane and
     * job roots. A PATH entry whose real path is at or under one is never
     * searched for az.cmd. Required (non-empty) on Windows.
     */
    untrustedRoots: readonly string[];
}
export declare const AZ_PYTHON_PREFIX: readonly string[];
export declare class AzBinaryError extends Error {
    constructor(message: string);
}
/**
 * Resolve the az entry point once. Windows: the first searchable PATH entry
 * holding az.cmd wins, and it must be the MSI layout: `<dir>\..\python.exe`
 * next to `<dir>\..\Lib\site-packages\azure\cli` (checked through its
 * `__main__.py`, the module `-m azure.cli` runs). PATH entries and roots
 * compare by real path, so an 8.3 short name or a junction cannot alias a
 * root, and the python.exe found must itself be outside the roots.
 */
export declare function resolveAzEntry(deps: AzBinaryDeps): AzEntry;
//# sourceMappingURL=az-binary.d.ts.map