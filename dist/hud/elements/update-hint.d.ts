/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */
export interface UpdateHintInput {
    /** Latest OMC version when an update is available, else null */
    omcUpdateAvailable: string | null;
    /**
     * Update channel the OMC update belongs to: 'marketplace' is a Claude Code
     * plugin install, 'copilot-plugin' a Copilot CLI plugin install.
     */
    omcUpdateSource: 'npm' | 'marketplace' | 'copilot-plugin' | null;
    /** Latest Claude Code version when an update is available, else null */
    claudeCodeUpdateAvailable: string | null;
    /** Host CLI; under Copilot no Claude Code line is ever rendered */
    host?: 'claude' | 'copilot';
}
/**
 * Render update hint detail lines (one per product, empty when up to date).
 *
 * The OMC command follows the install channel recorded by the session-start
 * update check: plugin installs cannot be updated through npm.
 */
export declare function renderUpdateHints(input: UpdateHintInput): string[];
/**
 * Pick the OMC update to show from the shared update-check cache.
 *
 * The cache is shared by every install channel on the machine, so it is only
 * trusted when it was written for this HUD's own channel and installed
 * version (caches without a source are npm, as in session-start). Otherwise
 * no OMC hint is shown rather than a command for the wrong channel.
 */
export declare function resolveCachedOmcUpdate(cached: {
    latestVersion?: string;
    source?: string;
    currentVersion?: string;
} | null | undefined, installedVersion: string | null, channel: 'npm' | 'marketplace' | 'copilot-plugin', compareVersions: (a: string, b: string) => number): {
    latestVersion: string;
    source: 'npm' | 'marketplace' | 'copilot-plugin';
} | null;
//# sourceMappingURL=update-hint.d.ts.map