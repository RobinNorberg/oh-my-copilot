/**
 * The `--serve` page script (client.ts CLIENT_JS), run exactly as served in
 * a VM with no browser: formatting, the row model, filter/sort/paginate, the
 * run-key guard, the attribute allowlist, and the DOM builders against a
 * minimal fake `document` that has no markup API at all. Plus a lint-style
 * check of the source for every markup or code sink.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CLIENT_JS, dashboardPageHtml } from '../client.js';

type FD = any;

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  appendChild(n: FakeNode): FakeNode {
    if (!(n instanceof FakeNode)) throw new TypeError('appendChild: not a node');
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n: FakeNode): FakeNode {
    this.childNodes = this.childNodes.filter((c) => c !== n);
    n.parentNode = null;
    return n;
  }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = [new FakeText(v)]; }
}
class FakeText extends FakeNode {
  constructor(public data: string) { super(); }
  override get textContent(): string { return this.data; }
}
class FakeEl extends FakeNode {
  attrs = new Map<string, string>();
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  focused = false;
  constructor(public tagName: string, public ns: string | null = null) { super(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(t: string, f: (e?: unknown) => void): void { (this.listeners[t] ??= []).push(f); }
  focus(): void { this.focused = true; }
  click(): void { for (const f of this.listeners.click ?? []) f(); }
  // Any markup sink is a test failure.
  set innerHTML(_v: string) { throw new Error('innerHTML used'); }
  set outerHTML(_v: string) { throw new Error('outerHTML used'); }
  insertAdjacentHTML(): void { throw new Error('insertAdjacentHTML used'); }
}
const doc = {
  createElement: (t: string) => new FakeEl(t),
  createElementNS: (ns: string, t: string) => new FakeEl(t, ns),
  createTextNode: (s: string) => new FakeText(s),
};
const all = (n: FakeNode): FakeEl[] => n.childNodes.flatMap((c) => (c instanceof FakeEl ? [c, ...all(c)] : []));
const texts = (n: FakeNode): string[] => n.childNodes.flatMap((c) => (c instanceof FakeText ? [c.data] : texts(c)));

function load(): FD {
  const ctx: Record<string, unknown> = {};
  runInNewContext(CLIENT_JS, ctx);
  return ctx.FactoryDashboard;
}
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const HOSTILE = '<img src=x onerror=alert(1)>"\'</code><script>';

function run(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key, kind: 'issue', trust: 'ok', verified: true, title: `title ${key}`, phase: 'merge', gate: { name: 'merge', reason: 'r', at: '' }, outcome: 'parked', pr: 7, head: null,
    forge: 'github', credits: 3, premiumRequests: 1, lanes: 1, roles: {}, startedAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:05:00.000Z', elapsedMs: 0,
    engineMs: 60_000, waitingMs: 30_000, waitingSince: null, timeline: [{ phase: 'implement', engineMs: 60_000, waitingMs: 0, gates: [] }, { phase: 'merge', engineMs: 0, waitingMs: 30_000, gates: ['merge'] }],
    mergeReadyAt: null, engineToMergeReadyMs: null, mergeWaitMs: 0, ...extra,
  };
}
const ui = () => ({ filter: '', phase: '', sort: null as { col: string; dir: string } | null, page: 1, open: {} as Record<string, boolean> });
const ctx = (extra: Record<string, unknown> = {}) => ({ ui: ui(), details: {}, on: {}, focus: {}, ages: [], ...extra });

describe('dashboard page script: pure parts', () => {
  const fd = load();

  it('formats durations and ages that tick from generatedAt', () => {
    expect(fd.fmtDur(0)).toBe('0s');
    expect(fd.fmtDur(61_000)).toBe('1m 1s');
    expect(fd.fmtDur(3 * 3_600_000 + 60_000)).toBe('3h 1m');
    expect(fd.fmtDur(50 * 3_600_000)).toBe('2d 2h');
    expect(fd.fmtDur(null)).toBe('');
    expect(fd.ageNow(60_000, 1_000, 31_000)).toBe(90_000);
    expect(fd.ageNow(null, 1, 2)).toBeNull();
    expect(fd.ageNow(5, 10, 5)).toBe(5); // a clock behind generatedAt never goes negative
    expect(fd.relAge('2026-11-20T10:00:00.000Z', Date.parse('2026-11-20T10:02:00.000Z'))).toBe('2m 0s ago');
    expect(fd.relAge('nonsense', 0)).toBe('');
  });

  it('the row model hides an unverified run\'s title and numbers', () => {
    const rows = plain(fd.runRows({ runs: [run('#1'), run('#2', { verified: false, trust: 'seal', title: 'SECRET', credits: 99 })] }));
    expect(rows[0]).toMatchObject({ key: '#1', order: 1, title: 'title #1', status: 'awaiting-human: merge', credits: 3 });
    expect(rows[1]).toMatchObject({ key: '#2', title: '', credits: null, verified: false, timeline: [] });
    expect(rows[1].status).toBe('not verified (seal)');
    expect(rows[1]).toMatchObject({ phase: '', gate: '', pr: null, engineMs: null, waitingMs: null, updatedAt: '' });
  });

  it('filters by text and phase, sorts stably with nulls last, paginates at 200', () => {
    const runs = [run('#3', { phase: 'review', title: 'gamma', credits: 1 }), run('#10', { title: 'alpha', credits: null }), run('#2', { title: 'beta', credits: 5 }), run('heal-0123abcd', { title: 'heal', credits: 2 })];
    const rows = fd.runRows({ runs });
    expect(plain(fd.filterRows(rows, 'ALP', '')).map((r: { key: string }) => r.key)).toEqual(['#10']);
    expect(plain(fd.filterRows(rows, '', 'review')).map((r: { key: string }) => r.key)).toEqual(['#3']);
    expect(plain(fd.filterRows(rows, '#7', '')).length).toBe(4); // PR number
    expect(plain(fd.sortRows(rows, 'key', 'asc')).map((r: { key: string }) => r.key)).toEqual(['#2', '#3', '#10', 'heal-0123abcd']);
    expect(plain(fd.sortRows(rows, 'key', 'desc')).map((r: { key: string }) => r.key)).toEqual(['#10', '#3', '#2', 'heal-0123abcd']);
    expect(plain(fd.sortRows(rows, 'credits', 'asc')).map((r: { key: string }) => r.key)).toEqual(['#3', 'heal-0123abcd', '#2', '#10']);
    expect(plain(fd.sortRows(rows, 'title', 'desc')).map((r: { title: string }) => r.title)).toEqual(['heal', 'gamma', 'beta', 'alpha']);
    expect(plain(fd.sortRows(rows, 'constructor', 'asc')).map((r: { key: string }) => r.key)).toEqual(['#3', '#10', '#2', 'heal-0123abcd']);
    const many = Array.from({ length: 450 }, (_, i) => i);
    expect(plain(fd.paginate(many, 1, 200))).toMatchObject({ page: 1, pages: 3, total: 450 });
    expect(fd.paginate(many, 3, 200).rows.length).toBe(50);
    expect(fd.paginate(many, 99, 200).page).toBe(3);
    expect(fd.paginate([], 0, 200).page).toBe(1);
  });

  it('only a validated run key reaches a fetch URL; untrusted rows offer the status command only', () => {
    expect(fd.apiKey('#12')).toBe('12');
    expect(fd.apiKey('heal-0123abcd')).toBe('heal-0123abcd');
    for (const k of ['#0', '#012', '12', '#1/../x', 'heal-0123ABCD', '../summary', '#1?x', 'javascript:alert(1)']) expect(fd.apiKey(k), k).toBeNull();
    const next = [{ label: 'resume', argv: ['omg', 'factory', 'run', '1'], line: 'omg factory run 1' }, { label: 'status', argv: ['omg', 'factory', 'run', 'status', '1'], line: 'omg factory run status 1' }];
    // An untrusted row: the status command built in the page from the key, whatever the server sent.
    expect(plain(fd.visibleNext({ trust: 'seal', key: '#1', next: [{ label: 'x', argv: ['omg', 'factory', 'run', 'status', '1'], line: 'omg factory run 1 --yes' }] }))).toEqual([{ label: 'read the run state', argv: ['omg', 'factory', 'run', 'status', '1'], line: 'omg factory run status 1', billed: false, inRoot: false }]);
    expect(plain(fd.visibleNext({ trust: 'seal', key: 'heal-0123abcd', next: [] }))[0].line).toBe('omg factory heal status 0123abcd');
    expect(plain(fd.visibleNext({ trust: 'seal', key: '#1 --yes', next }))).toEqual([]);
    expect(plain(fd.visibleNext({ trust: 'ok', next })).length).toBe(2);
    expect(fd.isStatusArgv(['omg', 'factory', 'run', 'status', '1; rm -rf /'])).toBe(false);
    expect(fd.isStatusArgv(['omg', 'factory', 'heal', 'status', '0123abcd'])).toBe(true);
  });

  it('h() refuses every attribute outside the allowlist (handlers, URLs, styles)', () => {
    for (const a of ['onclick', 'onerror', 'href', 'src', 'style', 'srcdoc', 'action', 'formaction', 'xlink:href', 'innerHTML']) {
      expect(() => fd.h(doc, 'a', { [a]: 'x' }), a).toThrow(/attribute not allowed/);
    }
    for (const a of fd.ATTRS) expect(a).not.toMatch(/^on|href|src|style|action/i);
    const el = fd.h(doc, 'p', { 'class': 'x' }, [HOSTILE, 5]);
    expect(el.childNodes.every((c: FakeNode) => c instanceof FakeText)).toBe(true);
    expect(el.textContent).toBe(`${HOSTILE}5`);
  });
});

describe('dashboard page script: DOM builders', () => {
  const fd = load();
  const data = (): Record<string, unknown> => ({
    schemaVersion: 2, generatedAt: '2026-11-20T10:10:00.000Z', forge: { read: false, at: null }, rev: 'r1',
    attention: {
      items: [
        { key: '#1', group: 'merge', gate: 'merge', phase: 'merge', ageMs: 60_000, credits: 3, cap: 20, pr: 7, head: null, title: HOSTILE, why: `why ${HOSTILE}`, trust: 'ok', notes: [HOSTILE], log: '.omg/progress/factory-1.log',
          next: [{ label: HOSTILE, argv: ['git', 'merge'], billed: false, line: 'git -C repo merge --no-ff --no-edit cccc', inRoot: false }, { label: 'rerun', argv: ['omg', 'factory', 'run', '1'], billed: true, line: 'omg factory run 1', inRoot: false }] },
        { key: '#2', group: 'inspect', gate: 'merge', phase: 'merge', ageMs: null, credits: null, cap: null, pr: null, head: null, title: 'SECRET', why: 'SERVER-WHY', trust: 'seal', notes: [],
          next: [{ label: 'read the run state', argv: ['omg', 'factory', 'run', 'status', '2'], billed: false, line: 'omg factory run status 2', inRoot: false }, { label: 'x', argv: ['omg', 'factory', 'run', '2'], line: 'omg factory run 2', billed: true, inRoot: false }] },
      ],
    },
    live: { engines: 0, slots: 0, runs: [], inFlightCredits: 0 },
    runs: [run('#1', { title: HOSTILE }), run('#2', { verified: false, trust: 'seal', title: '' })],
    tasks: [], cost: { caps: { source: 'unresolved', note: 'n', laneMaxCredits: null, maxRunCredits: null }, totals: { credits: 0, premiumRequests: 0, lanes: 0 }, byRole: [], byDay: [], byRun: [], excluded: { runs: 1, missing: 0 } },
    throughput: { byDay: [], engineToMergeReady: { runs: 0, medianMs: null, p90Ms: null }, waitingAtMerge: { runs: 0, medianMs: null } }, bench: [], warnings: [HOSTILE],
  });

  it('attention: hostile text only ever as text nodes; commands only in <code> with a Copy button; untrusted rows: marker, status command, no title', () => {
    const copies: string[] = [];
    const c = ctx({ on: { copy: (t: string) => copies.push(t) } });
    const el = fd.buildAttention(doc, data(), c);
    const els = all(el);
    // No element was made from data: every tag is one the builder chose.
    const allowed = ['div', 'h3', 'span', 'ul', 'li', 'p', 'b', 'code', 'button'];
    for (const e of els) expect(allowed).toContain(e.tagName);
    expect(texts(el).join('')).toContain(HOSTILE);
    expect(texts(el).join('')).not.toContain('SECRET');
    const codes = els.filter((e) => e.tagName === 'code').map((e) => e.textContent);
    // Inspect comes first, then Merge.
    expect(codes).toEqual(['omg factory run status 2', 'git -C repo merge --no-ff --no-edit cccc', 'omg factory run 1', '.omg/progress/factory-1.log']);
    // A label or title never sits inside a <code>.
    expect(codes.join('\n')).not.toContain(HOSTILE);
    const buttons = els.filter((e) => e.tagName === 'button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Copy', 'Copy', 'Copy']);
    buttons[0].click();
    buttons[2].click();
    expect(copies).toEqual(['omg factory run status 2', 'omg factory run 1']);
    // What a Copy button copies is exactly the text shown in its <code>.
    copies.length = 0;
    buttons.forEach((b) => b.click());
    expect(copies).toEqual(codes.slice(0, 3));
    // The untrusted row: its own fixed sentence, not the server's why.
    expect(texts(el).join('')).toContain(fd.UNTRUSTED_WHY.seal);
    expect(texts(el).join('')).not.toContain('SERVER-WHY');
    expect(els.some((e) => e.tagName === 'span' && e.textContent === 'not verified (seal)')).toBe(true);
    // Every attribute set is in the allowlist.
    for (const e of els) for (const k of e.attrs.keys()) expect(fd.ATTRS).toContain(k);
    // Ages tick.
    fd.tickAges(c.ages, Date.parse('2026-11-20T10:10:00.000Z'), Date.parse('2026-11-20T10:11:00.000Z'));
    expect(els.some((e) => e.textContent === 'waiting 2m 0s')).toBe(true);
  });

  it('--all-repos: repositories and their rows as text only; ids validated; the root never in an attribute; "in <root>:" before omg commands', () => {
    const items = (data().attention as { items: unknown[] }).items;
    const list = {
      schemaVersion: 1, allRepos: true, rev: 'x', generatedAt: '2026-11-20T10:10:00.000Z', summary: { repos: 3, skipped: 2, items: 2, engines: 0, byGroup: {} },
      repos: [
        { id: 'aaaaaaaaaaaaaaaa', name: HOSTILE, root: `C:/x/${HOSTILE}`, rootWord: null, forge: 'github', byGroup: { merge: 1, inspect: 1 }, items: 2, engines: 0, runs: 2, lastChange: '2026-11-20T10:05:00.000Z', attention: items },
        { id: 'bbbbbbbbbbbbbbbb', name: 'beta', root: '/r/beta', rootWord: '/r/beta', forge: null, byGroup: {}, items: 0, engines: 1, runs: 0, lastChange: null, attention: [] },
        { id: '../../x', name: 'evil', root: '/evil', rootWord: '/evil', byGroup: {}, items: 0, engines: 0, runs: 0, lastChange: null, attention: [] },
      ],
      warnings: [],
    };
    expect(fd.repoId('aaaaaaaaaaaaaaaa')).toBe('aaaaaaaaaaaaaaaa');
    for (const bad of ['../../x', 'AAAAAAAAAAAAAAAA', 'aaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa/', '']) expect(fd.repoId(bad)).toBeNull();
    const picked: unknown[] = [];
    const c = { ...ctx({ on: { repo: (id: unknown) => picked.push(id) } }), ui: { ...ui(), repo: null } };
    const table = fd.buildRepos(doc, list, c);
    const tels = all(table);
    // The id that is not one the server issues is not shown at all.
    expect(texts(table).join('')).not.toContain('evil');
    expect(texts(table).join('')).toContain(HOSTILE);
    for (const e of tels) for (const [k, v] of e.attrs) {
      expect(fd.ATTRS).toContain(k);
      expect(v).not.toContain('C:/x');
      expect(v).not.toContain('/r/beta');
    }
    const buttons = tels.filter((e) => e.tagName === 'button');
    expect(buttons.map((b) => b.getAttribute('data-k'))).toEqual(['repo:all', 'repo:aaaaaaaaaaaaaaaa', 'repo:bbbbbbbbbbbbbbbb']);
    buttons[2].click();
    buttons[0].click();
    expect(picked).toEqual(['bbbbbbbbbbbbbbbb', null]);
    const att = fd.buildAllAttention(doc, list, c);
    const aels = all(att);
    const t = texts(att).join('');
    expect(t).toContain('Run these in that repository\'s root');
    expect(t).not.toContain('SECRET');
    // Copy keys carry the repository id; nothing from data becomes an element id.
    const keys = aels.filter((e) => e.tagName === 'button').map((b) => b.getAttribute('data-k'));
    expect(keys.every((k) => String(k).startsWith('copy:aaaaaaaaaaaaaaaa:'))).toBe(true);
    expect(aels.some((e) => e.attrs.has('id'))).toBe(false);
    const withWord = fd.buildAllAttention(doc, { ...list, repos: [{ ...list.repos[0], rootWord: '"C:/x y"' }] }, c);
    expect(all(withWord).filter((e) => e.tagName === 'code').map((e) => e.textContent)).toContain('"C:/x y"');
    expect(texts(fd.buildAllAttention(doc, { ...list, repos: [list.repos[1]] }, c)).join('')).toBe('Nothing needs you in any repository.');
  });

  it('runs: sort headers are buttons with aria-sort, an unverified row shows only the marker, detail opens with gate output in a <pre>', () => {
    const toggled: string[] = [];
    const sorted: string[] = [];
    const c = ctx({ on: { toggle: (k: string) => toggled.push(k), sort: (k: string) => sorted.push(k) } });
    c.ui.sort = { col: 'key', dir: 'desc' };
    c.ui.open = { '1': true };
    (c.details as Record<string, unknown>)['1'] = {
      run: run('#1'), lanes: [{ id: 'l1', kind: 'implement', status: 'completed', model: null, credits: 1, premiumRequests: 1, startedAt: null, endedAt: null }],
      history: [{ at: 'a', from: 'intake', to: 'implement', note: HOSTILE }], gateDetail: { label: 'Output of the PR\'s own code (untrusted)', text: `x\n${HOSTILE}` },
    };
    const el = fd.buildRuns(doc, data(), c);
    const els = all(el);
    const ths = els.filter((e) => e.tagName === 'th' && e.getAttribute('scope') === 'col');
    expect(ths.find((t) => t.textContent === 'Run')!.getAttribute('aria-sort')).toBe('descending');
    expect(ths.find((t) => t.textContent === 'Title')!.getAttribute('aria-sort')).toBe('none');
    els.find((e) => e.getAttribute('data-k') === 'sort:title')!.click();
    expect(sorted).toEqual(['title']);
    const rows = els.find((e) => e.tagName === 'tbody')!.childNodes as FakeEl[];
    expect(rows.slice(0, 2).map((r) => (r.childNodes[0] as FakeEl).textContent)).toEqual(['#2', '#1']);
    expect(rows[2].getAttribute('class')).toBe('detailrow');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('not verified (seal');
    const pre = els.filter((e) => e.tagName === 'pre');
    expect(pre).toHaveLength(1);
    expect(pre[0].textContent).toBe(`x\n${HOSTILE}`);
    expect(pre[0].childNodes.every((n) => n instanceof FakeText)).toBe(true);
    expect(els.some((e) => e.tagName === 'p' && e.textContent.includes('PR\'s own code'))).toBe(true);
    const detailBtn = els.find((e) => e.getAttribute('data-k') === 'detail:1')!;
    expect(detailBtn.getAttribute('aria-expanded')).toBe('true');
    detailBtn.click();
    expect(toggled).toEqual(['1']);
    expect(els.filter((e) => e.tagName === 'svg').length).toBeGreaterThan(0);
    for (const e of els) for (const k of e.attrs.keys()) expect(fd.ATTRS).toContain(k);
  });

  it('runs: 450 rows paginate at 200 with Previous/Next', () => {
    const d = data();
    d.runs = Array.from({ length: 450 }, (_, i) => run(`#${i + 1}`));
    const c = ctx();
    c.ui.page = 3;
    const els = all(fd.buildRuns(doc, d, c));
    expect(els.filter((e) => e.tagName === 'tr').length).toBe(1 + 50);
    expect(els.find((e) => e.getAttribute('data-k') === 'page:next')!.getAttribute('disabled')).toBe('');
    expect(els.find((e) => e.getAttribute('data-k') === 'page:prev')!.getAttribute('disabled')).toBeNull();
  });

  it('renderAll fills every section body and records the focusable buttons by a stable key', () => {
    const bodies: Record<string, FakeEl> = {};
    const c = fd.renderAll(doc, data(), ui(), {}, {}, (id: string) => (bodies[id] ??= new FakeEl('div')));
    expect(Object.keys(bodies).sort()).toEqual(['b-attention', 'b-bench', 'b-cost', 'b-live', 'b-runs', 'b-summary', 'b-tasks', 'b-throughput', 'b-warnings']);
    expect(Object.keys(c.focus)).toContain('copy:#1:0');
    expect(Object.keys(c.focus)).toContain('sort:key');
    expect(texts(bodies['b-warnings']).join('')).toBe(HOSTILE);
  });
});

describe('dashboard page script: source lint', () => {
  it('has no markup or code sink, no string handler, no remote URL and nothing that breaks out of its <script>', () => {
    for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /javascript:/i, /\bon[a-z]+\s*=/, /setTimeout\(\s*['"]/, /setInterval\(\s*['"]/,
      /\.src\s*=/, /\.href\s*=/, /location\s*=/, /<\/script/i, /<!--/, /\$\{/, /import\(/, /postMessage/, /window\.open/, /https?:\/\/(?!www\.w3\.org\/2000\/svg')/]) {
      expect(CLIENT_JS, String(bad)).not.toMatch(bad);
    }
    // Computed access to a name built by concatenation (x['inner' + 'HTML']), reflection, and indirect globals.
    for (const bad of [/[\w$)\]]\s*\[\s*['"`][^'"`\]]*['"`]\s*\+/, /\bReflect\s*\./, /\bFunction\s*\(/, /\bglobalThis\s*\[/, /\bwindow\s*\[/, /\bdocument\s*\[/, /\bself\s*\[/, /\bconstructor\b/]) {
      expect(CLIENT_JS, String(bad)).not.toMatch(bad);
    }
    // setAttribute only in h() (the allowlisted builder) and the one constant class setter of the connection badge.
    const sets = CLIENT_JS.split('\n').filter((l) => /setAttribute/.test(l)).map((l) => l.trim());
    expect(sets).toEqual(["el.setAttribute(name, v === true ? '' : String(v));", "el.setAttribute('class', 'conn ' + state);"]);
    const hBody = CLIENT_JS.slice(CLIENT_JS.indexOf('function h(doc'), CLIENT_JS.indexOf('FD.h = h;'));
    expect(hBody).toContain('el.setAttribute(name');
    expect(hBody).toContain("FD.ATTRS.indexOf(name) < 0) throw");
    // Its fetch URLs are fixed strings and the validated run key.
    expect([...CLIENT_JS.matchAll(/fetchJson\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'url')).toEqual([
      "multi ? 'api/v1/repo/' + rid + '/run/' + api : 'api/v1/run/' + api", "'api/v1/repos'", "multi ? 'api/v1/repo/' + rid + '/summary' : 'api/v1/summary'",
    ]);
    // --all-repos: the repository id in a fetch URL is FD.repoId of the selection (16 hex or null), never other text.
    expect([...CLIENT_JS.matchAll(/var rid = ([^;]*);/g)].map((m) => m[1])).toEqual(['FD.repoId(want)', 'FD.repoId(want)']);
    expect([...CLIENT_JS.matchAll(/new EventSource\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["'events'"]);
  });

  it('the page carries no data, only the nonce; a bad nonce is refused', () => {
    const page = dashboardPageHtml('abc123==');
    expect(page.match(/nonce="abc123=="/g)).toHaveLength(2);
    expect(page).not.toMatch(/<script type="application\/json"|style="|<img|<link/);
    expect(() => dashboardPageHtml('"><script>')).toThrow();
    // Landmarks, the live region, the filter controls.
    for (const s of ['<main id="main"', 'aria-live="polite"', '<label for="f-text">', '<label for="f-phase">', '<nav aria-label="Sections">', 'prefers-color-scheme', 'prefers-reduced-motion', 'max-width:700px']) expect(page).toContain(s);
    expect(page.replace(CLIENT_JS, '').match(/aria-live/g)).toHaveLength(1);
  });
});

describe('dashboard page script: #613 review follow-ups', () => {
  const fd = load();

  it('L4: no other markup, parser or navigation sink, and computed writes only into the known maps', () => {
    for (const bad of [/createContextualFragment/, /DOMParser/, /execCommand/, /setHTMLUnsafe/, /location\.assign/, /location\.replace/, /parseHTMLUnsafe/, /srcdoc/]) {
      expect(CLIENT_JS, String(bad)).not.toMatch(bad);
    }
    const targets = [...new Set([...CLIENT_JS.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\[[^\]]+\]\s*=(?!=)/g)].map((m) => m[1]))].sort();
    expect(targets).toEqual(['bad', 'ctx.focus', 'details', 'seen', 'ui.open']);
  });

  it('L1: an attention item or a task whose key the runs list marks untrusted is untrusted, whatever its own trust says', () => {
    const data = {
      runs: [{ key: '#4', verified: false, trust: 'seal' }, { key: '#5', verified: true, trust: 'ok' }],
      attention: { items: [
        { key: '#4', group: 'merge', gate: 'merge', phase: 'merge', ageMs: 1, credits: 1, cap: null, pr: 9, head: null, title: 'LIE', why: 'WHY', trust: 'ok', notes: ['NOTE'],
          next: [{ label: 'rerun', argv: ['omg', 'factory', 'run', '4'], billed: true, line: 'omg factory run 4', inRoot: false }] },
      ] },
      tasks: [{ key: '#4', verified: true, title: 'LIE', outcome: 'parked', phase: 'merge', gate: 'merge', pr: 9, credits: 1, wallMs: 1, tracker: null },
        { key: '#5', verified: true, title: 'fine', outcome: 'parked', phase: 'merge', gate: 'merge', pr: 9, credits: 1, wallMs: 1, tracker: null }],
      forge: { read: false },
    };
    expect(Object.keys(fd.untrustedKeys(data))).toEqual(['#4']);
    const a = fd.buildAttention(doc, data, ctx());
    const t = texts(a).join('');
    for (const s of ['LIE', 'WHY', 'NOTE', 'omg factory run 4']) expect(t).not.toContain(s);
    expect(t).toContain('omg factory run status 4');
    const tasks = texts(fd.buildTasks(doc, data)).join('');
    expect(tasks).not.toContain('LIE');
    expect(tasks).toContain('fine');
  });

  it('L2: a command line with a control, line-separator or bidi character is not shown and cannot be copied', () => {
    for (const ch of ['\u0000', '\u001b', '\n', '\u007f', '\u0085', ' ', ' ', '‎', '‏', '‪', '‮', '⁦', '⁩']) {
      const c = ctx({ on: { copy: () => { throw new Error('copied'); } } });
      const li = fd.commandEl(doc, { label: 'x', argv: ['omg'], billed: false, line: `omg factory run 1${ch}; rm -rf /`, inRoot: false }, 'copy:k', c);
      expect(texts(li).join('')).toBe('command not shown: it holds a control character');
      expect(all(li).some((e) => e.tagName === 'button' || e.tagName === 'code')).toBe(false);
    }
    const ok = fd.commandEl(doc, { label: 'x', argv: ['omg'], billed: false, line: 'omg factory run 1', inRoot: false }, 'copy:k', ctx());
    expect(all(ok).filter((e) => e.tagName === 'code').map((e) => e.textContent)).toEqual(['omg factory run 1']);
  });

  it('M1: bench rows are labelled unsealed; text outside [A-Za-z0-9._ -] reads "(not shown)"; bad numbers read "invalid"', () => {
    const el = fd.buildBench(doc, { bench: [
      { source: 'bench-results', file: 'run<b>.json', mode: 'live‮', model: 'm-1', startedAt: '2026-11-21T01:00:00.000Z', issues: 3, passed: 2, premiumRequests: -1, credits: 1.5, wallMs: 60_000 },
      { source: 'bench-dir', file: 'ok.json', mode: 'fake', model: null, startedAt: 'javascript:x', issues: null, passed: null, premiumRequests: 1, credits: null, wallMs: null, invalid: ['credits', 'passed'] },
    ] });
    const t = texts(el);
    expect(t[0]).toBe('Unsealed files in the repository (anyone who can write the repository can edit them).');
    const all1 = t.join('|');
    expect(all1).toContain('(not shown)');
    expect(all1).not.toContain('run<b>');
    expect(all1).not.toContain('‮');
    expect(all1).not.toContain('javascript:');
    expect(all1).toContain('2026-11-21T01:00:00.000Z');
    expect(all1.split('|').filter((x) => x === 'invalid').length).toBe(3);
  });
});
