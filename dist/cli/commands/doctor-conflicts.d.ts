/**
 * Conflict diagnostic command
 * Scans for and reports plugin coexistence issues.
 */
export interface ConflictReport {
    hookConflicts: {
        event: string;
        command: string;
        isOmc: boolean;
    }[];
    claudeMdStatus: {
        hasMarkers: boolean;
        hasUserContent: boolean;
        path: string;
        companionFile?: string;
    } | null;
    legacySkills: {
        name: string;
        path: string;
    }[];
    envFlags: {
        disableOmc: boolean;
        skipHooks: string[];
    };
    configIssues: {
        unknownFields: string[];
    };
    windowsUnsafePluginHooks: {
        pluginRoot: string;
        event: string;
        command: string;
    }[];
    hasConflicts: boolean;
}
/**
 * Check for hook conflicts in both profile-level (~/.copilot/settings.json)
 * and project-level (./.copilot/settings.json).
 *
 * Copilot CLI settings precedence: project > profile > defaults.
 * We check both levels so the diagnostic is complete.
 */
export declare function checkHookConflicts(): ConflictReport['hookConflicts'];
/**
 * Native Windows cannot execute plugin hooks that still route through sh/find-node.
 * Detect stale cache manifests so doctor can point users at setup/update repair
 * instead of reporting a generic hook conflict.
 *
 * Fork note: the shipped hooks/hooks.json uses a Copilot dual-shell manifest with
 * `bash`/`powershell` keys (not a single `command`), but stale cache manifests from
 * older OMC versions may still carry a single `command` routed through sh/find-node.
 * We inspect all three keys so legacy and current manifest shapes both surface.
 */
export declare function checkWindowsUnsafePluginHooks(): ConflictReport['windowsUnsafePluginHooks'];
/**
 * Check copilot-instructions.md for OMC markers and user content.
 * Also checks companion files (CLAUDE-omg.md, etc.) for the file-split pattern
 * where users keep OMC config in a separate file.
 */
export declare function checkCopilotMdStatus(): ConflictReport['claudeMdStatus'];
/**
 * Check environment flags that affect OMC behavior
 */
export declare function checkEnvFlags(): ConflictReport['envFlags'];
/**
 * Check for legacy curl-installed skills that collide with plugin skill names.
 * Only flags skills whose names match actual installed plugin skills, avoiding
 * false positives for user's custom skills.
 */
export declare function checkLegacySkills(): ConflictReport['legacySkills'];
/**
 * Check for unknown fields in config files
 */
export declare function checkConfigIssues(): ConflictReport['configIssues'];
/**
 * Run complete conflict check
 */
export declare function runConflictCheck(): ConflictReport;
/**
 * Format report for display
 */
export declare function formatReport(report: ConflictReport, json: boolean): string;
/**
 * Doctor conflicts command
 */
export declare function doctorConflictsCommand(options: {
    json?: boolean;
}): Promise<number>;
//# sourceMappingURL=doctor-conflicts.d.ts.map