import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryCommand } from '../../cli/commands/factory.js';
import { recordingExec } from '../../forge/__tests__/recording-exec.js';
import { createForge } from '../../forge/index.js';
import { shipyardKeys } from '../../forge/types.js';
import { ACCEPTANCE, findPlanLink } from '../run/plan-rules.js';
import { acceptanceItems, acceptanceSection } from '../check/rules.js';
import type { FactoryCheckDeps } from '../check/cli.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import {
  enqueueGuardExec, findCycle, neutralizeNotifying, neutralizeTrusted, parseTicketFile, renderTicketBody, runFactoryEnqueue, specBodyWithTickets,
  type EnqueueJson, type Ticket,
} from '../enqueue.js';

const SHA = 'a'.repeat(40);
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

interface Issue { title: string; body: string; state?: string; labels?: string[]; author?: string }

/** A scripted GitHub: issues that gh create/edit change, factory PRs, branches on origin. */
function github(root: string, issues: Record<number, Issue>, o: { prs?: Record<number, number>; merged?: Record<number, number>; branches?: number[]; seen?: (args: string[]) => void } = {}): Exec {
  let next = Math.max(0, ...Object.keys(issues).map(Number)) + 1;
  const flags = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  return (cmd, args) => {
    const a = args.join(' ');
    o.seen?.(args);
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok(o.branches?.includes(Number(/issue-(\d+)$/.exec(args[2])![1])) ? `${SHA}\t${args[2]}\n` : '');
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path '${args[1].slice(41)}' does not exist in '${SHA}'` };
    }
    if (cmd === 'gh') {
      if (args[0] === 'issue' && args[1] === 'view') {
        const n = Number(args[2]);
        const i = issues[n];
        if (!i) return { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue' };
        return ok(JSON.stringify({ title: i.title, body: i.body, state: i.state ?? 'OPEN', url: `https://github.com/o/r/issues/${n}`, author: { login: i.author ?? 'o' }, comments: [], labels: (i.labels ?? []).map((name) => ({ name })) }));
      }
      if (args[0] === 'issue' && args[1] === 'list' && args[2] === '--repo') {
        const phrase = /^"(.*)" in:body$/.exec(args[5])![1];
        return ok(JSON.stringify(Object.entries(issues).filter(([, i]) => i.body.includes(phrase)).map(([n, i]) => ({ number: Number(n), body: i.body }))));
      }
      if (args[0] === 'issue' && args[1] === 'create') {
        const n = next++;
        issues[n] = { title: args[5], body: readFileSync(args[7], 'utf8'), labels: flags(args, '--label') };
        return ok(`Creating issue in o/r\n\nhttps://github.com/o/r/issues/${n}\n`);
      }
      if (args[0] === 'issue' && args[1] === 'edit') {
        const i = issues[Number(args[2])];
        if (args[3] === '--repo') {
          i.title = args[6];
          i.body = readFileSync(args[8], 'utf8');
        }
        const remove = flags(args, '--remove-label');
        i.labels = [...(i.labels ?? []).filter((l) => !remove.includes(l)), ...flags(args, '--add-label')];
        return ok(`https://github.com/o/r/issues/${args[2]}\n`);
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        const n = Number(/issue-(\d+)$/.exec(args[3])![1]);
        if (a.includes('--state merged')) return ok(JSON.stringify(o.merged?.[n] ? [{ number: o.merged[n] }] : []));
        return ok(JSON.stringify(o.prs?.[n] ? [{ number: o.prs[n], state: 'OPEN' }] : []));
      }
      if (args[0] === 'label' && args[1] === 'list') return ok(JSON.stringify([{ name: 'factory-ready' }]));
    }
    throw new Error(`unscripted ${cmd} ${a}`);
  };
}

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

function setTmp(dir: string): void {
  process.env.TMP = dir;
  process.env.TEMP = dir;
  process.env.TMPDIR = dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-enqueue-repo-'));
  scratch = mkdtempSync(join(tmpdir(), 'omg-enqueue-tmp-'));
  setTmp(scratch);
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

function deps(exec: Exec): FactoryCheckDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => undefined,
    projectConfig: () => ({ factory: { intake: { source: { type: 'label', label: 'factory' } } } }),
    createForge,
    isTTY: () => false,
    confirm: async () => { throw new Error('enqueue never prompts'); },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
}

