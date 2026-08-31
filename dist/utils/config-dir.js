/**
 * Host CLI Configuration Directory Resolution
 *
 * Resolves the active host CLI configuration directory, honouring
 * COPILOT_CONFIG_DIR (absolute path, or ~-prefixed) with fallback to
 * ~/.copilot.  Trailing separators are stripped; filesystem roots are
 * preserved.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/config-dir.mjs   — ESM hook/HUD runtime
 *   scripts/lib/config-dir.cjs   — CJS bridge runtime
 *   scripts/lib/config-dir.sh    — POSIX shell runtime
 */
import { join, normalize, parse, sep } from 'path';
import { homedir } from 'os';
/**
 * Strip a single trailing path separator (preserve filesystem root).
 * @internal Shared with scripts/lib/config-dir.{mjs,cjs,sh} — keep in sync.
 */
function stripTrailingSep(p) {
    if (!p.endsWith(sep)) {
        return p;
    }
    return p === parse(p).root ? p : p.slice(0, -1);
}
/**
 * Resolve the host CLI configuration directory.
 *
 * Honours COPILOT_CONFIG_DIR (absolute path, or ~-prefixed) with fallback
 * to ~/.copilot.  Trailing separators are stripped; filesystem roots are
 * preserved.
 */
export function getCopilotConfigDir() {
    const home = homedir();
    const configured = process.env.COPILOT_CONFIG_DIR?.trim();
    if (!configured) {
        return stripTrailingSep(normalize(join(home, '.copilot')));
    }
    if (configured === '~') {
        return stripTrailingSep(normalize(home));
    }
    if (configured.startsWith('~/') || configured.startsWith('~\\')) {
        return stripTrailingSep(normalize(join(home, configured.slice(2))));
    }
    return stripTrailingSep(normalize(configured));
}
/**
 * Resolve the OMC global configuration/cache directory under the active Claude
 * config dir. This keeps hook/updater/HUD caches aligned with COPILOT_CONFIG_DIR
 * instead of mixing in ~/.omc.
 */
export function getOmcConfigDir() {
    return join(getCopilotConfigDir(), '.omg');
}
/** Resolve the canonical update-check cache file path. */
export function getUpdateCheckCachePath() {
    return join(getOmcConfigDir(), 'update-check.json');
}
//# sourceMappingURL=config-dir.js.map