import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TIERS, parseModelProfile, profileAgentModels } from '../profiles.js';
describe('model profiles', () => {
    it('lists every plugin agent with the tier of the model in agents/<name>.md', () => {
        const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'agents');
        const byTier = { high: 'opus', medium: 'sonnet', low: 'haiku' };
        const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
            const name = file.slice(0, -3);
            const model = /^model:[ 	]*([a-z]+)/m.exec(readFileSync(join(dir, file), 'utf8'))?.[1];
            expect(AGENT_TIERS, name).toHaveProperty(name);
            expect(byTier[AGENT_TIERS[name]], name).toBe(model);
        }
        expect(Object.keys(AGENT_TIERS).sort()).toEqual(files.map((f) => f.slice(0, -3)).sort());
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