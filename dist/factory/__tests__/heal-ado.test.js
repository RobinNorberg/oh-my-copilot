/**
 * `omg factory heal` on Azure DevOps (ADO parity design §3.5, PR C3): the
 * CLI reads the builds of factory.heal.pipeline through the heal guard with
 * the `read` policy, the guard context and the ForgeCi come from the one
 * trusted forge config, and Azure DevOps without a pipeline is refused.
 * Fixtures only; build 205's timeline and log are variants of build 101's.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADO_FIXTURE_DIR, adoFixtureExec, loadAdoFixtures, parseAdoFixture } from '../../forge/ado/__tests__/fixtures.js';
import { adoConfig, POSIX_ENTRY, REPO } from '../../forge/ado/__tests__/world.js';
import { adoInvokeArgs } from '../../forge/ado/invoke.js';
import { adoHeal, healCommand } from '../heal/cli.js';
import { healGuardExec, HealSafetyError } from '../heal/history.js';
import { DEFAULT_HEAL_CONFIG } from '../heal/config.js';
import { healStateDir, listHealStates } from '../heal/state.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../run/budget.js';
import { createFactoryState, factoryCancelRequested, healRunKey, overwriteFactoryState } from '../run/state.js';
const NOW = new Date('2026-11-05T00:00:00Z');
const PIPELINE = { ...adoConfig(), heal: { pipeline: { definitionId: 9 } } };
const attempts = parseAdoFixture('build.timeline.GET.101-attempts.json', readFileSync(join(ADO_FIXTURE_DIR, 'variants', 'build.timeline.GET.101-attempts.json'), 'utf8'));
const base = loadAdoFixtures();
const named = (name) => base.find((f) => f.name === name);
const forBuild = (f, buildId, edit = (s) => s) => ({
    ...f, name: `${f.name}@${buildId}`, provenance: `synthetic: ${f.name} as build ${buildId}`,
    routeParameters: { ...f.routeParameters, buildId }, stdout: edit(structuredClone(f.stdout)),
});
/** Red 205: build 101's retried timeline and its Test log. Green 204: the same jobs, all succeeded. */
const FIXTURES = [
    ...base,
    forBuild(attempts, '205'),
    forBuild(named('build.logs.GET.101-7.json'), '205'),
    forBuild(attempts, '204', (t) => ({ ...t, records: t.records.filter((r) => r.attempt === 2).map((r) => ({ ...r, result: 'succeeded' })) })),
    forBuild(named('build.logs.GET.101-7.json'), '204', () => ({ count: 1, value: ['2026-10-29T09:10:00.0000000Z ##[section]Finishing: Run tests'] })),
];
let root;
let out;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-heal-ado-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
});
/** git answers the checkout (nothing fetched, no known-flaky file; `gitOk` subcommands succeed); az goes to the fixtures. */
function world(forge, gitOk = []) {
    const az = adoFixtureExec(FIXTURES);
    const git = [];
    const exec = (cmd, args, opts) => {
        if (cmd === 'az')
            return az(cmd, args, opts);
        if (cmd !== 'git')
            throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        git.push(args.join(' '));
        if (args.join(' ') === 'rev-parse --show-toplevel')
            return { status: 0, stdout: `${root}\n`, stderr: '' };
        if (gitOk.includes(args[0]))
            return { status: 0, stdout: '', stderr: '' };
        return { status: 1, stdout: '', stderr: 'not fetched' };
    };
    const forgeCalls = vi.fn(forge);
    const deps = {
        exec,
        base: () => 'main',
        config: () => ({ config: DEFAULT_HEAL_CONFIG, warnings: [] }),
        now: () => NOW,
        lanes: () => { throw new Error('heal scan starts no lane'); },
        ledgerDir: join(root, '.omg', 'test-ledger'),
        runLimits: () => ({ limits: { ...DEFAULT_FACTORY_RUN_LIMITS }, warnings: [] }),
        forgeKind: () => 'azure-devops',
        forge: forgeCalls,
        resolveAz: () => POSIX_ENTRY,
    };
    return { deps, az, git, forgeCalls };
}
async function cli(deps, argv) {
    out.length = 0;
    process.exitCode = undefined;
    await healCommand(deps).parseAsync([...argv, '--json'], { from: 'user' });
    return { code: process.exitCode, json: JSON.parse(out.join('\n')) };
}
const flag = (args, name) => args[args.indexOf(name) + 1];
describe('omg factory heal scan on Azure DevOps (fixtures)', () => {
    it('classifies the red individualCI build 205 of pipeline 9 on main and records it; every az call is a GET of the forge repo', async () => {
        const w = world(() => ({ config: PIPELINE, warnings: [] }));
        const { code, json } = await cli(w.deps, ['scan']);
        expect(code, json.error).toBe(0);
        expect(json.base).toBe('main');
        const red = json.entries.find((e) => e.runId === '205');
        expect(red).toMatchObject({ event: 'push', headBranch: 'main', recorded: true });
        expect(red.sig8).toMatch(/^[0-9a-f]{8}$/);
        expect(red.class).toBeDefined();
        const [state] = listHealStates(root);
        expect(state).toMatchObject({ sig8: red.sig8, source: 'push', seenRuns: ['205'] });
        expect(state.classification.firstRed).toEqual({ runId: '205', sha: 'd'.repeat(40) });
        expect(state.classification.lastGreen).toEqual({ runId: '204', sha: 'c'.repeat(40) });
        expect(state.classification.jobs.map((j) => j.job)).toEqual(['Test']);
        expect(state.classification.jobs[0].failingTests).toEqual([{ file: 'src/report.test.ts', title: 'exports CSV' }]);
        expect(healStateDir(root).startsWith(root)).toBe(true);
        // The read guard let only GETs of contoso/Web through; a rerun is recorded as the human step, never issued.
        expect(w.az.calls.length).toBeGreaterThan(0);
        for (const c of w.az.calls) {
            expect(flag(c.args, '--http-method')).toBe('GET');
            expect(flag(c.args, '--org')).toBe('https://dev.azure.com/contoso');
            expect(c.args).toContain('project=Web');
        }
        expect(w.az.calls.some((c) => c.args.some((a) => /retry/i.test(a)))).toBe(false);
        for (const r of state.rerunIntents)
            expect(r.command).toMatch(/^Rerun failed jobs on https:\/\/dev\.azure\.com\/contoso\/Web\/_build\/results\?buildId=\d+$/);
        expect(w.forgeCalls).toHaveBeenCalledTimes(1);
    });
    it('without factory.heal.pipeline heal is refused before any az call, naming the key', async () => {
        const w = world(() => ({ config: adoConfig(), warnings: [] }));
        const { code, json } = await cli(w.deps, ['scan']);
        expect(code).toBe(3);
        expect(json.error).toMatch(/needs factory\.heal\.pipeline/);
        expect(w.az.calls).toEqual([]);
    });
    it('without the forge config loader Azure DevOps is refused', async () => {
        const w = world(() => ({ config: PIPELINE, warnings: [] }));
        const { forge: _forge, ...deps } = w.deps;
        const { code, json } = await cli(deps, ['scan']);
        expect(code).toBe(3);
        expect(json.error).toMatch(/needs factory\.heal\.pipeline/);
    });
});
describe('omg factory heal run --dry-run on Azure DevOps (fixtures)', () => {
    it('collects the evidence through the forge CI over the read guard: every az call is a GET of pipeline 9 in the forge repo', async () => {
        const w = world(() => ({ config: PIPELINE, warnings: [] }), ['cat-file', 'merge-base']);
        const scan = await cli(w.deps, ['scan']);
        expect(scan.code, scan.json.error).toBe(0);
        const [state] = listHealStates(root);
        expect(state.next).toBe('debug-lane');
        const before = w.az.calls.length;
        const { code, json } = await cli(w.deps, ['run', state.sig8, '--dry-run']);
        expect(code, json.error).toBe(0);
        expect(json.message).toMatch(/^dry run: wrote the evidence bundle/);
        expect(json.bundleDir.startsWith(root)).toBe(true);
        const calls = w.az.calls.slice(before);
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) {
            expect(flag(c.args, '--http-method')).toBe('GET');
            expect(flag(c.args, '--org')).toBe('https://dev.azure.com/contoso');
            expect(c.args).toContain('project=Web');
            if (c.args.some((a) => a.startsWith('definitions=')))
                expect(c.args).toContain('definitions=9');
        }
    });
});
describe('heal status, close and cancel need no forge wiring', () => {
    const SIG8 = '0a1b2c3d';
    /** A ci-heal run's state as the engine leaves it parked (heal approve). */
    function seedCiHeal() {
        const record = {
            sig8: SIG8, class: 'regression', firstRed: { runId: '205', sha: 'd'.repeat(40) }, failingTests: [], env: [],
            diagnosis: { class: 'regression', rootCause: 'x', evidence: [], reproduced: false, fix: null },
        };
        overwriteFactoryState(root, healRunKey(SIG8), createFactoryState({ issue: 0, repoUrl: REPO.url, base: 'main', heal: record }, NOW.toISOString()));
    }
    const broken = [
        ['no factory.heal.pipeline', (deps) => ({ ...deps, forge: () => ({ config: adoConfig(), warnings: [] }) })],
        ['a failing az resolve', (deps) => ({ ...deps, resolveAz: () => { throw new Error('az is not installed'); } })],
    ];
    for (const [name, edit] of broken) {
        it(`with ${name}: status lists the signatures and cancel records the request without an az call`, async () => {
            const w = world(() => ({ config: PIPELINE, warnings: [] }));
            expect((await cli(w.deps, ['scan'])).code).toBe(0);
            const deps = edit(w.deps);
            const before = w.az.calls.length;
            const status = await cli(deps, ['status']);
            expect(status.code, status.json.error).toBe(0);
            expect(status.json.signatures).toHaveLength(1);
            seedCiHeal();
            const cancel = await cli(deps, ['cancel', SIG8]);
            expect(cancel.code, cancel.json.error).toBe(0);
            expect(cancel.json).toMatchObject({ ok: true, sig8: SIG8, cancelRequested: true });
            expect(cancel.json.note).toMatch(/a parked run is cancelled by the next omg factory heal cancel/);
            expect(factoryCancelRequested(root, healRunKey(SIG8))).toBe(true);
            expect(w.az.calls.length).toBe(before);
        });
    }
    it('status and close never load the forge config', async () => {
        const w = world(() => { throw new Error('the forge config is broken'); });
        expect((await cli(w.deps, ['status'])).json).toMatchObject({ ok: true, signatures: [] });
        const close = await cli(w.deps, ['close', SIG8]);
        expect(close.json.error).not.toMatch(/forge config/);
        expect(w.forgeCalls).not.toHaveBeenCalled();
    });
});
describe('adoHeal: the guard context and the ForgeCi come from one config', () => {
    /** Records every az argv the guard lets through; answers an empty build list. */
    const recordingAz = () => {
        const calls = [];
        const exec = (_cmd, args) => { calls.push([...args]); return { status: 0, stdout: '{"count":0,"value":[]}', stderr: '' }; };
        return { exec, calls };
    };
    it('the guard and the CI reads adoHeal builds name the configured repository, pipeline and entry, resolved once on first use', () => {
        const resolveAz = vi.fn(() => POSIX_ENTRY);
        const heal = adoHeal(PIPELINE, resolveAz, root);
        expect(resolveAz).not.toHaveBeenCalled();
        expect(heal.guard()).toEqual({ repo: PIPELINE.repo, entry: POSIX_ENTRY, allowedStates: [], allowedColumns: [], definitionId: PIPELINE.heal.pipeline.definitionId });
        expect(heal.forge()).toMatchObject({ config: PIPELINE, entry: POSIX_ENTRY });
        // The CI reads go out through the guard to the org, project and pipeline of the config.
        const az = recordingAz();
        heal.ci(healGuardExec(az.exec, heal.guard), root).listRuns({ workflow: 'ci', event: 'push', branch: 'main', limit: 5 });
        expect(az.calls).toHaveLength(1);
        for (const args of az.calls) {
            expect(flag(args, '--org')).toBe(`https://dev.azure.com/${PIPELINE.azureDevOps.org}`);
            expect(args).toContain(`project=${PIPELINE.azureDevOps.project}`);
            expect(args).toContain(`definitions=${PIPELINE.heal.pipeline.definitionId}`);
        }
        expect(resolveAz).toHaveBeenCalledTimes(1);
    });
    it('the guard context refuses a read of another organization, repository, project or pipeline than the config names', () => {
        const az = recordingAz();
        const exec = healGuardExec(az.exec, adoHeal(PIPELINE, () => POSIX_ENTRY, root).guard);
        const other = { ...REPO, project: 'Other', name: 'other-app' };
        const fabrikam = { ...REPO, owner: 'fabrikam' };
        const builds = (repo, definitions) => adoInvokeArgs({ entry: POSIX_ENTRY, repo }, 'build.builds.GET', { project: repo.project }, { definitions, statusFilter: 'completed' });
        expect(() => exec('az', adoInvokeArgs({ entry: POSIX_ENTRY, repo: other }, 'git.repositories.GET', { project: 'Web', repositoryId: 'other-app' }), {})).toThrow(HealSafetyError);
        expect(() => exec('az', builds(other, '9'), {})).toThrow(HealSafetyError);
        expect(() => exec('az', builds(fabrikam, '9'), {})).toThrow(/--org must be https:\/\/dev\.azure\.com\/contoso/);
        expect(() => exec('az', builds(REPO, '10'), {})).toThrow(/definitions must be the configured factory\.heal\.pipeline 9/);
        expect(az.calls).toEqual([]);
        expect(exec('az', builds(REPO, '9'), {}).status).toBe(0);
        expect(az.calls).toHaveLength(1);
    });
});
//# sourceMappingURL=heal-ado.test.js.map