import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { buildRouteTableNarrow, runFactoryInit, validateFactoryPrerequisites, } from '../factory.js';
import { readProjectRoutes } from '../../../hooks/session-end/chain-enqueuer.js';
const tempRoots = [];
/** Isolated git repo: getOmcRoot resolves `.omc` inside it, like the real project. */
function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-factory-init-'));
    tempRoots.push(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    return dir;
}
afterEach(() => {
    for (const dir of tempRoots)
        rmSync(dir, { recursive: true, force: true });
    tempRoots.length = 0;
});
function seedPrerequisites(dir) {
    mkdirSync(join(dir, '.omg', 'state'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n', 'utf8');
    writeFileSync(join(dir, 'GLOSSARY.md'), '---\ndocumentLanguage: en\n---\n# Glossary\n', 'utf8');
}
function routesPath(dir) {
    return join(dir, '.omg', 'factory-routes.json');
}
describe('buildRouteTableNarrow', () => {
    it('is exactly the listener intake route table', () => {
        expect(buildRouteTableNarrow()).toEqual({ 'success:intake': { stage: 'harbor', skill: 'harbor' } });
    });
});
describe('retired full-pipeline template', () => {
    it('is no longer exported', async () => {
        expect('buildRouteTableFull' in (await import('../factory.js'))).toBe(false);
    });
});
describe('validateFactoryPrerequisites', () => {
    it('reports missing .omg/state/ and the yard faces, and passes when all exist', () => {
        const dir = tempDir();
        const missing = validateFactoryPrerequisites(dir);
        expect(missing).toEqual({ ok: false, missing: ['.omg/state/', 'CLAUDE.md', 'GLOSSARY.md'] });
        seedPrerequisites(dir);
        expect(validateFactoryPrerequisites(dir)).toEqual({ ok: true, missing: [] });
    });
    it('no longer requires docs/design/', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        expect(existsSync(join(dir, 'docs', 'design'))).toBe(false);
        expect(validateFactoryPrerequisites(dir).ok).toBe(true);
    });
});
describe('runFactoryInit', () => {
    it('writes the narrow starter table by default and it round-trips through the route reader', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const result = runFactoryInit({ cwd: dir });
        expect(result.exitCode).toBe(0);
        expect(existsSync(routesPath(dir))).toBe(true);
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableNarrow());
        expect(readProjectRoutes(dir)).toEqual(buildRouteTableNarrow());
    });
    it('refuses narrow: false (--no-narrow) with a pointer to docs/REFERENCE.md and writes nothing', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const result = runFactoryInit({ cwd: dir, narrow: false });
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('--no-narrow');
        expect(result.message).toContain('diagnose');
        expect(result.message).toContain('omg factory run <issue>');
        expect(result.message).toContain('docs/REFERENCE.md');
        expect(existsSync(routesPath(dir))).toBe(false);
    });
    it('refuses narrow: false even with --force and leaves an existing table untouched', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const existing = { 'success:*': { stage: 'mine', skill: 'mine' } };
        writeFileSync(routesPath(dir), JSON.stringify(existing), 'utf8');
        const result = runFactoryInit({ cwd: dir, narrow: false, force: true });
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(existing);
    });
    it('refuses to overwrite an existing table (content untouched) and --force replaces it', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const existing = { 'success:*': { stage: 'mine', skill: 'mine' } };
        writeFileSync(routesPath(dir), JSON.stringify(existing), 'utf8');
        const refused = runFactoryInit({ cwd: dir });
        expect(refused.exitCode).toBe(1);
        expect(refused.message).toContain('--force');
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(existing);
        const forced = runFactoryInit({ cwd: dir, force: true });
        expect(forced.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableNarrow());
    });
    it('refuses without GLOSSARY.md, points at drydock, and writes nothing', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        rmSync(join(dir, 'GLOSSARY.md'));
        const result = runFactoryInit({ cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('GLOSSARY.md');
        expect(result.message).toContain('drydock');
        expect(result.message).not.toContain('docs/design');
        expect(existsSync(routesPath(dir))).toBe(false);
    });
    it('refuses and writes nothing when prerequisites are missing', () => {
        const dir = tempDir();
        const result = runFactoryInit({ cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('.omg/state/');
        expect(existsSync(routesPath(dir))).toBe(false);
    });
});
//# sourceMappingURL=factory-init.test.js.map