import type { PluginConfig } from '../shared/types.js';
/**
 * Settings key prefix for plugin agents. UNVERIFIED on a live Copilot: the other
 * candidate is the bare agent name. Check with `/subagents` or by reading
 * `subagent.started.model` in events.jsonl after setting an override.
 */
export declare const COPILOT_PLUGIN_AGENT_PREFIX = "oh-my-copilot:";
/**
 * Explicit `agents.<name>.model` overrides as { agentName: copilotModelId }.
 * Tier aliases (opus/sonnet/haiku/fable) resolve to the tier's first Copilot id;
 * Copilot ids pass through; anything else (e.g. a Claude Code model id) is skipped.
 * `omc` is the orchestrator, not a delegatable agent.
 */
export declare function resolveAgentModelOverrides(agents: PluginConfig['agents'] | undefined): Record<string, string>;
/** Pure merge: sets `subagents.agents[prefix+name].model`, keeps every other key. */
export declare function mergeSubagentModels(settings: Record<string, unknown>, overrides: Record<string, string>): {
    settings: Record<string, unknown>;
    changed: boolean;
};
/**
 * Merge overrides into settings.json. No write when nothing changes; otherwise a
 * `.bak` copy of the previous file, then an atomic replace. Unparseable settings
 * are left untouched. Returns the agent names written.
 */
export declare function syncCopilotAgentModels(settingsFile: string, overrides: Record<string, string>): string[];
//# sourceMappingURL=copilot-agent-models.d.ts.map