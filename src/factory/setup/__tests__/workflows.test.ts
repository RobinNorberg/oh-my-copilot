import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFactorySetup } from '../../../cli/commands/factory-setup.js';
import { getRuntimePackageVersion } from '../../../lib/version.js';
import { localRepo } from '../../check/__tests__/local-repo.js';
import { adoWorld, githubWorld, setupDeps } from './harness.js';
import { defaultFactoryRunDeps } from '../../../cli/commands/factory.js';
import { DEFAULT_HEARTBEAT_CRON, HEARTBEAT_MARKER, HEARTBEAT_TRIAGE_MIN_VERSION, checkCron, renderHeartbeat } from '../workflows.js';

// js-yaml is a transitive dependency without types (same use as skills-frontmatter-regression.test.ts).
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => unknown };

afterEach(() => {
  vi.unstubAllEnvs();
});

const VERSION = getRuntimePackageVersion();
type Doc = { on: Record<string, unknown>; permissions: Record<string, string>; jobs: { heartbeat: { steps: Array<{ uses?: string; run?: string; env?: Record<string, string> }> } } };
const parse = (text: string): Doc => load(text) as Doc;
const wfPath = (root: string): string => join(root, '.github', 'workflows', 'omg-factory-heartbeat.yml');
const adoPath = (root: string): string => join(root, '.azure-pipelines', 'omg-factory-heartbeat.yml');

describe('heartbeat workflow template (GitHub)', () => {
  const render = (mode: 'read-only' | 'triage') => renderHeartbeat('github', { mode, cron: DEFAULT_HEARTBEAT_CRON, version: mode === 'triage' ? HEARTBEAT_TRIAGE_MIN_VERSION : VERSION });

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

  it.each(['read-only', 'triage'] as const)('%s: no forbidden triggers, expressions, secrets, spends or floating versions', (mode) => {
    const text = render(mode);
    const doc = parse(text);
    expect(text).not.toMatch(/pull_request_target|workflow_run/);
    expect(text).not.toContain('github.event');
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/@latest|@main|@master/);
    expect(text).not.toMatch(/factory run|factory poll|copilot -p|copilot_run/);
    const steps = doc.jobs.heartbeat.steps;
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      // Values reach scripts through env, never by expression inside a run block.
      if (step.run) expect(step.run).not.toContain('${{');
    }
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))).toBeDefined();
    expect(load(text) as object).toHaveProperty('jobs.heartbeat.env.OMG_VERSION', mode === 'triage' ? HEARTBEAT_TRIAGE_MIN_VERSION : VERSION);
    expect(text).toContain('npm install -g --ignore-scripts "oh-my-copilot@${OMG_VERSION}"');
  });

  it('refuses a cron or version that could carry YAML', () => {
    expect(() => renderHeartbeat('github', { mode: 'read-only', cron: '0 * * * *\nx: y', version: VERSION })).toThrow(/--cron/);
    expect(() => renderHeartbeat('github', { mode: 'read-only', cron: '0 * * * *', version: '1.0.0\nx' })).toThrow(/pin/);
  });
});

describe('heartbeat pipeline template (Azure DevOps)', () => {
  it('schedule only, no CI or PR trigger, version pinned, triage step only in triage mode', () => {
    const ro = renderHeartbeat('azure-devops', { mode: 'read-only', cron: '0 6 * * *', version: VERSION, branch: 'dev' });
    const doc = load(ro) as { trigger: string; pr: string; schedules: Array<{ cron: string }>; variables: { OMG_VERSION: string } };
    expect(doc.trigger).toBe('none');
    expect(doc.pr).toBe('none');
    expect(doc.schedules[0].cron).toBe('0 6 * * *');
    expect(doc.variables.OMG_VERSION).toBe(VERSION);
    expect(ro).not.toContain('factory triage');
    expect(ro).not.toMatch(/factory run|@latest/);
    expect(renderHeartbeat('azure-devops', { mode: 'triage', cron: '0 6 * * *', version: HEARTBEAT_TRIAGE_MIN_VERSION, branch: 'dev' })).toContain('factory triage --apply --json');
  });
});

