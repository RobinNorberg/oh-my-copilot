// src/team/permissions.ts
/**
 * RBAC-compatible advisory permission scoping for workers.
 *
 * NOTE: This is an advisory layer only. MCP workers run in full-auto mode
 * and cannot be mechanically restricted. Permissions are injected into
 * prompts as instructions for the LLM to follow.
 */
import { posix as posixPath, win32 as win32Path } from 'node:path';
/**
 * Simple glob matching for path patterns.
 * Supports: * (any non-/ chars), ** (any depth including /), ? (single non-/ char), exact match.
 *
 * Uses iterative character-by-character matching to avoid ReDoS risk from regex.
 */
function matchGlob(pattern, path) {
    let pi = 0; // pattern index
    let si = 0; // string (path) index
    let starPi = -1; // pattern index after last '*' fallback point
    let starSi = -1; // string index at last '*' fallback point
    while (si < path.length) {
        // Check for '**' (matches anything including '/')
        if (pi < pattern.length - 1 && pattern[pi] === '*' && pattern[pi + 1] === '*') {
            // Consume the '**'
            pi += 2;
            // Skip trailing '/' after '**' if present
            if (pi < pattern.length && pattern[pi] === '/')
                pi++;
            starPi = pi;
            starSi = si;
            continue;
        }
        // Check for single '*' (matches any non-/ chars)
        if (pi < pattern.length && pattern[pi] === '*') {
            pi++;
            starPi = pi;
            starSi = si;
            continue;
        }
        // Check for '?' (matches single non-/ char)
        if (pi < pattern.length && pattern[pi] === '?' && path[si] !== '/') {
            pi++;
            si++;
            continue;
        }
        // Exact character match
        if (pi < pattern.length && pattern[pi] === path[si]) {
            pi++;
            si++;
            continue;
        }
        // Mismatch: backtrack to last star if possible
        if (starPi !== -1) {
            pi = starPi;
            starSi++;
            si = starSi;
            // For single '*', don't match across '/'
            // We detect this by checking if the star was a '**' or '*'
            // If we got here from '**', slashes are OK; from '*', skip if slash
            // Re-check: was the star a '**'?
            const wasSingleStar = starPi >= 2 && pattern[starPi - 2] === '*' && pattern[starPi - 1] === '*' ? false :
                starPi >= 1 && pattern[starPi - 1] === '*' ? true : false;
            if (wasSingleStar && si > 0 && path[si - 1] === '/') {
                return false;
            }
            continue;
        }
        return false;
    }
    // Consume remaining pattern characters (trailing '*' or '**')
    while (pi < pattern.length) {
        if (pattern[pi] === '*') {
            pi++;
        }
        else if (pattern[pi] === '/') {
            // Allow trailing slash in pattern after '**'
            pi++;
        }
        else {
            break;
        }
    }
    return pi === pattern.length;
}
/**
 * Path semantics for the host platform, selected per call so a platform-stubbed
 * test exercises the rules it means to.
 */
function pathFlavor() {
    return process.platform === 'win32' ? win32Path : posixPath;
}
/**
 * Windows filesystems are case-insensitive, so a deny pattern must match
 * regardless of case — otherwise `.GITHUB/workflows/x.yml` writes the same file
 * that `.github/**` is supposed to protect. POSIX keeps exact matching.
 */
