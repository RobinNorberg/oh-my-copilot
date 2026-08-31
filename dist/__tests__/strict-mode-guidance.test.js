import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOmcSystemPrompt } from '../index.js';
import { getAgentDefinitions } from '../agents/definitions.js';
import { resolveSystemPrompt } from '../agents/prompt-helpers.js';
describe('strict-mode guidance', () => {
    const originalStrictMode = process.env.OMC_STRICT_MODE;
    beforeEach(() => {
        if (originalStrictMode === undefined) {
            delete process.env.OMC_STRICT_MODE;
        }
        else {
            process.env.OMC_STRICT_MODE = originalStrictMode;
        }
    });
    afterEach(() => {
        if (originalStrictMode === undefined) {
            delete process.env.OMC_STRICT_MODE;
        }
        else {
            process.env.OMC_STRICT_MODE = originalStrictMode;
        }
    });
    it('does not append strict-mode guidance by default', () => {
        const prompt = getOmcSystemPrompt();
        expect(prompt).not.toContain('Strict Mode Execution Guidance');
    });
    it('appends strict-mode guidance to the orchestrator prompt when strict mode is enabled', () => {
        process.env.OMC_STRICT_MODE = 'true';
        const prompt = getOmcSystemPrompt();
        expect(prompt).toContain('Strict Mode Execution Guidance');
        expect(prompt).toContain('Report outcomes faithfully');
    });
    it('appends strict-mode guidance to agent prompts when strict mode is enabled', () => {
        process.env.OMC_STRICT_MODE = 'true';
        const agents = getAgentDefinitions();
        expect(agents.architect.prompt).toContain('## Strict Mode Guidance');
        expect(agents.architect.prompt).toContain('Default to writing no comments');
    });
    it('appends strict-mode guidance when resolving agent-role prompts with strict mode enabled', () => {
        process.env.OMC_STRICT_MODE = 'true';
        const prompt = resolveSystemPrompt(undefined, 'architect');
        expect(prompt).toContain('## Strict Mode Guidance');
        expect(prompt).toContain('verify the result with tests');
    });
});
//# sourceMappingURL=strict-mode-guidance.test.js.map