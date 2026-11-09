/**
 * `modelProfile`: one switch that maps agent tiers to Copilot models for the
 * plugin agents, applied by `omg setup` (installer/copilot-agent-models.ts).
 * `balanced` is today's behaviour: no override, every agent keeps its own
 * default model. Explicit `agents.<name>.model` settings always win.
 */
export const MODEL_PROFILES = ['quality-first', 'balanced', 'economy'];
export const DEFAULT_MODEL_PROFILE = 'balanced';
/** Tier of each plugin agent: the tier of its default model (opus, sonnet, haiku). */
export const AGENT_TIERS = {
    analyst: 'high',
    planner: 'high',
    architect: 'high',
    critic: 'high',
    'code-reviewer': 'high',
    'code-simplifier': 'high',
    'devils-advocate': 'high',
    debugger: 'medium',
    executor: 'medium',
    verifier: 'medium',
    'security-reviewer': 'medium',
    'test-engineer': 'medium',
    designer: 'medium',
    'qa-tester': 'medium',
    scientist: 'medium',
    tracer: 'medium',
    'git-master': 'medium',
    'document-specialist': 'medium',
    explore: 'low',
    writer: 'low',
};
/** Model tier alias per agent tier; `balanced` is empty on purpose (agent defaults). */
const PROFILE_TIERS = {
    'quality-first': { high: 'opus', medium: 'opus', low: 'sonnet' },
    balanced: {},
    economy: { high: 'sonnet', medium: 'haiku', low: 'haiku' },
};
/** The profile named by a config value; undefined for anything that is not one. */
export function parseModelProfile(value) {
    return typeof value === 'string' && MODEL_PROFILES.includes(value) ? value : undefined;
}
/** Agent name -> model tier alias the profile sets (empty for `balanced`). */
export function profileAgentModels(profile) {
    const tiers = PROFILE_TIERS[profile];
    const out = {};
    for (const [agent, tier] of Object.entries(AGENT_TIERS)) {
        const model = tiers[tier];
        if (model)
            out[agent] = model;
    }
    return out;
}
//# sourceMappingURL=profiles.js.map