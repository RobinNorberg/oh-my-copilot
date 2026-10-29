import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { detectForgeRepo } from '../../../forge/config.js';
import { applyFactoryEdits, assertFactoryOnly, buildSection, lineDiff, planWrites } from '../write.js';
import { SetupError } from '../guard.js';
import { tempRoot } from './harness.js';
const gh = detectForgeRepo('https://github.com/acme/widgets.git');
const ado = detectForgeRepo('https://dev.azure.com/contoso/Web/_git/web-app');
const EXISTING = `// project config, owner-edited
{
  // ship safety keys: never touched by the wizard
  "ship": { "base": "dev", "requiredChecks": ["build"] },
  "factory": {
    /* run limits stay */
    "run": { "maxCredits": 40 },
    "forge": {
      "azureDevOps": { "apiVersion": "7.1" } // pinned
    }
  }
}
`;
describe('jsonc writes', () => {
    it('sets the factory keys and keeps comments, ship and factory.run', () => {
        const section = buildSection(gh, { source: { type: 'label', label: 'factory' }, itemTypes: [] }, { enabled: true, stages: { queued: { label: 'factory:queued' } } });
        const out = applyFactoryEdits(EXISTING, [[['factory', 'forge', 'kind'], 'github'], [['factory', 'intake', 'source'], section.intake.source]]);
        for (const comment of ['// project config, owner-edited', '// ship safety keys: never touched by the wizard', '/* run limits stay */', '// pinned'])
            expect(out).toContain(comment);
        const parsed = parse(out);
        expect(parsed.ship).toEqual({ base: 'dev', requiredChecks: ['build'] });
        expect(parsed.factory.run).toEqual({ maxCredits: 40 });
        expect(parsed.factory.forge).toEqual({ azureDevOps: { apiVersion: '7.1' }, kind: 'github' });
        expect(parsed.factory.intake.source).toEqual({ type: 'label', label: 'factory' });
    });
    it('refuses an edit outside factory.*', () => {
        expect(() => applyFactoryEdits(EXISTING, [[['ship', 'base'], 'main']])).toThrow(SetupError);
        const changed = EXISTING.replace('"base": "dev"', '"base": "main"');
        expect(() => assertFactoryOnly(EXISTING, changed)).toThrow(/outside factory/);
        expect(() => assertFactoryOnly(EXISTING, EXISTING.replace('40', '9'))).not.toThrow();
    });
    it('refuses a config that is not valid JSONC', () => {
        expect(() => applyFactoryEdits('{ "ship": ', [[['factory', 'x'], 1]])).toThrow(expect.objectContaining({ exitCode: 5 }));
    });
    it('creates a missing file from nothing', () => {
        const out = applyFactoryEdits('', [[['factory', 'forge', 'kind'], 'github']]);
        expect(parse(out)).toEqual({ factory: { forge: { kind: 'github' } } });
        expect(out.endsWith('\n')).toBe(true);
    });
    it('writes trustedAuthors to the user config only, whatever the scope', () => {
        const root = tempRoot();
        const projectPath = join(root, '.copilot', 'omg.jsonc');
        const userPath = join(root, 'home', 'config.jsonc');
        mkdirSync(join(root, '.copilot'), { recursive: true });
        writeFileSync(projectPath, EXISTING);
        const section = buildSection(ado, { source: { type: 'wiql-query', queryId: '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3' }, itemTypes: ['User Story'] }, { enabled: true, stages: {} }, 'Web Team');
        for (const scope of ['project', 'user']) {
            const planned = planWrites({ scope, projectPath, userPath, section, trustedAuthors: ['owner@example.com'] });
            const user = planned.find((w) => w.path === userPath);
            expect(parse(user.after).factory.forge.azureDevOps.trustedAuthors).toEqual(['owner@example.com']);
            for (const w of planned.filter((p) => p.path !== userPath))
                expect(w.after).not.toContain('trustedAuthors');
            expect(planned.map((w) => w.path).sort()).toEqual(scope === 'project' ? [projectPath, userPath].sort() : [userPath]);
        }
        // planWrites only plans.
        expect(existsSync(userPath)).toBe(false);
        expect(readFileSync(projectPath, 'utf8')).toBe(EXISTING);
    });
    it('diffs line by line', () => {
        expect(lineDiff('a\nb\n', 'a\nc\n')).toBe('  a\n+ c\n- b');
        expect(lineDiff('', '{}\n')).toBe('+ {}');
    });
});
//# sourceMappingURL=write.test.js.map