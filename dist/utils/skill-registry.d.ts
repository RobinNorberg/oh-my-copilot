/**
 * Copilot's skill registry for unattended sessions: checks a bundled skill's
 * slash (skill-slash.ts) against `copilot skill list --json` before a session
 * is prompted with it.
 */
import type { CliAgentType } from '../team/model-contract.js';
/** One entry of `copilot skill list --json`. */
export interface CopilotSkillEntry {
    name: string;
    source?: string;
    /** The skill's directory; a plugin skill sits at `<plugin root>/skills/<dir>`. */
    path?: string;
}
/**
 * Lists the skills a Copilot session in `cwd` would register; null when the
 * probe failed, `'unresolved'` when no host binary resolves on PATH.
 */
export type SkillListProbe = (cwd: string, extraArgs: readonly string[]) => CopilotSkillEntry[] | null | 'unresolved';
/** `<host binary> [--plugin-dir <root>] skill list --json`: free, it starts no model session. */
export declare const defaultSkillListProbe: SkillListProbe;
/** Test seam: replace the probe (and drop the per-process cache). Returns the previous probe. */
export declare function setSkillListProbe(probe: SkillListProbe): SkillListProbe;
export interface ResolveSkillSlashOptions {
    /** Working directory of the session that will run the slash (project skills live there). */
    cwd: string;
    /** Host that runs the session; defaults to the detected host. */
    host?: CliAgentType;
    /** Args the spawned session gets before the prompt that change the skill set, e.g. `--plugin-dir`. */
    probeArgs?: readonly string[];
    /**
     * The session runs without a human (an --allow-all link): a skill that is
     * not ours throws `skill-shadowed:<name>`, and any probe failure (no host
     * binary on PATH, timeout, non-zero exit, unparseable output) throws
     * `skill-unverifiable:<name>`.
     */
    unattended?: boolean;
    /** Where a mismatch warning goes; stderr by default. */
    warn?: (message: string) => void;
}
/**
 * The slash an unattended session should be prompted with for a bundled
 * skill. On Copilot the registry is probed once per process (per cwd and
 * args): a namespaced-only entry (a plugin-name collision) wins, a missing or
 * shadowed name is warned about, and a failed probe falls back to the bare
 * name. With `unattended`, a failed probe throws `skill-unverifiable`, and a
 * bare entry that is not our plugin's skill (a project or user skill, another
 * plugin's, or a plugin outside OMC_PLUGIN_ROOT and the installed-plugins dir)
 * throws `skill-shadowed`.
 */
export declare function resolveSkillSlash(name: string, options: ResolveSkillSlashOptions): string;
//# sourceMappingURL=skill-registry.d.ts.map