import { describe, expect, it, vi } from 'vitest';
import { buildLaunchArgs, resolveCopilotModel, warnUnavailableCopilotTier } from '../model-contract.js';

const base = { teamName: 't', workerName: 'w', cwd: '/tmp' };
const modelArg = (args: string[]) => (args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined);

describe('resolveCopilotModel against the plan catalogue', () => {
  it('without a catalogue keeps the first model of the tier (unverified)', () => {
    expect(resolveCopilotModel('opus')).toEqual({ model: 'claude-opus-5.5', tier: 'opus', status: 'unverified' });
    expect(resolveCopilotModel('Fable', null)).toEqual({ model: 'claude-fable-5.2', tier: 'fable', status: 'unverified' });
  });

  it('takes the first tier model the catalogue offers', () => {
    const all = new Set(['claude-opus-5.5', 'gpt-6.1-sol', 'claude-sonnet-5.5', 'mai-code-2', 'mai-code-2-flash']);
    expect(resolveCopilotModel('opus', all)).toEqual({ model: 'claude-opus-5.5', tier: 'opus', status: 'available' });
    expect(resolveCopilotModel('sonnet', all).model).toBe('mai-code-2');
  });

  it('skips tier models the plan does not offer', () => {
    const pro = new Set(['claude-sonnet-5.5', 'mai-code-2', 'claude-haiku-5.5', 'gpt-6-luna']);
    expect(resolveCopilotModel('opus', pro)).toEqual({ model: 'claude-sonnet-5.5', tier: 'opus', status: 'available' });
    expect(resolveCopilotModel('haiku', pro).model).toBe('claude-haiku-5.5');
    expect(resolveCopilotModel('haiku', new Set(['gpt-6-luna'])).model).toBe('gpt-6-luna');
  });

  it('reports a tier with no offered model as unavailable and names no model', () => {
    expect(resolveCopilotModel('fable', new Set(['claude-sonnet-5.5']))).toEqual({ model: undefined, tier: 'fable', status: 'unavailable' });
    expect(resolveCopilotModel('opus', new Set())).toEqual({ model: undefined, tier: 'opus', status: 'unavailable' });
  });

  it('passes concrete ids through the id rewrite whatever the catalogue says', () => {
    expect(resolveCopilotModel('claude-sonnet-5-5', new Set())).toEqual({ model: 'claude-sonnet-5.5', status: 'passthrough' });
    expect(resolveCopilotModel('constructor', new Set())).toEqual({ model: 'constructor', status: 'passthrough' });
  });
});

describe('copilot worker --model with a catalogue', () => {
  it('uses the first offered tier model', () => {
    const args = buildLaunchArgs('copilot', { ...base, model: 'opus', copilotCatalogue: new Set(['gpt-6.1-sol']) });
    expect(modelArg(args)).toBe('gpt-6.1-sol');
  });

  it('keeps the first id when the catalogue is unknown', () => {
    expect(modelArg(buildLaunchArgs('copilot', { ...base, model: 'fable', copilotCatalogue: null }))).toBe('claude-fable-5.2');
    expect(modelArg(buildLaunchArgs('copilot', { ...base, model: 'fable' }))).toBe('claude-fable-5.2');
  });

  it('passes no --model when the plan offers no tier model, and warns once per tier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pro = new Set(['claude-sonnet-5.5']);
      const args = buildLaunchArgs('copilot', { ...base, model: 'fable', copilotCatalogue: pro });
      expect(args).not.toContain('--model');
      buildLaunchArgs('copilot', { ...base, model: 'fable', copilotCatalogue: pro });
      const fableLines = warn.mock.calls.filter(([line]) => String(line).includes('"fable"'));
      expect(fableLines).toHaveLength(1);
      expect(String(fableLines[0]![0])).toMatch(/claude-fable-5\.2, gpt-6\.2-astra/);
    } finally {
      warn.mockRestore();
    }
  });

  it('warnUnavailableCopilotTier writes through the given sink once', () => {
    const lines: string[] = [];
    warnUnavailableCopilotTier('test-tier', (l) => lines.push(l));
    warnUnavailableCopilotTier('test-tier', (l) => lines.push(l));
    expect(lines).toHaveLength(1);
  });
});
