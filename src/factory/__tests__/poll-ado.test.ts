/**
 * `omg factory poll` on Azure DevOps: runFactoryPoll with the real
 * createForge over the adapter's fixture world, so the CLI builds the az
 * read guard itself. The PR tick counts open human threads (system threads
 * and the factory's own are left out), a completed PR prints the resume hint
 * and reads no threads, the heal tick is gated on capabilities.heal,
 * TF400733 marks the tick rate-limited, and every az call is a GET or the
 * WIQL query.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoFixtureExec, loadAdoFixtures, parseAdoFixture, type AdoFixture } from '../../forge/ado/__tests__/fixtures.js';
import { POSIX_ENTRY, REPO, variant } from '../../forge/ado/__tests__/world.js';
import { ADO_RATE_LIMITED, ADO_TRANSIENT_ERROR } from '../../forge/ado/checks.js';
import { parseAdoThreads } from '../../forge/ado/reviews.js';
import { createForge } from '../../forge/index.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import type { ScanResult } from '../heal/cli.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo } from '../run/state.js';
import { defaultPollHealScan, pollStatePath, runFactoryPoll, type FactoryPollDeps, type FactoryPollOptions, type PollAutoStart, type PollHealScan, type PollTick } from '../poll.js';

const SHA = 'a'.repeat(40);
const T1 = '2026-10-31T11:00:00.000Z';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const SOURCE = { type: 'area-tag', areaPath: 'Web\\Factory', tag: 'factory' };

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-poll-ado-'));
  // A git checkout, so the poll and run state live under it (outside a repository the state root climbs to the home directory).
  execFileSync('git', ['init', '-q', root]);
  if (!pollStatePath(root).startsWith(root) || !factoryStateDir(root).startsWith(root)) throw new Error('state dir is outside the test root');
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The board's batched read of the source's one item (synthetic: the peek fixture narrowed to 42). */
function withPeek42(fixtures: AdoFixture[]): AdoFixture[] {
  const peek = fixtures.find((f) => f.name === 'wit.workItems.GET.peek.json')!;
  const stdout = structuredClone(peek.stdout) as { value: Array<{ id: number }>; count: number };
  stdout.value = stdout.value.filter((v) => v?.id === 42);
  stdout.count = stdout.value.length;
  return [...fixtures, parseAdoFixture('peek-42', JSON.stringify({
    provenance: 'synthetic: the peek fixture narrowed to work item 42', route: 'wit.workItems.GET',
    queryParameters: { ...peek.queryParameters, ids: '42' }, routeParameters: peek.routeParameters, stdout,
  }))];
}

/** The git reads of an ADO checkout and the fixtures for every az call; `az` keeps what reached the fixtures. */
function world(fixtures: readonly AdoFixture[] = withPeek42(loadAdoFixtures()), fail?: (args: string[]) => ExecResult | undefined) {
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
    return fail?.(args) ?? answer(cmd, args, opts);
  };
  return { exec, az };
}

const USER = { factory: { intake: { source: SOURCE }, progress: { enabled: true, stages: { reviewing: { column: 'Code Review' } } } } };

function deps(exec: Exec, over: Partial<FactoryPollDeps> = {}): FactoryPollDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => USER,
    projectConfig: () => undefined,
    createForge,
    resolveAz: () => POSIX_ENTRY,
    now: () => Date.parse('2026-10-31T12:00:00.000Z'),
    healScan: () => { throw new Error('no heal capability without factory.heal.pipeline'); },
    owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
    onStop: () => () => {},
    sleep: async () => {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
}

const poll = (exec: Exec, o: FactoryPollOptions = {}, over: Partial<FactoryPollDeps> = {}) => runFactoryPoll(o, deps(exec, over));
const tick = (): PollTick => JSON.parse(out.at(-1)!) as PollTick;
const flag = (args: readonly string[], f: string) => args[args.indexOf(f) + 1];
const routeOf = (args: readonly string[]) => `${flag(args, '--area')}.${flag(args, '--resource')}.${args.includes('--http-method') ? flag(args, '--http-method') : 'GET'}`;