function foldCase(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
/**
 * Express a path the way glob patterns are written, and say whether it even
 * lies inside the working directory.
 *
 * relative() yields '\' on Windows, so without normalizing no pattern
 * containing '/' matches — including the deny list, which would stop denying.
 * It also returns an ABSOLUTE path when no relative route exists: a different
 * volume (C: -> D:) or a UNC share. Those do not start with '..', so treating
 * only '..' as "outside" lets a cross-volume target through, and with the
 * default empty allowedPaths that means allowed.
 */
function toPatternPath(workingDirectory, filePath) {
    const flavor = pathFlavor();
    const raw = flavor.relative(workingDirectory, flavor.resolve(workingDirectory, filePath));
    return {
        relPath: raw.replace(/\\/g, '/'),
        outside: raw.startsWith('..') || flavor.isAbsolute(raw),
    };
}
/**
 * Check if a worker is allowed to modify a given path.
 * Denied paths override allowed paths.
 */
export function isPathAllowed(permissions, filePath, workingDirectory) {
    const { relPath, outside } = toPatternPath(workingDirectory, filePath);
    // Anything not inside the working directory is denied, whether it escaped
    // via '..' or sits on another volume / UNC share entirely.
    if (outside)
        return false;
    const target = foldCase(relPath);
    // Check denied paths first (they override)
    for (const pattern of permissions.deniedPaths) {
        if (matchGlob(foldCase(pattern), target))
            return false;
    }
    // If no allowed paths specified, allow all within workingDirectory
    if (permissions.allowedPaths.length === 0)
        return true;
    // Check allowed paths
    for (const pattern of permissions.allowedPaths) {
        if (matchGlob(foldCase(pattern), target))
            return true;
    }
    return false;
}
/**
 * Check if a worker is allowed to run a given command.
 * Empty allowedCommands means all commands are allowed.
 */
export function isCommandAllowed(permissions, command) {
    if (permissions.allowedCommands.length === 0)
        return true;
    const trimmed = command.trim();
    return permissions.allowedCommands.some(prefix => trimmed.startsWith(prefix));
}
/**
 * Generate permission instructions for inclusion in worker prompt.
 */
export function formatPermissionInstructions(permissions) {
    const lines = [];
    lines.push('PERMISSION CONSTRAINTS:');
    if (permissions.allowedPaths.length > 0) {
        lines.push(`- You may ONLY modify files matching: ${permissions.allowedPaths.join(', ')}`);
    }
    if (permissions.deniedPaths.length > 0) {
        lines.push(`- You must NOT modify files matching: ${permissions.deniedPaths.join(', ')}`);
    }
    if (permissions.allowedCommands.length > 0) {
        lines.push(`- You may ONLY run commands starting with: ${permissions.allowedCommands.join(', ')}`);
    }
    if (Number.isFinite(permissions.maxFileSize)) {
        lines.push(`- Maximum file size: ${Math.round(permissions.maxFileSize / 1024)}KB per file`);
    }
    if (lines.length === 1) {
        lines.push('- No restrictions (full access within working directory)');
    }
    return lines.join('\n');
}
/**
 * Default permissions (allow all within working directory).
 */
export function getDefaultPermissions(workerName) {
    return {
        workerName,
        allowedPaths: [], // empty = allow all
        deniedPaths: [],
        allowedCommands: [], // empty = allow all
        maxFileSize: Infinity,
    };
}
/**
 * Secure deny-defaults that are always enforced regardless of caller config.
 * These protect sensitive files from being modified by any worker.
 */
const SECURE_DENY_DEFAULTS = [
    '.git/**',
    '.env*',
    '**/.env*',
    '**/secrets/**',
    '**/.ssh/**',
    '**/node_modules/.cache/**',
];
/**
 * Merge caller-provided permissions with secure deny-defaults.
 * The deny-defaults are always prepended to deniedPaths so they cannot be overridden.
 */
export function getEffectivePermissions(base) {
    const perms = base
        ? { ...getDefaultPermissions(base.workerName), ...base }
        : getDefaultPermissions('default');
    // Prepend secure defaults (deduplicating against existing deniedPaths)
    const existingSet = new Set(perms.deniedPaths);
    const merged = [
        ...SECURE_DENY_DEFAULTS.filter(p => !existingSet.has(p)),
        ...perms.deniedPaths,
    ];
    perms.deniedPaths = merged;
    return perms;
}
/**
 * Check a list of changed file paths against permissions.
 * Returns an array of violations (empty = all paths allowed).
 *
 * @param changedPaths - relative or absolute paths of files that were modified
 * @param permissions - effective permissions to check against
 * @param cwd - working directory for resolving relative paths
 */
export function findPermissionViolations(changedPaths, permissions, cwd) {
    const violations = [];
    for (const filePath of changedPaths) {
        if (!isPathAllowed(permissions, filePath, cwd)) {
            // Determine which deny pattern matched for the reason
            const { relPath, outside } = toPatternPath(cwd, filePath);
            let reason;
            if (outside) {
                reason = `Path escapes working directory: ${relPath}`;
            }
            else {
                // Find which deny pattern matched
                const target = foldCase(relPath);
                const matchedDeny = permissions.deniedPaths.find(p => matchGlob(foldCase(p), target));
                if (matchedDeny) {
                    reason = `Matches denied pattern: ${matchedDeny}`;
                }
                else {
                    reason = `Not in allowed paths: ${permissions.allowedPaths.join(', ') || '(none configured)'}`;
                }
            }
            violations.push({ path: relPath, reason });
        }
    }
    return violations;
}
//# sourceMappingURL=permissions.js.map