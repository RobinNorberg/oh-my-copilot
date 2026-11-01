/**
 * Copilot's skill registry for unattended sessions: checks a bundled skill's
 * slash (skill-slash.ts) against `copilot skill list --json` before a session
 * is prompted with it.
 */

import { spawnSync } from 'child_process';
import { buildHostBinarySpawn } from '../cli/tmux-utils.js';
import type { CliAgentType } from '../team/model-contract.js';
import { detectHostCliType } from './host-signal.js';
import { SKILL_NAMESPACE, skillSlash } from './skill-slash.js';

/** One entry of `copilot skill list --json`. */
export interface CopilotSkillEntry {
  name: string;
  source?: string;
}

/** Lists the skills a Copilot session in `cwd` would register; null when the probe failed. */
export type SkillListProbe = (cwd: string, extraArgs: readonly string[]) => CopilotSkillEntry[] | null;

const PROBE_TIMEOUT_MS = 30_000;

/** `copilot [--plugin-dir <root>] skill list --json`: free, it starts no model session. */
export const defaultSkillListProbe: SkillListProbe = (cwd, extraArgs) => {
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
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is CopilotSkillEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as CopilotSkillEntry).name === 'string');
  } catch {
    return null;
  }
};

let activeProbe: SkillListProbe = defaultSkillListProbe;
const probeCache = new Map<string, CopilotSkillEntry[] | null>();

/** Test seam: replace the probe (and drop the per-process cache). Returns the previous probe. */
export function setSkillListProbe(probe: SkillListProbe): SkillListProbe {
  const previous = activeProbe;
  activeProbe = probe;
  probeCache.clear();
  return previous;
}

export interface ResolveSkillSlashOptions {
  /** Working directory of the session that will run the slash (project skills live there). */
  cwd: string;
  /** Host that runs the session; defaults to the detected host. */
  host?: CliAgentType;
  /** Args the spawned session gets before the prompt that change the skill set, e.g. `--plugin-dir`. */
  probeArgs?: readonly string[];
  /** Where a mismatch warning goes; stderr by default. */
  warn?: (message: string) => void;
}

/**
 * The slash an unattended session should be prompted with for a bundled
 * skill. On Copilot the registry is probed once per process (per cwd and
 * args): a namespaced-only entry (a plugin-name collision) wins, a missing or
 * project-shadowed name is warned about, and a failed probe falls back to the
 * bare name.
 */
export function resolveSkillSlash(name: string, options: ResolveSkillSlashOptions): string {
  const host = options.host ?? detectHostCliType();
  if (host !== 'copilot') return skillSlash(name, host);
  const probeArgs = options.probeArgs ?? [];
  const key = `${options.cwd}\0${probeArgs.join('\0')}`;
  if (!probeCache.has(key)) probeCache.set(key, activeProbe(options.cwd, probeArgs));
  const entries = probeCache.get(key);
  if (!entries) return skillSlash(name, host);
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[oh-my-copilot] ${message}\n`));
  const bare = entries.find((entry) => entry.name === name);
  if (bare) {
    if (bare.source && bare.source !== 'plugin') {
      warn(`a ${bare.source} skill named "${name}" shadows the bundled skill; /${name} will run that skill instead.`);
    }
    return `/${name}`;
  }
  const namespaced = `${SKILL_NAMESPACE}:${name}`;
  if (entries.some((entry) => entry.name === namespaced)) return `/${namespaced}`;
  warn(`copilot skill list has no skill named "${name}"; /${name} may be rejected as an unknown command.`);
  return `/${name}`;
}
