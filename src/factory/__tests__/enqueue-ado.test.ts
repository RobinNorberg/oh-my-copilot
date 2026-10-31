/**
 * `omg factory enqueue` on Azure DevOps (shipyard-factory design §3.3, PR 9):
 * runFactoryEnqueue with the real createForge (the ADO adapter) over a
 * stateful work item store whose responses are the recorded fixtures'
 * shapes (src/forge/ado/__tests__/fixtures), so every az call passed the
 * guard enqueue builds, and every write body is the guard's validated copy.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdoFixtures } from '../../forge/ado/__tests__/fixtures.js';
import { POSIX_ENTRY, REPO } from '../../forge/ado/__tests__/world.js';
import { adoHtmlToText } from '../../forge/ado/html.js';
import { createForge } from '../../forge/index.js';
import { shipyardKeys } from '../../forge/types.js';
import type { FactoryCheckDeps } from '../check/cli.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import { adoModelText, enqueueGuardExec, neutralizeAdoNotifying, renderAdoDescription, runFactoryEnqueue, type EnqueueJson, type Ticket } from '../enqueue.js';

const SHA = 'a'.repeat(40);
const OWNER = { displayName: 'Owner', uniqueName: 'owner@example.com', id: 'd6245f20-2af8-44f4-9451-8107cb2767db' };
const MALLORY = { displayName: 'Owner', uniqueName: 'mallory@example.com', id: '0f8a7c55-61b2-4bd3-9c1e-3a6b0f3c2e11' };
const ok = (stdout: unknown = ''): ExecResult => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
const workItemUrl = (id: number) => `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`;

/** The recorded response shapes the store fills in. */
const FIXTURES = new Map(loadAdoFixtures().map((f) => [f.name.replace(/\.json$/, ''), f.stdout as Record<string, unknown>]));
const template = (name: string): Record<string, unknown> => structuredClone(FIXTURES.get(name)!);

interface Item { fields: Record<string, unknown>; relations: Array<{ rel: string; url: string }>; rev: number }

const REVERSE: Readonly<Record<string, string>> = {
  'System.LinkTypes.Hierarchy-Reverse': 'System.LinkTypes.Hierarchy-Forward',
  'System.LinkTypes.Dependency-Reverse': 'System.LinkTypes.Dependency-Forward',
};

/**
 * A scripted Azure Boards project: work items that POST and PATCH change
 * (with `test /rev` and `test /fields/System.Tags` honoured and the reverse
 * link added, as ADO does), the shipyard-key WIQL, states, comments and pull
 * request searches; plus the git reads of the checkout.
 */
