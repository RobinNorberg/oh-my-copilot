import { describe, expect, it } from 'vitest';
import { detectHudHost } from '../../hud/host.js';
const NO_ENV = {};
/** Synthetic Copilot CLI 1.0.103 payload, built from its statusline builder's field list. */
const COPILOT_PAYLOAD = {
    cwd: 'C:\\Code\\OMC',
    session_id: '6f1c0e2a-0000-4000-8000-000000000000',
    transcript_path: 'C:\\Users\\u\\.copilot\\session-state\\6f1c0e2a-0000-4000-8000-000000000000',
    model: { id: 'claude-sonnet-5.5', display_name: 'Claude Sonnet 5.5' },
    version: '1.0.103',
    cost: { total_duration_ms: 0, total_premium_requests: 0 },
    context_window: { used_percentage: 0, current_context_used_percentage: 0 },
    ai_used: { total_nano_aiu: 0, formatted: '0' },
    allow_all_enabled: false,
    remote: { connected: false },
};
/** Claude Code payload shape (fields as in a 2.1.309 capture). */
const CLAUDE_PAYLOAD = {
    cwd: '/home/u/repo',
    session_id: 'a1d28173-0000-4000-8000-000000000000',
    transcript_path: '/home/u/.claude/projects/-home-u-repo/a1d28173-0000-4000-8000-000000000000.jsonl',
    model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
    version: '2.1.309',
    output_style: { name: 'default' },
    exceeds_200k_tokens: false,
    context_window: { used_percentage: 12 },
};
describe('detectHudHost', () => {
    it('detects a full Copilot payload', () => {
        expect(detectHudHost(COPILOT_PAYLOAD, NO_ENV)).toBe('copilot');
    });
    it.each([
        ['ai_used', { ai_used: { total_nano_aiu: 0 } }],
        ['allow_all_enabled', { allow_all_enabled: true }],
        ['remote.connected', { remote: { connected: false } }],
        ['cost.total_premium_requests', { cost: { total_premium_requests: 1 } }],
        ['context_window.current_context_used_percentage', { context_window: { current_context_used_percentage: 3 } }],
    ])('treats %s alone as Copilot', (_field, payload) => {
        expect(detectHudHost(payload, NO_ENV)).toBe('copilot');
    });
    it('detects a Claude Code payload', () => {
        expect(detectHudHost(CLAUDE_PAYLOAD, NO_ENV)).toBe('claude');
    });
    it.each([
        ['output_style', { output_style: { name: 'x' } }],
        ['exceeds_200k_tokens', { exceeds_200k_tokens: false }],
        ['rate_limits', { rate_limits: {} }],
        ['a .claude/projects transcript', { transcript_path: 'C:\\Users\\u\\.claude\\projects\\p\\s.jsonl' }],
    ])('treats %s as Claude', (_field, payload) => {
        expect(detectHudHost(payload, { COPILOT_CLI: '1' })).toBe('claude');
    });
    it('prefers the payload shape over the environment', () => {
        expect(detectHudHost(COPILOT_PAYLOAD, { CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('copilot');
    });
    it('falls back to the host env signal for an ambiguous payload', () => {
        const ambiguous = { cwd: '/x', model: { id: 'm' } };
        expect(detectHudHost(ambiguous, { COPILOT_CLI: '1' })).toBe('copilot');
        expect(detectHudHost(ambiguous, { COPILOT_AGENT_SESSION_ID: 's' })).toBe('copilot');
        expect(detectHudHost(ambiguous, { CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude');
    });
    it('resolves an unknown payload with no env signal to claude (upstream parity)', () => {
        expect(detectHudHost({ cwd: '/x' }, NO_ENV)).toBe('claude');
        expect(detectHudHost(null, NO_ENV)).toBe('claude');
    });
});
//# sourceMappingURL=host.test.js.map