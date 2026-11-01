/**
 * Copilot's skill registry for unattended sessions: checks a bundled skill's
 * slash (skill-slash.ts) against `copilot skill list --json` before a session
 * is prompted with it.
 */
import { spawnSync } from 'child_process';
import { buildHostBinarySpawn } from '../cli/tmux-utils.js';
import { detectHostCliType } from './host-signal.js';
import { SKILL_NAMESPACE, skillSlash } from './skill-slash.js';
const PROBE_TIMEOUT_MS = 30_000;
/** `copilot [--plugin-dir <root>] skill list --json`: free, it starts no model session. */
export const defaultSkillListProbe = (cwd, extraArgs) => {
    const args = [...extraArgs, 'skill', 'list', '--json'];
    try {
        const launch = process.platform === 'win32'
            ? buildHostBinarySpawn('copilot', args)
            : { command: 'copilot', args, windowsVerbatimArguments: false };
        const result = spawnSync(launch.command, launch.args, {
            cwd,
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            windowsHide: true,
            windowsVerbatimArguments: launch.windowsVerbatimArguments,
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
/**
 * The slash an unattended session should be prompted with for a bundled
 * skill. On Copilot the registry is probed once per process (per cwd and
 * args): a namespaced-only entry (a plugin-name collision) wins, a missing or
 * project-shadowed name is warned about, and a failed probe falls back to the
 * bare name.
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
    if (!entries)
        return skillSlash(name, host);
    const warn = options.warn ?? ((message) => process.stderr.write(`[oh-my-copilot] ${message}\n`));
    const bare = entries.find((entry) => entry.name === name);
    if (bare) {
        if (bare.source && bare.source !== 'plugin') {
            warn(`a ${bare.source} skill named "${name}" shadows the bundled skill; /${name} will run that skill instead.`);
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