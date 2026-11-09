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
import type { PluginConfig } from '../shared/types.js';
import { toCopilotModelId } from '../team/model-contract.js';
import { parseModelProfile, profileAgentModels } from '../features/model-routing/profiles.js';
import copilotModels from '../config/copilot-models.json' with { type: 'json' };

/**
 * Settings key prefix for plugin agents. UNVERIFIED on a live Copilot: the other
 * candidate is the bare agent name. Check with `/subagents` or by reading
 * `subagent.started.model` in events.jsonl after setting an override.
 */
export const COPILOT_PLUGIN_AGENT_PREFIX = 'oh-my-copilot:';

const KNOWN_MODELS = new Set<string>(copilotModels.knownModels);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `securityReviewer` -> `security-reviewer`. */
const toAgentName = (configKey: string): string =>
  configKey.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

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
export function resolveAgentModelOverrides(
  agents: PluginConfig['agents'] | undefined,
  modelProfile?: unknown,
): { overrides: Record<string, string>; skipped: string[] } {
  const { overrides, skipped } = resolveAgentModelPlan(agents, modelProfile);
  return { overrides, skipped };
}

/**
 * Same as resolveAgentModelOverrides plus `profileEntries`: the subset of
 * `overrides` that only the profile set. An explicit per-agent value of any kind
 * (valid, `inherit`, empty, invalid) removes the profile's entry for that agent
 * before the value is validated.
 */
export function resolveAgentModelPlan(
  agents: PluginConfig['agents'] | undefined,
  modelProfile?: unknown,
): { overrides: Record<string, string>; skipped: string[]; profileEntries: Record<string, string>; profileProblem?: string } {
  const overrides: Record<string, string> = {};
  const profileEntries: Record<string, string> = {};
  const skipped: string[] = [];
  const profile = parseModelProfile(modelProfile);
  const profileProblem = modelProfile !== undefined && !profile ? `modelProfile ${JSON.stringify(modelProfile)} is not quality-first, balanced or economy; no profile applied` : undefined;
  if (profile) {
    for (const [name, tier] of Object.entries(profileAgentModels(profile))) {
      overrides[name] = toCopilotModelId(tier);
      profileEntries[name] = overrides[name];
    }
  }
  for (const [key, value] of Object.entries(agents ?? {})) {
    if (key === 'omc' || value?.model === undefined) continue;
    delete overrides[toAgentName(key)];
    delete profileEntries[toAgentName(key)];
    if (typeof value.model !== 'string') {
      skipped.push(`${key}: ${JSON.stringify(value.model)}`);
      continue;
    }
    const model = value.model.trim();
    if (!model) continue;
    const resolved = toCopilotModelId(model);
    if (KNOWN_MODELS.has(resolved)) overrides[toAgentName(key)] = resolved;
    else skipped.push(`${key}: "${model}"`);
  }
  return { overrides, skipped, profileEntries, profileProblem };
}

/** Pure merge: sets `subagents.agents[prefix+name].model`, keeps every other key. */
export function mergeSubagentModels(
  settings: Record<string, unknown>,
  overrides: Record<string, string>,
): { settings: Record<string, unknown>; changed: boolean } {
  const names = Object.keys(overrides);
  if (names.length === 0) return { settings, changed: false };
  // Non-object values (`agents: []`, a string entry) are replaced, not spread into index keys.
  const subagents = isRecord(settings.subagents) ? { ...settings.subagents } : {};
  const agents = isRecord(subagents.agents) ? { ...subagents.agents } : {};
  let changed = false;
  for (const name of names) {
    const id = `${COPILOT_PLUGIN_AGENT_PREFIX}${name}`;
    const entry = isRecord(agents[id]) ? agents[id] : undefined;
    if (entry?.model === overrides[name]) continue;
    agents[id] = { ...entry, model: overrides[name] };
    changed = true;
  }
  if (!changed) return { settings, changed };
  return { settings: { ...settings, subagents: { ...subagents, agents } }, changed };
}

/** Agent -> model the profile wrote earlier; a missing or corrupt file reads as empty. */
function readProfileRecord(recordFile: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordFile, 'utf-8'));
    const entries = isRecord(parsed) && isRecord(parsed.entries) ? parsed.entries : {};
    return Object.fromEntries(Object.entries(entries).filter(([, v]) => typeof v === 'string' && v !== '')) as Record<string, string>;
  } catch {
    return {};
  }
}

function modelOf(settings: Record<string, unknown>, name: string): unknown {
  const agents = isRecord(settings.subagents) && isRecord(settings.subagents.agents) ? settings.subagents.agents : undefined;
  const entry = agents?.[`${COPILOT_PLUGIN_AGENT_PREFIX}${name}`];
  return isRecord(entry) ? entry.model : undefined;
}

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
export function syncCopilotAgentModels(
  settingsFile: string,
  overrides: Record<string, string>,
  profileEntries: Record<string, string> = {},
  recordFile?: string,
): { written: string[]; removed: string[]; error?: string } {
  const recorded = recordFile ? readProfileRecord(recordFile) : {};
  if (Object.keys(overrides).length === 0 && Object.keys(recorded).length === 0) return { written: [], removed: [] };
  let current: unknown = {};
  if (existsSync(settingsFile)) {
    try {
      current = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    } catch {
      return { written: [], removed: [], error: `${settingsFile} is not valid JSON; left untouched` };
    }
    if (!isRecord(current)) return { written: [], removed: [], error: `${settingsFile} is not a JSON object; left untouched` };
  }
  const base = current as Record<string, unknown>;

  const removed = Object.keys(recorded).filter(name => !(name in overrides) && modelOf(base, name) === recorded[name]);
  let afterRemoval = base;
  if (removed.length > 0) {
    const subagents = { ...(base.subagents as Record<string, unknown>) };
    const agents = { ...(subagents.agents as Record<string, unknown>) };
    for (const name of removed) {
      const id = `${COPILOT_PLUGIN_AGENT_PREFIX}${name}`;
      const { model: _model, ...rest } = agents[id] as Record<string, unknown>;
      if (Object.keys(rest).length > 0) agents[id] = rest;
      else delete agents[id];
    }
    afterRemoval = { ...base, subagents: { ...subagents, agents } };
  }
  const { settings, changed } = mergeSubagentModels(afterRemoval, overrides);

  // What the profile owns now: entries this sync writes, or recorded and still untouched.
  // A pre-existing equal value with no record is not ours.
  const nextRecord: Record<string, string> = {};
  for (const [name, value] of Object.entries(profileEntries)) {
    const current = modelOf(base, name);
    if (current !== value || recorded[name] === value) nextRecord[name] = value;
  }
  if (recordFile && JSON.stringify(nextRecord) !== JSON.stringify(recorded)) {
    atomicWriteJsonSync(recordFile, { entries: nextRecord });
  }

  if (!changed && removed.length === 0) return { written: [], removed };
  if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.bak`);
  atomicWriteJsonSync(settingsFile, settings);
  return { written: changed ? Object.keys(overrides) : [], removed };
}
