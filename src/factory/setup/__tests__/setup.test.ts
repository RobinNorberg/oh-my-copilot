import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import { factorySetupCommand, runFactorySetup, type FactorySetupOptions } from '../../../cli/commands/factory-setup.js';
import { listenForgeRefusal } from '../detect.js';
import { READINESS_PLACEHOLDER } from '../intake-pick.js';
import { adoWorld, fakeExec, fakeForge, githubWorld, QUERY_ID, scriptedPrompter, setupDeps, type FakeWorld } from './harness.js';

type Cfg = { ship?: unknown; factory?: { forge?: Record<string, unknown>; intake?: Record<string, unknown>; progress?: Record<string, unknown>; run?: unknown } };

const projectFile = (w: FakeWorld) => join(w.root, '.copilot', 'omg.jsonc');
const userFile = (w: FakeWorld) => join(w.root, 'user-home', 'config.jsonc');
const read = (p: string): Cfg => parse(readFileSync(p, 'utf8')) as Cfg;
const run = (w: FakeWorld, o: FactorySetupOptions, over = {}) => runFactorySetup(o, setupDeps(w, over), w.root);
const writes = (w: FakeWorld) => w.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'label' && c.args[1] === 'create');

const PROJECT_WITH_SHIP = `{
  // owner comment
  "ship": { "base": "dev", "requiredChecks": ["build"] },
  "factory": { "run": { "maxCredits": 40 } }
}
`;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('omg factory setup: GitHub', () => {
  it('--yes --json without a TTY writes factory.* to the project config and creates the missing labels', async () => {
    const w = githubWorld();
    mkdirSync(join(w.root, '.copilot'), { recursive: true });
    writeFileSync(projectFile(w), PROJECT_WITH_SHIP);
    const r = await run(w, { intake: 'label:factory', yes: true, json: true });
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([projectFile(w)]);
    const cfg = read(projectFile(w));
    expect(cfg.ship).toEqual({ base: 'dev', requiredChecks: ['build'] });
    expect(cfg.factory!.run).toEqual({ maxCredits: 40 });
    expect(cfg.factory!.forge).toEqual({ kind: 'github', github: { repo: 'acme/widgets', host: 'github.com' } });
    expect(cfg.factory!.intake).toEqual({ source: { type: 'label', label: 'factory' } });
    expect((cfg.factory!.progress as { stages: Record<string, unknown> }).stages.building).toEqual({ label: 'factory:building' });
    expect(readFileSync(projectFile(w), 'utf8')).toContain('// owner comment');
    // factory:queued existed; the intake label and the other stage labels were created.
    expect(writes(w).map((c) => c.args[2])).toEqual(['factory', 'factory:building', 'factory:reviewing', 'factory:verifying', 'factory:ready-to-merge', 'factory:done', 'factory:blocked']);
    expect(r.labels.created).toHaveLength(7);
    expect(r.preview).toEqual([{ id: 7, title: 'Add the export button', url: 'https://example.test/7', readiness: READINESS_PLACEHOLDER }]);
    expect(existsSync(userFile(w))).toBe(false);
  });

  it('--dry-run writes nothing and creates no label, but shows the diff and the preview', async () => {
    const w = githubWorld();
    const r = await run(w, { intake: 'milestone:v5.18', dryRun: true, json: true });
    expect(r.exitCode).toBe(0);
    expect(r.written).toBeNull();
    expect(r.diffs[0].diff).toContain('"milestone": "v5.18"');
    expect(r.labels.missing.length).toBeGreaterThan(0);
    expect(writes(w)).toEqual([]);
    expect(existsSync(join(w.root, '.copilot'))).toBe(false);
    expect(existsSync(join(w.root, 'user-home'))).toBe(false);
    expect(readdirSync(w.root)).toEqual([]);
    expect(r.preview).toHaveLength(1);
  });

  it('--scope user writes the user config only', async () => {
    const w = githubWorld();
    const r = await run(w, { intake: 'label:factory', progress: 'none', scope: 'user', yes: true });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([userFile(w)]);
    expect(read(userFile(w)).factory!.progress).toEqual({ enabled: false, stages: {} });
    expect(existsSync(projectFile(w))).toBe(false);
  });

  it('never echoes what gh auth status prints', async () => {
    const w = githubWorld();
    const r = await run(w, { intake: 'label:factory', dryRun: true, json: true });
    expect(JSON.stringify(r)).not.toContain('gho_');
    expect(r.auth).toEqual({ ok: true, checks: [{ name: 'gh auth status', ok: true, detail: 'logged in to github.com' }] });
  });

  it('runs the preview forge on the engine guard and a pluggable readiness hook', async () => {
    const w = githubWorld();
    const seen: { exec?: unknown; queried?: unknown[] } = {};
    const r = await run(w, { intake: 'label:factory', dryRun: true }, {
      createForge: fakeForge([{ id: 3, title: 'T', url: 'u' }], seen),
      previewCheck: (_f: unknown, ids: readonly number[]) => ids.map((id) => ({ id, title: 'scored', url: '', readiness: 'runnable 87' })),
    });
    expect(seen.queried).toEqual([{ source: { type: 'label', label: 'factory' }, limit: 10 }]);
    expect(r.preview).toEqual([{ id: 3, title: 'scored', url: '', readiness: 'runnable 87' }]);
    // The engine guard refuses what the setup guard would never allow either.
    expect(() => (seen.exec as (c: string, a: string[]) => unknown)('gh', ['pr', 'merge', '1'])).toThrow();
  });

  it('a forge without an adapter in this build only loses the preview', async () => {
    const w = githubWorld();
    const r = await run(w, { intake: 'label:factory', dryRun: true }, { createForge: () => { throw new Error('no forge adapter for github in this build'); } });
    expect(r.exitCode).toBe(0);
    expect(r.previewError).toContain('no forge adapter');
  });

  it('interactive: picks a milestone, keeps default labels, confirms the write', async () => {
    const w = githubWorld();
    const prompter = scriptedPrompter(['milestone', 'v6.0', true, true]);
    const r = await run(w, {}, { isTTY: () => true, prompter });
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(read(projectFile(w)).factory!.intake).toEqual({ source: { type: 'milestone', milestone: 'v6.0' } });
    expect(prompter.asked).toEqual(['Intake source', 'Milestone', 'Use the default factory:<stage> labels?', 'Write these changes?']);
  });

  it('interactive: declining the write writes nothing (exit 2)', async () => {
    const w = githubWorld();
    const r = await run(w, { intake: 'label:factory', progress: 'default' }, { isTTY: () => true, prompter: scriptedPrompter([false]) });
    expect(r.exitCode).toBe(2);
    expect(existsSync(projectFile(w))).toBe(false);
    expect(writes(w)).toEqual([]);
  });
});

