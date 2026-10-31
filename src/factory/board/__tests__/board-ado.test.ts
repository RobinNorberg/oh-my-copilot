/**
 * `omg factory board` on Azure DevOps: runFactoryBoard with the real
 * createForge over the adapter's fixture world (src/forge/ado/__tests__/fixtures),
 * so the CLI builds the az read guard itself. Live stages come from the
 * board column (factory.progress.stages), `--no-check` makes one batched
 * work item read, and the guard refuses every az write.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoFixtureExec, loadAdoFixtures, parseAdoFixture, type AdoFixture } from '../../../forge/ado/__tests__/fixtures.js';
import { POSIX_ENTRY, REPO, variant } from '../../../forge/ado/__tests__/world.js';
import { adoInvokeArgs } from '../../../forge/ado/invoke.js';
import { createForge } from '../../../forge/index.js';
import type { ForgeFactory } from '../../../forge/types.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { FactorySafetyError } from '../../run/exec.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo } from '../../run/state.js';
import { runFactoryBoard, type BoardJson, type FactoryBoardDeps, type FactoryBoardOptions } from '../collect.js';

const SHA = 'a'.repeat(40);
const T1 = '2026-10-31T11:00:00.000Z';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const SOURCE = 'area-tag:Web\\Factory#factory';

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-board-ado-'));
  // A git checkout, so the run state lives under it (outside a repository the state root climbs to the home directory).
  execFileSync('git', ['init', '-q', root]);
  if (!factoryStateDir(root).startsWith(root)) throw new Error(`state dir ${factoryStateDir(root)} is outside the test root`);
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The git reads of an ADO checkout and the fixtures for every az call; `az` keeps what reached the fixtures. */
function world(fixtures: readonly AdoFixture[] = loadAdoFixtures()) {
  const answer = adoFixtureExec(fixtures);
  const az: string[][] = [];
  const exec: Exec = (cmd, args, opts) => {
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok(`${REPO.url}\n`);
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
      throw new Error(`unscripted git ${a}`);
    }
    az.push(args);
    return answer(cmd, args, opts);
  };
  return { exec, az };
}

/** Progress on the board: building is the Ready column, reviewing the Code Review column. */
const USER = { factory: { progress: { enabled: true, stages: { building: { column: 'Ready' }, reviewing: { column: 'Code Review' } } } } };

function deps(exec: Exec, over: Partial<FactoryBoardDeps> = {}): FactoryBoardDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => USER,
    projectConfig: () => undefined,
    createForge,
    resolveAz: () => POSIX_ENTRY,
    now: () => Date.parse('2026-10-31T12:00:00.000Z'),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
}

const board = (exec: Exec, o: FactoryBoardOptions = {}, over: Partial<FactoryBoardDeps> = {}) => runFactoryBoard(o, deps(exec, over));
const json = (): BoardJson => JSON.parse(out.join('\n')) as BoardJson;
const flag = (args: readonly string[], f: string) => args[args.indexOf(f) + 1];
const routeOf = (args: readonly string[]) => `${flag(args, '--area')}.${flag(args, '--resource')}.${args.includes('--http-method') ? flag(args, '--http-method') : 'GET'}`;

/** Work item 42 in review (PR 17); the tracker shows it in the Ready column. */
function seedReview(): void {
  const s = { ...moveTo({ ...createFactoryState({ issue: 42, repoUrl: REPO.url, base: 'dev' }, T1), forgeKind: 'azure-devops' as const }, 'review', 'pr open', T1), pr: 17, trackerStage: 'reviewing' as const };
  const path = factoryStatePath(root, 42);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}

