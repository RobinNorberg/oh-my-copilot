import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { getAiUsed, getCopilotContextPercent, getCopilotModelName, getCopilotTokenUsage, getSessionDurationMs, } from '../../hud/stdin.js';
function fixture(name) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}
const idle = fixture('copilot-1.0.103-synth-idle.json');
const afterPrompt = fixture('copilot-1.0.103-synth-after-prompt.json');
const nearLimit = fixture('copilot-1.0.103-synth-near-limit.json');
const aiUsedAuto = fixture('copilot-1.0.103-synth-ai-used.json');
describe('Copilot statusline payload getters', () => {
    it('prefers current_context_used_percentage, then used_percentage, then the token fallbacks', () => {
        expect(getCopilotContextPercent(idle)).toBe(0);
        expect(getCopilotContextPercent(afterPrompt)).toBe(31);
        expect(getCopilotContextPercent(nearLimit)).toBe(86);
        expect(getCopilotContextPercent({ context_window: { used_percentage: 18.6 } })).toBe(19);
        expect(getCopilotContextPercent({ context_window: { current_context_used_percentage: 140 } })).toBe(100);
        expect(getCopilotContextPercent({
            context_window: { context_window_size: 1000, current_usage: { input_tokens: 250 } },
        })).toBe(25);
        expect(getCopilotContextPercent({})).toBe(0);
    });
    it('reads the session duration from cost.total_duration_ms', () => {
        expect(getSessionDurationMs(afterPrompt)).toBe(1_500_000);
        expect(getSessionDurationMs({})).toBeNull();
        expect(getSessionDurationMs({ cost: { total_duration_ms: -1 } })).toBeNull();
        expect(getSessionDurationMs({ cost: { total_duration_ms: Number.NaN } })).toBeNull();
    });
    it('reads ai_used, tolerating a missing formatted text or nano value', () => {
        expect(getAiUsed(idle)).toEqual({ nanoAiu: 0, formatted: '0' });
        expect(getAiUsed(nearLimit)).toEqual({ nanoAiu: 9_140_000_000, formatted: null });
        expect(getAiUsed({ ai_used: { formatted: ' 1.2 ' } })).toEqual({ nanoAiu: null, formatted: '1.2' });
        expect(getAiUsed({ ai_used: {} })).toBeNull();
        expect(getAiUsed({})).toBeNull();
    });
    it('labels the model by display_name, and auto by its tier', () => {
        expect(getCopilotModelName(idle)).toBe('Claude Sonnet 5.5');
        expect(getCopilotModelName(nearLimit)).toBe('GPT-5.4');
        expect(getCopilotModelName(aiUsedAuto)).toBe('Auto>balanced');
        expect(getCopilotModelName({ model: { id: 'auto', display_name: 'Auto', auto_tier: null } })).toBe('Auto');
        expect(getCopilotModelName({ model: { id: 'gpt-6-luna' } })).toBe('gpt-6-luna');
        expect(getCopilotModelName({})).toBeNull();
    });
    it('reads last-call and session token counts', () => {
        expect(getCopilotTokenUsage(afterPrompt)).toEqual({
            lastRequest: { inputTokens: 41200, outputTokens: 850 },
            sessionTotal: 63900,
        });
        expect(getCopilotTokenUsage({})).toEqual({ lastRequest: null, sessionTotal: null });
    });
});
//# sourceMappingURL=copilot-stdin.test.js.map