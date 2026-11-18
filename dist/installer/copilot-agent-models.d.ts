import type { PluginConfig } from '../shared/types.js';
/**
 * Settings key prefix for plugin agents. UNVERIFIED on a live Copilot: the other
 * candidate is the bare agent name. Check with `/subagents` or by reading
 * `subagent.started.model` in events.jsonl after setting an override.
 */
export declare const COPILOT_PLUGIN_AGENT_PREFIX = "oh-my-copilot:";
/**
 * Explicit `agents.<name>.model` overrides as { agentName: copilotModelId }.
 * Values go through resolveCopilotModel (tier aliases in any case resolve to the
 * first tier model `catalogue` offers, or the tier's first id without one;
 * dashed Claude Code ids become dotted) and are kept
 * only when the result is in copilot-models.json knownModels; everything else
 * (`inherit`, unlisted ids such as claude-opus-4-8) lands in `skipped`.
 * `omc` is the orchestrator, not a delegatable agent. A `modelProfile`
 * (features/model-routing/profiles.ts) sets every agent first; explicit
 * per-agent values win over it.
 */
export declare function resolveAgentModelOverrides(agents: PluginConfig['agents'] | undefined, modelProfile?: unknown, catalogue?: ReadonlySet<string> | null): {
    overrides: Record<string, string>;
    skipped: string[];
};
/**
 * Same as resolveAgentModelOverrides plus `profileEntries`: the subset of
 * `overrides` that only the profile set. An explicit per-agent value of any kind
 * (valid, `inherit`, empty, invalid) removes the profile's entry for that agent
 * before the value is validated.
 *
 * `catalogue` is the plan's Copilot model ids (copilot-run/model-catalogue.ts).
 * A tier alias none of whose models it offers writes no override (the agent
 * inherits the session model) and lands in `unavailableTiers` as
 * { tier: agent names }.
 */
export declare function resolveAgentModelPlan(agents: PluginConfig['agents'] | undefined, modelProfile?: unknown, catalogue?: ReadonlySet<string> | null): {
    overrides: Record<string, string>;
    skipped: string[];
    profileEntries: Record<string, string>;
    profileProblem?: string;
    unavailableTiers: Record<string, string[]>;
};
/**
 * Whether the plan for these settings names any tier alias, i.e. whether
 * reading the Copilot catalogue can change what `omg setup` writes.
 */
export declare function usesCopilotTierAliases(agents: PluginConfig['agents'] | undefined, modelProfile?: unknown): boolean;
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
 *
 * `unavailableTiers` (resolveAgentModelPlan) names agents whose tier alias
 * resolves to no model. Their entry's `model` is removed when it is one of
 * that tier's ids (or the tier's first id before v5.30), i.e. what an earlier
 * setup wrote for the alias, so the agent really inherits the session model;
 * any other value is left alone.
 */
export declare function syncCopilotAgentModels(settingsFile: string, overrides: Record<string, string>, profileEntries?: Record<string, string>, recordFile?: string, unavailableTiers?: Record<string, string[]>): {
    written: string[];
    removed: string[];
    error?: string;
};
//# sourceMappingURL=copilot-agent-models.d.ts.map