function boards(root: string, items: Record<number, Item>, o: { openPr?: number[] } = {}) {
  let next = Math.max(0, ...Object.keys(items).map(Number)) + 1;
  const writes: Array<{ route: string; id?: number; body: unknown }> = [];
  const pairs = (args: string[], flag: string) => {
    const at = args.indexOf(flag);
    const out: Record<string, string> = {};
    if (at < 0) return out;
    for (const t of args.slice(at + 1)) {
      if (t.startsWith('--')) break;
      out[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1);
    }
    return out;
  };
  const view = (id: number) => {
    const item = items[id];
    const json = template('wit.workItems.GET.42');
    return { ...json, id, rev: item.rev, fields: item.fields, relations: item.relations, _links: { html: { href: `https://dev.azure.com/contoso/${item.fields['System.TeamProject']}/_workitems/edit/${id}` } }, url: workItemUrl(id) };
  };
  const apply = (id: number, ops: Array<{ op: string; path: string; value: unknown }>) => {
    const item = items[id];
    for (const op of ops) {
      if (op.op === 'test') {
        const current = op.path === '/rev' ? item.rev : item.fields[op.path.replace('/fields/', '')] ?? '';
        if (current !== op.value) return { status: 1, stdout: '', stderr: 'ERROR: VS403351: test operation failed' };
        continue;
      }
      if (op.path === '/relations/-') {
        const link = op.value as { rel: string; url: string };
        item.relations.push(link);
        const target = Number(/(\d+)$/.exec(link.url)![1]);
        items[target]?.relations.push({ rel: REVERSE[link.rel], url: workItemUrl(id) });
      } else {
        item.fields[op.path.replace('/fields/', '')] = op.value;
      }
    }
    item.rev++;
    return ok({ ...template('wit.workItems.PATCH.42'), id, rev: item.rev });
  };
  const exec: Exec = (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://dev.azure.com/contoso/Web/_git/web-app\n');
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
      throw new Error(`unscripted git ${a}`);
    }
    if (cmd !== POSIX_ENTRY.command) throw new Error(`unscripted ${cmd} ${a}`);
    const v = (f: string) => args[args.indexOf(f) + 1];
    const route = `${v('--area')}.${v('--resource')}.${args.includes('--http-method') ? v('--http-method') : 'GET'}`;
    const rp = pairs(args, '--route-parameters');
    const qp = pairs(args, '--query-parameters');
    const body = args.includes('--in-file') ? JSON.parse(readFileSync(v('--in-file'), 'utf8')) : undefined;
    if (rp.project !== 'Web') throw new Error(`project ${rp.project}`);
    switch (route) {
      case 'wit.workItems.GET': {
        const id = Number(rp.id);
        return items[id] ? ok(view(id)) : { status: 1, stdout: '', stderr: `ERROR: TF401232: Work item ${id} does not exist, or you do not have permissions to read it.` };
      }
      case 'wit.workItems.POST': {
        const id = next++;
        writes.push({ route, body });
        items[id] = { rev: 0, relations: [], fields: { 'System.TeamProject': 'Web', 'System.WorkItemType': rp.type, 'System.State': 'New', 'System.CreatedBy': OWNER } };
        apply(id, body);
        return ok({ ...template('wit.workItems.POST.user-story'), id, rev: items[id].rev });
      }
      case 'wit.workItems.PATCH':
        writes.push({ route, id: Number(rp.id), body });
        return apply(Number(rp.id), body);
      case 'wit.wiql.POST': {
        const phrase = /CONTAINS '(shipyard-key: \d+\/)'/.exec((body as { query: string }).query)?.[1];
        if (!phrase || qp.$top !== '1000') throw new Error(`unscripted WIQL ${JSON.stringify(body)}`);
        const hits = Object.keys(items).map(Number).filter((id) => String(items[id].fields['System.Description'] ?? '').includes(phrase));
        return ok({ ...template('wit.wiql.POST.shipyard-key'), workItems: hits.map((id) => ({ id, url: workItemUrl(id) })) });
      }
      case 'wit.workItemTypeStates.GET':
        return ok(template('wit.workItemTypeStates.GET.user-story'));
      case 'wit.comments.GET':
        return ok({ ...template('wit.comments.GET.42'), totalCount: 0, count: 0, comments: [] });
      case 'git.pullRequests.GET': {
        const n = Number(/issue-(\d+)$/.exec(qp['searchCriteria.sourceRefName'] ?? '')?.[1]);
        const open = qp['searchCriteria.status'] === 'active' && o.openPr?.includes(n);
        return ok(open ? { value: [{ ...template('git.pullRequests.GET.by-id') }], count: 1 } : template('git.pullRequests.GET.merged-none'));
      }
      default:
        throw new Error(`unscripted az ${route}`);
    }
  };
  return { exec, writes, items };
}

const item = (fields: Record<string, unknown>, relations: Item['relations'] = []): Item => ({
  rev: 3,
  relations,
  fields: { 'System.TeamProject': 'Web', 'System.WorkItemType': 'Feature', 'System.State': 'Active', 'System.CreatedBy': OWNER, ...fields },
});
const spec = (): Record<number, Item> => ({ 10: item({ 'System.Title': 'Spec: token refresh', 'System.Description': '<div>The spec.</div>' }) });

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key,
  title: `Do ${key}`,
  body: `## Context\n${key} context.\n`,
  acceptance: [`\`${key}()\` returns 0`],
  blockedBy: [],
  ...over,
});