function ticketFile(tickets: unknown[], extra: Record<string, unknown> = {}): string {
  const path = join(root, 'tickets.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, spec: 10, tickets, ...extra }));
  return path;
}

async function enqueue(exec: Exec, tickets: unknown[], o: { dryRun?: boolean } = {}): Promise<{ code: number; json: EnqueueJson }> {
  out = [];
  const code = await runFactoryEnqueue({ spec: '10', file: ticketFile(tickets), json: true, ...o }, deps(exec));
  return { code, json: JSON.parse(out.join('\n')) as EnqueueJson };
}

const writes = (calls: string[]) => calls.filter((c) => /"issue","(?:create|edit|close|delete)"/.test(c));
const spec = (): Record<number, Issue> => ({ 10: { title: 'Spec: token refresh', body: 'The spec.\n' } });

describe('omg factory enqueue: the ticket file', () => {
  const parse = (raw: unknown) => parseTicketFile(raw, 3);
  const file = (tickets: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, spec: 10, tickets, ...extra });

  it('accepts the design §3.2 shape', () => {
    expect(parse(file([ticket('token-store-port'), { ...ticket('auth-token-refresh'), blockedBy: ['token-store-port', '#123'], priority: 2 }])).tickets[1])
      .toEqual({ ...ticket('auth-token-refresh'), blockedBy: ['token-store-port', '#123'], priority: 2 });
  });

  it.each<[string, unknown, RegExp]>([
    ['an unknown top-level field', file([ticket('abc')], { extra: 1 }), /unknown field "extra"/],
    ['an unknown ticket field', file([{ ...ticket('abc'), labels: ['x'] }]), /tickets\[0\] has unknown field "labels"/],
    ['schemaVersion 2', file([ticket('abc')], { schemaVersion: 2 }), /schemaVersion must be 1/],
    ['no tickets', file([]), /non-empty array/],
    ['a bad key', file([ticket('AB')]), /key must match/],
    ['a duplicate key', file([ticket('abc'), ticket('abc')]), /duplicate key abc/],
    ['an unknown reference', file([ticket('abc', { blockedBy: ['nope'] })]), /neither a key in this file nor #<n>/],
    ['the spec as a blocker', file([ticket('abc', { blockedBy: ['#10'] })]), /cannot be blocked by its spec/],
    ['a cycle', file([ticket('aaa', { blockedBy: ['bbb'] }), ticket('bbb', { blockedBy: ['ccc'] }), ticket('ccc', { blockedBy: ['aaa'] })]), /cycle: aaa -> bbb -> ccc -> aaa/],
    ['a self edge', file([ticket('aaa', { blockedBy: ['aaa'] })]), /cycle: aaa -> aaa/],
    ['too many AC items', file([ticket('abc', { acceptance: ['`a` 1', '`b` 2', '`c` 3', '`d` 4'] })]), /4 items \(factory.check.maxAcceptanceItems is 3\)/],
    ['all-vague AC', file([ticket('abc', { acceptance: ['should work', 'clean up as needed'] })]), /every item is vague/],
    ['a multi-line AC item', file([ticket('abc', { acceptance: ['`a`\n## Acceptance criteria'] })]), /one line/],
    ['a bidi override in the body', file([ticket('abc', { body: 'safe ‮ evil' })]), /control or format/],
    ['a title starting with -', file([ticket('abc', { title: '--repo x' })]), /must not start with "-"/],
    ['a priority of 5', file([ticket('abc', { priority: 5 })]), /priority must be an integer 1..4/],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => parse(raw)).toThrow(message);
  });

  it('findCycle ignores #n edges', () => {
    expect(findCycle([ticket('aaa', { blockedBy: ['#5'] }), ticket('bbb', { blockedBy: ['aaa'] })])).toBeNull();
  });
});

