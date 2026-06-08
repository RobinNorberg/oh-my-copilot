import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
const PACKAGE_ROOT = process.cwd();
const HOOKS_JSON_PATH = join(PACKAGE_ROOT, 'hooks', 'hooks.json');
const PLUGIN_JSON_PATH = join(PACKAGE_ROOT, '.claude-plugin', 'plugin.json');
const SCRIPTS_ROOT = join(PACKAGE_ROOT, 'scripts');
function referencesStandardHooksManifest(value) {
    if (typeof value === 'string') {
        const normalized = value.replace(/\\/g, '/');
        return normalized === './hooks/hooks.json' || normalized === 'hooks/hooks.json';
    }
    if (Array.isArray(value)) {
        return value.some(referencesStandardHooksManifest);
    }
    if (value && typeof value === 'object') {
        return Object.values(value).some(referencesStandardHooksManifest);
    }
    return false;
}
const LOCAL_IMPORT_RE = /(?:import\s+(?:[^'"()]+?\s+from\s+)?|import\s*\(|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+|require\s*\()\s*['"](\.[^'"]+)['"]/g;
// Fork uses ${PLUGIN_ROOT} (Copilot CLI), not "$CLAUDE_PLUGIN_ROOT" (Claude Code).
const PLUGIN_SCRIPT_RE = /\$\{PLUGIN_ROOT\}\/(scripts\/[^\s"]+)/g;
let packedFilesCache = null;
function extractCommandStrings(entry) {
    const commands = [];
    const cfg = entry;
    if (typeof cfg.command === 'string')
        commands.push(cfg.command);
    if (typeof cfg.bash === 'string')
        commands.push(cfg.bash);
    if (typeof cfg.powershell === 'string')
        commands.push(cfg.powershell);
    return commands;
}
function listHookScriptEntries() {
    const hooksJson = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8'));
    const entries = new Set(['scripts/run.cjs']);
    for (const eventHooks of Object.values(hooksJson.hooks ?? {})) {
        for (const matcherEntry of eventHooks) {
            // Fork's hooks.json puts bash/powershell/command directly on the matcher entry,
            // not nested under a `hooks` array. Handle both shapes for forward compatibility.
            const nestedHooks = matcherEntry.hooks ?? [];
            const directCommands = extractCommandStrings(matcherEntry);
            const candidateCommands = [...directCommands];
            for (const hook of nestedHooks) {
                candidateCommands.push(...extractCommandStrings(hook));
            }
            for (const command of candidateCommands) {
                for (const match of command.matchAll(PLUGIN_SCRIPT_RE)) {
                    entries.add(match[1]);
                }
            }
        }
    }
    return [...entries].sort();
}
function resolveRelativeScriptImport(fromFile, specifier) {
    const resolved = normalize(join(dirname(fromFile), specifier));
    const candidates = [
        resolved,
        `${resolved}.mjs`,
        `${resolved}.cjs`,
        `${resolved}.js`,
        join(resolved, 'index.mjs'),
        join(resolved, 'index.cjs'),
        join(resolved, 'index.js'),
    ];
    for (const candidate of candidates) {
        if (candidate.startsWith(SCRIPTS_ROOT) && existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
function collectRequiredScriptFiles(entryRelPath, collected = new Set()) {
    const absolutePath = join(PACKAGE_ROOT, entryRelPath);
    if (!existsSync(absolutePath)) {
        throw new Error(`Required hook file is missing in repo: ${entryRelPath}`);
    }
    const normalizedRel = relative(PACKAGE_ROOT, absolutePath).replace(/\\/g, '/');
    if (collected.has(normalizedRel)) {
        return collected;
    }
    collected.add(normalizedRel);
    const content = readFileSync(absolutePath, 'utf-8');
    for (const match of content.matchAll(LOCAL_IMPORT_RE)) {
        const resolved = resolveRelativeScriptImport(absolutePath, match[1]);
        if (!resolved) {
            continue;
        }
        collectRequiredScriptFiles(relative(PACKAGE_ROOT, resolved).replace(/\\/g, '/'), collected);
    }
    return collected;
}
function getPackedFiles() {
    if (packedFilesCache) {
        return packedFilesCache;
    }
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const stdout = execFileSync(npmBin, ['pack', '--dry-run', '--json'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf-8',
        shell: process.platform === 'win32',
    });
    const results = JSON.parse(stdout);
    packedFilesCache = new Set((results[0]?.files ?? []).map(file => file.path));
    return packedFilesCache;
}
describe('npm package hook surface regression', () => {
    it('does not explicitly reference the auto-loaded standard hooks manifest from plugin.json', () => {
        const pluginJson = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf-8'));
        expect(referencesStandardHooksManifest(pluginJson.hooks)).toBe(false);
        const packedFiles = getPackedFiles();
        expect(packedFiles.has('.claude-plugin/plugin.json')).toBe(true);
    });
    it('packs hooks.json, hook entry scripts, and their local script dependencies', () => {
        const requiredFiles = new Set(['hooks/hooks.json']);
        for (const entryRelPath of listHookScriptEntries()) {
            for (const file of collectRequiredScriptFiles(entryRelPath)) {
                requiredFiles.add(file);
            }
        }
        const packedFiles = getPackedFiles();
        expect([...requiredFiles].sort()).not.toHaveLength(0);
        const missing = [...requiredFiles].filter(file => !packedFiles.has(file)).sort();
        expect(missing).toEqual([]);
    });
});
//# sourceMappingURL=npm-package-hook-surface.test.js.map