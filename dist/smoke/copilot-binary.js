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
export function resolveCopilotBinary(override, env, deps = {}) {
    const exists = deps.existsSync ?? existsSync;
    const resolve = deps.resolveExecutable ?? ((name) => resolveExecutable(name));
    const list = deps.readdirSync ?? ((p) => readdirSync(p));
    const platform = deps.platform ?? process.platform;
    if (override) {
        if (exists(override))
            return { bin: override, source: 'override' };
        const found = resolve(override);
        return found ? { bin: found, source: 'override' } : { bin: null, source: null };
    }
    const onPath = resolve('copilot');
    if (onPath)
        return { bin: onPath, source: 'path' };
    const envPath = env.COPILOT_CLI_PATH?.trim();
    if (envPath && exists(envPath))
        return { bin: envPath, source: 'COPILOT_CLI_PATH' };
    if (platform === 'win32' && env.LOCALAPPDATA) {
        const packagesDir = join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
        try {
            for (const entry of list(packagesDir).filter((name) => /^GitHub\.Copilot/i.test(name)).sort()) {
                const candidate = join(packagesDir, entry, 'copilot.exe');
                if (exists(candidate))
                    return { bin: candidate, source: 'winget' };
            }
        }
        catch { /* no WinGet packages dir */ }
    }
    return { bin: null, source: null };
}
/** Extract `x.y.z` from `copilot --version` output ("GitHub Copilot CLI 1.0.91."). */
export function parseCopilotVersion(output) {
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
    return match ? match[1] : null;
}
//# sourceMappingURL=copilot-binary.js.map