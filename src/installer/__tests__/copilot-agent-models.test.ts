import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeSubagentModels,
  resolveAgentModelOverrides,
  resolveAgentModelPlan,
  syncCopilotAgentModels,
} from '../copilot-agent-models.js';

describe('resolveAgentModelOverrides', () => {
  it('maps tier aliases and Copilot ids, kebab-cases keys, skips omc and reports foreign ids', () => {
    expect(resolveAgentModelOverrides({
      omc: { model: 'opus' },
      executor: { model: 'opus' },
      securityReviewer: { model: 'claude-haiku-4.5' },
      writer: { model: 'sonnet' },
      critic: { model: 'some-other-model' },
      explore: {},
    })).toEqual({
      overrides: {
        executor: 'claude-opus-5.5',
        'security-reviewer': 'claude-haiku-4.5',
        writer: 'claude-sonnet-5.5',
      },
      skipped: ['critic: "some-other-model"'],
    });
    expect(resolveAgentModelOverrides(undefined)).toEqual({ overrides: {}, skipped: [] });
  });

  it('normalizes dashed Claude Code ids and tier case; keeps only knownModels', () => {
    expect(resolveAgentModelOverrides({
      executor: { model: 'claude-sonnet-5-5' },
      planner: { model: 'Opus' },
      architect: { model: 'claude-opus-4-8' },
      critic: { model: 'inherit' },
      writer: { model: 'gpt-4o' },
    })).toEqual({
      overrides: { executor: 'claude-sonnet-5.5', planner: 'claude-opus-5.5' },
      skipped: ['architect: "claude-opus-4-8"', 'critic: "inherit"', 'writer: "gpt-4o"'],
    });
  });

  it('skips a non-string model without dropping other valid overrides', () => {
    expect(resolveAgentModelOverrides({
      executor: { model: 5 as unknown as string },
      planner: { model: 'Opus' },
    })).toEqual({
      overrides: { planner: 'claude-opus-5.5' },
      skipped: ['executor: 5'],
    });
  });
});

describe('mergeSubagentModels', () => {
  it('preserves other keys and sibling fields, and is idempotent', () => {
    const base = {
      theme: 'dark',
      subagents: { maxDepth: 3, agents: { 'oh-my-copilot:executor': { effortLevel: 'high' }, other: { model: 'x' } } },
    };
    const first = mergeSubagentModels(base, { executor: 'claude-opus-5.5' });
    expect(first.changed).toBe(true);
    expect(first.settings).toEqual({
      theme: 'dark',
      subagents: {
        maxDepth: 3,
        agents: { 'oh-my-copilot:executor': { effortLevel: 'high', model: 'claude-opus-5.5' }, other: { model: 'x' } },
      },
    });
    expect(base.subagents.agents['oh-my-copilot:executor']).toEqual({ effortLevel: 'high' });
    expect(mergeSubagentModels(first.settings, { executor: 'claude-opus-5.5' }).changed).toBe(false);
  });

  it('replaces non-object subagents values instead of spreading them into index keys', () => {
    expect(mergeSubagentModels({ subagents: { agents: [] } }, { executor: 'claude-opus-5.5' }).settings).toEqual({
      subagents: { agents: { 'oh-my-copilot:executor': { model: 'claude-opus-5.5' } } },
    });
    expect(mergeSubagentModels({ subagents: 'x' }, { executor: 'claude-opus-5.5' }).settings).toEqual({
      subagents: { agents: { 'oh-my-copilot:executor': { model: 'claude-opus-5.5' } } },
    });
    expect(
      mergeSubagentModels({ subagents: { agents: { 'oh-my-copilot:executor': 'opus' } } }, { executor: 'claude-opus-5.5' }).settings,
    ).toEqual({ subagents: { agents: { 'oh-my-copilot:executor': { model: 'claude-opus-5.5' } } } });
  });
});

