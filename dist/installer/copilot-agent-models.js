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
import { toCopilotModelId } from '../team/model-contract.js';
import copilotModels from '../config/copilot-models.json' with { type: 'json' };
/**
 * Settings key prefix for plugin agents. UNVERIFIED on a live Copilot: the other
 * candidate is the bare agent name. Check with `/subagents` or by reading
 * `subagent.started.model` in events.jsonl after setting an override.
 */
export const COPILOT_PLUGIN_AGENT_PREFIX = 'oh-my-copilot:';
const KNOWN_MODELS = new Set(copilotModels.knownModels);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** `securityReviewer` -> `security-reviewer`. */
const toAgentName = (configKey) => configKey.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
/**
 * Explicit `agents.<name>.model` overrides as { agentName: copilotModelId }.
 * Values go through toCopilotModelId (tier aliases in any case resolve to the
 * tier's first Copilot id; dashed Claude Code ids become dotted) and are kept
 * only when the result is in copilot-models.json knownModels; everything else
 * (`inherit`, unlisted ids such as claude-opus-4-8) lands in `skipped`.
 * `omc` is the orchestrator, not a delegatable agent.
 */
export function resolveAgentModelOverrides(agents) {
    const overrides = {};
    const skipped = [];
    for (const [key, value] of Object.entries(agents ?? {})) {
        const model = value?.model?.trim();
        if (key === 'omc' || !model)
            continue;
        const resolved = toCopilotModelId(model);
        if (KNOWN_MODELS.has(resolved))
            overrides[toAgentName(key)] = resolved;
        else
            skipped.push(`${key}: "${model}"`);
    }
    return { overrides, skipped };
}
/** Pure merge: sets `subagents.agents[prefix+name].model`, keeps every other key. */
export function mergeSubagentModels(settings, overrides) {
    const names = Object.keys(overrides);
    if (names.length === 0)
        return { settings, changed: false };
    // Non-object values (`agents: []`, a string entry) are replaced, not spread into index keys.
    const subagents = isRecord(settings.subagents) ? { ...settings.subagents } : {};
    const agents = isRecord(subagents.agents) ? { ...subagents.agents } : {};
    let changed = false;
    for (const name of names) {
        const id = `${COPILOT_PLUGIN_AGENT_PREFIX}${name}`;
        const entry = isRecord(agents[id]) ? agents[id] : undefined;
        if (entry?.model === overrides[name])
            continue;
        agents[id] = { ...entry, model: overrides[name] };
        changed = true;
    }
    if (!changed)
        return { settings, changed };
    return { settings: { ...settings, subagents: { ...subagents, agents } }, changed };
}
/**
 * Merge overrides into settings.json. No write when nothing changes; otherwise a
 * `.bak` copy of the previous file, then an atomic replace. Settings that are not
 * a JSON object are left untouched and reported in `error`. Returns the agent
 * names written.
 */
export function syncCopilotAgentModels(settingsFile, overrides) {
    if (Object.keys(overrides).length === 0)
        return { written: [] };
    let current = {};
    if (existsSync(settingsFile)) {
        try {
            current = JSON.parse(readFileSync(settingsFile, 'utf-8'));
        }
        catch {
            return { written: [], error: `${settingsFile} is not valid JSON; left untouched` };
        }
        if (!isRecord(current))
            return { written: [], error: `${settingsFile} is not a JSON object; left untouched` };
    }
    const { settings, changed } = mergeSubagentModels(current, overrides);
    if (!changed)
        return { written: [] };
    if (existsSync(settingsFile))
        copyFileSync(settingsFile, `${settingsFile}.bak`);
    atomicWriteJsonSync(settingsFile, settings);
    return { written: Object.keys(overrides) };
}
//# sourceMappingURL=copilot-agent-models.js.map