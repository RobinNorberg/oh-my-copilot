/**
 * Make `agents.<name>.model` real on Copilot CLI.
 *
 * Copilot ignores the PreToolUse `updatedInput` rewrite Claude Code uses, but it
 * has a native per-agent override: `subagents.agents["<id>"].model` in
 * $COPILOT_HOME/settings.json, which beats the agent file's `model`/`models`.
 * `omg setup` therefore copies the user's explicit overrides there.
 */
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import copilotModels from '../config/copilot-models.json' with { type: 'json' };
/**
 * Settings key prefix for plugin agents. UNVERIFIED on a live Copilot: the other
 * candidate is the bare agent name. Check with `/subagents` or by reading
 * `subagent.started.model` in events.jsonl after setting an override.
 */
export const COPILOT_PLUGIN_AGENT_PREFIX = 'oh-my-copilot:';
const COPILOT_MODEL_ID = /^(claude|gpt|gemini)-/;
const TIERS = copilotModels.tiers;
/** `securityReviewer` -> `security-reviewer`. */
const toAgentName = (configKey) => configKey.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
/**
 * Explicit `agents.<name>.model` overrides as { agentName: copilotModelId }.
 * Tier aliases (opus/sonnet/haiku/fable) resolve to the tier's first Copilot id;
 * Copilot ids pass through; anything else (e.g. a Claude Code model id) is skipped.
 * `omc` is the orchestrator, not a delegatable agent.
 */
export function resolveAgentModelOverrides(agents) {
    const out = {};
    for (const [key, value] of Object.entries(agents ?? {})) {
        const model = value?.model?.trim();
        if (key === 'omc' || !model)
            continue;
        const resolved = TIERS[model]?.[0] ?? (COPILOT_MODEL_ID.test(model) ? model : undefined);
        if (resolved)
            out[toAgentName(key)] = resolved;
    }
    return out;
}
/** Pure merge: sets `subagents.agents[prefix+name].model`, keeps every other key. */
export function mergeSubagentModels(settings, overrides) {
    const names = Object.keys(overrides);
    if (names.length === 0)
        return { settings, changed: false };
    const subagents = { ...settings.subagents };
    const agents = { ...subagents.agents };
    let changed = false;
    for (const name of names) {
        const id = `${COPILOT_PLUGIN_AGENT_PREFIX}${name}`;
        if (agents[id]?.model === overrides[name])
            continue;
        agents[id] = { ...agents[id], model: overrides[name] };
        changed = true;
    }
    if (!changed)
        return { settings, changed };
    return { settings: { ...settings, subagents: { ...subagents, agents } }, changed };
}
/**
 * Merge overrides into settings.json. No write when nothing changes; otherwise a
 * `.bak` copy of the previous file, then an atomic replace. Unparseable settings
 * are left untouched. Returns the agent names written.
 */
export function syncCopilotAgentModels(settingsFile, overrides) {
    if (Object.keys(overrides).length === 0)
        return [];
    let current = {};
    if (existsSync(settingsFile)) {
        try {
            current = JSON.parse(readFileSync(settingsFile, 'utf-8'));
        }
        catch {
            return [];
        }
        if (current === null || typeof current !== 'object' || Array.isArray(current))
            return [];
    }
    const { settings, changed } = mergeSubagentModels(current, overrides);
    if (!changed)
        return [];
    if (existsSync(settingsFile))
        copyFileSync(settingsFile, `${settingsFile}.bak`);
    atomicWriteJsonSync(settingsFile, settings);
    return Object.keys(overrides);
}
//# sourceMappingURL=copilot-agent-models.js.map