/** Spec 30 with child 42 (synthetic: the 42 fixture as its parent). */
function withSpec(fixtures: AdoFixture[]): AdoFixture[] {
  const item = fixtures.find((f) => f.name === 'wit.workItems.GET.42.json')!;
  const comments = fixtures.find((f) => f.name === 'wit.comments.GET.42.json')!;
  const spec = structuredClone(item.stdout) as { id: number; fields: Record<string, unknown>; relations: unknown[]; _links: unknown };
  spec.id = 30;
  spec.fields['System.Title'] = 'Reports spec';
  spec._links = { html: { href: 'https://dev.azure.com/contoso/Web/_workitems/edit/30' } };
  spec.relations = [{ rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/42' }];
  return [
    ...fixtures,
    parseAdoFixture('spec-30', JSON.stringify({ provenance: 'synthetic: spec 30 with child 42', route: 'wit.workItems.GET', routeParameters: { project: 'Web', id: '30' }, queryParameters: { $expand: 'relations' }, stdout: spec })),
    parseAdoFixture('spec-30-comments', JSON.stringify({ provenance: 'synthetic: no comments on spec 30', route: 'wit.comments.GET', routeParameters: { project: 'Web', workItemId: '30' }, stdout: { ...(comments.stdout as object), comments: [] } })),
  ];
}

describe('omg factory board on Azure DevOps (runFactoryBoard + the real adapter)', () => {
  it('maps the board column to the live stage, flags drift, and reads through GETs and the WIQL query only', async () => {
    seedReview();
    const w = world();
    expect(await board(w.exec, { source: SOURCE, json: true })).toBe(0);
    const b = json();
    expect(b).toMatchObject({ ok: true, forge: 'azure-devops', repo: REPO.url, source: { type: 'area-tag', areaPath: 'Web\\Factory', tag: 'factory' }, parent: null });
    expect(b.columns.filter((c) => c.items.length).map((c) => [c.stage, c.title, c.items.map((r) => r.id)])).toEqual([['reviewing', 'Code Review', [42]]]);
    expect(b.columns.find((c) => c.stage === 'building')!.title).toBe('Ready');
    const row = b.columns.find((c) => c.stage === 'reviewing')!.items[0];
    expect(row).toMatchObject({ title: 'Add CSV export to the report page', url: 'https://dev.azure.com/contoso/Web/_workitems/edit/42', check: { bucket: 'blocked' } });
    expect(row.run).toMatchObject({ phase: 'review', pr: 17, integrity: 'ok' });
    expect(row.stage).toEqual({ expected: 'reviewing', recorded: 'reviewing', live: 'building' });
    expect(row.liveText).toBe('Ready');
    expect(row.flags).toEqual(['drift']);
    expect(w.az.length).toBeGreaterThan(0);
    expect(w.az.map(routeOf).filter((r) => !r.endsWith('.GET'))).toEqual(['wit.wiql.POST']);

    out = [];
    expect(await board(world().exec, { source: SOURCE })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^factory board {2}azure-devops https:\/\/dev\.azure\.com\/contoso\/Web\/_git\/web-app {2}source area-tag Web\\Factory#factory {2}\(1 item, 1 run\)/);
    expect(text).toMatch(/REVIEWING \(Code Review\)\n {2}#42 +review {2}0\.00 cr {2}PR !17 {2}Add CSV export to the report page {2}drift: live "Ready" != recorded reviewing/);
  });

  it('--no-check reads every item in one batched GET (no comments, states or PR lookups); a missing id is read-failed', async () => {
    const fixtures = variant(loadAdoFixtures(), 'wit.wiql.POST.query.json', (s) => ({ ...s, workItems: [{ id: 42 }, { id: 404 }] }));
    const w = world(fixtures);
    expect(await board(w.exec, { source: SOURCE, check: false, json: true })).toBe(1);
    expect(w.az.map(routeOf)).toEqual(['wit.wiql.POST', 'wit.workItems.GET']);
    const peek = w.az[1];
    expect(peek.slice(peek.indexOf('--query-parameters') + 1, peek.indexOf('--http-method'))).toEqual(['ids=42,404', 'fields=System.Id,System.Title,System.State,System.BoardColumn,System.Tags', 'errorPolicy=omit']);
    const b = json();
    expect(b.ok).toBe(false);
    expect(b.columns[0].items).toEqual([
      { id: 42, title: 'Add CSV export to the report page', url: 'https://dev.azure.com/contoso/Web/_workitems/edit/42', stage: { live: 'building' }, flags: [] },
      { id: 404, title: '', url: '', error: '#404 could not be read', stage: {}, flags: [] },
    ]);
  });

  it('--parent shows the spec\'s children (Hierarchy-Forward links)', async () => {
    const w = world(withSpec(loadAdoFixtures()));
    expect(await board(w.exec, { parent: '30', json: true })).toBe(0);
    const b = json();
    expect(b.parent).toEqual({ id: 30, title: 'Reports spec', url: 'https://dev.azure.com/contoso/Web/_workitems/edit/30' });
    expect(b.columns[0].items.map((r) => r.id)).toEqual([42]);
    expect(w.az.map(routeOf).every((r) => r.endsWith('.GET'))).toBe(true);
  });

  it('the read guard refuses every az write (and an oversized batch) before it reaches az', async () => {
    let guarded: Exec | undefined;
    const spy: ForgeFactory = (exec, cwd, config, options) => {
      guarded = exec;
      return createForge(exec, cwd, config, options);
    };
    const w = world();
    expect(await board(w.exec, { source: SOURCE, json: true }, { createForge: spy })).toBe(0);
    const before = w.az.length;
    const ctx = { entry: POSIX_ENTRY, repo: REPO };
    const body = join(root, 'body.json');
    writeFileSync(body, '{}');
    const writes: Array<[string, Record<string, string>, Record<string, string>?]> = [
      ['wit.workItems.PATCH', { project: 'Web', id: '42' }],
      ['wit.workItems.POST', { project: 'Web', type: 'User Story' }],
      ['wit.comments.POST', { project: 'Web', workItemId: '42' }, { format: 'markdown' }],
      ['git.pullRequests.POST', { project: 'Web', repositoryId: 'web-app' }],
      ['git.pullRequests.PATCH', { project: 'Web', repositoryId: 'web-app', pullRequestId: '17' }],
      ['git.pullRequestThreads.POST', { project: 'Web', repositoryId: 'web-app', pullRequestId: '17' }],
      ['policy.evaluations.PATCH', { project: 'Web', evaluationId: '00000000-0000-0000-0000-000000000001' }],
    ];
    for (const [route, rp, qp] of writes) {
      const args = adoInvokeArgs(ctx, route, rp, qp, route === 'policy.evaluations.PATCH' ? undefined : body);
      expect(() => guarded!(POSIX_ENTRY.command, args, { cwd: root }), route).toThrow(FactorySafetyError);
    }
    const ids = Array.from({ length: 201 }, (_, i) => String(i + 1)).join(',');
    expect(() => guarded!(POSIX_ENTRY.command, adoInvokeArgs(ctx, 'wit.workItems.GET', { project: 'Web' }, { ids, fields: 'System.Title', errorPolicy: 'omit' }), { cwd: root })).toThrow(/query parameter ids has a refused value/);
    expect(() => guarded!(POSIX_ENTRY.command, adoInvokeArgs(ctx, 'wit.workItems.GET', { project: 'Web' }, { ids: '42', errorPolicy: 'fail' }), { cwd: root })).toThrow(/query parameter errorPolicy has a refused value/);
    expect(w.az.length).toBe(before);
  });
});
