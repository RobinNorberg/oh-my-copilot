/**
 * Project config file location.
 *
 * Canonical: `.copilot/omg.jsonc`. Earlier fork builds read
 * `.copilot/omc.jsonc`, so readers still accept it as a fallback when the
 * canonical file is absent. Writers and docs use the canonical name only, and
 * `omg doctor conflicts` reports a legacy-named file with the rename command
 * instead of renaming it silently.
 */
import { existsSync } from "fs";
import { join } from "path";
export const PROJECT_CONFIG_DIR = ".copilot";
export const PROJECT_CONFIG_FILE = "omg.jsonc";
/** Name earlier fork builds read from `.copilot/`. */
export const LEGACY_PROJECT_CONFIG_FILE = "omc.jsonc";
/** Upstream oh-my-claudecode location, still read by a few standalone hooks. */
export const UPSTREAM_PROJECT_CONFIG_DIR = ".claude";
export function getCanonicalProjectConfigPath(directory = process.cwd()) {
    return join(directory, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
}
/** Project config candidates in read order: canonical first, then the legacy fork name. */
export function getProjectConfigCandidates(directory = process.cwd()) {
    return [
        getCanonicalProjectConfigPath(directory),
        join(directory, PROJECT_CONFIG_DIR, LEGACY_PROJECT_CONFIG_FILE),
    ];
}
/**
 * The project config file to read: the first existing candidate, or the
 * canonical path when none exists (so callers report the expected location).
 */
export function resolveProjectConfigPath(directory = process.cwd()) {
    const candidates = getProjectConfigCandidates(directory);
    return candidates.find((path) => existsSync(path)) ?? candidates[0];
}
function quote(path) {
    return `"${path}"`;
}
/**
 * Legacy-named project config files under `directory`: `.copilot/omc.jsonc`
 * and the upstream `.claude/omc.jsonc`. Never touches the files.
 */
export function findLegacyProjectConfigs(directory = process.cwd()) {
    const canonicalPath = getCanonicalProjectConfigPath(directory);
    const canonicalExists = existsSync(canonicalPath);
    const canonicalDir = join(directory, PROJECT_CONFIG_DIR);
    const legacyDirs = [PROJECT_CONFIG_DIR, UPSTREAM_PROJECT_CONFIG_DIR];
    const found = [];
    // Only the highest-precedence legacy file gets a rename; once the canonical
    // file exists (or is claimed), the rest are reported as ignored.
    let renameClaimed = canonicalExists;
    for (const legacyDir of legacyDirs) {
        const legacyPath = join(directory, legacyDir, LEGACY_PROJECT_CONFIG_FILE);
        if (!existsSync(legacyPath))
            continue;
        let renameCommand = null;
        if (!renameClaimed) {
            const from = quote(`${legacyDir}/${LEGACY_PROJECT_CONFIG_FILE}`);
            const to = quote(`${PROJECT_CONFIG_DIR}/${PROJECT_CONFIG_FILE}`);
            const mv = `mv ${from} ${to}`;
            // Emitted as separate commands: PowerShell 5.1 has no `&&`, and
            // `mkdir -p` is a POSIX-only flag, so each step runs on its own line.
            renameCommand = existsSync(canonicalDir)
                ? [mv]
                : [`mkdir ${quote(PROJECT_CONFIG_DIR)}`, mv];
            renameClaimed = true;
        }
        found.push({ legacyPath, canonicalPath, canonicalExists, renameCommand });
    }
    return found;
}
//# sourceMappingURL=project-config-path.js.map