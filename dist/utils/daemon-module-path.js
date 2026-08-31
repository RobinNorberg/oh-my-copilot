import { posix, win32 } from 'path';
/**
 * Resolve the module path used by forked daemon bootstrap scripts.
 *
 * - In source execution (*.ts), convert to the sibling compiled *.js path.
 * - In bundled CJS execution (bridge/cli.cjs), resolve to the dist module path.
 * - Otherwise keep the original path.
 */
export function resolveDaemonModulePath(currentFilename, distSegments) {
    const isWindowsStylePath = /^[a-zA-Z]:\\/.test(currentFilename) || currentFilename.includes('\\');
    // Follow the shape of the incoming path, not the host platform: joining a
    // POSIX path with win32 separators yields a mixed-separator module path.
    const pathApi = isWindowsStylePath ? win32 : posix;
    const tsCompiledPath = currentFilename.replace(/\.ts$/, '.js');
    if (tsCompiledPath !== currentFilename) {
        return tsCompiledPath;
    }
    const currentDir = pathApi.dirname(currentFilename);
    const inBundledCli = pathApi.basename(currentFilename) === 'cli.cjs' && pathApi.basename(currentDir) === 'bridge';
    if (inBundledCli) {
        return pathApi.join(currentDir, '..', 'dist', ...distSegments);
    }
    return currentFilename;
}
//# sourceMappingURL=daemon-module-path.js.map