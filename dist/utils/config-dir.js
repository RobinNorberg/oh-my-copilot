/**
 * Copilot CLI Configuration Directory Resolution
 *
 * Resolves the active Copilot CLI configuration directory, honouring
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
 * Resolve the Copilot CLI configuration directory.
 *
 * Honours COPILOT_CONFIG_DIR (absolute path, or ~-prefixed) with fallback
 * to ~/.copilot.  Trailing separators are stripped; filesystem roots are
 * preserved.
 */
export function getConfigDir() {
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
/** Alias — used throughout the fork codebase */
export { getConfigDir as getCopilotConfigDir };
/** Alias — used by modules ported directly from upstream */
export { getConfigDir as getClaudeConfigDir };
//# sourceMappingURL=config-dir.js.map