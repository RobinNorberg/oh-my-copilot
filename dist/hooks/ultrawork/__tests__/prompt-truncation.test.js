/**
 * Regression tests for issue #2542
 *
 * Stop-hook feedback for ultrawork was reinjecting the full original_prompt on
 * every stop event, burning context tokens.  The fix caps the echoed text via
 * truncatePromptForEcho.
 */
import { describe, it, expect } from 'vitest';
import { getUltraworkPersistenceMessage, } from '../index.js';
import { DEFAULT_PROMPT_ECHO_MAX_CHARS } from '../../../lib/truncate-prompt.js';
function makeState(originalPrompt) {
    return {
        active: true,
        started_at: new Date().toISOString(),
        original_prompt: originalPrompt,
        reinforcement_count: 0,
        last_checked_at: new Date().toISOString(),
    };
}
describe('getUltraworkPersistenceMessage — prompt truncation (issue #2542)', () => {
    it('includes the full prompt when it is short', () => {
        const state = makeState('Fix the login bug');
        const msg = getUltraworkPersistenceMessage(state);
        expect(msg).toContain('Fix the login bug');
    });
    it('truncates a long prompt and appends ellipsis', () => {
        const long = 'Implement '.repeat(40); // well over 150 chars
        const state = makeState(long);
        const msg = getUltraworkPersistenceMessage(state);
        // The echoed portion should be capped
        const match = msg.match(/Original task: (.+)/);
        expect(match).not.toBeNull();
        const echoed = match[1];
        // length ≤ maxChars + 1 (the ellipsis character)
        expect([...echoed].length).toBeLessThanOrEqual(DEFAULT_PROMPT_ECHO_MAX_CHARS + 1);
        expect(echoed.endsWith('…')).toBe(true);
    });
    it('does NOT embed the full long prompt anywhere in the message', () => {
        const long = 'x'.repeat(DEFAULT_PROMPT_ECHO_MAX_CHARS + 100);
        const state = makeState(long);
        const msg = getUltraworkPersistenceMessage(state);
        expect(msg).not.toContain(long);
    });
});
//# sourceMappingURL=prompt-truncation.test.js.map