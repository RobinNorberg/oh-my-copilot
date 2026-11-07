import { existsSync, readFileSync } from 'fs';
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
        // The base is ship.base (default dev here: no config names main).
        expect(r.limitations).toEqual(localForgeLimitations('dev'));
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