describe('omg factory setup --workflows', () => {
  const run = (world: ReturnType<typeof githubWorld>, o: Parameters<typeof runFactorySetup>[0]) => runFactorySetup({ workflows: true, ...o }, setupDeps(world), world.root);

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
    const r = await run(world, { yes: true, mode: 'triage', omgVersion: HEARTBEAT_TRIAGE_MIN_VERSION });
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
    const r = await runFactorySetup(
      { workflows: true, forge: 'local', yes: true },
      { exec: repo.exec, env: {}, isTTY: () => false, resolveAz: () => { throw new Error('no az'); }, createForge: () => { throw new Error('no forge'); }, userConfigPath: () => join(repo.home, 'user-config.jsonc') },
      repo.root,
    );
    expect(r.exitCode).toBe(0);
    expect(r.written).toBeNull();
    expect(r.notes.join('\n')).toMatch(/not applicable to the local/);
    expect(existsSync(join(repo.root, '.github'))).toBe(false);
  });
});

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type AdoStep = { bash?: string; task?: string; env?: Record<string, string>; inputs?: Record<string, string>; condition?: string; checkout?: string; persistCredentials?: boolean };
const TOKEN_ENV = /^(GH_TOKEN|GITHUB_TOKEN|AZURE_DEVOPS_EXT_PAT|SYSTEM_ACCESSTOKEN)$/;
const ghSteps = (text: string): Step[] => (load(text) as { jobs: { heartbeat: { steps: Step[] } } }).jobs.heartbeat.steps;
const adoSteps = (text: string): AdoStep[] => (load(text) as { steps: AdoStep[] }).steps;
const GH_DEFAULTS = { cron: DEFAULT_HEARTBEAT_CRON, version: HEARTBEAT_TRIAGE_MIN_VERSION } as const;

describe('token scope (GitHub)', () => {
  it.each(['read-only', 'triage'] as const)('%s: no token at job or workflow level, none in any install step, token only on the omg steps', (mode) => {
    const text = renderHeartbeat('github', { mode, ...GH_DEFAULTS });
    const doc = load(text) as { env?: Record<string, string>; jobs: { heartbeat: { env: Record<string, string> } } };
    expect(Object.keys(doc.env ?? {}).filter((k) => TOKEN_ENV.test(k))).toEqual([]);
    expect(Object.keys(doc.jobs.heartbeat.env).filter((k) => TOKEN_ENV.test(k))).toEqual([]);
    let installs = 0;
    for (const step of ghSteps(text)) {
      if (step.run && /npm install|npx/.test(step.run)) {
        installs++;
        expect(Object.keys(step.env ?? {}).filter((k) => TOKEN_ENV.test(k))).toEqual([]);
        expect(step.run).toContain('--ignore-scripts');
        expect(step.run).not.toContain('npx');
      }
    }
    expect(installs).toBe(1);
    const omgSteps = ghSteps(text).filter((s) => s.run?.includes('omg factory'));
    expect(omgSteps.length).toBe(mode === 'triage' ? 2 : 1);
    for (const s of omgSteps) expect(s.env?.GH_TOKEN).toBe('${{ github.token }}');
  });

  it('the job summary neutralises backticks so a title with a fence cannot break out', () => {
    for (const mode of ['read-only', 'triage'] as const) {
      const summarySteps = ghSteps(renderHeartbeat('github', { mode, ...GH_DEFAULTS })).filter((x) => x.run?.includes('GITHUB_STEP_SUMMARY'));
      expect(summarySteps.length).toBe(mode === 'triage' ? 2 : 1);
      for (const s of summarySteps) expect(s.run).toContain("head -c 20000 heartbeat-" );
      for (const s of summarySteps) expect(s.run).toContain("| sed 's/`/\\\\u0060/g'");
    }
  });

  it('keeps retention at 7 days and treats every non-zero code as an error', () => {
    const steps = ghSteps(renderHeartbeat('github', { mode: 'read-only', ...GH_DEFAULTS }));
    expect(steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))?.with?.['retention-days']).toBe(7);
    const fail = steps.find((s) => s.name === 'Fail on a real error')!;
    expect(fail.run).toContain("''|0) ;;");
    expect(fail.run).not.toMatch(/\|6\)/);
  });

  it('pins exactly these actions (tags verified with gh api git/ref/tags, lightweight tags so the object is the commit)', () => {
    const pins = ghSteps(renderHeartbeat('github', { mode: 'read-only', ...GH_DEFAULTS }))
      .filter((s) => s.uses)
      .map((s) => s.uses);
    expect(pins).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', // v7.0.1
      'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', // v7.1.0
      'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', // v7.0.2
    ]);
  });
});