describe('syncCopilotAgentModels', () => {
  it('writes with a backup, then does not touch the file when nothing changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try {
      const file = join(dir, 'settings.json');
      const original = JSON.stringify({ theme: 'dark' });
      writeFileSync(file, original);
      expect(syncCopilotAgentModels(file, { planner: 'claude-opus-5.5' })).toEqual({ written: ['planner'], removed: [] });
      expect(readFileSync(`${file}.bak`, 'utf8')).toBe(original);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(written.theme).toBe('dark');
      expect(written.subagents.agents['oh-my-copilot:planner'].model).toBe('claude-opus-5.5');

      const mtime = statSync(file).mtimeMs;
      expect(syncCopilotAgentModels(file, { planner: 'claude-opus-5.5' })).toEqual({ written: [], removed: [] });
      expect(statSync(file).mtimeMs).toBe(mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a missing file, ignores empty overrides, and leaves unparseable settings alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try {
      const file = join(dir, 'settings.json');
      expect(syncCopilotAgentModels(file, {})).toEqual({ written: [], removed: [] });
      expect(existsSync(file)).toBe(false);
      expect(syncCopilotAgentModels(file, { writer: 'claude-haiku-5.5' })).toEqual({ written: ['writer'], removed: [] });
      expect(existsSync(`${file}.bak`)).toBe(false);
      writeFileSync(file, '{ not json');
      expect(syncCopilotAgentModels(file, { writer: 'claude-opus-5.5' })).toEqual({
        written: [], removed: [],
        error: `${file} is not valid JSON; left untouched`,
      });
      expect(readFileSync(file, 'utf8')).toBe('{ not json');
      writeFileSync(file, '[]');
      expect(syncCopilotAgentModels(file, { writer: 'claude-opus-5.5' }).error).toMatch(/not a JSON object/);
      expect(readFileSync(file, 'utf8')).toBe('[]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveAgentModelOverrides with a modelProfile', () => {
  it('balanced and absent profiles add nothing', () => {
    expect(resolveAgentModelOverrides(undefined, 'balanced')).toEqual({ overrides: {}, skipped: [] });
    expect(resolveAgentModelOverrides(undefined, undefined)).toEqual({ overrides: {}, skipped: [] });
  });

  it('economy maps tiers, and an explicit agent model wins over it', () => {
    const { overrides, skipped } = resolveAgentModelOverrides({ architect: { model: 'opus' } }, 'economy');
    expect(skipped).toEqual([]);
    expect(overrides.architect).toBe('claude-opus-5.5');
    expect(overrides.critic).toBe('claude-sonnet-5.5');
    expect(overrides.executor).toBe('claude-haiku-5.5');
    expect(overrides.explore).toBe('claude-haiku-5.5');
  });

  it('reports an unknown profile and applies none', () => {
    const plan = resolveAgentModelPlan(undefined, 'turbo');
    expect(plan.overrides).toEqual({});
    expect(plan.skipped).toEqual([]);
    expect(plan.profileProblem).toMatch(/"turbo"/);
  });
});

describe('model profile entries are reversible', () => {
  const sync = (dir: string, agents: Parameters<typeof resolveAgentModelPlan>[0], profile?: string) => {
    const plan = resolveAgentModelPlan(agents, profile);
    return syncCopilotAgentModels(join(dir, 'settings.json'), plan.overrides, plan.profileEntries, join(dir, 'record.json'));
  };
  const modelOf = (dir: string, name: string) =>
    JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).subagents?.agents?.[`oh-my-copilot:${name}`]?.model;
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('economy then balanced leaves no profile entry and keeps a user-edited one', () => withDir((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    sync(dir, undefined, 'economy');
    expect(modelOf(dir, 'executor')).toBe('claude-haiku-5.5');
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    settings.subagents.agents['oh-my-copilot:explore'].model = 'claude-opus-5.5'; // user edit
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    const result = sync(dir, undefined, 'balanced');
    expect(result.removed).toContain('executor');
    expect(result.removed).not.toContain('explore');
    const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(Object.keys(after.subagents.agents)).toEqual(['oh-my-copilot:explore']);
    expect(after.theme).toBe('dark');
    expect(modelOf(dir, 'explore')).toBe('claude-opus-5.5');
  }));

  it('economy then quality-first replaces the values', () => withDir((dir) => {
    sync(dir, undefined, 'economy');
    sync(dir, undefined, 'quality-first');
    expect(modelOf(dir, 'executor')).toBe('claude-opus-5.5');
    expect(modelOf(dir, 'explore')).toBe('claude-sonnet-5.5');
    sync(dir, undefined, undefined);
    expect(modelOf(dir, 'executor')).toBeUndefined();
  }));

  it('never removes an explicit entry, and nothing without a record', () => withDir((dir) => {
    sync(dir, { executor: { model: 'opus' } }, undefined);
    sync(dir, undefined, undefined);
    expect(modelOf(dir, 'executor')).toBe('claude-opus-5.5');
    writeFileSync(join(dir, 'record.json'), '{ not json');
    expect(sync(dir, undefined, undefined).removed).toEqual([]);
    expect(modelOf(dir, 'executor')).toBe('claude-opus-5.5');
    rmSync(join(dir, 'record.json'));
    sync(dir, undefined, 'economy');
    rmSync(join(dir, 'record.json'));
    expect(sync(dir, undefined, 'balanced').removed).toEqual([]);
    expect(modelOf(dir, 'executor')).toBe('claude-haiku-5.5');
  }));

  it('an explicit inherit, empty or invalid value drops the profile entry for that agent', () => {
    const plan = resolveAgentModelPlan({ executor: { model: 'inherit' }, writer: { model: ' ' }, critic: { model: 'bogus' } }, 'economy');
    expect(plan.overrides).not.toHaveProperty('executor');
    expect(plan.overrides).not.toHaveProperty('writer');
    expect(plan.overrides).not.toHaveProperty('critic');
    expect(plan.profileEntries).not.toHaveProperty('executor');
    expect(plan.overrides.explore).toBe('claude-haiku-5.5');
    expect(plan.skipped).toEqual(['executor: "inherit"', 'critic: "bogus"']);
  });
});
