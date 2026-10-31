/**
 * `omg factory enqueue`'s Azure DevOps writes (shipyard-factory design §3.3,
 * PR 7b): the create route, the PATCH tracker paths and the two relation
 * types pass the factory guard only with the TrackerWriteContext; the
 * adapter builds the JSON-patch documents and the escaped HTML.
 */

import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertFactoryCommand, FactorySafetyError, type TrackerWriteContext } from '../../../factory/run/exec.js';
import { guardExec, type Exec } from '../../../ship/exec.js';
import type { AdoGuardContext } from '../guard.js';
import { adoHtmlToText } from '../html.js';
import { adoRouteById, validateAdoBody } from '../routes.js';
import { adoListHtml, adoTextHtml } from '../tracker.js';
import { loadAdoFixtures } from './fixtures.js';
import { adoWorld, POSIX_ENTRY, REPO, variant } from './world.js';

const scratch = mkdtempSync(join(tmpdir(), 'omg-ado-tracker-writes-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const file = (content: unknown) => {
  const path = join(scratch, `f${n++}`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
};
/** A control or format character by code point (kept out of the source text). */
const ch = (cp: number) => String.fromCodePoint(cp);

const WRITES: TrackerWriteContext = { repo: 'unused-on-ado', bodyDir: scratch, labels: ['factory', 'ready'], itemTypes: ['User Story', 'Bug'] };
const CTX: AdoGuardContext = { repo: REPO, entry: POSIX_ENTRY };
const ORG = ['--org', 'https://dev.azure.com/contoso', '--detect', 'false', '--output', 'json'];
const MEDIA = ['--media-type', 'application/json-patch+json'];
const invoke = (resource: string, method: string, rp: string[], extra: string[] = []) => [
  'devops', 'invoke', '--area', 'wit', '--resource', resource, '--route-parameters', ...rp, '--http-method', method, '--api-version', '7.1', ...extra, ...ORG,
];
const create = (ops: unknown, type = 'User Story') => invoke('workItems', 'POST', ['project=Web', `type=${type}`], ['--in-file', file(ops), ...MEDIA]);
const patch = (ops: unknown) => invoke('workItems', 'PATCH', ['project=Web', 'id=42'], ['--in-file', file(ops), ...MEDIA]);
const REV = { op: 'test', path: '/rev', value: 7 };
const TITLE = { op: 'add', path: '/fields/System.Title', value: 'Export the report as CSV' };
const link = (rel: string, url = 'https://dev.azure.com/contoso/_apis/wit/workItems/41') => ({ op: 'add', path: '/relations/-', value: { rel, url } });

/** The factory guard: `writes` set = enqueue; null = the engine and check. */
const guard = (args: string[], writes: TrackerWriteContext | null = WRITES) => () => assertFactoryCommand('az', args, [], undefined, CTX, writes ?? undefined);
const refused = (fn: () => void, reason: RegExp) => expect(fn).toThrow(reason);

describe('ADO tracker writes: the route allowlist', () => {
  it('enqueue may create a work item of a configured type and PATCH the tracker fields and links', () => {
    expect(guard(create([TITLE, { op: 'add', path: '/fields/System.Tags', value: 'factory' }, { op: 'add', path: '/fields/System.AreaPath', value: 'Web\\Factory' }]))).not.toThrow();
    expect(guard(create([TITLE], 'Bug'))).not.toThrow();
    expect(guard(patch([REV, TITLE, { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 }]))).not.toThrow();
    expect(guard(patch([REV, link('System.LinkTypes.Dependency-Reverse')]))).not.toThrow();
    expect(guard(patch([REV, link('System.LinkTypes.Hierarchy-Reverse')]))).not.toThrow();
  });

  it('the engine, check and omg ship never get them', () => {
    refused(guard(create([TITLE]), null), /wit\.workItems\.POST is a tracker write \(omg factory enqueue only\)/);
    refused(guard(patch([REV, TITLE]), null), /body\[1\]\.path is not allowed/);
    refused(guard(patch([REV, link('System.LinkTypes.Dependency-Reverse')]), null), /body\[1\]\.path is not allowed/);
    const ship = guardExec((() => ({ status: 0, stdout: '{}', stderr: '' })) as Exec, () => [], () => CTX);
    expect(() => ship('az', create([TITLE]))).toThrow(/not a route omg ship runs/);
    // The engine's own writes are unchanged.
    expect(guard(patch([REV, { op: 'add', path: '/fields/System.Tags', value: 'factory; factory-ready' }]), null)).not.toThrow();
  });

  it('refuses every other work item verb and resource, and another type', () => {
    for (const method of ['DELETE', 'PUT']) refused(guard(invoke('workItems', method, ['project=Web', 'id=42'])), /is not an allowed Azure DevOps route/);
    for (const resource of ['workItemsBatch', 'workItemTypeTemplate', 'attachments', 'workItemsDelete']) refused(guard(invoke(resource, 'POST', ['project=Web'])), /is not an allowed Azure DevOps route/);
    refused(guard(create([TITLE], 'Epic')), /type "Epic" is not a tracker write item type \(User Story, Bug\)/);
    refused(guard(create([TITLE], 'user story')), /is not a tracker write item type/);
    refused(guard(create([TITLE]), { ...WRITES, itemTypes: undefined }), /none configured/);
    refused(guard(invoke('workItems', 'POST', ['project=Web'], ['--in-file', file([TITLE]), ...MEDIA])), /the type route parameter is required/);
    refused(guard(invoke('workItems', 'POST', ['project=Web', 'type=User Story'], ['--in-file', file([TITLE])])), /--media-type must be application\/json-patch\+json/);
    refused(guard(invoke('workItems', 'POST', ['project=Web', 'type=User Story'], ['--query-parameters', 'bypassRules=true', '--in-file', file([TITLE]), ...MEDIA])), /bypassRules is not allowed/);
    refused(guard(invoke('workItems', 'POST', ['project=Other', 'type=User Story'], ['--in-file', file([TITLE]), ...MEDIA])), /project must be the forge project/);
  });

  it('refuses ops that remove, replace, move or copy, and fields outside the list', () => {
    for (const op of ['remove', 'replace', 'move', 'copy']) refused(guard(patch([REV, { ...TITLE, op }])), /op must be one of test, add/);
    refused(guard(create([{ op: 'test', path: '/rev', value: 1 }, TITLE])), /op must be one of add/);
    for (const path of ['/fields/System.AssignedTo', '/fields/System.IterationPath', '/fields/System.History', '/relations/0', '/relations/-/url', '/id']) {
      refused(guard(patch([REV, { op: 'add', path, value: 'x' }])), /path is not allowed/);
    }
    refused(guard(create([TITLE, link('System.LinkTypes.Hierarchy-Reverse')])), /path is not allowed/);
    refused(guard(create([TITLE, { op: 'add', path: '/fields/System.State', value: 'Closed' }])), /path is not allowed/);
    // A state write stays held to the configured progress states, tracker context or not.
    refused(guard(patch([REV, { op: 'add', path: '/fields/System.State', value: 'Closed' }])), /none configured/);
  });

  it('a tracker PATCH starts with test /rev', () => {
    refused(guard(patch([TITLE])), /a tracker write starts with test \/rev/);
    refused(guard(patch([TITLE, REV])), /a tracker write starts with test \/rev/);
  });
});

describe('ADO tracker writes: only the two relation types', () => {
  it('Hierarchy-Reverse (parent) and Dependency-Reverse (predecessor) only, as { rel, url }', () => {
    for (const rel of ['System.LinkTypes.Dependency-Forward', 'System.LinkTypes.Hierarchy-Forward', 'System.LinkTypes.Related', 'Hyperlink', 'AttachedFile', 'ArtifactLink', 'system.linktypes.dependency-reverse']) {
      refused(guard(patch([REV, link(rel)])), /rel must be one of/);
    }
    refused(guard(patch([REV, { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/41', attributes: { comment: 'x' } } }])), /attributes is not allowed/);
    refused(guard(patch([REV, { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Dependency-Reverse' } }])), /url is required/);
  });

  it('the url names a work item of the forge org, nothing else', () => {
    refused(guard(patch([REV, link('System.LinkTypes.Dependency-Reverse', 'https://dev.azure.com/fabrikam/_apis/wit/workItems/41')])), /url is not a work item of the forge org/);
    for (const url of ['https://evil.example/_apis/wit/workItems/41', 'https://dev.azure.com/contoso/_apis/wit/workItems/0', 'https://dev.azure.com/contoso/_apis/wit/workItems/41?x=1', 'https://dev.azure.com/contoso/_apis/git/repositories/41', 'http://dev.azure.com/contoso/_apis/wit/workItems/41']) {
      refused(guard(patch([REV, link('System.LinkTypes.Dependency-Reverse', url)])), /url has a refused value/);
    }
    // Org names compare case-insensitively, as the guard's --org does.
    expect(guard(patch([REV, link('System.LinkTypes.Dependency-Reverse', 'https://dev.azure.com/Contoso/_apis/wit/workItems/41')]))).not.toThrow();
  });
});

describe('ADO tracker writes: the text rule', () => {
  const field = (path: string, value: unknown) => create([TITLE, { op: 'add', path, value }]);
  const DESC = '/fields/System.Description';
  const AC = '/fields/Microsoft.VSTS.Common.AcceptanceCriteria';

  it('titles: one line of visible text, no leading -, at most 255 characters', () => {
    for (const bad of [`evil${ch(0x1b)}[31m`, `a${ch(0)}b`, `line\nbreak`, `tab\there`, `${ch(0x202e)}gnp.exe`, `zero${ch(0x200b)}width`, '-x', 'x'.repeat(256), '']) {
      refused(guard(create([{ ...TITLE, value: bad }])), /body\[0\]\.value (has a refused value|is longer than 255|must be a non-empty)/);
    }
    expect(guard(create([{ ...TITLE, value: 'Export – the “report” as CSV 🚀' }]))).not.toThrow();
  });

  it('description and AC: only the HTML the adapter builds (escaped text, div, br, ul, li, five entities)', () => {
    expect(guard(field(DESC, adoTextHtml('a < b & "c" \'d\'\n\n\tindented')))).not.toThrow();
    expect(guard(field(AC, adoListHtml(['`GET /report.csv` returns 200', '<script>alert(1)</script>'])))).not.toThrow();
    for (const bad of [
      '<a href="https://evil.example">x</a>', '<img src=x>', '<div onclick="x">a</div>', '<script>alert(1)</script>', '<DIV>x</DIV>', '<br/>', '&nbsp;', '&#x41;', 'a & b', 'a > b',
      `bidi ${ch(0x202e)}x`, `isolate ${ch(0x2066)}x`, `mark ${ch(0x200f)}x`, `nul ${ch(0)}`, `esc ${ch(0x1b)}`, 'raw\nnewline', `c1 ${ch(0x85)}`,
    ]) {
      refused(guard(field(DESC, bad)), /has a refused value/);
      refused(guard(field(AC, bad)), /has a refused value/);
    }
    refused(guard(field(DESC, 'x'.repeat(262_145))), /longer than 262144/);
  });

  it('tags: allowlisted on a new item; never factory:/harbor:, a leading -, a comma or a control character', () => {
    refused(guard(field('/fields/System.Tags', 'factory; other')), /tag "other" is not on the tracker write allowlist/);
    const all = { ...WRITES, labels: ['factory:building', 'harbor:accepted', '-x', 'a,b', `t${ch(0x1b)}`] };
    for (const tag of all.labels) refused(guard(field('/fields/System.Tags', tag), all), /refused (tag|value)/);
    refused(guard(field('/fields/System.Tags', 'Factory: Done'.toLowerCase())), /refused tag/);
    // An update keeps the item's other tags, but the tag rule still holds.
    expect(guard(patch([REV, { op: 'add', path: '/fields/System.Tags', value: 'factory; reports; ready' }]))).not.toThrow();
    refused(guard(patch([REV, { op: 'add', path: '/fields/System.Tags', value: 'factory; harbor:accepted' }])), /refused tag "harbor:accepted"/);
    refused(guard(patch([REV, { op: 'add', path: '/fields/System.Tags', value: 'factory; ; x' }])), /refused tag ""/);
  });

  it('area path: the forge project or under it; priority 1 to 4', () => {
    expect(guard(field('/fields/System.AreaPath', 'web\\Factory\\CSV'))).not.toThrow();
    for (const bad of ['Other\\Factory', 'Web\\', 'Web\\\\x', 'Webby']) refused(guard(field('/fields/System.AreaPath', bad)), /area/);
    for (const bad of ['Web/Factory', '@Web', `Web\\a${ch(0x1b)}`]) refused(guard(field('/fields/System.AreaPath', bad)), /has a refused value/);
    for (const bad of [0, 5, '2', 2.5]) refused(guard(field('/fields/Microsoft.VSTS.Common.Priority', bad)), /Priority|must be one of/);
  });

  it('validateAdoBody alone: the create route and tracker paths need the tracker context', () => {
    expect(validateAdoBody(adoRouteById('wit.workItems.POST'), [TITLE])).toMatch(/is a tracker write/);
    expect(validateAdoBody(adoRouteById('wit.workItems.PATCH'), [REV, TITLE])).toMatch(/path is not allowed/);
    expect(validateAdoBody(adoRouteById('wit.workItems.PATCH'), [REV, TITLE], { trackerWrites: WRITES })).toBeUndefined();
    // A relation needs the org to compare with.
    expect(validateAdoBody(adoRouteById('wit.workItems.PATCH'), [REV, link('System.LinkTypes.Dependency-Reverse')], { trackerWrites: WRITES })).toMatch(/not a work item of the forge org/);
  });
});

describe('ADO tracker writes: guard refusals mirroring the GitHub ones (#372)', () => {
  it('--in-file with `:` past the drive letter (an NTFS alternate data stream) is refused on every route', () => {
    const ads = `${file([REV, TITLE])}:s`;
    refused(guard(invoke('workItems', 'PATCH', ['project=Web', 'id=42'], ['--in-file', ads, ...MEDIA])), /must not contain `:`/);
    refused(guard(invoke('workItems', 'POST', ['project=Web', 'type=User Story'], ['--in-file', ads, ...MEDIA])), /must not contain `:`/);
  });

  it('a leading @ in the type (az reads @<path> as that file) and a refused type name', () => {
    refused(guard(create([TITLE], '@C:\\secrets.txt')), /type has a refused value|not a tracker write item type/);
    refused(guard(create([TITLE], 'User/Story')), /type has a refused value|not a tracker write item type/);
  });
});

describe('ADO adapter: enqueue writes over the fixtures', () => {
  const body = (text: string) => file(text);
  const source = { type: 'area-tag' as const, areaPath: 'Web\\Factory', tag: 'factory' };

  it('createItem: one POST of the first intake type; escaped description and AC, priority, tags, area path', () => {
    const { forge, calls, routes } = adoWorld({ writes: WRITES, source });
    const text = '## Context\nUsers <b>want</b> CSV & "more".\n\nshipyard-key: 30/csv-export';
    const id = forge.tracker.createItem!({ title: 'Export the report as CSV', bodyFile: body(text), labels: ['factory'], acceptance: ['`GET /report.csv` returns 200', 'a < b'], priority: 2 });
    expect(id).toBe(50);
    expect(routes()).toEqual(['wit.workItems.POST']);
    const args = calls[0].args;
    expect(args[args.indexOf('--route-parameters') + 1]).toBe('project=Web');
    expect(args[args.indexOf('--route-parameters') + 2]).toBe('type=User Story');
    expect(calls[0].body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Export the report as CSV' },
      { op: 'add', path: '/fields/System.Description', value: '<div>## Context<br>Users &lt;b&gt;want&lt;/b&gt; CSV &amp; &quot;more&quot;.<br><br>shipyard-key: 30/csv-export</div>' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: '<ul><li>`GET /report.csv` returns 200</li><li>a &lt; b</li></ul>' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 },
      { op: 'add', path: '/fields/System.Tags', value: 'factory' },
      { op: 'add', path: '/fields/System.AreaPath', value: 'Web\\Factory' },
    ]);
    // What viewItem reads back is the text that was written.
    const desc = (calls[0].body as Array<{ value: unknown }>)[1].value;
    expect(adoHtmlToText(desc)).toBe('## Context\nUsers <b>want</b> CSV & "more".\n\nshipyard-key: 30/csv-export');
    expect(adoHtmlToText(adoListHtml(['one', 'a < b']))).toBe('- one\n- a < b');
  });

  it('createItem without the tracker write context is refused by the guard; no type configured throws before any call', () => {
    const { forge, calls } = adoWorld({ source });
    expect(() => forge.tracker.createItem!({ title: 'x', bodyFile: body('x'), labels: [] })).toThrow(FactorySafetyError);
    expect(calls).toEqual([]);
  });

  it('createItem: a refused title or AC item never reaches az', () => {
    const { forge, calls } = adoWorld({ writes: WRITES });
    expect(() => forge.tracker.createItem!({ title: `x${ch(0x202e)}`, bodyFile: body('x'), labels: [] })).toThrow(/body\[0\]\.value has a refused value/);
    expect(() => forge.tracker.createItem!({ title: 'x', bodyFile: body('x'), labels: [], acceptance: [`a${ch(0)}`] })).toThrow(/has a refused value/);
    expect(() => forge.tracker.createItem!({ title: 'x', bodyFile: body('x'), labels: ['harbor:accepted'] })).toThrow(/refused tag/);
    expect(calls).toEqual([]);
  });

  it('the body file is read like a gh tracker write: one link, no hardlink', () => {
    const { forge, calls } = adoWorld({ writes: WRITES });
    const original = body('secret');
    const hard = join(scratch, `hard${n++}`);
    linkSync(original, hard);
    expect(() => forge.tracker.createItem!({ title: 'x', bodyFile: hard, labels: [] })).toThrow(/one link/);
    expect(() => forge.tracker.createItem!({ title: 'x', bodyFile: join(scratch, 'missing'), labels: [] })).toThrow(/cannot read --body-file/);
    expect(calls).toEqual([]);
  });

  it('updateItem: test /rev, the fields, and the tag edit in one PATCH', () => {
    const { forge, calls, routes } = adoWorld({ writes: WRITES });
    forge.tracker.updateItem!(42, { title: 'New title', bodyFile: body('Body'), addLabels: ['ready', 'Factory'], removeLabels: ['reports'], acceptance: ['one'], priority: 1 });
    expect(routes()).toEqual(['wit.workItems.GET', 'wit.workItems.PATCH']);
    expect(calls[1].body).toEqual([
      { op: 'test', path: '/rev', value: 7 },
      { op: 'add', path: '/fields/System.Title', value: 'New title' },
      { op: 'add', path: '/fields/System.Description', value: '<div>Body</div>' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: '<ul><li>one</li></ul>' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 1 },
      { op: 'add', path: '/fields/System.Tags', value: 'factory; ready' },
    ]);
  });

  it('updateItem: no tag op when the tags do not change; removing the last tag is refused', () => {
    const { forge, calls } = adoWorld({ writes: WRITES });
    forge.tracker.updateItem!(42, { title: 'T', bodyFile: body('B'), addLabels: ['factory'], removeLabels: [] });
    expect((calls[1].body as Array<{ path: string }>).map((o) => o.path)).toEqual(['/rev', '/fields/System.Title', '/fields/System.Description']);
    expect(() => forge.tracker.updateItem!(42, { title: 'T', bodyFile: body('B'), addLabels: [], removeLabels: ['factory', 'reports'] })).toThrow(/last tag/);
  });

  it('addRelation: Dependency-Reverse / Hierarchy-Reverse to an org work item url; no write when linked', () => {
    const { forge, calls, routes } = adoWorld({ writes: WRITES });
    forge.tracker.addRelation!(42, 'depends-on', 41);
    expect(routes()).toEqual(['wit.workItems.GET', 'wit.workItems.PATCH']);
    expect(calls[1].body).toEqual([
      { op: 'test', path: '/rev', value: 7 },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/41' } },
    ]);
    // Already linked (fixture: predecessor 40, parent 30): read only.
    forge.tracker.addRelation!(42, 'depends-on', 40);
    forge.tracker.addRelation!(42, 'parent', 30);
    expect(routes()).toEqual(['wit.workItems.GET', 'wit.workItems.PATCH', 'wit.workItems.GET', 'wit.workItems.GET']);
  });

  it('addRelation: one parent, no self link, no other kind', () => {
    const { forge, routes } = adoWorld({ writes: WRITES });
    expect(() => forge.tracker.addRelation!(42, 'parent', 31)).toThrow(/already has parent 30/);
    expect(() => forge.tracker.addRelation!(42, 'depends-on', 42)).toThrow(/cannot link to 42/);
    expect(() => forge.tracker.addRelation!(42, 'depends-on', 0)).toThrow(/cannot link/);
    expect(() => forge.tracker.addRelation!(42, 'related' as never, 41)).toThrow(/relation "related" is not a tracker write/);
    expect(() => forge.tracker.addRelation!(42, 'constructor' as never, 41)).toThrow(/is not a tracker write/);
    expect(routes()).toEqual(['wit.workItems.GET']);
  });

  it('addRelation without the tracker write context is refused by the guard', () => {
    const { forge } = adoWorld();
    expect(() => forge.tracker.addRelation!(42, 'depends-on', 41)).toThrow(/body\[1\]\.path is not allowed/);
  });

  it('findByKey: the WIQL CONTAINS search, then exactly one footer line read from the item', () => {
    const footer = (desc: string) => variant(loadAdoFixtures(), 'wit.workItems.GET.42.json', (s) => ({ ...s, fields: { ...s.fields, 'System.Description': desc } }));
    const { forge, calls } = adoWorld({ fixtures: footer('<div>Users want CSV.<br><br>shipyard-key: 30/csv-export</div>') });
    const found = forge.tracker.findByKey!(30);
    expect(found.map((f) => [f.key, f.item.id, f.item.parent, f.item.authorTrusted])).toEqual([['csv-export', 42, 30, true]]);
    expect(calls[0].body).toEqual({ query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Description] CONTAINS 'shipyard-key: 30/' ORDER BY [System.Id] ASC" });
    // Another spec's key, two keys for this spec, or none: skipped.
    expect(adoWorld({ fixtures: footer('<div>shipyard-key: 31/csv-export</div>') }).forge.tracker.findByKey!(30)).toEqual([]);
    expect(adoWorld({ fixtures: footer('<div>shipyard-key: 30/a-key<br>shipyard-key: 30/b-key</div>') }).forge.tracker.findByKey!(30)).toEqual([]);
    expect(adoWorld().forge.tracker.findByKey!(30)).toEqual([]);
    expect(() => adoWorld().forge.tracker.findByKey!(0)).toThrow(/refused spec id/);
  });
});