describe('Azure DevOps pipeline hardening', () => {
  const render = (mode: 'read-only' | 'triage', branch = 'main') => renderHeartbeat('azure-devops', { mode, cron: '0 6 * * *', version: HEARTBEAT_TRIAGE_MIN_VERSION, branch });

  it('schedules only the default branch, with always: true kept and explained', () => {
    const text = render('read-only', 'release/v1.x');
    const doc = load(text) as { schedules: Array<{ branches: { include: string[] }; always: boolean }> };
    expect(doc.schedules[0].branches.include).toEqual(['release/v1.x']);
    expect(doc.schedules[0].always).toBe(true);
    expect(text).toMatch(/always: true on purpose/);
  });

  it.each(['', 'a b', "x'y", 'a..b', 'x\ny', '*'])('refuses the branch %j', (branch) => {
    expect(() => render('read-only', branch)).toThrow(/cannot schedule the pipeline on branch/);
  });

  it.each(['read-only', 'triage'] as const)('%s: install step has no token and no scripts, omg steps carry the PAT, nothing persists credentials', (mode) => {
    const text = render(mode);
    const steps = adoSteps(text);
    for (const s of steps) {
      expect(s.persistCredentials).not.toBe(true);
      if (s.bash && /npm install|npx/.test(s.bash)) {
        expect(Object.keys(s.env ?? {}).filter((k) => TOKEN_ENV.test(k))).toEqual([]);
        expect(s.bash).toContain('--ignore-scripts');
      }
    }
    expect(text).not.toContain('persistCredentials: true');
    expect(steps.find((s) => s.task === 'UseNode@1')).toBeDefined();
    expect(steps.find((s) => s.task === 'PublishPipelineArtifact@1')?.condition).toBe('always()');
    expect(steps.some((s) => s.task === 'NodeTool@0' || s.task === 'PublishBuildArtifacts@1')).toBe(false);
    const omg = steps.filter((s) => s.bash?.includes('omg factory'));
    expect(omg.length).toBe(mode === 'triage' ? 2 : 1);
    for (const s of omg) expect(s.env?.AZURE_DEVOPS_EXT_PAT).toBe('$(System.AccessToken)');
  });

  it('the triage step keeps its exit code, prints bounded output and still runs after a failed check', () => {
    const triage = adoSteps(render('triage')).find((s) => s.bash?.includes('factory triage'))!;
    expect(triage.bash).toContain('set +e');
    expect(triage.bash).toContain('code=$?');
    expect(triage.bash).toContain('head -c 20000');
    expect(triage.bash).toContain('exit "${code}"');
    expect(triage.condition).toBe('succeededOrFailed()');
    expect(triage.bash).toContain('heartbeat/heartbeat-triage.json');
  });

  it('the setup command renders the detected base branch', async () => {
    const world = adoWorld();
    const r = await runFactorySetup({ workflows: true, yes: true }, setupDeps(world), world.root);
    expect(r.error).toBeUndefined();
    const doc = load(readFileSync(adoPath(world.root), 'utf8')) as { schedules: Array<{ branches: { include: string[] } }> };
    expect(doc.schedules[0].branches.include).toEqual([defaultFactoryRunDeps.base(world.root)]);
  });
});

describe('cron validation', () => {
  it.each(['99 * * * *', '* 24 * * *', '0 0 0 * *', '0 0 32 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '5-1 * * * *', '0 0 * *', 'a b c d e', '1,x * * * *'])('refuses %j', (cron) => {
    expect(() => checkCron(cron)).toThrow(/--cron/);
  });

  it.each(['17 */2 * * *', '0 6 * * 1-5', '0,30 8-18 * * 1,3,5', '0 0 1 1 7', '*/15 * * * *', '0 */6 * * *'])('accepts %j with no warning', (cron) => {
    expect(checkCron(cron)).toEqual([]);
  });

  it.each([['* * * * *', 1], ['*/5 * * * *', 5], ['0,10 * * * *', 10], ['*/14 * * * *', 4]] as const)('warns about %j (gap %i min)', (cron, gap) => {
    const w = checkCron(cron);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`every ${gap} minute`);
  });

  it('setup surfaces the warning and refuses a bad range with exit 2', async () => {
    const world = githubWorld();
    const ok = await runFactorySetup({ workflows: true, dryRun: true, cron: '*/5 * * * *' }, setupDeps(world), world.root);
    expect(ok.exitCode).toBe(0);
    expect(ok.notes.some((n) => n.startsWith('warning: --cron'))).toBe(true);
    const bad = await runFactorySetup({ workflows: true, dryRun: true, cron: '99 * * * *' }, setupDeps(world), world.root);
    expect(bad.exitCode).toBe(2);
  });
});