/** Work item 42 in review with PR 17. */
function seedReview(): void {
  const s = { ...moveTo({ ...createFactoryState({ issue: 42, repoUrl: REPO.url, base: 'dev' }, T1), forgeKind: 'azure-devops' as const }, 'review', 'pr open', T1), pr: 17, trackerStage: 'reviewing' as const };
  const path = factoryStatePath(root, 42);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}

describe('omg factory poll on Azure DevOps (runFactoryPoll + the real adapter)', () => {
  it('--once --json: intake, PR threads and board through GETs and the WIQL query only', async () => {
    seedReview();
    const w = world();
    expect(await poll(w.exec, { once: true, json: true })).toBe(0);
    const t = tick();
    expect(t).toMatchObject({
      forge: 'azure-devops', repo: REPO.url,
      heal: { ran: false, reason: expect.stringContaining('factory.heal.pipeline') },
      intake: { ran: true, items: 1, new: [{ id: 42 }] },
      // Only thread 3: thread 1 is ADO's own (system), 2 the factory's (the PR creator), 4 fixed, 5 deleted.
      prs: [{ id: 42, pr: 17, state: 'OPEN', threads: 1 }],
      // The run in review holds no gate: it is in flight, so the tick is not idle.
      idle: false, rateLimited: false, errors: [],
    });
    expect(t.board.map((b) => [b.stage, b.row.id, b.row.stage.live])).toEqual([['reviewing', 42, 'unmapped']]);
    const routes = w.az.map(routeOf);
    expect(routes).toEqual(expect.arrayContaining(['wit.wiql.POST', 'git.pullRequests.GET', 'git.pullRequestThreads.GET', 'wit.workItems.GET']));
    for (const r of routes) expect(r, r).toMatch(/\.GET$|^wit\.wiql\.POST$/);
    // viewPr's read gives listThreads the PR creator: two calls per open run.
    expect(routes.filter((r) => r.startsWith('git.'))).toEqual(['git.pullRequests.GET', 'git.pullRequestThreads.GET']);
  });

  it('text output: the open human threads line', async () => {
    seedReview();
    expect(await poll(world().exec, { once: true })).toBe(0);
    expect(out.join('\n')).toContain('PR !17 of #42: 1 open human thread(s)');
  });

  it('a PR a human completed prints the resume hint, reads no threads and writes nothing', async () => {
    seedReview();
    const w = world(withPeek42(variant(loadAdoFixtures(), 'git.pullRequests.GET.by-id.json', (pr) => ({ ...pr, status: 'completed' }))));
    expect(await poll(w.exec, { once: true, json: true })).toBe(0);
    expect(tick().prs).toEqual([{ id: 42, pr: 17, state: 'MERGED', hint: 'omg factory run 42' }]);
    expect(w.az.map(routeOf)).not.toContain('git.pullRequestThreads.GET');
    for (const args of w.az) expect(args.includes('--http-method') ? flag(args, '--http-method') : 'GET').toMatch(/^(?:GET|POST)$/);
    expect(w.az.filter((a) => flag(a, '--http-method') === 'POST').map(routeOf)).toEqual(['wit.wiql.POST']);
  });

  it('heal: with factory.heal.pipeline the tick calls the scan; the default scan is refused on ADO and only skips', async () => {
    const user = { factory: { ...USER.factory, heal: { pipeline: { definitionId: 7 } } } };
    const calls: string[] = [];
    const fake: PollHealScan = (o) => { calls.push(o.kind); return { base: o.base, dryRun: false, entries: [], queued: 0 } satisfies ScanResult; };
    expect(await poll(world().exec, { once: true, json: true }, { trustedUser: () => user, healScan: fake })).toBe(0);
    expect(calls).toEqual(['azure-devops']);
    expect(tick().heal).toEqual({ ran: true, entries: 0, recorded: 0, queued: 0 });
    const healScan = defaultPollHealScan(() => { throw new Error('no command runs'); }, () => { throw new Error('no config read'); }, join(root, 'ledger'));
    expect(await poll(world().exec, { once: true, json: true }, { trustedUser: () => user, healScan })).toBe(0);
    expect(tick()).toMatchObject({ heal: { ran: false, reason: expect.stringContaining('does not run on Azure DevOps yet') }, errors: [] });
  });

  it('TF400733 marks the tick rate-limited, and a --once tick with a failed read exits 1', async () => {
    const limited = (args: string[]) => (routeOf(args) === 'wit.wiql.POST'
      ? { status: 1, stdout: '', stderr: 'ERROR: TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource \'Count\' in namespace \'User\'.' }
      : undefined);
    expect(await poll(world(undefined, limited).exec, { once: true, json: true })).toBe(1);
    expect(tick()).toMatchObject({ rateLimited: true, intake: { ran: false }, errors: [expect.stringMatching(/^intake: .*TF400733/)] });
  });

  it('factory.intake.autoStart: an idle tick starts one run --next; a run in flight or a working-tree key starts none', async () => {
    const starts: string[] = [];
    const autoStart: PollAutoStart = async (o) => { starts.push(o.root); return { exitCode: 0, next: 42, message: 'parked at awaiting-human: merge' }; };
    const user = { factory: { ...USER.factory, intake: { ...USER.factory.intake, autoStart: true } } };
    const w = world();
    expect(await poll(w.exec, { once: true, json: true }, { trustedUser: () => user, autoStart, budget: () => null })).toBe(0);
    expect(tick()).toMatchObject({ forge: 'azure-devops', idle: true, autoStart: { started: true, next: 42, exitCode: 0 } });
    expect(starts).toEqual([root]);
    // The tick's own reads stay GETs and the WIQL query.
    for (const r of w.az.map(routeOf)) expect(r, r).toMatch(/\.GET$|^wit\.wiql\.POST$/);
    seedReview();
    expect(await poll(world().exec, { once: true, json: true }, { trustedUser: () => user, autoStart, budget: () => null })).toBe(0);
    expect(tick().autoStart).toEqual({ started: false, reason: 'a run is in flight' });
    rmSync(factoryStatePath(root, 42));
    const project = { factory: { intake: { autoStart: true } } };
    expect(await poll(world().exec, { once: true, json: true }, { projectConfig: () => project, autoStart, budget: () => null })).toBe(0);
    expect(tick().autoStart).toEqual({ started: false, reason: 'factory.intake.autoStart is off' });
    expect(err.join('\n')).toContain('ignoring factory.intake.autoStart from the working-tree project config');
    expect(starts).toHaveLength(1);
  });
});

