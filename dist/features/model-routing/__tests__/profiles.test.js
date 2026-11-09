import { describe, expect, it } from 'vitest';
import { AGENT_TIERS, parseModelProfile, profileAgentModels } from '../profiles.js';
import { getAgentDefinitions } from '../../../agents/definitions.js';
describe('model profiles', () => {
    it('lists every plugin agent with the tier of its default model', () => {
        const defs = getAgentDefinitions({ config: {} });
        const byTier = { high: 'opus', medium: 'sonnet', low: 'haiku' };
        for (const [name, def] of Object.entries(defs)) {
            expect(AGENT_TIERS, name).toHaveProperty(name);
            expect(def.defaultModel, name).toBe(byTier[AGENT_TIERS[name]]);
        }
        expect(Object.keys(AGENT_TIERS).sort()).toEqual(Object.keys(defs).sort());
    });
    it('balanced sets nothing; the others map tiers', () => {
        expect(profileAgentModels('balanced')).toEqual({});
        const q = profileAgentModels('quality-first');
        expect([q.architect, q.executor, q.explore]).toEqual(['opus', 'opus', 'sonnet']);
        const e = profileAgentModels('economy');
        expect([e.architect, e.executor, e.explore]).toEqual(['sonnet', 'haiku', 'haiku']);
    });
    it('parses only the three names', () => {
        expect(parseModelProfile('economy')).toBe('economy');
        expect(parseModelProfile('Economy')).toBeUndefined();
        expect(parseModelProfile(3)).toBeUndefined();
    });
});
//# sourceMappingURL=profiles.test.js.map