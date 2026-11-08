import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFactorySetup } from '../../../cli/commands/factory-setup.js';
import { createForge } from '../../../forge/index.js';
import { localForgeLimitations, parseBacklogFile } from '../../../forge/local/index.js';
import { parseJsonc } from '../../../utils/jsonc.js';
import { localRepo, programs } from '../../check/__tests__/local-repo.js';
import { parseIntakeSpec } from '../intake-pick.js';
import { SAMPLE_BACKLOG_FILE, SAMPLE_BACKLOG_TEXT } from '../write.js';
function deps(repo) {
    return {
        exec: repo.exec,
        env: {},
        isTTY: () => false,
        resolveAz: () => { throw new Error('az must not be resolved for the local forge'); },
        createForge,
        userConfigPath: () => join(repo.home, 'user-config.jsonc'),
    };
}
afterEach(() => {
    vi.unstubAllEnvs();
});
const projectPath = (repo) => join(repo.root, '.copilot', 'omg.jsonc');
const samplePath = (repo) => join(repo.root, '.copilot', 'backlog', SAMPLE_BACKLOG_FILE);
describe('omg factory setup: the local (offline) forge', () => {
    it('F10: no origin and no flags reports the missing forge first (exit 5, --forge local hint), not the missing --intake', async () => {
        const repo = localRepo();
        const r = await runFactorySetup({}, deps(repo), repo.root);
        expect(r.exitCode).toBe(5);
        expect(r.error).toMatch(/^unsupported forge: this repository has no origin remote.*omg factory setup --forge local/);
        expect(r.error).not.toMatch(/--intake/);
        expect(programs(repo)).toEqual(['git']);
    });
    it('--forge local --dry-run needs no --intake, shows both diffs and writes nothing', async () => {
        const repo = localRepo();
        const r = await runFactorySetup({ forge: 'local', dryRun: true }, deps(repo), repo.root);
        expect(r.error).toBeUndefined();
        expect(r.exitCode).toBe(0);
        expect(r.forge).toMatchObject({ kind: 'local', host: 'local', owner: 'local' });
        expect(r.forge.url.startsWith(repo.home)).toBe(true);
        expect(r.config).toMatchObject({ forge: { kind: 'local', local: { backlogDir: '.copilot/backlog' } }, intake: { source: { type: 'local-backlog' } } });
        expect(r.diffs.map((d) => d.path)).toEqual([projectPath(repo), samplePath(repo)]);
        expect(r.written).toBeNull();
        expect(existsSync(projectPath(repo))).toBe(false);
        expect(existsSync(samplePath(repo))).toBe(false);
        // F20: no config names a base and there is no dev branch: the current branch main, written as ship.base.
        expect(r.config?.ship).toEqual({ base: 'main' });
        expect(r.limitations).toEqual(localForgeLimitations('main'));
        expect(r.notes.join('\n')).not.toContain('<base>');
        expect(r.notes).toContain(`commit .copilot/backlog/ items on main: omg factory run reads backlog items at the base commit only`);
        expect(r.notes.some((n) => n.startsWith('base branch main (ship.base, detected: the current branch)'))).toBe(true);
        expect(r.notes.some((n) => n.startsWith('no local gate:'))).toBe(true);
        expect(r.auth?.ok).toBe(true);
        expect(programs(repo)).toEqual(['git']);
        // Nothing under the forge stateDir either (no mirror, no store).
        expect(existsSync(join(repo.home, 'state', 'forge'))).toBe(false);
    });
    it('--forge local --yes writes factory.forge.kind local and a closed sample item; a second run changes nothing', async () => {
        const repo = localRepo();
        const r = await runFactorySetup({ forge: 'local', yes: true }, deps(repo), repo.root);
        expect(r.error).toBeUndefined();
        expect(r.written).toEqual([projectPath(repo), samplePath(repo)]);
        const config = parseJsonc(readFileSync(projectPath(repo), 'utf8'));
        expect(config.factory).toMatchObject({ forge: { kind: 'local', local: { backlogDir: '.copilot/backlog' } }, intake: { source: { type: 'local-backlog' } } });
        expect(config.ship).toEqual({ base: 'main' });
        const sample = readFileSync(samplePath(repo), 'utf8');
        expect(sample).toBe(SAMPLE_BACKLOG_TEXT);
        expect(parseBacklogFile(`.copilot/backlog/${SAMPLE_BACKLOG_FILE}`, sample)).toMatchObject({ id: 1, state: 'closed' });
        // The preview reads the working tree: the closed sample is no open item.
        expect(r.previewError).toBeUndefined();
        expect(r.preview).toEqual([]);
        const again = await runFactorySetup({ forge: 'local', yes: true }, deps(repo), repo.root);
        expect(again.exitCode).toBe(0);
        expect(again.diffs).toEqual([]);
        expect(again.written).toBeNull();
        expect(programs(repo)).toEqual(['git']);
    });
    it('F20: base detection prefers an existing dev, and never overrides a ship.base the config already names', async () => {
        const repo = localRepo();
        execFileSync('git', ['branch', 'dev'], { cwd: repo.root, stdio: 'ignore' });
        const withDev = await runFactorySetup({ forge: 'local', dryRun: true }, deps(repo), repo.root);
        expect(withDev.error).toBeUndefined();
        expect(withDev.config?.ship).toEqual({ base: 'dev' });
        expect(withDev.limitations).toEqual(localForgeLimitations('dev'));
        mkdirSync(join(repo.root, '.copilot'), { recursive: true });
        writeFileSync(projectPath(repo), '{\n  // keep me\n  "ship": { "base": "release", "requiredChecks": ["ci"] }\n}\n');
        const named = await runFactorySetup({ forge: 'local', yes: true }, deps(repo), repo.root);
        expect(named.error).toBeUndefined();
        expect(named.config?.ship).toBeUndefined();
        expect(named.limitations).toEqual(localForgeLimitations('release'));
        expect(named.notes.some((n) => n.startsWith('release is not in ship.trustedBases'))).toBe(true);
        const text = readFileSync(projectPath(repo), 'utf8');
        expect(text).toContain('// keep me');
        expect(parseJsonc(text).ship).toEqual({ base: 'release', requiredChecks: ['ci'] });
        expect(programs(repo)).toEqual(['git']);
    });
    it('F20: an invalid ship.base in the config is reported (exit 2, naming the file), never replaced by a planned write', async () => {
        const repo = localRepo();
        mkdirSync(join(repo.root, '.copilot'), { recursive: true });
        const before = '{\n  "ship": { "base": "-bad" }\n}\n';
        writeFileSync(projectPath(repo), before);
        const r = await runFactorySetup({ forge: 'local', yes: true }, deps(repo), repo.root);
        expect(r.exitCode).toBe(2);
        expect(r.error).toBe(`ship.base "-bad" in ${projectPath(repo)} is not a plain branch name: set it to the branch you merge into (or remove it to let setup detect one)`);
        expect(r.error).not.toMatch(/writes only factory/);
        expect(r.written).toBeNull();
        expect(readFileSync(projectPath(repo), 'utf8')).toBe(before);
        // In the user config too.
        writeFileSync(projectPath(repo), '{}\n');
        writeFileSync(join(repo.home, 'user-config.jsonc'), '{ "ship": { "base": 42 } }\n');
        const u = await runFactorySetup({ forge: 'local', dryRun: true }, deps(repo), repo.root);
        expect(u.exitCode).toBe(2);
        expect(u.error).toContain(`ship.base 42 in ${join(repo.home, 'user-config.jsonc')} is not a plain branch name`);
    });
    it('--intake local-backlog:<label> is kept; GitHub and ADO pins are refused with --forge local', async () => {
        const repo = localRepo();
        const r = await runFactorySetup({ forge: 'local', intake: 'local-backlog:factory', dryRun: true }, deps(repo), repo.root);
        expect(r.config?.intake.source).toEqual({ type: 'local-backlog', label: 'factory' });
        const pinned = await runFactorySetup({ forge: 'local', repo: 'acme/widgets', dryRun: true }, deps(repo), repo.root);
        expect(pinned.exitCode).toBe(2);
        expect(pinned.error).toMatch(/--forge local takes none/);
        const ado = await runFactorySetup({ forge: 'local', itemTypes: 'Bug', dryRun: true }, deps(repo), repo.root);
        expect(ado.exitCode).toBe(2);
        expect(ado.error).toMatch(/Azure DevOps flags; this repository is on the local forge/);
        const bad = await runFactorySetup({ forge: 'gitlab', dryRun: true }, deps(repo), repo.root);
        expect(bad.exitCode).toBe(2);
        expect(bad.error).toMatch(/--forge must be github, azure-devops or local/);
    });
    it('parseIntakeSpec: local-backlog only on the local forge', () => {
        expect(parseIntakeSpec('local-backlog', 'local')).toEqual({ type: 'local-backlog' });
        expect(parseIntakeSpec('local-backlog:factory', 'local')).toEqual({ type: 'local-backlog', label: 'factory' });
        expect(() => parseIntakeSpec('local-backlog:', 'local')).toThrow(/empty value/);
        expect(() => parseIntakeSpec('label:factory', 'local')).toThrow(/the local source is local-backlog/);
        expect(() => parseIntakeSpec('local-backlog', 'github')).toThrow(/the github sources are/);
    });
});
//# sourceMappingURL=setup-local.test.js.map