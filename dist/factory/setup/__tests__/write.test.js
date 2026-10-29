import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { detectForgeRepo } from '../../../forge/config.js';
import { applyFactoryEdits, assertFactoryOnly, buildSection, lineDiff, planWrites } from '../write.js';
import { SetupError } from '../guard.js';
import { parseJsonc } from '../../../utils/jsonc.js';
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
        expect(() => assertFactoryOnly(EXISTING, changed, 'project')).toThrow(/outside factory.forge/);
        // Only factory.forge, factory.intake and factory.progress may change in the project file; factory.run may not.
        expect(() => assertFactoryOnly(EXISTING, EXISTING.replace('40', '9'), 'project')).toThrow(SetupError);
        expect(() => assertFactoryOnly(EXISTING, EXISTING.replace('"7.1"', '"7.0"'), 'project')).not.toThrow();
        // The user config may change only trustedAuthors.
        const withAuthors = applyFactoryEdits(EXISTING, [[['factory', 'forge', 'azureDevOps', 'trustedAuthors'], ['a@example.com']]]);
        expect(() => assertFactoryOnly(EXISTING, withAuthors, 'user')).not.toThrow();
        expect(() => assertFactoryOnly('', applyFactoryEdits('', [[['factory', 'forge', 'azureDevOps', 'trustedAuthors'], ['a@example.com']]]), 'user')).not.toThrow();
        expect(() => assertFactoryOnly(EXISTING, EXISTING.replace('"7.1"', '"7.0"'), 'user')).toThrow(SetupError);
    });
    it('refuses a config that is not valid JSONC', () => {
        expect(() => applyFactoryEdits('{ "ship": ', [[['factory', 'x'], 1]])).toThrow(expect.objectContaining({ exitCode: 5 }));
    });
    it('keeps a leading UTF-8 BOM', () => {
        const out = applyFactoryEdits(`﻿${EXISTING}`, [[['factory', 'forge', 'kind'], 'github']]);
        expect(out.startsWith('﻿{') || out.startsWith('﻿//')).toBe(true);
        expect(out.indexOf('﻿', 1)).toBe(-1);
        expect(parseJsonc(out)).toMatchObject({ factory: { forge: { kind: 'github' } } });
        expect(() => assertFactoryOnly(`﻿${EXISTING}`, out, 'project')).not.toThrow();
    });
    it.each([
        ['top-level factory twice', '{ "factory": { "forge": { "kind": "github" } }, "factory": {} }', /"factory" appears twice/],
        ['forge twice inside factory', '{ "factory": { "forge": {}, "forge": { "kind": "github" } } }', /"forge" appears twice/],
        ['a scalar factory', '{ "factory": 5 }', /factory is not an object/],
        ['a scalar factory.forge', '{ "factory": { "forge": 5 } }', /cannot edit config at factory.forge.kind/],
    ])('refuses %s with exit 5', (_name, text, message) => {
        let error;
        try {
            applyFactoryEdits(text, [[['factory', 'forge', 'kind'], 'github']]);
        }
        catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(SetupError);
        expect(error).toMatchObject({ exitCode: 5, message: expect.stringMatching(message) });
    });
    it('refuses a symlinked or junctioned .copilot directory or project config', () => {
        const root = tempRoot();
        const real = join(root, 'elsewhere');
        mkdirSync(real);
        symlinkSync(real, join(root, '.copilot'), 'junction');
        const section = buildSection(gh, { source: { type: 'label', label: 'factory' }, itemTypes: [] }, { enabled: false, stages: {} });
        const plan = () => planWrites({ projectPath: join(root, '.copilot', 'omg.jsonc'), userPath: join(root, 'user.jsonc'), section });
        expect(plan).toThrow(/symlink or junction/);
        if (process.platform !== 'win32') {
            const other = tempRoot();
            mkdirSync(join(other, '.copilot'));
            writeFileSync(join(real, 'omg.jsonc'), '{}');
            symlinkSync(join(real, 'omg.jsonc'), join(other, '.copilot', 'omg.jsonc'));
            expect(() => planWrites({ projectPath: join(other, '.copilot', 'omg.jsonc'), userPath: join(other, 'user.jsonc'), section })).toThrow(/symlink or junction/);
        }
    });
    it('creates a missing file from nothing', () => {
        const out = applyFactoryEdits('', [[['factory', 'forge', 'kind'], 'github']]);
        expect(parse(out)).toEqual({ factory: { forge: { kind: 'github' } } });
        expect(out.endsWith('\n')).toBe(true);
    });
    it('writes the section to the project config and only trustedAuthors to the user config', () => {
        const root = tempRoot();
        const projectPath = join(root, '.copilot', 'omg.jsonc');
        const userPath = join(root, 'home', 'config.jsonc');
        mkdirSync(join(root, '.copilot'), { recursive: true });
        writeFileSync(projectPath, EXISTING);
        const section = buildSection(ado, { source: { type: 'wiql-query', queryId: '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3' }, itemTypes: ['User Story'] }, { enabled: true, stages: {} }, 'Web Team');
        const planned = planWrites({ projectPath, userPath, section, trustedAuthors: ['owner@example.com'] });
        const user = planned.find((w) => w.path === userPath);
        expect(parse(user.after)).toEqual({ factory: { forge: { azureDevOps: { trustedAuthors: ['owner@example.com'] } } } });
        expect(planned.find((w) => w.path === projectPath).after).not.toContain('trustedAuthors');
        expect(planned.map((w) => w.path).sort()).toEqual([projectPath, userPath].sort());
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