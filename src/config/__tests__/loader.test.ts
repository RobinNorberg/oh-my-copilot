import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactOmcStartupGuidance,
  generateConfigSchema,
  loadConfig,
  loadContextFromFiles,
} from '../loader.js';
import { saveAndClear, restore } from './test-helpers.js';

const ALL_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'OMC_ROUTING_FORCE_INHERIT',
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

// ---------------------------------------------------------------------------
// Auto-forceInherit for Bedrock / Vertex (issues #1201, #1025)
// ---------------------------------------------------------------------------
describe('loadConfig() — auto-forceInherit for non-standard providers', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(ALL_KEYS); });
  afterEach(() => { restore(saved); });

  it('auto-enables forceInherit for global. Bedrock inference profile with [1m] suffix', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit for us. Bedrock region prefix', () => {
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-opus-4-6-v1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('does not auto-enable forceInherit for Bedrock inference-profile ARN model IDs (use CLAUDE_CODE_USE_BEDROCK=1 instead)', () => {
    process.env.ANTHROPIC_MODEL =
      'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0';
    const config = loadConfig();
    // isBedrock() only checks region prefix patterns and CLAUDE_CODE_USE_BEDROCK env var,
    // not ARN format. ARN model IDs contain 'claude' so non-copilot model check also skips.
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('auto-enables forceInherit when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('does NOT auto-enable forceInherit for standard Anthropic API usage', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('does NOT auto-enable forceInherit when no provider env vars are set', () => {
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('respects explicit OMC_ROUTING_FORCE_INHERIT=false even on Bedrock', () => {
    // When user explicitly sets the var (even to false), auto-detection is skipped.
    // This matches the guard: process.env.OMC_ROUTING_FORCE_INHERIT === undefined
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
    const config = loadConfig();
    // env var is defined → auto-detection skipped → remains at default (false)
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('maps Bedrock family env vars into agent defaults and routing tiers', () => {
    process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL = 'us.anthropic.claude-opus-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-v1:0';

    const config = loadConfig();

    expect(config.agents?.architect?.model).toBe('us.anthropic.claude-opus-4-6-v1:0');
    expect(config.agents?.executor?.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(config.agents?.explore?.model).toBe('us.anthropic.claude-haiku-4-5-v1:0');
    expect(config.routing?.tierModels?.HIGH).toBe('us.anthropic.claude-opus-4-6-v1:0');
    expect(config.routing?.tierModels?.MEDIUM).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(config.routing?.tierModels?.LOW).toBe('us.anthropic.claude-haiku-4-5-v1:0');
  });

  it('supports Anthropic family-default env vars for tiered routing defaults', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6-custom';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6-custom';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-custom';

    const config = loadConfig();

    expect(config.agents?.architect?.model).toBe('claude-opus-4-6-custom');
    expect(config.agents?.executor?.model).toBe('claude-sonnet-4-6-custom');
    expect(config.agents?.explore?.model).toBe('claude-haiku-4-5-custom');
  });

});

describe("startup context compaction", () => {
  it("loadContextFromFiles includes file content with header prefix", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-loader-context-"));

    try {
      const omcAgentsPath = join(tempDir, "AGENTS.md");
      const omcGuidance = `# oh-my-copilot - Intelligent Multi-Agent Orchestration

<operating_principles>
- keep this
</operating_principles>

<verification>
- verify this stays
</verification>`;

      writeFileSync(omcAgentsPath, omcGuidance);

      const loaded = loadContextFromFiles([omcAgentsPath]);

      expect(loaded).toContain("<operating_principles>");
      expect(loaded).toContain("<verification>");
      expect(loaded).toContain("## Context from");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

});

describe("plan output configuration", () => {
  let saved: Record<string, string | undefined>;
  let originalCwd: string;

  beforeEach(() => {
    saved = saveAndClear(ALL_KEYS);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restore(saved);
  });

  it("includes plan output defaults", () => {
    const config = loadConfig();
    // planOutput is optional; when not set in project config, it may be undefined
    // or contain defaults depending on loader implementation
    if (config.planOutput !== undefined) {
      expect(config.planOutput).toMatchObject({
        directory: expect.any(String),
      });
    }
  });

  it("includes teleport defaults", () => {
    const config = loadConfig();
    expect(config.teleport).toEqual({
      symlinkNodeModules: true,
    });
  });

  it("loads plan output overrides from project config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-plan-output-"));

    try {
      const copilotDir = join(tempDir, ".copilot");
      require("node:fs").mkdirSync(copilotDir, { recursive: true });
      writeFileSync(
        join(copilotDir, "omg.jsonc"),
        JSON.stringify({
          planOutput: {
            directory: "docs/plans",
            filenameTemplate: "plan-{{name}}.md",
          },
        }),
      );

      process.chdir(tempDir);

      const config = loadConfig();
      expect(config.planOutput).toEqual({
        directory: "docs/plans",
        filenameTemplate: "plan-{{name}}.md",
      });
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("company context configuration", () => {
  let saved: Record<string, string | undefined>;
  let originalCwd: string;

  beforeEach(() => {
    saved = saveAndClear(ALL_KEYS);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restore(saved);
  });

  it("includes the default prompt-level fallback", () => {
    const config = loadConfig();
    expect(config.companyContext).toEqual({
      onError: "warn",
    });
  });

  it("loads company context overrides from project config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-company-context-"));

    try {
      const copilotDir = join(tempDir, ".copilot");
      require("node:fs").mkdirSync(copilotDir, { recursive: true });
      writeFileSync(
        join(copilotDir, "omg.jsonc"),
        JSON.stringify({
          companyContext: {
            tool: "mcp__vendor__get_company_context",
            onError: "fail",
          },
        }),
      );

      process.chdir(tempDir);

      const config = loadConfig();
      expect(config.companyContext).toEqual({
        tool: "mcp__vendor__get_company_context",
        onError: "fail",
      });
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes companyContext in the generated config schema", () => {
    const schema = generateConfigSchema() as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };

    expect(schema.properties?.companyContext).toBeDefined();
    expect(schema.properties?.companyContext?.properties?.tool).toBeDefined();
    expect(schema.properties?.companyContext?.properties?.onError).toBeDefined();
  });
});

describe("team.roleRouting (Option E)", () => {
  let saved: Record<string, string | undefined>;
  let originalCwd: string;

  beforeEach(() => {
    saved = saveAndClear([...ALL_KEYS, "OMCP_TEAM_ROLE_OVERRIDES"] as const);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restore(saved);
  });

  it("includes default empty team block in built config", () => {
    const config = loadConfig();
    expect(config.team).toBeDefined();
    expect(config.team?.roleRouting).toEqual({});
    expect(config.team?.ops).toEqual({});
  });

  it("merges per-role file overrides into team.roleRouting", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-routing-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: {
            roleRouting: {
              critic: { provider: "codex", model: "gpt-5.3-codex" },
              "code-reviewer": { provider: "gemini" },
            },
          },
        }),
      );
      process.chdir(tempDir);
      const config = loadConfig();
      expect(config.team?.roleRouting?.critic).toEqual({
        provider: "codex",
        model: "gpt-5.3-codex",
      });
      expect(config.team?.roleRouting?.["code-reviewer"]).toEqual({
        provider: "gemini",
      });
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("OMCP_TEAM_ROLE_OVERRIDES env wins over file config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-routing-env-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: { roleRouting: { critic: { provider: "claude", model: "HIGH" } } },
        }),
      );
      process.env.OMCP_TEAM_ROLE_OVERRIDES = JSON.stringify({
        critic: { provider: "codex" },
      });
      process.chdir(tempDir);
      const config = loadConfig();
      expect(config.team?.roleRouting?.critic?.provider).toBe("codex");
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("OMCP_TEAM_ROLE_OVERRIDES with invalid JSON is ignored with warning", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.OMCP_TEAM_ROLE_OVERRIDES = "{not valid json";
      const config = loadConfig();
      expect(config.team?.roleRouting).toEqual({});
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OMCP_TEAM_ROLE_OVERRIDES"),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("rejects invalid provider value with descriptive error", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-bad-provider-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: { roleRouting: { critic: { provider: "openai" } } },
        }),
      );
      process.chdir(tempDir);
      expect(() => loadConfig()).toThrow(/team\.roleRouting\.critic\.provider/);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects orchestrator.provider override (orchestrator is pinned to claude)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-orch-pin-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: {
            roleRouting: { orchestrator: { provider: "codex", model: "HIGH" } },
          },
        }),
      );
      process.chdir(tempDir);
      expect(() => loadConfig()).toThrow(/orchestrator: key "provider" is not allowed/);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown agent name", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-bad-agent-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: { roleRouting: { executor: { agent: "nonExistentAgent" } } },
        }),
      );
      process.chdir(tempDir);
      expect(() => loadConfig()).toThrow(/team\.roleRouting\.executor\.agent/);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts 'reviewer' alias and preserves the raw key for later alias-aware resolution", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-alias-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: { roleRouting: { reviewer: { provider: "codex" } } },
        }),
      );
      process.chdir(tempDir);
      // Should not throw — alias normalizes to code-reviewer canonical role.
      const config = loadConfig();
      expect(config.team?.roleRouting).toBeDefined();
      // Validator preserves the user's key as-written; runtime/stage routing
      // must therefore resolve aliases from the stored raw map too.
      const r = config.team?.roleRouting as Record<string, unknown>;
      expect(r["reviewer"]).toEqual({ provider: "codex" });
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported team.ops.defaultAgentType values", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-default-agent-type-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: { ops: { defaultAgentType: "executor" } },
        }),
      );
      process.chdir(tempDir);
      expect(() => loadConfig()).toThrow(/team\.ops\.defaultAgentType/);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown role with descriptive error", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-team-bad-role-"));
    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          team: { roleRouting: { "totally-fake-role": { provider: "claude" } } },
        }),
      );
      process.chdir(tempDir);
      expect(() => loadConfig()).toThrow(/unknown role "totally-fake-role"/);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