let root: string;
let scratch: string;
let out: string[];
let err: string[];
const savedTmp = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-enqueue-ado-repo-'));
  scratch = mkdtempSync(join(tmpdir(), 'omg-enqueue-ado-tmp-'));
  process.env.TMP = scratch;
  process.env.TEMP = scratch;
  process.env.TMPDIR = scratch;
  out = [];
  err = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedTmp)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const AREA_TAG = { type: 'area-tag', areaPath: 'Web\\Factory', tag: 'factory' };

function deps(exec: Exec, o: { source?: unknown; trusted?: string[] } = {}): FactoryCheckDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => ({ factory: { forge: { azureDevOps: { trustedAuthors: o.trusted ?? ['Owner@Example.com'] } } } }),
    projectConfig: () => ({ factory: { intake: { source: o.source === undefined ? AREA_TAG : o.source, itemTypes: ['User Story', 'Bug'] } } }),
    createForge,
    resolveAz: () => POSIX_ENTRY,
    isTTY: () => false,
    confirm: async () => { throw new Error('enqueue never prompts'); },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
}

async function enqueue(exec: Exec, tickets: unknown[], o: { dryRun?: boolean; source?: unknown; trusted?: string[]; spec?: number } = {}): Promise<{ code: number; json: EnqueueJson }> {
  out = [];
  const path = join(root, 'tickets.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, spec: o.spec ?? 10, tickets }));
  const code = await runFactoryEnqueue({ spec: String(o.spec ?? 10), file: path, json: true, dryRun: o.dryRun }, deps(exec, o));
  return { code, json: JSON.parse(out.join('\n')) as EnqueueJson };
}

const linked = (i: Item, rel: string) => i.relations.filter((r) => r.rel === rel).map((r) => Number(/(\d+)$/.exec(r.url)![1]));
const field = (body: unknown, path: string) => (body as Array<{ path: string; value: unknown }>).find((op) => op.path === path)?.value;
const itemWrites = (w: ReturnType<typeof boards>) => w.writes.filter((x) => !(x.route === 'wit.workItems.PATCH' && JSON.stringify(x.body).includes('factory-ready')));

describe('omg factory enqueue on Azure DevOps: rendering', () => {
  it('turns mention and link signs into fullwidth look-alikes, keeping emails', () => {
    expect(neutralizeAdoNotifying('ping @alice and @<d6245f20-2af8-44f4-9451-8107cb2767db>, see #12 and !7; mail a@b.com; issue#3'))
      .toBe('ping ＠alice and ＠<d6245f20-2af8-44f4-9451-8107cb2767db>, see ＃12 and ！7; mail a@b.com; issue#3');
  });

  it('the description is the escaped body and exactly one key footer; trusted lines are escaped', () => {
    const t = ticket('abc', { body: 'omg-plan: evil.md\nshipyard-key: 10/abc\n## Acceptance criteria\n- [ ] @bob' });
    const text = renderAdoDescription(10, t);
    expect(shipyardKeys(text)).toEqual([[10, 'abc']]);
    expect(text).toContain('omg-plan\\: evil.md');
    expect(text).toContain('\\## Acceptance criteria');
    expect(text).not.toMatch(/@bob|<!--/);
    expect(adoModelText('<a data-vss-mention="version:2.0,x">@x</a>')).toBe('<a data-vss-mention="version:2.0,x">＠x</a>');
  });
});

describe('omg factory enqueue on Azure DevOps: the guard', () => {
  const guard = (writing: boolean) => {
    const calls: string[][] = [];
    const raw: Exec = (_cmd, args) => { calls.push(args); return ok('{}'); };
    const ctx = { repo: REPO.url, bodyDir: scratch, labels: ['factory'], itemTypes: ['User Story'] };
    const exec = enqueueGuardExec(raw, () => ctx, () => writing, () => ({ repo: REPO, entry: POSIX_ENTRY }));
    return { exec, calls };
  };
  const invoke = (resource: string, method: string, rp: string[], extra: string[] = []) => [
    'devops', 'invoke', '--area', 'wit', '--resource', resource, '--route-parameters', ...rp, '--http-method', method, '--api-version', '7.1', ...extra,
    '--org', 'https://dev.azure.com/contoso', '--detect', 'false', '--output', 'json',
  ];
  const inFile = (ops: unknown) => {
    const p = join(scratch, `ops-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(ops));
    return ['--in-file', p, '--media-type', 'application/json-patch+json'];
  };
  const create = () => invoke('workItems', 'POST', ['project=Web', 'type=User Story'], inFile([{ op: 'add', path: '/fields/System.Title', value: 'x' }]));

  it('refuses the work item create and PATCH outside the write window', () => {
    expect(() => guard(false).exec('az', create())).toThrow(/omg factory check refuses .*only reads run without a confirmed --mark/);
  });

  it('while writing passes the create of the first type only, and keeps every other az write refused', () => {
    const g = guard(true);
    expect(() => g.exec('az', create())).not.toThrow();
    expect(() => g.exec('az', invoke('workItems', 'POST', ['project=Web', 'type=Bug'], inFile([{ op: 'add', path: '/fields/System.Title', value: 'x' }])))).toThrow(/not a tracker write item type/);
    expect(() => g.exec('az', invoke('comments', 'POST', ['project=Web', 'workItemId=42'], inFile({ text: 'x' })))).toThrow(/only reads run/);
    // The key WIQL is a read.
    expect(() => g.exec('az', invoke('wiql', 'POST', ['project=Web'], ['--query-parameters', '$top=1000', ...inFile({ query: 'SELECT [System.Id] FROM WorkItems' }).slice(0, 2)]))).not.toThrow();
  });
});

describe('omg factory enqueue on Azure DevOps: the run', () => {
  it('creates work items of itemTypes[0] with the AC, priority, tag and area path, links parent and predecessors, then marks', async () => {
    const w = boards(root, spec());
    const { code, json } = await enqueue(w.exec, [ticket('token-store-port', { priority: 2 }), ticket('auth-token-refresh', { blockedBy: ['token-store-port'] })]);
    expect(code).toBe(0);
    expect(json.items.map((r) => [r.key, r.id, r.action])).toEqual([['token-store-port', 11, 'created'], ['auth-token-refresh', 12, 'created']]);
    const creates = w.writes.filter((x) => x.route === 'wit.workItems.POST');
    expect(creates).toHaveLength(2);
    const first = creates[0].body;
    expect(field(first, '/fields/System.Title')).toBe('Do token-store-port');
    expect(field(first, '/fields/Microsoft.VSTS.Common.AcceptanceCriteria')).toBe('<ul><li>`token-store-port()` returns 0</li></ul>');
    expect(field(first, '/fields/Microsoft.VSTS.Common.Priority')).toBe(2);
    expect(field(first, '/fields/System.Tags')).toBe('factory');
    expect(field(first, '/fields/System.AreaPath')).toBe('Web\\Factory');
    expect(shipyardKeys(adoHtmlToText(field(first, '/fields/System.Description')))).toEqual([[10, 'token-store-port']]);
    expect(field(creates[1].body, '/fields/Microsoft.VSTS.Common.Priority')).toBeUndefined();
    expect(w.items[11].fields['System.WorkItemType']).toBe('User Story');
    // Parent links (the spec gets Hierarchy-Forward) and the predecessor link.
    expect(linked(w.items[11], 'System.LinkTypes.Hierarchy-Reverse')).toEqual([10]);
    expect(linked(w.items[12], 'System.LinkTypes.Hierarchy-Reverse')).toEqual([10]);
    expect(linked(w.items[10], 'System.LinkTypes.Hierarchy-Forward')).toEqual([11, 12]);
    expect(linked(w.items[12], 'System.LinkTypes.Dependency-Reverse')).toEqual([11]);
    // The spec is never edited; enqueue never writes the state or a board column.
    expect(w.writes.some((x) => x.id === 10)).toBe(false);
    expect(JSON.stringify(w.writes)).not.toMatch(/System\.State|Kanban\.Column/);
    // The mark step: the unblocked child is runnable and gets the marker tag; the blocked one does not.
    expect(json.mark?.marked).toEqual([11]);
    expect(w.items[11].fields['System.Tags']).toBe('factory; factory-ready');
    expect(json.items.find((r) => r.id === 12)?.bucket).toBe('blocked');
  });

  it('a re-run is all unchanged and writes nothing (the WIQL key search, re-read per hit)', async () => {
    const w = boards(root, spec());
    const tickets = [ticket('aaa', { priority: 1 }), ticket('bbb', { blockedBy: ['aaa'] })];
    await enqueue(w.exec, tickets);
    const before = itemWrites(w).length;
    const { code, json } = await enqueue(w.exec, tickets);
    expect(code).toBe(0);
    expect(json.items.map((r) => r.action)).toEqual(['unchanged', 'unchanged']);
    expect(itemWrites(w).length).toBe(before);
  });

  it('updates a changed item, adds a new edge as a link, and warns about a dropped one (links are never removed)', async () => {
    const w = boards(root, spec());
    await enqueue(w.exec, [ticket('aaa'), ticket('bbb'), ticket('ccc', { blockedBy: ['aaa'] })]);
    const before = w.writes.length;
    const { json } = await enqueue(w.exec, [ticket('aaa'), ticket('bbb'), ticket('ccc', { title: 'New title', blockedBy: ['bbb'] })]);
    expect(json.items.map((r) => r.action)).toEqual(['unchanged', 'unchanged', 'updated']);
    const patches = w.writes.slice(before).filter((x) => x.id === 13 && x.route === 'wit.workItems.PATCH');
    expect(patches.map((x) => field(x.body, '/fields/System.Title') ?? (field(x.body, '/relations/-') as { url: string } | undefined)?.url)).toEqual(['New title', workItemUrl(12)]);
    expect(linked(w.items[13], 'System.LinkTypes.Dependency-Reverse')).toEqual([11, 12]);
    expect(json.warnings).toContain('#13 (ccc) keeps its predecessor link to #11: enqueue never removes a link; remove it by hand if that edge is gone');
  });

  it('keeps a claimed item and reports an orphan without closing it', async () => {
    const w = boards(root, spec());
    await enqueue(w.exec, [ticket('aaa'), ticket('bbb')]);
    const claimed = boards(root, w.items, { openPr: [11] });
    const before = itemWrites(claimed).length;
    const { json } = await enqueue(claimed.exec, [ticket('aaa', { title: 'Changed' })]);
    expect(json.items.map((r) => [r.key, r.id, r.action, r.reasons[0]])).toEqual([['aaa', 11, 'kept-claimed', 'pr-exists'], ['bbb', 12, 'orphaned', undefined]]);
    expect(itemWrites(claimed).length).toBe(before);
    expect(claimed.items[12].fields['System.State']).toBe('New');
  });

  it('ignores a key held by an untrusted creator or by a child of another spec; adopts a trusted holder whose parent link failed', async () => {
    const description = (key: string) => `<div>x<br><br>shipyard-key: 10/${key}</div>`;
    const items = {
      ...spec(),
      20: item({ 'System.Title': 'Spec 20', 'System.Description': '<div>Other.</div>' }),
      30: item({ 'System.Title': 'Do aaa', 'System.Description': description('aaa'), 'System.CreatedBy': MALLORY }, [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: workItemUrl(10) }]),
      31: item({ 'System.Title': 'Do bbb', 'System.Description': description('bbb') }, [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: workItemUrl(20) }]),
      32: item({ 'System.Title': 'Do ccc', 'System.Description': description('ccc'), 'System.WorkItemType': 'User Story' }),
    };
    const w = boards(root, items);
    const { json } = await enqueue(w.exec, [ticket('aaa'), ticket('bbb'), ticket('ccc')]);
    expect(json.ignored).toEqual([{ id: 30, key: 'aaa', reason: 'author is not trusted' }, { id: 31, key: 'bbb', reason: 'not a child of #10' }]);
    expect(json.items.map((r) => [r.key, r.id, r.action])).toEqual([['aaa', 33, 'created'], ['bbb', 34, 'created'], ['ccc', 32, 'updated']]);
    expect(linked(w.items[32], 'System.LinkTypes.Hierarchy-Reverse')).toEqual([10]);
  });

  it('ignores a key holder from another project', async () => {
    const items = { ...spec(), 30: item({ 'System.Title': 'Do aaa', 'System.TeamProject': 'Other', 'System.Description': '<div>x<br><br>shipyard-key: 10/aaa</div>' }) };
    const w = boards(root, items);
    const { json } = await enqueue(w.exec, [ticket('aaa')]);
    expect(json.ignored).toEqual([{ id: 30, key: 'aaa', reason: 'not in the forge project' }]);
    expect(json.items.map((r) => [r.key, r.action])).toEqual([['aaa', 'created']]);
  });

  it('--dry-run shows the fields, links and mark candidates and writes nothing', async () => {
    const w = boards(root, spec());
    const { code, json } = await enqueue(w.exec, [ticket('aaa', { priority: 3, title: 'ping @bob', acceptance: ['`x` covers #5'] }), ticket('bbb', { blockedBy: ['aaa'] })], { dryRun: true });
    expect(code).toBe(0);
    expect(w.writes).toEqual([]);
    expect(json.items[0].planned).toMatchObject({ title: 'ping ＠bob', acceptance: ['`x` covers ＃5'], priority: 3, addLabels: ['factory'], links: ['parent #10'] });
    expect(json.items[1].planned?.links).toEqual(['parent #10', 'depends-on #aaa']);
    expect(json.spec).toEqual({ id: 10, taskList: 'unchanged' });
    expect(json.items.every((r) => r.markCandidate)).toBe(true);
  });

  it('posts no mention or work item link: title, description and AC carry fullwidth signs and escaped HTML only', async () => {
    const w = boards(root, spec());
    await enqueue(w.exec, [ticket('aaa', { title: 'Fix #12 for @alice', body: 'cc @<d6245f20-2af8-44f4-9451-8107cb2767db> <a data-vss-mention="version:2.0,x">@x</a> !4', acceptance: ['`f()` closes #7'] })]);
    const body = JSON.stringify(w.writes.filter((x) => x.route === 'wit.workItems.POST').map((x) => x.body));
    expect(body).not.toMatch(/[@#!]\d|@[<\w]|<a |data-vss-mention="/);
    expect(field(w.writes[0].body, '/fields/System.Title')).toBe('Fix ＃12 for ＠alice');
  });

  it('warns when a board-column or saved-query source cannot be honoured (enqueue never sets a column or state)', async () => {
    for (const [source, message] of [
      [{ type: 'board-column', team: 'Web Team', board: 'Stories', column: 'Ready' }, /board column Ready: enqueue never sets a column or state/],
      [{ type: 'wiql-query', queryId: '9b9a8c4e-0d5b-4c4e-9a54-0e7a2c3b1f00' }, /saved query: membership is the query's job/],
    ] as const) {
      const w = boards(root, spec());
      const { json } = await enqueue(w.exec, [ticket('aaa')], { source, dryRun: true });
      expect(json.warnings.some((x) => message.test(x))).toBe(true);
      expect(json.items[0].planned?.addLabels).toEqual([]);
    }
  });

  it('refuses an untrusted spec, a spec of another project, and a #n edge of another project before any write', async () => {
    const empty = boards(root, spec());
    await expect(enqueue(empty.exec, [ticket('aaa')], { trusted: [] })).rejects.toThrow(/trustedAuthors is empty in the user config, so no Azure DevOps author is trusted/);
    const mallory = boards(root, { 10: item({ 'System.Title': 'Spec', 'System.CreatedBy': MALLORY }) });
    await expect(enqueue(mallory.exec, [ticket('aaa')])).rejects.toThrow(/spec #10's creator is not in factory.forge.azureDevOps.trustedAuthors/);
    const other = boards(root, { 10: item({ 'System.Title': 'Spec', 'System.TeamProject': 'Other' }) });
    await expect(enqueue(other.exec, [ticket('aaa')])).rejects.toThrow(/spec #10 is not a work item of project Web/);
    const edge = boards(root, { ...spec(), 5: item({ 'System.Title': 'Elsewhere', 'System.TeamProject': 'Other' }) });
    await expect(enqueue(edge.exec, [ticket('aaa', { blockedBy: ['#5'] })])).rejects.toThrow(/blockedBy #5 is not a work item of project Web/);
    for (const w of [empty, mallory, other, edge]) expect(w.writes).toEqual([]);
  });
});
