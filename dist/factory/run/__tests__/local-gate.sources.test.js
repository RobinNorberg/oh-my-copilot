import { describe, expect, it } from 'vitest';
import { gateDefinitionSources } from '../local-gate.js';
describe('gate definitions that the repository cannot pin park as unknown', () => {
    it('npx fetches registry code: unresolved, in any spelling', () => {
        for (const gate of [['npx', 'vitest'], ['npx.cmd', '-y', 'eslint', '.'], ['C:\\tools\\npx.exe', 'x'], ['/usr/bin/npx', 'x']]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/runs npx, which fetches and runs registry code/);
        }
    });
    it('a bare binary is looked up on PATH, so no repository file defines it', () => {
        for (const gate of [['vitest'], ['cargo', 'test'], ['make', 'check'], ['pytest.exe', '-q']]) {
            const out = gateDefinitionSources(gate);
            expect(out.sources, gate.join(' ')).toEqual([]);
            expect(out.unresolved, gate.join(' ')).toMatch(/from PATH, and the repository holds no file that defines it/);
        }
    });
    it('a gate named by a path keeps its file as the definition, and node keeps its script', () => {
        expect(gateDefinitionSources(['./ci/gate.sh'])).toEqual({ sources: [{ path: 'ci/gate.sh' }] });
        expect(gateDefinitionSources(['node_modules/.bin/vitest', 'run'])).toEqual({ sources: [{ path: 'node_modules/.bin/vitest' }] });
        expect(gateDefinitionSources(['node', 'scripts/gate.mjs'])).toEqual({ sources: [{ path: 'scripts/gate.mjs' }] });
        // Outside the repository a pull request cannot change it.
        expect(gateDefinitionSources(['/usr/local/bin/gate'])).toEqual({ sources: [] });
        expect(gateDefinitionSources(['node', '--test'])).toEqual({ sources: [] });
    });
    it('npm-style gates are unchanged', () => {
        expect(gateDefinitionSources(['npm', 'test']).unresolved).toBeUndefined();
        expect(gateDefinitionSources(['pnpm', 'lint']).unresolved).toBeUndefined();
    });
});
//# sourceMappingURL=local-gate.sources.test.js.map