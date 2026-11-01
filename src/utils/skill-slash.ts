/**
 * Host-aware slash names for bundled skills.
 *
 * Copilot CLI (>= 1.0.66, verified on 1.0.105) registers a plugin skill under
 * its bare frontmatter name (`/ralph`) and rejects `/oh-my-copilot:ralph` as
 * an unknown command. It namespaces a plugin skill only when two plugins ship
 * the same name (then both are `/<plugin>:<name>` and the bare name is gone),
 * and a project skill of the same name silently replaces the plugin skill.
 * Claude Code registers the plugin's skills as `/oh-my-copilot:<name>`.
 * Unattended sessions check the name against Copilot's registry with
 * resolveSkillSlash (skill-registry.ts).
 */

import type { CliAgentType } from '../team/model-contract.js';
import { detectHostCliType } from './host-signal.js';

/** The plugin name both hosts use as the skill namespace. */
export const SKILL_NAMESPACE = 'oh-my-copilot';

/** The slash command a host resolves for a bundled skill. */
export function skillSlash(name: string, host: CliAgentType = detectHostCliType()): string {
  return host === 'copilot' ? `/${name}` : `/${SKILL_NAMESPACE}:${name}`;
}
