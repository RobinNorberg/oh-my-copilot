import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isBedrock,
  isVertexAI,
  isNonCopilotProvider,
  resolveClaudeFamily,
  hasExtendedContextSuffix,
  isProviderSpecificModelId,
  isSubagentSafeModelId,
  resolveInheritedModelFromEnv,
} from '../models.js';
import { saveAndClear, restore } from './test-helpers.js';

const TIER_MODEL_ENV_KEYS = [
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
  'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
  'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;
const BEDROCK_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', ...TIER_MODEL_ENV_KEYS] as const;
const VERTEX_KEYS = ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', ...TIER_MODEL_ENV_KEYS] as const;
const ALL_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'OMC_ROUTING_FORCE_INHERIT',
  ...TIER_MODEL_ENV_KEYS,
] as const;

// ---------------------------------------------------------------------------
// isBedrock()
// ---------------------------------------------------------------------------
describe('isBedrock()', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(BEDROCK_KEYS); });
  afterEach(() => { restore(saved); });

  it('returns true when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    expect(isBedrock()).toBe(true);
  });

  it('returns false when CLAUDE_CODE_USE_BEDROCK=0', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '0';
    expect(isBedrock()).toBe(false);
  });

  // --- ANTHROPIC_MODEL pattern detection ---

  it('detects global. inference profile — the [1m] 1M-context case', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(isBedrock()).toBe(true);
  });

  it('detects global. inference profile without suffix', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects us. region prefix', () => {
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-opus-4-6-v1';
    expect(isBedrock()).toBe(true);
  });

  it('detects eu. region prefix', () => {
    process.env.ANTHROPIC_MODEL = 'eu.anthropic.claude-haiku-4-5-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects ap. region prefix', () => {
    process.env.ANTHROPIC_MODEL = 'ap.anthropic.claude-sonnet-4-6-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects bare anthropic.copilot prefix (legacy Bedrock IDs)', () => {
    process.env.ANTHROPIC_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('also checks CLAUDE_MODEL', () => {
    process.env.CLAUDE_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(isBedrock()).toBe(true);
  });

  it('detects Bedrock model IDs from tier model env vars', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('returns false for bare Anthropic model IDs', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    expect(isBedrock()).toBe(false);
  });

  it('returns false when no relevant env var is set', () => {
    expect(isBedrock()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isVertexAI()
// ---------------------------------------------------------------------------
describe('isVertexAI()', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(VERTEX_KEYS); });
  afterEach(() => { restore(saved); });

  it('returns true when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    expect(isVertexAI()).toBe(true);
  });

  it('detects vertex_ai/ prefix in ANTHROPIC_MODEL', () => {
    process.env.ANTHROPIC_MODEL = 'vertex_ai/claude-sonnet-4-6@20250301';
    expect(isVertexAI()).toBe(true);
  });

  it('detects Vertex model IDs from tier model env vars', () => {
    process.env.OMC_MODEL_MEDIUM = 'vertex_ai/claude-sonnet-4-6@20250301';
    expect(isVertexAI()).toBe(true);
  });

  it('returns false for Bedrock or bare model IDs', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(isVertexAI()).toBe(false);
  });

  it('returns false when CLAUDE_CODE_USE_VERTEX=0', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '0';
    expect(isVertexAI()).toBe(false);
  });

  it('returns false when no relevant env var is set', () => {
    expect(isVertexAI()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNonCopilotProvider()
// ---------------------------------------------------------------------------
describe('isNonCopilotProvider()', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(ALL_KEYS); });
  afterEach(() => { restore(saved); });

  it('returns true for global. Bedrock inference profile (the [1m] case)', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(isNonCopilotProvider()).toBe(true);
  });

  it('returns true when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    expect(isNonCopilotProvider()).toBe(true);
  });

  it('returns true when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    expect(isNonCopilotProvider()).toBe(true);
  });

  it('returns true when OMC_ROUTING_FORCE_INHERIT=true', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
    expect(isNonCopilotProvider()).toBe(true);
  });

  it('returns true when Anthropic tier defaults target a non-Claude provider', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6:cloud';
    expect(isNonCopilotProvider()).toBe(true);
  });

  it('returns true when OMC tier defaults target a non-Claude provider', () => {
    process.env.OMC_MODEL_MEDIUM = 'glm-5.1:cloud';
    expect(isNonCopilotProvider()).toBe(true);
  });

  // TODO(port-2866 path-B): re-enable when/if fork adopts upstream's
  // shouldAutoForceInherit() helper. Current fork uses isNonCopilotProvider()
  // for both "is non-Claude" and "auto force-inherit" decisions, which conflates
  // the broad and narrow signals these tests pull apart.
  it.skip('does not globally force inheritance for tier-only non-Claude defaults', () => {
    process.env.OMC_MODEL_HIGH = 'glm-5.1:cloud';

    expect(isNonCopilotProvider()).toBe(true);
    // expect(shouldAutoForceInherit()).toBe(false);
  });

  it.skip('does globally force inheritance for direct non-Claude session models', () => {
    process.env.CLAUDE_MODEL = 'glm-5.1:cloud';

    expect(isNonCopilotProvider()).toBe(true);
    // expect(shouldAutoForceInherit()).toBe(true);
  });

  it('lets a direct Claude CLAUDE_MODEL beat a stale non-Claude ANTHROPIC_MODEL', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
    process.env.ANTHROPIC_MODEL = 'kimi-k2.6:cloud';

    expect(isNonCopilotProvider()).toBe(false);
  });

  it('lets a direct Claude CLAUDE_MODEL beat stale non-Claude tier defaults', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
    process.env.OMC_MODEL_MEDIUM = 'glm-5.1:cloud';

    expect(isNonCopilotProvider()).toBe(false);
  });

  it('lets a direct Claude ANTHROPIC_MODEL beat stale non-Claude tier defaults', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    process.env.OMC_MODEL_MEDIUM = 'glm-5.1:cloud';

    expect(isNonCopilotProvider()).toBe(false);
  });

  it('does not treat bare tier aliases as non-Claude provider IDs', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet';
    expect(isNonCopilotProvider()).toBe(false);
  });

  it('returns false for standard Anthropic API bare model IDs', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    expect(isNonCopilotProvider()).toBe(false);
  });

  it('returns false when no env vars are set', () => {
    expect(isNonCopilotProvider()).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// resolveInheritedModelFromEnv()
// ---------------------------------------------------------------------------
describe('resolveInheritedModelFromEnv()', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(ALL_KEYS); });
  afterEach(() => { restore(saved); });

  it('prefers explicit session model env vars over tier defaults', () => {
    process.env.CLAUDE_MODEL = 'claude-session-parent';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6:cloud';

    expect(resolveInheritedModelFromEnv()).toBe('claude-session-parent');
  });

  it('falls back to the medium tier env model for forceInherit without session model vars', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1:cloud';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6:cloud';

    expect(resolveInheritedModelFromEnv()).toBe('kimi-k2.6:cloud');
  });

  it('uses OMC tier model env vars as inherit fallback when provider envs are absent', () => {
    process.env.OMC_MODEL_MEDIUM = 'gpt-5.3:proxy';

    expect(resolveInheritedModelFromEnv()).toBe('gpt-5.3:proxy');
  });

  it('returns undefined instead of a built-in Claude fallback when no model env is configured', () => {
    expect(resolveInheritedModelFromEnv()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isProviderSpecificModelId() — issue #1695
// ---------------------------------------------------------------------------
describe('isProviderSpecificModelId()', () => {
  it('detects Bedrock region-prefixed model IDs', () => {
    expect(isProviderSpecificModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    expect(isProviderSpecificModelId('global.anthropic.claude-opus-4-6-v1:0')).toBe(true);
    expect(isProviderSpecificModelId('eu.anthropic.claude-haiku-4-5-v1:0')).toBe(true);
    expect(isProviderSpecificModelId('ap.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
  });

  it('detects Bedrock bare anthropic.claude prefix (legacy)', () => {
    expect(isProviderSpecificModelId('anthropic.claude-3-haiku-20240307-v1:0')).toBe(true);
  });

  it('detects Bedrock ARN formats', () => {
    expect(isProviderSpecificModelId('arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0')).toBe(true);
    expect(isProviderSpecificModelId('arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123/global.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
  });

  it('detects Vertex AI model IDs', () => {
    expect(isProviderSpecificModelId('vertex_ai/claude-sonnet-4-6@20250514')).toBe(true);
  });

  it('returns false for bare Anthropic API model IDs', () => {
    expect(isProviderSpecificModelId('claude-sonnet-4-6')).toBe(false);
    expect(isProviderSpecificModelId('claude-opus-4-6')).toBe(false);
    expect(isProviderSpecificModelId('claude-haiku-4-5')).toBe(false);
  });

  it('returns false for aliases', () => {
    expect(isProviderSpecificModelId('sonnet')).toBe(false);
    expect(isProviderSpecificModelId('opus')).toBe(false);
    expect(isProviderSpecificModelId('haiku')).toBe(false);
  });

  it('returns false for non-Claude model IDs', () => {
    expect(isProviderSpecificModelId('gpt-4o')).toBe(false);
    expect(isProviderSpecificModelId('gemini-1.5-pro')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeFamily() — ensure Bedrock profile IDs map to correct families
// ---------------------------------------------------------------------------
describe('resolveClaudeFamily() — Bedrock inference profile IDs', () => {
  it('resolves global. sonnet [1m] profile to SONNET', () => {
    expect(resolveClaudeFamily('global.anthropic.claude-sonnet-4-6[1m]')).toBe('SONNET');
  });

  it('resolves us. opus profile to OPUS', () => {
    expect(resolveClaudeFamily('us.anthropic.claude-opus-4-6-v1')).toBe('OPUS');
  });

  it('resolves eu. haiku profile to HAIKU', () => {
    expect(resolveClaudeFamily('eu.anthropic.claude-haiku-4-5-v1:0')).toBe('HAIKU');
  });

  it('resolves bare Anthropic model IDs', () => {
    expect(resolveClaudeFamily('claude-sonnet-4-6')).toBe('SONNET');
    expect(resolveClaudeFamily('claude-opus-4-6')).toBe('OPUS');
    expect(resolveClaudeFamily('claude-haiku-4-5')).toBe('HAIKU');
  });

  it('returns null for non-Copilot model IDs', () => {
    expect(resolveClaudeFamily('gpt-4o')).toBeNull();
    expect(resolveClaudeFamily('gemini-1.5-pro')).toBeNull();
  });
});
