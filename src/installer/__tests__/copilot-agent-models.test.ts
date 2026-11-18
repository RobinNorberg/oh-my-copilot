import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeSubagentModels,
  resolveAgentModelOverrides,
  resolveAgentModelPlan,
  syncCopilotAgentModels,
  usesCopilotTierAliases,
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
        writer: 'mai-code-2',
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
    expect(overrides.critic).toBe('mai-code-2');
    expect(overrides.executor).toBe('mai-code-2-flash');
    expect(overrides.explore).toBe('mai-code-2-flash');
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
    expect(modelOf(dir, 'executor')).toBe('mai-code-2-flash');
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
    expect(modelOf(dir, 'explore')).toBe('mai-code-2');
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
    expect(modelOf(dir, 'executor')).toBe('mai-code-2-flash');
  }));

  it('a failing settings write leaves the record listing every entry still in settings', () => withDir((dir) => {
    sync(dir, undefined, 'economy');
    const recordBefore = readFileSync(join(dir, 'record.json'), 'utf8');
    const settingsBefore = readFileSync(join(dir, 'settings.json'), 'utf8');
    mkdirSync(join(dir, 'settings.json.bak')); // the backup copy now throws
    expect(() => sync(dir, undefined, 'balanced')).toThrow();
    expect(readFileSync(join(dir, 'record.json'), 'utf8')).toBe(recordBefore);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(settingsBefore);
    expect(Object.keys(JSON.parse(recordBefore).entries)).toContain('executor');
    rmSync(join(dir, 'settings.json.bak'), { recursive: true });
    sync(dir, undefined, 'balanced'); // a later setup still cleans up
    expect(modelOf(dir, 'executor')).toBeUndefined();
  }));

  it('ignores record keys that are not known agents or not strings', () => withDir((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ subagents: { agents: {
      'oh-my-copilot:stranger': { model: 'x' },
      'oh-my-copilot:__proto__': { model: 'x' },
      'oh-my-copilot:executor': { model: 7 },
    } } }));
    writeFileSync(join(dir, 'record.json'), '{"entries":{"stranger":"x","__proto__":"x","executor":7}}');
    expect(sync(dir, undefined, undefined).removed).toEqual([]);
    const agents = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).subagents.agents;
    expect(Object.keys(agents)).toEqual(['oh-my-copilot:stranger', 'oh-my-copilot:__proto__', 'oh-my-copilot:executor']);
  }));

  it('an explicit inherit, empty or invalid value drops the profile entry for that agent', () => {
    const plan = resolveAgentModelPlan({ executor: { model: 'inherit' }, writer: { model: ' ' }, critic: { model: 'bogus' } }, 'economy');
    expect(plan.overrides).not.toHaveProperty('executor');
    expect(plan.overrides).not.toHaveProperty('writer');
    expect(plan.overrides).not.toHaveProperty('critic');
    expect(plan.profileEntries).not.toHaveProperty('executor');
    expect(plan.overrides.explore).toBe('mai-code-2-flash');
    expect(plan.skipped).toEqual(['executor: "inherit"', 'critic: "bogus"']);
  });
});

describe('tier aliases against the plan catalogue', () => {
  it('resolves each tier to the first model the plan offers', () => {
    const pro = new Set(['claude-sonnet-5.5', 'mai-code-2', 'mai-code-2-flash', 'claude-haiku-5.5']);
    const plan = resolveAgentModelPlan({ architect: { model: 'opus' } }, 'economy', pro);
    expect(plan.overrides.architect).toBe('claude-sonnet-5.5');
    expect(plan.overrides.critic).toBe('mai-code-2');
    expect(plan.overrides.explore).toBe('mai-code-2-flash');
    expect(plan.unavailableTiers).toEqual({});
  });

  it('writes no override for a tier the plan cannot use and reports it', () => {
    const pro = new Set(['claude-sonnet-5.5', 'mai-code-2']);
    const plan = resolveAgentModelPlan({ planner: { model: 'fable' }, executor: { model: 'opus' } }, undefined, pro);
    expect(plan.overrides).toEqual({ executor: 'claude-sonnet-5.5' });
    expect(plan.skipped).toEqual([]);
    expect(plan.unavailableTiers).toEqual({ fable: ['planner'] });
  });

  it('a profile tier the plan cannot use leaves those agents on the session model', () => {
    const plan = resolveAgentModelPlan({ explore: { model: 'gpt-6-luna' } }, 'economy', new Set(['mai-code-2']));
    expect(plan.overrides.critic).toBe('mai-code-2');
    expect(plan.overrides).not.toHaveProperty('executor');
    expect(plan.profileEntries).not.toHaveProperty('executor');
    expect(plan.overrides.explore).toBe('gpt-6-luna');
    expect(plan.unavailableTiers.haiku).toContain('executor');
    expect(plan.unavailableTiers.haiku).not.toContain('explore');
  });

  it('an unknown catalogue keeps the first confirmed id of each tier; fable has none', () => {
    const plan = resolveAgentModelPlan({ planner: { model: 'fable' }, executor: { model: 'opus' } }, undefined, null);
    expect(plan.overrides).toEqual({ executor: 'claude-opus-5.5' });
    expect(plan.unavailableTiers).toEqual({ fable: ['planner'] });
  });

  it('removes a stale override an earlier setup wrote for a tier the plan cannot use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try {
      const file = join(dir, 'settings.json');
      // v5.29.1 wrote fable's first id, claude-opus-5.5; a user-chosen id for another agent stays.
      writeFileSync(file, JSON.stringify({
        theme: 'dark',
        subagents: { agents: {
          'oh-my-copilot:planner': { model: 'claude-opus-5.5', effort: 'high' },
          'oh-my-copilot:critic': { model: 'claude-fable-5.2' },
          'oh-my-copilot:architect': { model: 'gpt-6-luna' },
        } },
      }));
      const plan = resolveAgentModelPlan(
        { planner: { model: 'fable' }, critic: { model: 'fable' }, architect: { model: 'fable' } },
        undefined,
        new Set(['claude-sonnet-5.5']),
      );
      expect(plan.unavailableTiers).toEqual({ fable: ['planner', 'critic', 'architect'] });
      const result = syncCopilotAgentModels(file, plan.overrides, plan.profileEntries, join(dir, 'record.json'), plan.unavailableTiers);
      expect(result.removed.sort()).toEqual(['critic', 'planner']);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        theme: 'dark',
        subagents: { agents: {
          'oh-my-copilot:planner': { effort: 'high' },
          'oh-my-copilot:architect': { model: 'gpt-6-luna' },
        } },
      });
      // Nothing left to remove: no further write.
      expect(syncCopilotAgentModels(file, plan.overrides, plan.profileEntries, join(dir, 'record.json'), plan.unavailableTiers)).toEqual({ written: [], removed: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('usesCopilotTierAliases tells whether the catalogue matters', () => {
    expect(usesCopilotTierAliases(undefined, undefined)).toBe(false);
    expect(usesCopilotTierAliases(undefined, 'balanced')).toBe(false);
    expect(usesCopilotTierAliases(undefined, 'economy')).toBe(true);
    expect(usesCopilotTierAliases({ executor: { model: 'claude-sonnet-5.5' } })).toBe(false);
    expect(usesCopilotTierAliases({ executor: { model: ' Opus ' } })).toBe(true);
    expect(usesCopilotTierAliases({ omc: { model: 'opus' } })).toBe(false);
  });
});
