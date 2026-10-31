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
import { ADO_FIXTURE_DIR, adoFixtureExec, loadAdoFixtures, parseAdoFixture, type AdoFixture } from '../../forge/ado/__tests__/fixtures.js';
import { adoConfig, POSIX_ENTRY, REPO } from '../../forge/ado/__tests__/world.js';
import { createAzureDevOpsForge } from '../../forge/ado/index.js';
import type { LoadedForgeConfig } from '../../forge/config.js';
import type { ResolvedForgeConfig } from '../../forge/types.js';
import type { Exec } from '../../ship/exec.js';
import { adoInvokeArgs } from '../../forge/ado/invoke.js';
import { adoHeal, healCommand, type HealDeps } from '../heal/cli.js';
import { healGuardExec, HealSafetyError } from '../heal/history.js';
import { DEFAULT_HEAL_CONFIG } from '../heal/config.js';
import { healStateDir, listHealStates } from '../heal/state.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../run/budget.js';

const NOW = new Date('2026-11-05T00:00:00Z');
const PIPELINE: ResolvedForgeConfig = { ...adoConfig(), heal: { pipeline: { definitionId: 9 } } };

const attempts = parseAdoFixture('build.timeline.GET.101-attempts.json', readFileSync(join(ADO_FIXTURE_DIR, 'variants', 'build.timeline.GET.101-attempts.json'), 'utf8'));
const base = loadAdoFixtures();
const named = (name: string) => base.find((f) => f.name === name)!;
const forBuild = (f: AdoFixture, buildId: string, edit: (stdout: any) => unknown = (s) => s): AdoFixture => ({
  ...f, name: `${f.name}@${buildId}`, provenance: `synthetic: ${f.name} as build ${buildId}`,
  routeParameters: { ...f.routeParameters, buildId }, stdout: edit(structuredClone(f.stdout)),
});
/** Red 205: build 101's retried timeline and its Test log. Green 204: the same jobs, all succeeded. */
const FIXTURES: AdoFixture[] = [
  ...base,
  forBuild(attempts, '205'),
  forBuild(named('build.logs.GET.101-7.json'), '205'),
  forBuild(attempts, '204', (t) => ({ ...t, records: t.records.filter((r: any) => r.attempt === 2).map((r: any) => ({ ...r, result: 'succeeded' })) })),
  forBuild(named('build.logs.GET.101-7.json'), '204', () => ({ count: 1, value: ['2026-10-29T09:10:00.0000000Z ##[section]Finishing: Run tests'] })),
];

let root: string;
let out: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-heal-ado-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** git answers the checkout (nothing fetched, no known-flaky file); az goes to the fixtures. */
function world(forge: () => LoadedForgeConfig) {
  const az = adoFixtureExec(FIXTURES);
  const git: string[] = [];
  const exec: Exec = (cmd, args, opts) => {
    if (cmd === 'az') return az(cmd, args, opts);
    if (cmd !== 'git') throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    git.push(args.join(' '));
    if (args.join(' ') === 'rev-parse --show-toplevel') return { status: 0, stdout: `${root}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: 'not fetched' };
  };
  const forgeCalls = vi.fn(forge);
  const deps: HealDeps = {
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

async function cli(deps: HealDeps, argv: string[]): Promise<{ code: number | undefined; json: any }> {
  await healCommand(deps).parseAsync([...argv, '--json'], { from: 'user' });
  return { code: process.exitCode as number | undefined, json: JSON.parse(out.join('\n')) };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe('omg factory heal scan on Azure DevOps (fixtures)', () => {
  it('classifies the red individualCI build 205 of pipeline 9 on main and records it; every az call is a GET of the forge repo', async () => {
    const w = world(() => ({ config: PIPELINE, warnings: [] }));
    const { code, json } = await cli(w.deps, ['scan']);

    expect(code, json.error).toBe(0);
    expect(json.base).toBe('main');
    const red = json.entries.find((e: { runId: string }) => e.runId === '205');
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
    for (const r of state.rerunIntents) expect(r.command).toMatch(/^Rerun failed jobs on https:\/\/dev\.azure\.com\/contoso\/Web\/_build\/results\?buildId=\d+$/);
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

describe('adoHeal: the guard context and the ForgeCi come from one config', () => {
  it('the guard context names the forge repository, entry and no progress values', () => {
    const heal = adoHeal(PIPELINE, POSIX_ENTRY, root);
    const forge = createAzureDevOpsForge(() => ({ status: 1, stdout: '', stderr: '' }), root, heal.forge.config, { ...heal.forge.options, entry: heal.forge.entry! });
    expect(heal.guard().repo).toEqual(forge.repo);
    expect(heal.guard().repo).toEqual(REPO);
    expect(heal.forge.config).toBe(PIPELINE);
    expect(heal.guard()).toMatchObject({ entry: POSIX_ENTRY, allowedStates: [], allowedColumns: [] });
  });

  it('the guard context refuses a read of another repository or project than the config names', () => {
    const exec = healGuardExec(adoFixtureExec(FIXTURES), adoHeal(PIPELINE, POSIX_ENTRY, root).guard);
    const other = { ...REPO, project: 'Other', name: 'other-app' };
    expect(() => exec('az', adoInvokeArgs({ entry: POSIX_ENTRY, repo: other }, 'git.repositories.GET', { project: 'Web', repositoryId: 'other-app' }), {})).toThrow(HealSafetyError);
    expect(() => exec('az', adoInvokeArgs({ entry: POSIX_ENTRY, repo: other }, 'build.builds.GET', { project: 'Other' }), {})).toThrow(HealSafetyError);
  });
});
