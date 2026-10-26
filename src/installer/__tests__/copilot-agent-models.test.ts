import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeSubagentModels,
  resolveAgentModelOverrides,
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
      expect(syncCopilotAgentModels(file, { planner: 'claude-opus-5.5' })).toEqual({ written: ['planner'] });
      expect(readFileSync(`${file}.bak`, 'utf8')).toBe(original);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(written.theme).toBe('dark');
      expect(written.subagents.agents['oh-my-copilot:planner'].model).toBe('claude-opus-5.5');

      const mtime = statSync(file).mtimeMs;
      expect(syncCopilotAgentModels(file, { planner: 'claude-opus-5.5' })).toEqual({ written: [] });
      expect(statSync(file).mtimeMs).toBe(mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a missing file, ignores empty overrides, and leaves unparseable settings alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try {
      const file = join(dir, 'settings.json');
      expect(syncCopilotAgentModels(file, {})).toEqual({ written: [] });
      expect(existsSync(file)).toBe(false);
      expect(syncCopilotAgentModels(file, { writer: 'claude-haiku-5.5' })).toEqual({ written: ['writer'] });
      expect(existsSync(`${file}.bak`)).toBe(false);
      writeFileSync(file, '{ not json');
      expect(syncCopilotAgentModels(file, { writer: 'claude-opus-5.5' })).toEqual({
        written: [],
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