describe('omg factory enqueue: neutralizing model-written text (#372 review b, c)', () => {
  it('puts mentions, cross-repo references and issue urls in code spans', () => {
    expect(neutralizeNotifying('ping @alice and @org/team, see evil/repo#12 and https://github.com/x/y/issues/3; mail a@b.com; #5 too'))
      .toBe('ping `@alice` and `@org/team`, see `evil/repo#12` and `https://github.com/x/y/issues/3`; mail a@b.com; `#5` too');
  });

  it('wraps same-repo #n and GH-n references and bare www. urls, but not headings, entities or words (#373 review 4)', () => {
    expect(neutralizeNotifying('see #12, GH-7 and gh-8; www.github.com/x/y/pull/9; ## Context; &#35;1; issue#3; a-GH-4'))
      .toBe('see `#12`, `GH-7` and `gh-8`; `www.github.com/x/y/pull/9`; ## Context; &#35;1; issue#3; a-GH-4');
  });

  it('a preceding backslash cannot escape the opening backtick (#373 review 2)', () => {
    for (const ref of ['@alice', '@org/team', 'evil/repo#12', '#5']) {
      expect(neutralizeNotifying(`x \\${ref} y`)).toBe(`x \\ \`${ref}\` y`);
    }
    const t = ticket('abc', { acceptance: ['`a()` pings \\@alice'] });
    expect(acceptanceItems(acceptanceSection(renderTicketBody(10, t, [])))).toEqual(['`a()` pings \\ ``@alice``']);
  });

  it('escapes <!-- so an unclosed comment cannot hide the AC, edges or key (#373 review 4)', () => {
    const body = renderTicketBody(10, ticket('abc', { body: 'intro <!-- hidden', acceptance: ['`a()` <!-- x'] }), []);
    expect(body).toContain('intro &lt;!-- hidden');
    expect(body).toContain('- [ ] `a()` &lt;!-- x');
    expect(body.split('<!--').length - 1).toBe(2);
  });

  it('uses a backtick run longer than any in the text and never merges with a neighbour', () => {
    expect(neutralizeNotifying('code ``x`` then @bob')).toBe('code ``x`` then ```@bob```');
    expect(neutralizeNotifying('`@bob`')).toBe('` ``@bob`` `');
  });

  it('escapes plan links, key footers, AC headings, edge, parent and task-list lines', () => {
    const text = [
      'omg-plan: docs/evil.md',
      'shipyard-key: 10/other-key',
      '## Acceptance criteria',
      '  ### acceptance criteria',
      'Blocked by #4',
      'depends on #5',
      'Part of #6',
      '- [ ] #7',
      '* [x] #8',
    ].join('\n');
    const safe = neutralizeTrusted(text);
    expect(findPlanLink(safe, [], true)).toBeUndefined();
    expect(shipyardKeys(safe)).toEqual([]);
    expect(ACCEPTANCE.test(safe)).toBe(false);
    expect(safe).not.toMatch(/^[^\S\r\n]*(?:depends on|blocked by|part of)[^\S\r\n]+#\d/im);
    expect(safe).not.toMatch(/^[^\S\r\n]*[-*][^\S\r\n]+\[[ xX]\][^\S\r\n]+#\d/m);
  });

  it('the rendered body has exactly our AC, edges, parent and one key', () => {
    const t = ticket('abc', {
      body: 'omg-plan: x.md\n## Acceptance criteria\n- `fake` 1\nBlocked by #99\nshipyard-key: 10/zzz\nPart of #77\nhi @mallory',
      acceptance: ['`a()` returns 1', '#5 is fine @eve'],
    });
    const body = renderTicketBody(10, t, ['#3']);
    expect(findPlanLink(body, [], true)).toBeUndefined();
    expect(shipyardKeys(body)).toEqual([[10, 'abc']]);
    expect(acceptanceItems(acceptanceSection(body))).toEqual(['`a()` returns 1', '`#5` is fine `@eve`']);
    expect([...body.matchAll(/^blocked by #(\d+)/gim)].map((m) => m[1])).toEqual(['3']);
    expect(/^part of #(\d+)/im.exec(body)?.[1]).toBe('10');
    expect(body).toContain('hi ``@mallory``');
  });
});

describe('omg factory enqueue: spec task list', () => {
  it('appends the section, then rewrites it in place and keeps ticked boxes', () => {
    const first = specBodyWithTickets('Spec.\n', [3, 4]);
    expect(first).toBe('Spec.\n\n<!-- shipyard:tickets -->\n- [ ] #3\n- [ ] #4\n<!-- /shipyard:tickets -->\n');
    const ticked = first.replace('- [ ] #3', '- [x] #3');
    expect(specBodyWithTickets(`${ticked}after\n`, [3, 4, 5])).toBe('Spec.\n\n<!-- shipyard:tickets -->\n- [x] #3\n- [ ] #4\n- [ ] #5\n<!-- /shipyard:tickets -->\nafter\n');
  });

  it('refuses a malformed section', () => {
    expect(() => specBodyWithTickets('<!-- /shipyard:tickets --> <!-- shipyard:tickets -->', [1])).toThrow(/malformed/);
  });
});

describe('omg factory enqueue: the guard', () => {
  const ctx = { repo: 'github.com/o/r', bodyDir: tmpdir(), labels: ['factory'] };
  const inner: Exec = () => ok();

  it('refuses writes outside the write window and everything that is not a read shape', () => {
    const guarded = enqueueGuardExec(inner, () => ctx, () => false);
    expect(() => guarded('gh', ['issue', 'create', '--repo', 'github.com/o/r', '--title', 't', '--body-file', join(tmpdir(), 'b.md')])).toThrow(/refuses/);
    expect(() => guarded('gh', ['issue', 'edit', '5', '--repo', 'github.com/o/r', '--title', 't', '--body-file', join(tmpdir(), 'b.md')])).toThrow(/refuses/);
    expect(() => guarded('gh', ['issue', 'edit', '5', '--add-label', 'factory:done'])).toThrow(/refuses/);
    expect(() => guarded('gh', ['issue', 'close', '5'])).toThrow(/refuses/);
    expect(() => guarded('gh', ['api', 'repos/o/r/issues'])).toThrow(/refuses/);
    expect(() => guarded('gh', ['pr', 'create', '--draft', '--base', 'dev', '--head', 'factory/issue-1', '--title', 't', '--body-file', 'b'])).toThrow(/refuses/);
    expect(() => guarded('node', ['-e', '1'])).toThrow(/omg factory enqueue refuses/);
    expect(guarded('gh', ['issue', 'list', '--repo', 'github.com/o/r', '--search', '"shipyard-key: 10/" in:body', '--state', 'all', '--json', 'number,body', '--limit', '1000']).status).toBe(0);
  });

  it('while writing, still refuses another repository and a label off the allowlist', () => {
    const guarded = enqueueGuardExec(inner, () => ctx, () => true);
    expect(() => guarded('gh', ['issue', 'create', '--repo', 'github.com/evil/r', '--title', 't', '--body-file', join(tmpdir(), 'b.md')])).toThrow(/refuses/);
    expect(() => guarded('gh', ['issue', 'edit', '5', '--repo', 'github.com/o/r', '--title', 't', '--body-file', join(tmpdir(), 'b.md'), '--add-label', 'bug'])).toThrow(/refuses/);
  });
});

describe('omg factory enqueue: the run', () => {
  it('is registered under omg factory and documents the mark step', () => {
    const cmd = factoryCommand().commands.find((c) => c.name() === 'enqueue')!;
    expect(cmd).toBeDefined();
    let help = '';
    cmd.configureOutput({ writeOut: (s) => { help += s; } });
    cmd.outputHelp();
    expect(help).toMatch(/--mark --yes/);
    expect(help).toMatch(/C3 signature/);
  });

  it('creates the children, writes edges in a second pass, lists them on the spec, then marks the runnable ones', async () => {
    const issues = spec();
    const dirs: string[] = [];
    const rec = recordingExec(github(root, issues, { seen: (args) => { if (args[1] === 'create') dirs.push(...readdirSync(scratch)); } }), {}, ['gh']);
    // auth-token-refresh comes first but is blocked by the later token-store-port: its edge needs the second pass.
    const { code, json } = await enqueue(rec.exec, [ticket('auth-token-refresh', { blockedBy: ['token-store-port'], priority: 2 }), ticket('token-store-port', { body: 'cc @alice' })]);
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.items.map((r) => [r.key, r.id, r.action, r.bucket, r.reasons])).toEqual([
      ['auth-token-refresh', 11, 'created', 'blocked', ['depends-on:#12']],
      ['token-store-port', 12, 'created', 'runnable', []],
    ]);
    expect(json.spec).toEqual({ id: 10, taskList: 'updated' });
    expect(json.mark?.marked).toEqual([12]);

    expect(issues[11].labels).toEqual(['factory', 'priority:p1']);
    expect(issues[11].body).toContain('<!-- shipyard:edges -->\nPart of #10\nBlocked by #12\n<!-- /shipyard:edges -->\n\nshipyard-key: 10/auth-token-refresh\n');
    expect(issues[12].body).toContain('cc `@alice`');
    expect(issues[12].labels).toEqual(['factory', 'factory-ready']);
    expect(issues[10].body).toBe('The spec.\n\n<!-- shipyard:tickets -->\n- [ ] #11\n- [ ] #12\n<!-- /shipyard:tickets -->\n');

    const w = writes(rec.calls);
    expect(w).toHaveLength(6);
    expect(w[0]).toMatch(/^gh \["issue","create","--repo","github.com\/o\/r","--title","Do auth-token-refresh","--body-file","[^"]*omg-gh-body-[^"]*","--label","factory","--label","priority:p1"\]/);
    // #373 review 3: the spec's task list is rewritten right after each create.
    expect(w[1]).toMatch(/^gh \["issue","edit","10","--repo","github.com\/o\/r","--title","Spec: token refresh","--body-file","[^"]*"\] /);
    expect(w[2]).toMatch(/"issue","create".*"--title","Do token-store-port"/);
    expect(w[3]).toMatch(/^gh \["issue","edit","10","--repo"/);
    expect(w[4]).toMatch(/^gh \["issue","edit","11","--repo","github.com\/o\/r","--title","Do auth-token-refresh","--body-file","[^"]*"\] /);
    expect(w[5]).toMatch(/^gh \["issue","edit","12","--add-label","factory-ready"\] /);

    // #372 review (a): bodies are written to a fresh omg-enqueue-* directory under the temp dir, removed afterwards.
    expect(dirs.some((d) => d.startsWith('omg-enqueue-'))).toBe(true);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('a re-run is all unchanged and writes nothing', async () => {
    const issues = spec();
    const tickets = [ticket('auth-token-refresh', { blockedBy: ['token-store-port'], priority: 2 }), ticket('token-store-port')];
    await enqueue(github(root, issues), tickets);
    const rec = recordingExec(github(root, issues), {}, ['gh']);
    const { code, json } = await enqueue(rec.exec, tickets);
    expect(code).toBe(0);
    expect(json.items.map((r) => r.action)).toEqual(['unchanged', 'unchanged']);
    expect(json.spec.taskList).toBe('unchanged');
    expect(json.mark?.alreadyMarked).toEqual([12]);
    expect(writes(rec.calls)).toEqual([]);
  });

  it('updates a changed unclaimed item, keeps a claimed one, reports an orphan without closing it', async () => {
    const issues = spec();
    await enqueue(github(root, issues), [ticket('aaa'), ticket('bbb'), ticket('ccc')]);
    // #12 (bbb) has an open factory PR; ccc leaves the file.
    const rec = recordingExec(github(root, issues, { prs: { 12: 40 } }), {}, ['gh']);
    const { code, json } = await enqueue(rec.exec, [ticket('aaa', { title: 'Do aaa better', priority: 1 }), ticket('bbb', { title: 'Do bbb differently' })]);
    expect(code).toBe(0);
    expect(json.items.map((r) => [r.key, r.id, r.action, r.reasons[0] ?? ''])).toEqual([
      ['aaa', 11, 'updated', ''],
      ['bbb', 12, 'kept-claimed', 'pr-exists'],
      ['ccc', 13, 'orphaned', ''],
    ]);
    expect(issues[11].title).toBe('Do aaa better');
    expect(issues[11].labels).toContain('priority:p0');
    expect(issues[12].title).toBe('Do bbb');
    expect(issues[13].state ?? 'OPEN').toBe('OPEN');
    // The orphan stays a child of the spec.
    expect(issues[10].body).toContain('- [ ] #13');
    expect(writes(rec.calls).filter((c) => /"edit","1[23]","--repo"/.test(c))).toEqual([]);
  });

  it('treats a merged factory PR, a run branch and a closed item as claimed', async () => {
    const issues = spec();
    await enqueue(github(root, issues), [ticket('aaa'), ticket('bbb'), ticket('ccc')]);
    issues[13].state = 'CLOSED';
    const changed = [ticket('aaa', { title: 'x aaa' }), ticket('bbb', { title: 'x bbb' }), ticket('ccc', { title: 'x ccc' })];
    const { json } = await enqueue(github(root, issues, { merged: { 11: 41 }, branches: [12] }), changed);
    expect(json.items.map((r) => [r.action, r.reasons[0]])).toEqual([['kept-claimed', 'merged'], ['kept-claimed', 'branch-exists'], ['kept-claimed', 'closed']]);
  });

  it('ignores a key held by an untrusted author or by an issue that is not a child of the spec', async () => {
    const issues: Record<number, Issue> = {
      ...spec(),
      20: { title: 'squatter', body: 'Part of #10\n\nshipyard-key: 10/aaa\n', author: 'stranger' },
      21: { title: 'elsewhere', body: 'Part of #99\n\nshipyard-key: 10/bbb\n' },
    };
    const { code, json } = await enqueue(github(root, issues), [ticket('aaa'), ticket('bbb')]);
    expect(code).toBe(0);
    expect(json.ignored).toEqual([
      { id: 20, key: 'aaa', reason: 'author is not trusted' },
      { id: 21, key: 'bbb', reason: 'not a child of #10' },
    ]);
    expect(json.items.map((r) => [r.key, r.id, r.action])).toEqual([['aaa', 22, 'created'], ['bbb', 23, 'created']]);
    expect(issues[20].body).toBe('Part of #10\n\nshipyard-key: 10/aaa\n');
  });

  it('--dry-run prints the exact writes and writes nothing', async () => {
    const issues = spec();
    const rec = recordingExec(github(root, issues), {}, ['gh']);
    const { code, json } = await enqueue(rec.exec, [ticket('aaa', { blockedBy: ['bbb'] }), ticket('bbb', { priority: 4 })], { dryRun: true });
    expect(code).toBe(0);
    expect(json.dryRun).toBe(true);
    expect(json.mark).toBeNull();
    expect(json.items.map((r) => [r.key, r.id, r.action, r.markCandidate])).toEqual([['aaa', null, 'created', true], ['bbb', null, 'created', true]]);
    expect(json.items[0].planned!.body).toContain('Blocked by #bbb');
    expect(json.items[1].planned!.addLabels).toEqual(['factory', 'priority:p3']);
    expect(json.spec.taskList).toBe('updated');
    expect(writes(rec.calls)).toEqual([]);
    expect(issues[10].body).toBe('The spec.\n');

    out = [];
    expect(await runFactoryEnqueue({ spec: '10', file: ticketFile([ticket('aaa')]), dryRun: true }, deps(github(root, issues)))).toBe(0);
    expect(out.join('\n')).toMatch(/dry run: nothing was written/);
    expect(out.join('\n')).toMatch(/== create aaa: "Do aaa" \[\+factory\]\n## Context/);
    expect(out.join('\n')).toMatch(/== mark step: omg factory check --mark --yes over \(new\) aaa;/);
  });

  it('the dry run lists the exact mark candidates: never an orphan or a claimed item (#373 review 1)', async () => {
    const issues = spec();
    await enqueue(github(root, issues), [ticket('aaa'), ticket('bbb'), ticket('ccc')]);
    const { json } = await enqueue(github(root, issues, { prs: { 12: 40 } }), [ticket('aaa'), ticket('bbb', { title: 'x' }), ticket('ddd')], { dryRun: true });
    expect(json.items.map((r) => [r.key, r.id, r.action, r.markCandidate])).toEqual([
      ['aaa', 11, 'unchanged', true],
      ['bbb', 12, 'kept-claimed', false],
      ['ddd', null, 'created', true],
      ['ccc', 13, 'orphaned', false],
    ]);
  });

  it('marks only this file\'s items: not an outsider listed in the spec body, not an orphan (#373 review 1)', async () => {
    const issues: Record<number, Issue> = {
      10: { title: 'Spec', body: 'The spec.\n- [ ] #20\n' },
      20: { title: 'outsider', body: '## Acceptance criteria\n- [ ] `evil()` returns 1\n', author: 'stranger', labels: ['factory'] },
    };
    await enqueue(github(root, issues), [ticket('aaa'), ticket('ccc')]);
    expect(issues[20].labels).toEqual(['factory']);
    expect(issues[22].labels).toContain('factory-ready');
    // ccc leaves the file and its marker is removed by hand: the orphan is never re-marked.
    issues[22].labels = ['factory'];
    const rec = recordingExec(github(root, issues), {}, ['gh']);
    const { code, json } = await enqueue(rec.exec, [ticket('aaa')]);
    expect(code).toBe(0);
    expect(json.items.map((r) => [r.key, r.id, r.action])).toEqual([['aaa', 21, 'unchanged'], ['ccc', 22, 'orphaned']]);
    expect(issues[22].labels).toEqual(['factory']);
    expect(issues[20].labels).toEqual(['factory']);
    expect(rec.calls.filter((c) => /"--add-label"/.test(c))).toEqual([]);
  });

  it('refuses a spec whose author is not trusted (#373 review 1)', async () => {
    const issues: Record<number, Issue> = { 10: { title: 'Spec', body: 'x\n', author: 'stranger' } };
    const rec = recordingExec(github(root, issues), {}, ['gh']);
    await expect(runFactoryEnqueue({ spec: '10', file: ticketFile([ticket('aaa')]), json: true }, deps(rec.exec))).rejects.toThrow(/author is not an OWNER, MEMBER or COLLABORATOR/);
    expect(writes(rec.calls)).toEqual([]);
  });

  it('refuses a bad file, a closed spec, a mismatched spec and a missing #n before any write', async () => {
    const run = async (issues: Record<number, Issue>, tickets: unknown[], specArg = '10') => {
      const rec = recordingExec(github(root, issues), {}, ['gh']);
      await expect(runFactoryEnqueue({ spec: specArg, file: ticketFile(tickets), json: true }, deps(rec.exec))).rejects.toThrow();
      expect(writes(rec.calls)).toEqual([]);
    };
    await run(spec(), [{ ...ticket('aaa'), extra: true }]);
    await run({ 10: { title: 'Spec', body: '', state: 'CLOSED' } }, [ticket('aaa')]);
    await run(spec(), [ticket('aaa')], '11');
    await run(spec(), [ticket('aaa', { blockedBy: ['#55'] })]);
    await run({}, [ticket('aaa')]);
  });

  it('refuses (#372 review a) when the temporary directory is inside the worktree', async () => {
    const inside = join(root, 'tmp');
    mkdirSync(inside);
    setTmp(inside);
    const issues = spec();
    const rec = recordingExec(github(root, issues), {}, ['gh']);
    await expect(runFactoryEnqueue({ spec: '10', file: ticketFile([ticket('aaa')]), json: true }, deps(rec.exec))).rejects.toThrow(/inside the worktree/);
    expect(writes(rec.calls)).toEqual([]);
    expect(readdirSync(inside)).toEqual([]);
  });

  it('reports a write failure as exit 1 and skips the mark step', async () => {
    const issues = spec();
    const base = github(root, issues);
    const failing: Exec = (cmd, args, opts) => (args[1] === 'create' && issues[11] ? { status: 1, stdout: '', stderr: 'HTTP 502' } : base(cmd, args, opts));
    const { code, json } = await enqueue(failing, [ticket('aaa'), ticket('bbb')]);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.mark).toBeNull();
    expect(json.warnings.join('\n')).toMatch(/re-run enqueue/);
    expect(json.items.map((r) => [r.key, r.id])).toEqual([['aaa', 11], ['bbb', null]]);
    // #373 review 3: #11 is already on the spec, so a re-run that the key search does not answer yet still finds it.
    expect(issues[10].body).toContain('- [ ] #11');
    const lagging: Exec = (cmd, args, opts) => (args[1] === 'list' && args[2] === '--repo' ? ok('[]') : base(cmd, args, opts));
    const again = await enqueue(lagging, [ticket('aaa'), ticket('bbb')]);
    expect(again.code).toBe(0);
    expect(again.json.items.map((r) => [r.key, r.id, r.action])).toEqual([['aaa', 11, 'unchanged'], ['bbb', 12, 'created']]);
    expect(Object.keys(issues)).toEqual(['10', '11', '12']);
  });
});