describe('triage needs a release that has it', () => {
  it('is refused below the minimum, with exit 2 and a message naming the way out', async () => {
    const world = githubWorld();
    expect(HEARTBEAT_TRIAGE_MIN_VERSION).toBe('5.22.0');
    const r = await runFactorySetup({ workflows: true, dryRun: true, mode: 'triage', omgVersion: '5.21.0' }, setupDeps(world), world.root);
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/--mode triage needs omg >= 5\.22\.0.*--omg-version/);
    expect(existsSync(join(world.root, '.github'))).toBe(false);
  });

  it('this build is refused too while its own version is below the minimum', async () => {
    const world = githubWorld();
    const r = await runFactorySetup({ workflows: true, dryRun: true, mode: 'triage' }, setupDeps(world), world.root);
    const [major, minor] = VERSION.split('.').map(Number);
    expect(r.exitCode).toBe(major < 5 || (major === 5 && minor < 22) ? 2 : 0);
  });

  it('--omg-version at or above the minimum pins that version', async () => {
    const world = githubWorld();
    const r = await runFactorySetup({ workflows: true, yes: true, mode: 'triage', omgVersion: '5.22.1' }, setupDeps(world), world.root);
    expect(r.exitCode).toBe(0);
    expect(load(readFileSync(wfPath(world.root), 'utf8'))).toHaveProperty('jobs.heartbeat.env.OMG_VERSION', '5.22.1');
  });

  it.each(['5.22', 'v5.22.0', '5.22.0-rc.1', '5.022.0', 'latest', '5.22.0\nx'])('refuses the override %j', async (v) => {
    const world = githubWorld();
    const r = await runFactorySetup({ workflows: true, dryRun: true, omgVersion: v }, setupDeps(world), world.root);
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/--omg-version/);
  });

  it('--omg-version without --workflows exits 2', async () => {
    const world = githubWorld();
    const r = await runFactorySetup({ omgVersion: '5.22.0', dryRun: true, intake: 'label:factory:queued' }, setupDeps(world), world.root);
    expect(r.exitCode).toBe(2);
  });

  it('warns when running from a checkout or unreleased build, and not when the version is overridden', async () => {
    // These tests run from src/ inside a git checkout, which is exactly the case to warn about.
    const world = githubWorld();
    const warned = await runFactorySetup({ workflows: true, dryRun: true }, setupDeps(world), world.root);
    expect(warned.notes.some((n) => /git checkout or an unreleased build.*must be published/.test(n))).toBe(true);
    const pinned = await runFactorySetup({ workflows: true, dryRun: true, omgVersion: '5.19.7' }, setupDeps(world), world.root);
    expect(pinned.notes.some((n) => /unreleased build/.test(n))).toBe(false);
  });
});

describe('linked target directories are refused at plan time', () => {
  const link = (root: string, name: string, dangling: boolean): string => {
    const target = mkdtempSync(join(tmpdir(), 'omg-link-target-'));
    // Throws on failure: a test that cannot create its link must fail, not pass vacuously.
    symlinkSync(target, join(root, name), 'junction');
    if (dangling) rmdirSync(target);
    return target;
  };

  it('a linked .github', async () => {
    const world = githubWorld();
    const target = link(world.root, '.github', false);
    const r = await runFactorySetup({ workflows: true, yes: true }, setupDeps(world), world.root);
    expect(r.exitCode).toBe(5);
    expect(r.error).toMatch(/symlink or junction/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('a dangling linked .github', async () => {
    const world = githubWorld();
    link(world.root, '.github', true);
    const r = await runFactorySetup({ workflows: true, yes: true }, setupDeps(world), world.root);
    expect(r.exitCode).toBe(5);
    expect(r.error).toMatch(/symlink or junction/);
  });

  it('a linked .azure-pipelines, dangling or not', async () => {
    for (const dangling of [false, true]) {
      const world = adoWorld();
      const target = link(world.root, '.azure-pipelines', dangling);
      const r = await runFactorySetup({ workflows: true, yes: true }, setupDeps(world), world.root);
      expect(r.exitCode).toBe(5);
      if (!dangling) expect(readdirSync(target)).toEqual([]);
    }
  });
});
