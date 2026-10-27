/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */
import { RESET } from '../colors.js';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
/** Copilot CLI plugin update; the marketplace clone is refreshed first, as in the Claude hint. */
const COPILOT_PLUGIN_UPDATE = '! copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc';
const NPM_UPDATE = '! npm i -g oh-my-copilot@latest';
/**
 * Render update hint detail lines (one per product, empty when up to date).
 *
 * The OMC command follows the install channel recorded by the session-start
 * update check: plugin installs cannot be updated through npm.
 */
export function renderUpdateHints(input) {
    const lines = [];
    const copilot = input.host === 'copilot';
    if (input.omcUpdateAvailable) {
        let command = NPM_UPDATE;
        if (input.omcUpdateSource === 'copilot-plugin' || (copilot && input.omcUpdateSource === 'marketplace')) {
            command = COPILOT_PLUGIN_UPDATE;
        }
        else if (input.omcUpdateSource === 'marketplace') {
            command = '! claude plugin marketplace update omc && claude plugin update oh-my-copilot@omc';
        }
        lines.push(`${YELLOW}${BOLD}[!] omg ${input.omcUpdateAvailable} - paste: ${command}${RESET}`);
    }
    if (!copilot && input.claudeCodeUpdateAvailable) {
        lines.push(`${YELLOW}${BOLD}[!] claude ${input.claudeCodeUpdateAvailable} - paste: ! claude update${RESET}`);
    }
    return lines;
}
/**
 * Pick the OMC update to show from the shared update-check cache.
 *
 * The cache is shared by every install channel on the machine, so it is only
 * trusted when it was written for this HUD's own channel and installed
 * version (caches without a source are npm, as in session-start). Otherwise
 * no OMC hint is shown rather than a command for the wrong channel.
 */
export function resolveCachedOmcUpdate(cached, installedVersion, channel, compareVersions) {
    if (!cached?.latestVersion || !installedVersion)
        return null;
    const sameChannel = cached.source === channel || (!cached.source && channel === 'npm');
    if (!sameChannel || cached.currentVersion !== installedVersion)
        return null;
    if (compareVersions(installedVersion, cached.latestVersion) >= 0)
        return null;
    return { latestVersion: cached.latestVersion, source: channel };
}
//# sourceMappingURL=update-hint.js.map