/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */
export interface OmcUpdateState {
    /** Version to advertise as an update, else null */
    updateAvailable: string | null;
    /** Newer installed version the HUD wrapper skipped because it has no built HUD, else null */
    unbuiltVersion: string | null;
}
/**
 * Decide what the HUD says about newer OMC versions.
 *
 * The HUD wrapper keeps rendering the previous built version while a newer
 * cached version has no dist/hud/index.js, and reports that version through
 * OMC_HUD_UNBUILT_VERSION. That version is already installed, so the update
 * command cannot deliver it: it is reported as unbuilt rather than as an
 * update. A latest version above the unbuilt one is still a real update.
 */
export declare function resolveOmcUpdateState(omcVersion: string | null, latestVersion: unknown, unbuiltVersionEnv: string | undefined): OmcUpdateState;
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
    /** Newer installed OMC version that has no built HUD, else null */
    omcUnbuiltVersion?: string | null;
    /** OMC version this HUD is running */
    omcVersion?: string | null;
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