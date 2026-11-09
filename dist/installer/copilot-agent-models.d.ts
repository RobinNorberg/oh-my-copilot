import type { PluginConfig } from '../shared/types.js';
/**
 * Settings key prefix for plugin agents. UNVERIFIED on a live Copilot: the other
 * candidate is the bare agent name. Check with `/subagents` or by reading
 * `subagent.started.model` in events.jsonl after setting an override.
 */
export declare const COPILOT_PLUGIN_AGENT_PREFIX = "oh-my-copilot:";
/**
 * Explicit `agents.<name>.model` overrides as { agentName: copilotModelId }.
 * Values go through toCopilotModelId (tier aliases in any case resolve to the
 * tier's first Copilot id; dashed Claude Code ids become dotted) and are kept
 * only when the result is in copilot-models.json knownModels; everything else
 * (`inherit`, unlisted ids such as claude-opus-4-8) lands in `skipped`.
 * `omc` is the orchestrator, not a delegatable agent. A `modelProfile`
 * (features/model-routing/profiles.ts) sets every agent first; explicit
 * per-agent values win over it.
 */
export declare function resolveAgentModelOverrides(agents: PluginConfig['agents'] | undefined, modelProfile?: unknown): {
    overrides: Record<string, string>;
    skipped: string[];
};
/**
 * Same as resolveAgentModelOverrides plus `profileEntries`: the subset of
 * `overrides` that only the profile set. An explicit per-agent value of any kind
 * (valid, `inherit`, empty, invalid) removes the profile's entry for that agent
 * before the value is validated.
 */
export declare function resolveAgentModelPlan(agents: PluginConfig['agents'] | undefined, modelProfile?: unknown): {
    overrides: Record<string, string>;
    skipped: string[];
    profileEntries: Record<string, string>;
    profileProblem?: string;
};
/** Pure merge: sets `subagents.agents[prefix+name].model`, keeps every other key. */
export declare function mergeSubagentModels(settings: Record<string, unknown>, overrides: Record<string, string>): {
    settings: Record<string, unknown>;
    changed: boolean;
};
/**
 * Merge overrides into settings.json. No write when nothing changes; otherwise a
 * `.bak` copy of the previous file, then an atomic replace. Settings that are not
 * a JSON object are left untouched and reported in `error`. Returns the agent
 * names written and removed.
 *
 * `profileEntries` (the overrides only a modelProfile set) are recorded in
 * `recordFile` (omg-owned, not settings.json). On a later sync an entry that is
 * recorded, still holds exactly the recorded model and is no longer in
 * `overrides` is removed again, so going back to `balanced` restores the agent
 * defaults. Without a record nothing is removed, and a value the user changed
 * is left alone.
 */
export declare function syncCopilotAgentModels(settingsFile: string, overrides: Record<string, string>, profileEntries?: Record<string, string>, recordFile?: string): {
    written: string[];
    removed: string[];
    error?: string;
};
//# sourceMappingURL=copilot-agent-models.d.ts.map