describe('omg factory setup: non-interactive flag matrix', () => {
  it.each<[string, FactorySetupOptions, number, RegExp]>([
    ['no --intake', { yes: true }, 2, /--intake/],
    ['no --yes and no --dry-run', { intake: 'label:factory' }, 2, /--yes/],
    ['nothing at all', {}, 2, /--intake, --yes/],
    ['a bad scope', { intake: 'label:factory', yes: true, scope: 'team' }, 2, /--scope/],
    ['an unknown forge', { intake: 'label:factory', yes: true, forge: 'gitlab' }, 2, /--forge/],
    ['projects v2 intake', { intake: 'project-column:acme/7/Status/Ready', yes: true }, 2, /Projects v2/],
    ['an ADO source on GitHub', { intake: `wiql-query:${QUERY_ID}`, yes: true }, 2, /github sources/],
    ['ADO flags on GitHub', { intake: 'label:factory', yes: true, itemTypes: 'Bug' }, 2, /Azure DevOps flags/],
    ['--forge azure-devops on a GitHub remote', { intake: 'label:factory', yes: true, forge: 'azure-devops' }, 5, /forge mismatch/],
    ['--repo of another repository', { intake: 'label:factory', yes: true, repo: 'evil/widgets' }, 5, /forge mismatch/],
    ['an unknown milestone', { intake: 'milestone:v9', yes: true }, 5, /unknown milestone/],
    ['a missing --progress file', { intake: 'label:factory', yes: true, progress: 'nope.json' }, 2, /--progress/],
  ])('%s exits %i', async (_name, o, code, message) => {
    const w = githubWorld();
    const r = await run(w, { json: true, ...o });
    expect(r.exitCode).toBe(code);
    expect(r.error).toMatch(message);
    expect(existsSync(projectFile(w))).toBe(false);
  });

  it('gh not logged in exits 3 with the fix', async () => {
    const w = githubWorld();
    delete w.answers['gh auth status --hostname github.com'];
    const r = await run(w, { intake: 'label:factory', yes: true });
    expect(r.exitCode).toBe(3);
    expect(r.error).toContain('gh auth login --hostname github.com');
  });

  it('an unsupported remote exits 5', async () => {
    const w = githubWorld();
    w.origin = 'https://gitlab.com/acme/widgets.git';
    const r = await run(w, { intake: 'label:factory', yes: true });
    expect(r.exitCode).toBe(5);
    expect(r.error).toMatch(/unsupported forge/);
  });

  it('the commander command maps flags and sets the exit code', async () => {
    const w = githubWorld();
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    await factorySetupCommand(setupDeps(w)).parseAsync(['--intake', 'label:factory', '--dry-run', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    const json = JSON.parse(out.join('\n')) as { forge: { kind: string }; written: unknown; config: unknown };
    expect(json.forge.kind).toBe('github');
    expect(json.written).toBeNull();
    expect(json.config).toBeDefined();
  });
});

describe('omg factory setup: Azure DevOps (fixtures)', () => {
  it('wiql-query with trusted authors: identity and intake to the project, trustedAuthors to the user config only', async () => {
    const w = adoWorld();
    const r = await run(w, { intake: `wiql-query:${QUERY_ID.toUpperCase()}`, itemTypes: 'user story,Bug', trustedAuthor: 'owner@example.com', yes: true, json: true });
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.written!.sort()).toEqual([projectFile(w), userFile(w)].sort());
    const project = read(projectFile(w));
    expect(project.factory!.forge).toEqual({ kind: 'azure-devops', azureDevOps: { org: 'contoso', project: 'Web', repo: 'web-app' } });
    expect(project.factory!.intake).toEqual({ source: { type: 'wiql-query', queryId: QUERY_ID }, itemTypes: ['User Story', 'Bug'] });
    expect(readFileSync(projectFile(w), 'utf8')).not.toContain('trustedAuthors');
    expect(read(userFile(w)).factory).toEqual({ forge: { azureDevOps: { trustedAuthors: ['owner@example.com'] } } });
    expect(r.auth!.checks.map((c) => c.name)).toEqual(['az extension azure-devops', 'az login', 'read project', 'read repository']);
    // Every az call was a read.
    expect(w.calls.filter((c) => c.cmd === 'az' && c.args[1] === 'invoke').every((c) => c.args[c.args.indexOf('--http-method') + 1] === 'GET')).toBe(true);
  });

  it('board-column with a progress file maps columns and the done state', async () => {
    const w = adoWorld();
    const progress = join(w.root, 'progress.json');
    writeFileSync(progress, JSON.stringify({ stages: { reviewing: { column: 'Code Review' }, 'ready-to-merge': { column: 'Ready to merge' }, done: { state: 'Closed' } } }));
    const r = await run(w, { intake: 'board-column:Web Team/Stories/Ready', progress, dryRun: true, json: true });
    expect(r.error).toBeUndefined();
    expect(r.config!.forge).toEqual({ kind: 'azure-devops', azureDevOps: { org: 'contoso', project: 'Web', repo: 'web-app', team: 'Web Team' } });
    expect(r.config!.progress.stages.done).toEqual({ state: 'Closed' });
    expect(r.config!.intake.itemTypes).toEqual(['User Story', 'Bug']);
    expect(existsSync(projectFile(w))).toBe(false);
  });

  it('area-tag through a PAT instead of az login', async () => {
    const w = adoWorld();
    delete w.answers['az account show --output json'];
    const r = await run(w, { intake: 'area-tag:Web\\Factory#factory', dryRun: true }, { env: { AZURE_DEVOPS_EXT_PAT: 'secret-pat-value' } });
    expect(r.exitCode).toBe(0);
    expect(JSON.stringify(r)).not.toContain('secret-pat-value');
    expect(r.config!.intake.source).toEqual({ type: 'area-tag', areaPath: 'Web\\Factory', tag: 'factory' });
  });

  it.each<[string, FactorySetupOptions, number, RegExp]>([
    ['an unknown saved query', { intake: 'wiql-query:99999999-3f40-4a5b-8c6d-7e8f90a1b2c3' }, 5, /unknown query/],
    ['a tree query', { intake: 'wiql-query:1c7d2e3f-4051-4b6c-9d7e-8f90a1b2c3d4' }, 5, /unknown query/],
    ['a query id that is no GUID', { intake: 'wiql-query:42' }, 2, /GUID/],
    ['an unknown column', { intake: 'board-column:Web Team/Stories/Doing' }, 5, /unknown column/],
    ['an unknown area', { intake: 'area-tag:Web\\Nope#factory' }, 5, /unknown area/],
    ['an unknown item type', { intake: `wiql-query:${QUERY_ID}`, itemTypes: 'Feature' }, 5, /unknown work item type/],
    ['a GitHub source on ADO', { intake: 'label:factory' }, 2, /azure-devops sources/],
    ['--org of another organization', { intake: `wiql-query:${QUERY_ID}`, org: 'fabrikam' }, 5, /forge mismatch/],
  ])('%s exits %i', async (_name, o, code, message) => {
    const w = adoWorld();
    const r = await run(w, { yes: true, json: true, ...o });
    expect(r.exitCode).toBe(code);
    expect(r.error).toMatch(message);
    expect(existsSync(projectFile(w))).toBe(false);
  });

  it.each<[string, object, number, RegExp]>([
    ['a closed state before done', { reviewing: { state: 'Closed' } }, 5, /state validation failed/],
    ['a state that does not exist', { done: { state: 'Shipped' } }, 5, /state validation failed/],
    ['a state change on blocked', { blocked: { state: 'Active' } }, 5, /never changes the work item state/],
    ['a column that is not on the board', { reviewing: { column: 'QA' } }, 5, /not on board/],
    ['a GitHub label mapping', { queued: { label: 'factory:queued' } }, 5, /GitHub mapping/],
  ])('progress with %s exits %i', async (_name, stages, code, message) => {
    const w = adoWorld();
    const progress = join(w.root, 'progress.json');
    writeFileSync(progress, JSON.stringify({ stages }));
    const r = await run(w, { intake: 'board-column:Web Team/Stories/Ready', progress, yes: true });
    expect(r.exitCode).toBe(code);
    expect(r.error).toMatch(message);
  });

  it('a column mapping without a board exits 2', async () => {
    const w = adoWorld();
    const progress = join(w.root, 'progress.json');
    writeFileSync(progress, JSON.stringify({ stages: { reviewing: { column: 'Code Review' } } }));
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, progress, yes: true });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/--board/);
  });

  it('missing azure-devops extension exits 3 with the install command', async () => {
    const w = adoWorld();
    delete w.answers['az extension show --name azure-devops --output json'];
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, yes: true });
    expect(r.exitCode).toBe(3);
    expect(r.error).toContain('az extension add --name azure-devops');
  });

  it('no az on PATH exits 3', async () => {
    const w = adoWorld();
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, yes: true }, { resolveAz: () => { throw new Error('Azure CLI not found'); } });
    expect(r.exitCode).toBe(3);
  });

  it('no login and no PAT exits 3', async () => {
    const w = adoWorld();
    delete w.answers['az account show --output json'];
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, yes: true });
    expect(r.exitCode).toBe(3);
    expect(r.error).toContain('az login');
  });

  it('interactive board-column: team, board and column from the forge, columns per stage', async () => {
    const w = adoWorld();
    const prompter = scriptedPrompter([
      'board-column', 'Web Team', 'Stories', 'Ready',
      true, // move items on the board
      '(none)', 'Ready', 'Code Review', '(none)', 'Ready to merge', 'Closed', '(none)', // queued … blocked
      'Closed', // done state
      '', // trusted authors
      true, // write
    ]);
    const r = await run(w, {}, { isTTY: () => true, prompter });
    expect(r.error).toBeUndefined();
    expect(read(projectFile(w)).factory!.progress).toEqual({
      enabled: true,
      stages: { building: { column: 'Ready' }, reviewing: { column: 'Code Review' }, 'ready-to-merge': { column: 'Ready to merge' }, done: { column: 'Closed', state: 'Closed' } },
    });
    expect(existsSync(userFile(w))).toBe(false);
  });
});

describe('omg factory listen on Azure DevOps', () => {
  it('refuses when the origin is Azure DevOps or the user config pins azure-devops', () => {
    const ado = adoWorld();
    expect(listenForgeRefusal(fakeExec(ado), ado.root, undefined)).toMatch(/GitHub webhooks only/);
    const gh = githubWorld();
    expect(listenForgeRefusal(fakeExec(gh), gh.root, undefined)).toBeUndefined();
    expect(listenForgeRefusal(fakeExec(gh), gh.root, { factory: { forge: { kind: 'azure-devops' } } })).toMatch(/azure-devops/);
  });
});
