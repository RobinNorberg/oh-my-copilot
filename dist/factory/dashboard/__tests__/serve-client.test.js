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
class FakeNode {
    childNodes = [];
    parentNode = null;
    appendChild(n) {
        if (!(n instanceof FakeNode))
            throw new TypeError('appendChild: not a node');
        n.parentNode = this;
        this.childNodes.push(n);
        return n;
    }
    removeChild(n) {
        this.childNodes = this.childNodes.filter((c) => c !== n);
        n.parentNode = null;
        return n;
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.childNodes = [new FakeText(v)]; }
}
class FakeText extends FakeNode {
    data;
    constructor(data) {
        super();
        this.data = data;
    }
    get textContent() { return this.data; }
}
class FakeEl extends FakeNode {
    tagName;
    ns;
    attrs = new Map();
    listeners = {};
    focused = false;
    constructor(tagName, ns = null) {
        super();
        this.tagName = tagName;
        this.ns = ns;
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    focus() { this.focused = true; }
    click() { for (const f of this.listeners.click ?? [])
        f(); }
    // Any markup sink is a test failure.
    set innerHTML(_v) { throw new Error('innerHTML used'); }
    set outerHTML(_v) { throw new Error('outerHTML used'); }
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); }
}
const doc = {
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => new FakeEl(t, ns),
    createTextNode: (s) => new FakeText(s),
};
const all = (n) => n.childNodes.flatMap((c) => (c instanceof FakeEl ? [c, ...all(c)] : []));
const texts = (n) => n.childNodes.flatMap((c) => (c instanceof FakeText ? [c.data] : texts(c)));
function load() {
    const ctx = {};
    runInNewContext(CLIENT_JS, ctx);
    return ctx.FactoryDashboard;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const HOSTILE = '<img src=x onerror=alert(1)>"\'</code><script>';
function run(key, extra = {}) {
    return {
        key, kind: 'issue', trust: 'ok', verified: true, title: `title ${key}`, phase: 'merge', gate: { name: 'merge', reason: 'r', at: '' }, outcome: 'parked', pr: 7, head: null,
        forge: 'github', credits: 3, premiumRequests: 1, lanes: 1, roles: {}, startedAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:05:00.000Z', elapsedMs: 0,
        engineMs: 60_000, waitingMs: 30_000, waitingSince: null, timeline: [{ phase: 'implement', engineMs: 60_000, waitingMs: 0, gates: [] }, { phase: 'merge', engineMs: 0, waitingMs: 30_000, gates: ['merge'] }],
        mergeReadyAt: null, engineToMergeReadyMs: null, mergeWaitMs: 0, ...extra,
    };
}
const ui = () => ({ filter: '', phase: '', sort: null, page: 1, open: {} });
const ctx = (extra = {}) => ({ ui: ui(), details: {}, on: {}, focus: {}, ages: [], ...extra });
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
        expect(rows[1].status).toBe('not verified (seal) merge awaiting-human: merge');
    });
    it('filters by text and phase, sorts stably with nulls last, paginates at 200', () => {
        const runs = [run('#3', { phase: 'review', title: 'gamma', credits: 1 }), run('#10', { title: 'alpha', credits: null }), run('#2', { title: 'beta', credits: 5 }), run('heal-0123abcd', { title: 'heal', credits: 2 })];
        const rows = fd.runRows({ runs });
        expect(plain(fd.filterRows(rows, 'ALP', '')).map((r) => r.key)).toEqual(['#10']);
        expect(plain(fd.filterRows(rows, '', 'review')).map((r) => r.key)).toEqual(['#3']);
        expect(plain(fd.filterRows(rows, '#7', '')).length).toBe(4); // PR number
        expect(plain(fd.sortRows(rows, 'key', 'asc')).map((r) => r.key)).toEqual(['#2', '#3', '#10', 'heal-0123abcd']);
        expect(plain(fd.sortRows(rows, 'key', 'desc')).map((r) => r.key)).toEqual(['#10', '#3', '#2', 'heal-0123abcd']);
        expect(plain(fd.sortRows(rows, 'credits', 'asc')).map((r) => r.key)).toEqual(['#3', 'heal-0123abcd', '#2', '#10']);
        expect(plain(fd.sortRows(rows, 'title', 'desc')).map((r) => r.title)).toEqual(['heal', 'gamma', 'beta', 'alpha']);
        expect(plain(fd.sortRows(rows, 'constructor', 'asc')).map((r) => r.key)).toEqual(['#3', '#10', '#2', 'heal-0123abcd']);
        const many = Array.from({ length: 450 }, (_, i) => i);
        expect(plain(fd.paginate(many, 1, 200))).toMatchObject({ page: 1, pages: 3, total: 450 });
        expect(fd.paginate(many, 3, 200).rows.length).toBe(50);
        expect(fd.paginate(many, 99, 200).page).toBe(3);
        expect(fd.paginate([], 0, 200).page).toBe(1);
    });
    it('only a validated run key reaches a fetch URL; untrusted rows offer the status command only', () => {
        expect(fd.apiKey('#12')).toBe('12');
        expect(fd.apiKey('heal-0123abcd')).toBe('heal-0123abcd');
        for (const k of ['#0', '#012', '12', '#1/../x', 'heal-0123ABCD', '../summary', '#1?x', 'javascript:alert(1)'])
            expect(fd.apiKey(k), k).toBeNull();
        const next = [{ label: 'resume', argv: ['omg', 'factory', 'run', '1'], line: 'omg factory run 1' }, { label: 'status', argv: ['omg', 'factory', 'run', 'status', '1'], line: 'omg factory run status 1' }];
        expect(plain(fd.visibleNext({ trust: 'seal', next })).map((n) => n.label)).toEqual(['status']);
        expect(plain(fd.visibleNext({ trust: 'ok', next })).length).toBe(2);
        expect(fd.isStatusArgv(['omg', 'factory', 'run', 'status', '1; rm -rf /'])).toBe(false);
        expect(fd.isStatusArgv(['omg', 'factory', 'heal', 'status', '0123abcd'])).toBe(true);
    });
    it('h() refuses every attribute outside the allowlist (handlers, URLs, styles)', () => {
        for (const a of ['onclick', 'onerror', 'href', 'src', 'style', 'srcdoc', 'action', 'formaction', 'xlink:href', 'innerHTML']) {
            expect(() => fd.h(doc, 'a', { [a]: 'x' }), a).toThrow(/attribute not allowed/);
        }
        for (const a of fd.ATTRS)
            expect(a).not.toMatch(/^on|href|src|style|action/i);
        const el = fd.h(doc, 'p', { 'class': 'x' }, [HOSTILE, 5]);
        expect(el.childNodes.every((c) => c instanceof FakeText)).toBe(true);
        expect(el.textContent).toBe(`${HOSTILE}5`);
    });
});
describe('dashboard page script: DOM builders', () => {
    const fd = load();
    const data = () => ({
        schemaVersion: 2, generatedAt: '2026-11-20T10:10:00.000Z', forge: { read: false, at: null }, rev: 'r1',
        attention: {
            items: [
                { key: '#1', group: 'merge', gate: 'merge', phase: 'merge', ageMs: 60_000, credits: 3, cap: 20, pr: 7, head: null, title: HOSTILE, why: `why ${HOSTILE}`, trust: 'ok', notes: [HOSTILE], log: '.omg/progress/factory-1.log',
                    next: [{ label: HOSTILE, argv: ['git', 'merge'], billed: false, line: 'git -C repo merge --no-ff --no-edit cccc', inRoot: false }, { label: 'rerun', argv: ['omg', 'factory', 'run', '1'], billed: true, line: 'omg factory run 1', inRoot: false }] },
                { key: '#2', group: 'inspect', gate: 'merge', phase: 'merge', ageMs: null, credits: null, cap: null, pr: null, head: null, title: 'SECRET', why: 'state is not the engine\'s last write', trust: 'seal', notes: [],
                    next: [{ label: 'read the run state', argv: ['omg', 'factory', 'run', 'status', '2'], billed: false, line: 'omg factory run status 2', inRoot: false }, { label: 'x', argv: ['omg', 'factory', 'run', '2'], line: 'omg factory run 2', billed: true, inRoot: false }] },
            ],
        },
        live: { engines: 0, slots: 0, runs: [], inFlightCredits: 0 },
        runs: [run('#1', { title: HOSTILE }), run('#2', { verified: false, trust: 'seal', title: '' })],
        tasks: [], cost: { caps: { source: 'unresolved', note: 'n', laneMaxCredits: null, maxRunCredits: null }, totals: { credits: 0, premiumRequests: 0, lanes: 0 }, byRole: [], byDay: [], byRun: [], excluded: { runs: 1, credits: 0, premiumRequests: 0 } },
        throughput: { byDay: [], engineToMergeReady: { runs: 0, medianMs: null, p90Ms: null }, waitingAtMerge: { runs: 0, medianMs: null } }, bench: [], warnings: [HOSTILE],
    });
    it('attention: hostile text only ever as text nodes; commands only in <code> with a Copy button; untrusted rows: marker, status command, no title', () => {
        const copies = [];
        const c = ctx({ on: { copy: (t) => copies.push(t) } });
        const el = fd.buildAttention(doc, data(), c);
        const els = all(el);
        // No element was made from data: every tag is one the builder chose.
        const allowed = ['div', 'h3', 'span', 'ul', 'li', 'p', 'b', 'code', 'button'];
        for (const e of els)
            expect(allowed).toContain(e.tagName);
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
        expect(els.some((e) => e.tagName === 'span' && e.textContent === 'not verified (seal)')).toBe(true);
        // Every attribute set is in the allowlist.
        for (const e of els)
            for (const k of e.attrs.keys())
                expect(fd.ATTRS).toContain(k);
        // Ages tick.
        fd.tickAges(c.ages, Date.parse('2026-11-20T10:10:00.000Z'), Date.parse('2026-11-20T10:11:00.000Z'));
        expect(els.some((e) => e.textContent === 'waiting 2m 0s')).toBe(true);
    });
    it('runs: sort headers are buttons with aria-sort, an unverified row shows only the marker, detail opens with gate output in a <pre>', () => {
        const toggled = [];
        const sorted = [];
        const c = ctx({ on: { toggle: (k) => toggled.push(k), sort: (k) => sorted.push(k) } });
        c.ui.sort = { col: 'key', dir: 'desc' };
        c.ui.open = { '1': true };
        c.details['1'] = {
            run: run('#1'), lanes: [{ id: 'l1', kind: 'implement', status: 'completed', model: null, credits: 1, premiumRequests: 1, startedAt: null, endedAt: null }],
            history: [{ at: 'a', from: 'intake', to: 'implement', note: HOSTILE }], gateDetail: { label: 'Output of the PR\'s own code (untrusted)', text: `x\n${HOSTILE}` },
        };
        const el = fd.buildRuns(doc, data(), c);
        const els = all(el);
        const ths = els.filter((e) => e.tagName === 'th' && e.getAttribute('scope') === 'col');
        expect(ths.find((t) => t.textContent === 'Run').getAttribute('aria-sort')).toBe('descending');
        expect(ths.find((t) => t.textContent === 'Title').getAttribute('aria-sort')).toBe('none');
        els.find((e) => e.getAttribute('data-k') === 'sort:title').click();
        expect(sorted).toEqual(['title']);
        const rows = els.find((e) => e.tagName === 'tbody').childNodes;
        expect(rows.slice(0, 2).map((r) => r.childNodes[0].textContent)).toEqual(['#2', '#1']);
        expect(rows[2].getAttribute('class')).toBe('detailrow');
        expect(rows).toHaveLength(3);
        expect(rows[0].textContent).toContain('not verified (seal');
        const pre = els.filter((e) => e.tagName === 'pre');
        expect(pre).toHaveLength(1);
        expect(pre[0].textContent).toBe(`x\n${HOSTILE}`);
        expect(pre[0].childNodes.every((n) => n instanceof FakeText)).toBe(true);
        expect(els.some((e) => e.tagName === 'p' && e.textContent.includes('PR\'s own code'))).toBe(true);
        const detailBtn = els.find((e) => e.getAttribute('data-k') === 'detail:1');
        expect(detailBtn.getAttribute('aria-expanded')).toBe('true');
        detailBtn.click();
        expect(toggled).toEqual(['1']);
        expect(els.filter((e) => e.tagName === 'svg').length).toBeGreaterThan(0);
        for (const e of els)
            for (const k of e.attrs.keys())
                expect(fd.ATTRS).toContain(k);
    });
    it('runs: 450 rows paginate at 200 with Previous/Next', () => {
        const d = data();
        d.runs = Array.from({ length: 450 }, (_, i) => run(`#${i + 1}`));
        const c = ctx();
        c.ui.page = 3;
        const els = all(fd.buildRuns(doc, d, c));
        expect(els.filter((e) => e.tagName === 'tr').length).toBe(1 + 50);
        expect(els.find((e) => e.getAttribute('data-k') === 'page:next').getAttribute('disabled')).toBe('');
        expect(els.find((e) => e.getAttribute('data-k') === 'page:prev').getAttribute('disabled')).toBeNull();
    });
    it('renderAll fills every section body and records the focusable buttons by a stable key', () => {
        const bodies = {};
        const c = fd.renderAll(doc, data(), ui(), {}, {}, (id) => (bodies[id] ??= new FakeEl('div')));
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
        // Its fetch URLs are fixed strings and the validated run key.
        expect([...CLIENT_JS.matchAll(/fetchJson\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'url')).toEqual(["'api/v1/run/' + api", "'api/v1/summary'"]);
        expect([...CLIENT_JS.matchAll(/new EventSource\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["'events'"]);
    });
    it('the page carries no data, only the nonce; a bad nonce is refused', () => {
        const page = dashboardPageHtml('abc123==');
        expect(page.match(/nonce="abc123=="/g)).toHaveLength(2);
        expect(page).not.toMatch(/<script type="application\/json"|style="|<img|<link/);
        expect(() => dashboardPageHtml('"><script>')).toThrow();
        // Landmarks, the live region, the filter controls.
        for (const s of ['<main id="main"', 'aria-live="polite"', '<label for="f-text">', '<label for="f-phase">', '<nav aria-label="Sections">', 'prefers-color-scheme', 'prefers-reduced-motion', 'max-width:700px'])
            expect(page).toContain(s);
        expect(page.replace(CLIENT_JS, '').match(/aria-live/g)).toHaveLength(1);
    });
});
//# sourceMappingURL=serve-client.test.js.map