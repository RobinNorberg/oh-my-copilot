import { describe, expect, it } from 'vitest';

import { addTurnUsage, type SdkTurnUsage } from '../sdk-host.js';

const usage = (data: Record<string, unknown>) => ({ type: 'assistant.usage', data });

describe('sdk host per-turn usage', () => {
  it('sums the token and credit fields of every assistant.usage call into its turn', () => {
    const list: SdkTurnUsage[] = [];
    addTurnUsage(list, 1, usage({
      model: 'claude-sonnet-5.5', inputTokens: 21_000, outputTokens: 300, cacheReadTokens: 18_000, cacheWriteTokens: 2_000,
      copilotUsage: { totalNanoAiu: 4.5e9 },
    }));
    addTurnUsage(list, 1, usage({ inputTokens: 22_000, outputTokens: 120, cacheReadTokens: 21_000, copilotUsage: { totalNanoAiu: 1.5e9 } }));
    addTurnUsage(list, 2, usage({ model: 'gpt-test', inputTokens: 500, copilotUsage: { totalNanoAiu: 0.25e9 } }));
    expect(list).toEqual([
      {
        turn: 1, calls: 2, credits: 6, input_tokens: 43_000, output_tokens: 420,
        cache_read_tokens: 39_000, cache_write_tokens: 2_000, model: 'claude-sonnet-5.5',
      },
      {
        turn: 2, calls: 1, credits: 0.25, input_tokens: 500, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, model: 'gpt-test',
      },
    ]);
  });

  it('ignores other events and malformed token fields', () => {
    const list: SdkTurnUsage[] = [];
    addTurnUsage(list, 1, { type: 'assistant.message', data: { inputTokens: 5 } });
    expect(list).toEqual([]);
    addTurnUsage(list, 1, usage({ inputTokens: '900', outputTokens: -3, cacheReadTokens: Number.NaN }));
    expect(list[0]).toMatchObject({ calls: 1, credits: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, model: null });
  });

  it('keeps only the last 50 turns', () => {
    const list: SdkTurnUsage[] = [];
    for (let turn = 1; turn <= 60; turn++) addTurnUsage(list, turn, usage({ inputTokens: turn }));
    expect(list).toHaveLength(50);
    expect(list[0]!.turn).toBe(11);
    expect(list.at(-1)!.turn).toBe(60);
  });
});
