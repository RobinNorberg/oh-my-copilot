/**
 * `modelProfile`: one switch that maps agent tiers to Copilot models for the
 * plugin agents, applied by `omg setup` (installer/copilot-agent-models.ts).
 * `balanced` is today's behaviour: no override, every agent keeps its own
 * default model. Explicit `agents.<name>.model` settings always win.
 */
export type ModelProfile = 'quality-first' | 'balanced' | 'economy';
export declare const MODEL_PROFILES: readonly ModelProfile[];
export declare const DEFAULT_MODEL_PROFILE: ModelProfile;
export type AgentTier = 'high' | 'medium' | 'low';
/** Tier of each plugin agent: the tier of its default model (opus, sonnet, haiku). */
export declare const AGENT_TIERS: Readonly<Record<string, AgentTier>>;
/** The profile named by a config value; undefined for anything that is not one. */
export declare function parseModelProfile(value: unknown): ModelProfile | undefined;
/** Agent name -> model tier alias the profile sets (empty for `balanced`). */
export declare function profileAgentModels(profile: ModelProfile): Record<string, string>;
//# sourceMappingURL=profiles.d.ts.map