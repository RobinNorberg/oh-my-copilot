import { beforeEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ calls: [] }));
vi.mock('../team/model-contract.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isCliAvailable: (agentType) => {
        probe.calls.push(agentType);
        return false;
    },
}));
import { renderSkillRuntimeGuidance } from '../features/builtin-skills/runtime-guidance.js';
import { clearSkillsCache, createBuiltinSkills } from '../features/builtin-skills/skills.js';
const availability = { claude: false, codex: true, gemini: false, grok: false, antigravity: false };
describe('runtime availability probing is lazy', () => {
    beforeEach(() => {
        probe.calls.length = 0;
        clearSkillsCache();
    });
    it('does not invoke the availability thunk for skills without runtime guidance', () => {
        const thunk = vi.fn(() => availability);
        expect(renderSkillRuntimeGuidance('executor', thunk)).toBe('');
        expect(renderSkillRuntimeGuidance('cancel', thunk)).toBe('');
        expect(thunk).not.toHaveBeenCalled();
    });
    it('invokes the thunk for a runtime-guidance skill and renders the same output as a value', () => {
        const thunk = vi.fn(() => availability);
        const lazy = renderSkillRuntimeGuidance('ralph', thunk);
        expect(thunk).toHaveBeenCalledTimes(1);
        expect(lazy).toBe(renderSkillRuntimeGuidance('ralph', availability));
        expect(lazy).toContain('Codex CLI is installed');
    });
    it('probes each CLI once per load pass even with several matching skills', () => {
        expect(createBuiltinSkills().length).toBeGreaterThan(1);
        expect([...probe.calls].sort()).toEqual(['antigravity', 'claude', 'codex', 'gemini', 'grok']);
    });
});
//# sourceMappingURL=skills-runtime-probe-laziness.test.js.map