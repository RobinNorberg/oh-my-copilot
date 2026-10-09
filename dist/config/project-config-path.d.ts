/**
 * Project config file location.
 *
 * Canonical: `.copilot/omg.jsonc`. Earlier fork builds read
 * `.copilot/omc.jsonc`, so readers still accept it as a fallback when the
 * canonical file is absent. Writers and docs use the canonical name only, and
 * `omg doctor conflicts` reports a legacy-named file with the rename command
 * instead of renaming it silently.
 */
export declare const PROJECT_CONFIG_DIR = ".copilot";
export declare const PROJECT_CONFIG_FILE = "omg.jsonc";
/** Name earlier fork builds read from `.copilot/`. */
export declare const LEGACY_PROJECT_CONFIG_FILE = "omc.jsonc";
/** Upstream oh-my-claudecode location, still read by a few standalone hooks. */
export declare const UPSTREAM_PROJECT_CONFIG_DIR = ".claude";
export declare function getCanonicalProjectConfigPath(directory?: string): string;
/** Project config candidates in read order: canonical first, then the legacy fork name. */
export declare function getProjectConfigCandidates(directory?: string): string[];
/**
 * The project config file to read: the first existing candidate, or the
 * canonical path when none exists (so callers report the expected location).
 */
export declare function resolveProjectConfigPath(directory?: string): string;
export interface LegacyProjectConfig {
    /** Absolute path of the legacy-named file. */
    legacyPath: string;
    /** Absolute canonical path it should move to. */
    canonicalPath: string;
    /** True when the canonical file also exists, so the legacy file is not read by the loader. */
    canonicalExists: boolean;
    /**
     * Commands that rename the legacy file, run in order, or null when the
     * canonical file already exists. Two entries when the canonical directory
     * must be created first; one entry otherwise.
     */
    renameCommand: string[] | null;
}
/**
 * Legacy-named project config files under `directory`: `.copilot/omc.jsonc`
 * and the upstream `.claude/omc.jsonc`. Never touches the files.
 */
export declare function findLegacyProjectConfigs(directory?: string): LegacyProjectConfig[];
//# sourceMappingURL=project-config-path.d.ts.map