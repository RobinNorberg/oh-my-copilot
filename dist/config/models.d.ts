export type ModelTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type ClaudeModelFamily = 'HAIKU' | 'SONNET' | 'OPUS';
/**
 * Canonical Copilot family defaults.
 * Keep these date-less so version bumps are a one-line edit per family.
 */
export declare const COPILOT_FAMILY_DEFAULTS: Record<ClaudeModelFamily, string>;
/** Canonical tier->model mapping used as built-in defaults */
export declare const BUILTIN_TIER_MODEL_DEFAULTS: Record<ModelTier, string>;
/** Canonical Copilot high-reasoning variants by family */
export declare const COPILOT_FAMILY_HIGH_VARIANTS: Record<ClaudeModelFamily, string>;
/** Built-in defaults for external provider models */
export declare const BUILTIN_EXTERNAL_MODEL_DEFAULTS: {
    readonly codexModel: "gpt-5.3-codex";
    readonly geminiModel: "gemini-3.1-pro-preview";
};
export declare function hasTierModelEnvOverrides(): boolean;
export declare function getDefaultModelHigh(): string;
export declare function getDefaultModelMedium(): string;
export declare function getDefaultModelLow(): string;
/**
 * Get all default tier models as a record.
 * Each call reads current env vars, so changes are reflected immediately.
 */
export declare function getDefaultTierModels(): Record<ModelTier, string>;
/**
 * Resolve a Copilot family from an arbitrary model ID.
 * Supports Anthropic IDs and provider-prefixed forms (e.g. vertex_ai/...).
 */
export declare function resolveClaudeFamily(modelId: string): ClaudeModelFamily | null;
/**
 * Resolve a canonical Copilot high variant from a Copilot model ID.
 * Returns null for non-Copilot model IDs.
 */
export declare function getClaudeHighVariantFromModel(modelId: string): string | null;
/** Get built-in default model for an external provider */
export declare function getBuiltinExternalDefaultModel(provider: 'codex' | 'gemini'): string;
/**
 * Detect whether Copilot CLI is running on AWS Bedrock.
 *
 * Copilot CLI sets CLAUDE_CODE_USE_BEDROCK=1 when configured for Bedrock.
 * As a fallback, Bedrock model IDs use prefixed formats like:
 *   - us.anthropic.claude-sonnet-4-6-v1:0
 *   - global.anthropic.claude-sonnet-4-6-v1:0
 *   - anthropic.claude-3-haiku-20240307-v1:0
 *
 * On Bedrock, passing bare tier names (sonnet/opus/haiku) to spawned
 * agents causes 400 errors because the provider expects full Bedrock
 * model IDs with region/inference-profile prefixes.
 */
export declare function isBedrock(): boolean;
/**
 * Detect whether Copilot CLI is running on Google Vertex AI.
 *
 * Copilot CLI sets CLAUDE_CODE_USE_VERTEX=1 when configured for Vertex AI.
 * Vertex model IDs typically use a "vertex_ai/" prefix.
 *
 * On Vertex, passing bare tier names causes errors because the provider
 * expects full Vertex model paths.
 */
export declare function isVertexAI(): boolean;
/**
 * Check whether a model ID string is a provider-specific identifier that
 * should NOT be normalized to a bare alias (sonnet/opus/haiku).
 *
 * Provider-specific IDs include:
 *   - Bedrock prefixed: us.anthropic.claude-*, global.anthropic.claude-*, anthropic.claude-*
 *   - Bedrock ARN: arn:aws:bedrock:...
 *   - Vertex AI: vertex_ai/...
 *
 * These IDs must be passed through to the CLI as-is because normalizing them
 * would produce invalid model names on the target provider. (issue #1695)
 */
export declare function isProviderSpecificModelId(modelId: string): boolean;
/** Check if a model ID string matches Bedrock patterns */
export declare function isBedrockModelId(modelId: string): boolean;
/** Check if a model ID string matches Vertex AI patterns */
export declare function isVertexModelId(modelId: string): boolean;
/**
 * Detect whether OMC should avoid passing Copilot-specific model tier
 * names (sonnet/opus/haiku) to the Agent tool.
 *
 * Returns true when:
 * - User explicitly set OMC_ROUTING_FORCE_INHERIT=true
 * - Running on AWS Bedrock — needs full Bedrock model IDs, not bare tier names
 * - Running on Google Vertex AI — needs full Vertex model paths
 * - A non-Copilot model ID is detected (CC Switch, LiteLLM, etc.)
 * - A custom ANTHROPIC_BASE_URL points to a non-Anthropic endpoint
 */
export declare function isNonCopilotProvider(): boolean;
//# sourceMappingURL=models.d.ts.map