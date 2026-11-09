import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFactorySetup } from '../../../cli/commands/factory-setup.js';
import { getRuntimePackageVersion } from '../../../lib/version.js';
import { localRepo } from '../../check/__tests__/local-repo.js';
import { adoWorld, githubWorld, setupDeps } from './harness.js';
import { DEFAULT_HEARTBEAT_CRON, HEARTBEAT_MARKER, renderHeartbeat } from '../workflows.js';
// js-yaml is a transitive dependency without types (same use as skills-frontmatter-regression.test.ts).
const { load } = createRequire(import.meta.url)('js-yaml');
afterEach(() => {
    vi.unstubAllEnvs();
});
const VERSION = getRuntimePackageVersion();
const parse = (text) => load(text);
const wfPath = (root) => join(root, '.github', 'workflows', 'omg-factory-heartbeat.yml');
const adoPath = (root) => join(root, '.azure-pipelines', 'omg-factory-heartbeat.yml');
describe('heartbeat workflow template (GitHub)', () => {
    const render = (mode) => renderHeartbeat('github', { mode, cron: DEFAULT_HEARTBEAT_CRON, version: VERSION });
    it('read-only: schedule + workflow_dispatch only, read permissions, marker first', () => {
        const text = render('read-only');
        const doc = parse(text);
        expect(text.startsWith(HEARTBEAT_MARKER)).toBe(true);
        expect(Object.keys(doc.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
        expect(doc.on.schedule).toEqual([{ cron: DEFAULT_HEARTBEAT_CRON }]);
        expect(doc.permissions).toEqual({ contents: 'read', issues: 'read', 'pull-requests': 'read' });
        expect(text).not.toContain('factory triage');
        expect(text).not.toContain('steps.triage');
    });
    it('triage: the only write scope is issues, and the triage step appears', () => {
        const text = render('triage');
        const doc = parse(text);
        expect(doc.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'read' });
        expect(text).toContain('omg factory triage --apply --json');
        expect(text).toContain('opt-in write scope');
    });
    it.each(['read-only', 'triage'])('%s: no forbidden triggers, expressions, secrets, spends or floating versions', (mode) => {
        const text = render(mode);
        const doc = parse(text);
        expect(text).not.toMatch(/pull_request_target|workflow_run/);
        expect(text).not.toContain('github.event');
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/@latest|@main|@master/);
        expect(text).not.toMatch(/factory run|factory poll|copilot -p|copilot_run/);
        const steps = doc.jobs.heartbeat.steps;
        for (const step of steps) {
            if (step.uses)
                expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
            // Values reach scripts through env, never by expression inside a run block.
            if (step.run)
                expect(step.run).not.toContain('${{');
        }
        expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))).toBeDefined();
        expect(load(text)).toHaveProperty('jobs.heartbeat.env.OMG_VERSION', VERSION);
        expect(text).toContain('--package "oh-my-copilot@${OMG_VERSION}"');
    });
    it('refuses a cron or version that could carry YAML', () => {
        expect(() => renderHeartbeat('github', { mode: 'read-only', cron: '0 * * * *\nx: y', version: VERSION })).toThrow(/--cron/);
        expect(() => renderHeartbeat('github', { mode: 'read-only', cron: '0 * * * *', version: '1.0.0\nx' })).toThrow(/pin/);
    });
});
describe('heartbeat pipeline template (Azure DevOps)', () => {
    it('schedule only, no CI or PR trigger, version pinned, triage step only in triage mode', () => {
        const ro = renderHeartbeat('azure-devops', { mode: 'read-only', cron: '0 6 * * *', version: VERSION });
        const doc = load(ro);
        expect(doc.trigger).toBe('none');
        expect(doc.pr).toBe('none');
        expect(doc.schedules[0].cron).toBe('0 6 * * *');
        expect(doc.variables.OMG_VERSION).toBe(VERSION);
        expect(ro).not.toContain('factory triage');
        expect(ro).not.toMatch(/factory run|@latest/);
        expect(renderHeartbeat('azure-devops', { mode: 'triage', cron: '0 6 * * *', version: VERSION })).toContain('factory triage --apply --json');
    });
});
describe('omg factory setup --workflows', () => {
    const run = (world, o) => runFactorySetup({ workflows: true, ...o }, setupDeps(world), world.root);
    it('--dry-run names the one file and writes nothing', async () => {
        const world = githubWorld();
        const r = await run(world, { dryRun: true });
        expect(r.error).toBeUndefined();
        expect(r.exitCode).toBe(0);
        expect(r.written).toBeNull();
        expect(r.diffs.map((d) => d.path)).toEqual([wfPath(world.root)]);
        expect(r.notes).toContain('would write .github/workflows/omg-factory-heartbeat.yml');
        expect(existsSync(join(world.root, '.github'))).toBe(false);
        // No auth, no forge read: only the git lookups of the detection ran.
        expect(world.calls.every((c) => c.cmd === 'git')).toBe(true);
    });
    it('writes the workflow, is idempotent, and touches nothing outside .github/workflows', async () => {
        const world = githubWorld();
        const first = await run(world, { yes: true });
        expect(first.exitCode).toBe(0);
        expect(first.written).toEqual([wfPath(world.root)]);
        const text = readFileSync(wfPath(world.root), 'utf8');
        expect(parse(text).permissions.issues).toBe('read');
        expect(readdirSync(world.root).sort()).toEqual(['.github']);
        expect(readdirSync(join(world.root, '.github'))).toEqual(['workflows']);
        const second = await run(world, { yes: true });
        expect(second.written).toBeNull();
        expect(second.notes).toContain('.github/workflows/omg-factory-heartbeat.yml is already up to date');
        expect(readFileSync(wfPath(world.root), 'utf8')).toBe(text);
    });
    it('a re-run with another mode updates a file it wrote', async () => {
        const world = githubWorld();
        await run(world, { yes: true });
        const r = await run(world, { yes: true, mode: 'triage' });
        expect(r.exitCode).toBe(0);
        expect(parse(readFileSync(wfPath(world.root), 'utf8')).permissions.issues).toBe('write');
    });
    it('never overwrites a file it did not write without --force', async () => {
        const world = githubWorld();
        mkdirSync(join(world.root, '.github', 'workflows'), { recursive: true });
        writeFileSync(wfPath(world.root), 'name: mine\non: push\n');
        const refused = await run(world, { yes: true });
        expect(refused.exitCode).toBe(5);
        expect(refused.error).toMatch(/was not written by omg factory setup --workflows.*--force/);
        expect(readFileSync(wfPath(world.root), 'utf8')).toBe('name: mine\non: push\n');
        const forced = await run(world, { yes: true, force: true });
        expect(forced.exitCode).toBe(0);
        expect(readFileSync(wfPath(world.root), 'utf8').startsWith(HEARTBEAT_MARKER)).toBe(true);
    });
    it('non-interactive without --yes or --dry-run is a usage error and writes nothing', async () => {
        const world = githubWorld();
        const r = await run(world, {});
        expect(r.exitCode).toBe(2);
        expect(r.error).toMatch(/needs --yes/);
        expect(existsSync(join(world.root, '.github'))).toBe(false);
    });
    it('bad --mode and --cron exit 2; --mode without --workflows exits 2', async () => {
        const world = githubWorld();
        expect((await run(world, { dryRun: true, mode: 'write' })).exitCode).toBe(2);
        expect((await run(world, { dryRun: true, cron: 'every day' })).exitCode).toBe(2);
        const plain = await runFactorySetup({ mode: 'triage', dryRun: true, intake: 'label:factory:queued' }, setupDeps(world), world.root);
        expect(plain.exitCode).toBe(2);
        expect(plain.error).toMatch(/belong to --workflows/);
    });
    it('Azure DevOps writes the pipeline under .azure-pipelines', async () => {
        const world = adoWorld();
        const r = await runFactorySetup({ workflows: true, yes: true }, setupDeps(world), world.root);
        expect(r.error).toBeUndefined();
        expect(r.written).toEqual([adoPath(world.root)]);
        expect(readdirSync(world.root)).toEqual(['.azure-pipelines']);
    });
    it('the local forge prints not applicable, exits 0 and writes nothing', async () => {
        const repo = localRepo();
        const r = await runFactorySetup({ workflows: true, forge: 'local', yes: true }, { exec: repo.exec, env: {}, isTTY: () => false, resolveAz: () => { throw new Error('no az'); }, createForge: () => { throw new Error('no forge'); }, userConfigPath: () => join(repo.home, 'user-config.jsonc') }, repo.root);
        expect(r.exitCode).toBe(0);
        expect(r.written).toBeNull();
        expect(r.notes.join('\n')).toMatch(/not applicable to the local/);
        expect(existsSync(join(repo.root, '.github'))).toBe(false);
    });
});
//# sourceMappingURL=workflows.test.js.map