/**
 * Copilot's skill registry for unattended sessions: checks a bundled skill's
 * slash (skill-slash.ts) against `copilot skill list --json` before a session
 * is prompted with it.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { detectHostCliType } from './host-signal.js';
import { getHostCliBinary } from './host-detection.js';
import { SKILL_NAMESPACE, skillSlash } from './skill-slash.js';
import { childEnv, resolveBareExe } from './windows-search.js';
const PROBE_TIMEOUT_MS = 5_000;
/**
 * `<host binary> [--plugin-dir <root>] skill list --json`: free, it starts no
 * model session. The binary is the one a link spawns, resolved on PATH only
 * (resolveBareExe): the probe runs in the project cwd, so a cwd-relative
 * lookup could run a `copilot.exe` the repo planted. A binary that does not
 * resolve (or only resolves to a `.cmd` shim) is not probed.
 */
export const defaultSkillListProbe = (cwd, extraArgs) => {
    const command = resolveBareExe(getHostCliBinary());
    if (!command)
        return null;
    try {
        const result = spawnSync(command, [...extraArgs, 'skill', 'list', '--json'], {
            cwd,
            env: childEnv(process.env),
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.status !== 0 || typeof result.stdout !== 'string')
            return null;
        const parsed = JSON.parse(result.stdout);
        if (!Array.isArray(parsed))
            return null;
        return parsed.filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.name === 'string');
    }
    catch {
        return null;
    }
};
let activeProbe = defaultSkillListProbe;
const probeCache = new Map();
/** Test seam: replace the probe (and drop the per-process cache). Returns the previous probe. */
export function setSkillListProbe(probe) {
    const previous = activeProbe;
    activeProbe = probe;
    probeCache.clear();
    return previous;
}
/** Copilot's `source` is printed in a warning: strip control characters so it cannot drive the terminal. */
function printable(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
/** A plugin entry whose plugin root (`<path>/../..`) has a plugin.json named oh-my-copilot. */
function isOurSkill(entry) {
    if (entry.source !== 'plugin' || typeof entry.path !== 'string' || entry.path === '')
        return false;
    try {
        const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry.path)), 'plugin.json'), 'utf8'));
        return typeof manifest === 'object' && manifest !== null && manifest.name === SKILL_NAMESPACE;
    }
    catch {
        return false;
    }
}
/**
 * The slash an unattended session should be prompted with for a bundled
 * skill. On Copilot the registry is probed once per process (per cwd and
 * args): a namespaced-only entry (a plugin-name collision) wins, a missing or
 * shadowed name is warned about, and a failed probe falls back to the bare
 * name. With `unattended`, a bare entry that is not our plugin's skill (a
 * project or user skill, or another plugin's) throws instead.
 */
export function resolveSkillSlash(name, options) {
    const host = options.host ?? detectHostCliType();
    if (host !== 'copilot')
        return skillSlash(name, host);
    const probeArgs = options.probeArgs ?? [];
    const key = `${options.cwd}\0${probeArgs.join('\0')}`;
    if (!probeCache.has(key))
        probeCache.set(key, activeProbe(options.cwd, probeArgs));
    const entries = probeCache.get(key);
    // No registry to check (no PATH binary, timeout, old CLI): even unattended,
    // the bare name goes out. Refusing would stop every chain wherever the probe
    // cannot run, and the caller already confirmed the skill is bundled; the
    // shadow check narrows the risk where it can verify, it is not the boundary.
    if (!entries)
        return skillSlash(name, host);
    const warn = options.warn ?? ((message) => process.stderr.write(`[oh-my-copilot] ${message}\n`));
    const bare = entries.find((entry) => entry.name === name);
    if (bare) {
        if (options.unattended && !isOurSkill(bare)) {
            throw new Error(`skill-shadowed:${name}: a ${printable(bare.source ?? 'unknown')} skill registers as /${name}; an unattended session would run it instead of the bundled skill`);
        }
        if (bare.source && bare.source !== 'plugin') {
            warn(`a ${printable(bare.source)} skill named "${name}" shadows the bundled skill; /${name} will run that skill instead.`);
        }
        return `/${name}`;
    }
    const namespaced = `${SKILL_NAMESPACE}:${name}`;
    if (entries.some((entry) => entry.name === namespaced))
        return `/${namespaced}`;
    warn(`copilot skill list has no skill named "${name}"; /${name} may be rejected as an unknown command.`);
    return `/${name}`;
}
//# sourceMappingURL=skill-registry.js.map