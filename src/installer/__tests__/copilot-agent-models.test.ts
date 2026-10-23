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
  it('maps tier aliases and Copilot ids, kebab-cases keys, skips omc and foreign ids', () => {
    expect(resolveAgentModelOverrides({
      omc: { model: 'opus' },
      executor: { model: 'opus' },
      securityReviewer: { model: 'claude-haiku-4.5' },
      writer: { model: 'sonnet' },
      critic: { model: 'some-other-model' },
      explore: {},
    })).toEqual({
      executor: 'claude-opus-5.5',
      'security-reviewer': 'claude-haiku-4.5',
      writer: 'claude-sonnet-5.5',
    });
    expect(resolveAgentModelOverrides(undefined)).toEqual({});
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
});

describe('syncCopilotAgentModels', () => {
  it('writes with a backup, then does not touch the file when nothing changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try {
      const file = join(dir, 'settings.json');
      const original = JSON.stringify({ theme: 'dark' });
      writeFileSync(file, original);
      expect(syncCopilotAgentModels(file, { planner: 'claude-opus-5.5' })).toEqual(['planner']);
      expect(readFileSync(`${file}.bak`, 'utf8')).toBe(original);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(written.theme).toBe('dark');
      expect(written.subagents.agents['oh-my-copilot:planner'].model).toBe('claude-opus-5.5');

      const mtime = statSync(file).mtimeMs;
      expect(syncCopilotAgentModels(file, { planner: 'claude-opus-5.5' })).toEqual([]);
      expect(statSync(file).mtimeMs).toBe(mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a missing file, ignores empty overrides, and leaves unparseable settings alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-agent-models-'));
    try {
      const file = join(dir, 'settings.json');
      expect(syncCopilotAgentModels(file, {})).toEqual([]);
      expect(existsSync(file)).toBe(false);
      expect(syncCopilotAgentModels(file, { writer: 'claude-haiku-5.5' })).toEqual(['writer']);
      expect(existsSync(`${file}.bak`)).toBe(false);
      writeFileSync(file, '{ not json');
      expect(syncCopilotAgentModels(file, { writer: 'claude-opus-5.5' })).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