describe('ADO rate limits and threads', () => {
  it('ADO_RATE_LIMITED and the transient set', () => {
    for (const m of ['TF400733: The request has been canceled', 'HTTP 429', 'Too Many Requests']) expect(ADO_RATE_LIMITED.test(m), m).toBe(true);
    for (const m of ['HTTP 4290', 'TF400898', 'Service Unavailable']) expect(ADO_RATE_LIMITED.test(m), m).toBe(false);
    expect(ADO_TRANSIENT_ERROR.test('TF400733: The request has been canceled')).toBe(true);
  });

  it('parseAdoThreads: statuses, kinds, the PR author and deleted threads', () => {
    const json = { value: [
      { id: 1, status: 'active', comments: [{ commentType: 'text', author: { uniqueName: 'Me@Example.com' } }], lastUpdatedDate: 'x' },
      { id: 2, status: 'weird', comments: [{ commentType: 'poll', author: {} }], threadContext: { filePath: '/a.ts' } },
      { id: 3, status: 'active', isDeleted: true, comments: [] },
    ] };
    expect(parseAdoThreads(json, 17, 'me@example.com')).toEqual([
      { id: 1, status: 'active', kind: 'text', author: 'me@example.com', byPrAuthor: true, updatedAt: 'x' },
      { id: 2, status: 'unknown', kind: 'unknown', author: '', byPrAuthor: false, updatedAt: '', file: '/a.ts' },
    ]);
    expect(() => parseAdoThreads({ value: [{ status: 'active' }] }, 17, undefined)).toThrow(/without an id/);
  });
});
