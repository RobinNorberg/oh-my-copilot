/**
 * `omg factory dashboard` schemaVersion 2: the timeline split (engine vs
 * waiting on you), cost and throughput, bench files, trust (unverified runs
 * marked and kept out of totals), the page (escaping, no script, CSP, empty
 * states, meta refresh only with --watch), and the CLI: read-only by
 * default, --forge, --watch with a fake clock, --schema 1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryDashboardCommand, writeFileAtomic } from '../../../cli/commands/factory-dashboard.js';
import { attentionJson, collectAttention } from '../../attention/collect.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { EngineLedger } from '../../run/ledger.js';
import { computeFactoryIntegrity, createFactoryState, factoryStatePath, moveTo, runKeyOf, setGate, updateFactoryState, } from '../../run/state.js';
import { collectDashboardV2, runTimeline } from '../collect-v2.js';
import { renderDashboardHtml } from '../render.js';
const REPO = 'https://github.com/o/r';
const HEAD = 'c'.repeat(40);
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: () => false };
let dir;
let root;
let ledgerDir;
beforeEach(() => {
    vi.stubEnv('OMC_STATE_DIR', '');
    dir = mkdtempSync(join(tmpdir(), 'omg-dash2-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    ledgerDir = join(dir, 'ledger');
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
});
const lane = (id, kind, credits, end, extra = {}) => ({
    id, kind, startSha: 'a', status: 'completed', maxCredits: 5, startedAt: end, endedAt: end, usage: { credits, premiumRequests: 1, source: 'measured' }, ...extra,
});
/** Written as the engine writes: sealed and recorded in the engine ledger. */
function asEngine(s) {
    const key = runKeyOf(s);
    const l = EngineLedger.open(ledgerDir, root, key);
    updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
    return s;
}
/** intake 0 s -> implement 10 s -> review 70 s -> prepare 100 s -> gates 120 s -> merge 150 s, park at merge 152 s. */
function toMergePark(issue, title = `item ${issue}`, offset = 0) {
    let s = { ...createFactoryState({ issue, repoUrl: REPO, base: 'main' }, iso(offset)), forgeKind: 'github', issueTitle: title };
    s = moveTo(s, 'implement', 'plan ok', iso(offset + 10));
    s = moveTo(s, 'review', 'pushed', iso(offset + 70));
    s = moveTo(s, 'prepare', 'approve', iso(offset + 100));
    s = moveTo(s, 'gates', 'prepared', iso(offset + 120));
    s = moveTo(s, 'merge', 'gates green', iso(offset + 150));
    s = { ...setGate(s, 'merge', 'merge is a human step', iso(offset + 152)), pr: issue + 100, head: HEAD };
    return { ...s, lanes: [lane(`issue-${issue}-implement-1`, 'implement', 2, iso(offset + 60)), lane(`issue-${issue}-review-1`, 'review', 1, iso(offset + 95))] };
}
const opts = (now, extra = {}) => ({ ledgerDir, now: () => now, owner: OWNER, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 20 }, ...extra });
describe('runTimeline', () => {
    it('splits engine time from time parked at the merge gate, to now while still parked', () => {
        const s = toMergePark(1);
        const now = T0 + (152 + 420) * 1000; // 7 min at the merge park
        const t = runTimeline(s, now);
        expect(t.steps.map((x) => [x.phase, x.engineMs, x.waitingMs])).toEqual([
            ['intake', 10_000, 0], ['implement', 60_000, 0], ['review', 30_000, 0], ['prepare', 20_000, 0], ['gates', 30_000, 0], ['merge', 2_000, 420_000],
        ]);
        expect(t).toMatchObject({ engineMs: 152_000, waitingMs: 420_000, waitingSince: iso(152), mergeReadyAt: iso(152), engineToMergeReadyMs: 152_000, mergeWaitMs: 420_000 });
    });
    it('a rerun ends the wait; the engine time after it counts again, and a later merge record ends the run', () => {
        let s = toMergePark(2);
        s = { ...s, history: [...s.history, { at: iso(452), from: 'merge', to: 'merge', note: 'rerun after awaiting-human: merge' }] };
        s = moveTo(s, 'prepare', 'base moved', iso(455));
        s = moveTo(s, 'gates', 'prepared', iso(475));
        s = moveTo(s, 'merge', 'green', iso(485));
        s = setGate(s, 'merge', 'merge is a human step', iso(486));
        s = moveTo(s, 'merged', 'PR #102 merged by a human after awaiting-human: merge', iso(1086));
        const t = runTimeline(s, T0 + 99_999_000);
        expect(t.waitingMs).toBe(300_000 + 600_000);
        expect(t.engineMs).toBe(152_000 + 3_000 + 20_000 + 10_000 + 1_000);
        expect(t.waitingSince).toBeNull();
        expect(t.steps.at(-1)).toEqual({ phase: 'merged', engineMs: 0, waitingMs: 0, gates: [] });
        expect(t.mergeReadyAt).toBe(iso(152));
        expect(t.engineToMergeReadyMs).toBe(152_000);
    });
    it('a gate newer than the last history entry (no park note) waits from gate.at', () => {
        let s = moveTo(createFactoryState({ issue: 3, repoUrl: REPO, base: 'main' }, iso(0)), 'implement', 'go', iso(10));
        s = { ...s, gate: { name: 'fix-failed', reason: 'r', at: iso(40) }, updatedAt: iso(40) };
        const t = runTimeline(s, T0 + 100_000);
        expect(t).toMatchObject({ engineMs: 40_000, waitingMs: 60_000, waitingSince: iso(40) });
    });
});
describe('collectDashboardV2', () => {
    it('sums credits from verified runs only, marks unverified runs and keeps their text and numbers out', () => {
        asEngine(toMergePark(1, 'First'));
        asEngine(toMergePark(2, 'Second', 600));
        // #3: sealed but never recorded in the ledger; #4: a hand edit after the seal.
        const s3 = { ...toMergePark(3, 'SECRET-TITLE-3'), lanes: [lane('l9', 'implement', 50, iso(30))] };
        writeFileSync(factoryStatePath(root, 3), JSON.stringify({ ...s3, integrity: computeFactoryIntegrity(s3) }));
        asEngine(toMergePark(4, 'Four'));
        const p4 = factoryStatePath(root, 4);
        writeFileSync(p4, readFileSync(p4, 'utf8').replace('Four', 'SECRET-TITLE-4'));
        const d = collectDashboardV2(root, opts(T0 + 2_000_000));
        expect(d.schemaVersion).toBe(2);
        expect(d.cost.totals).toEqual({ credits: 6, premiumRequests: 4, lanes: 4 });
        expect(d.cost.excluded).toEqual({ runs: 2, credits: 53, premiumRequests: 3 });
        const r3 = d.runs.find((r) => r.key === '#3');
        const r4 = d.runs.find((r) => r.key === '#4');
        expect(r3).toMatchObject({ verified: false, trust: 'unverified', title: '', credits: null, timeline: [] });
        expect(r4).toMatchObject({ verified: false, trust: 'seal', title: '', credits: null });
        expect(JSON.stringify({ ...d, attention: null })).not.toMatch(/SECRET-TITLE/);
        // The Attention section keeps attention's own rule: the row is there, without a reason and with the status command only.
        expect(d.attention.items.filter((i) => i.trust !== 'ok').every((i) => i.reason === undefined)).toBe(true);
        expect(d.cost.byRole).toEqual([{ role: 'implement', credits: 4, premiumRequests: 2, lanes: 2 }, { role: 'review', credits: 2, premiumRequests: 2, lanes: 2 }]);
        expect(d.cost.byRun.map((r) => [r.key, r.credits, r.cap])).toEqual([['#2', 3, 20], ['#1', 3, 20]]);
        expect(d.cost.caps).toMatchObject({ laneMaxCredits: DEFAULT_FACTORY_RUN_LIMITS.laneMaxCredits, maxRunCredits: 20, source: 'config' });
        // Attention is the attention collector's output, unverified rows included with the status command only.
        expect(d.attention).toEqual(attentionJson(collectAttention(root, { ledgerDir, now: () => T0 + 2_000_000, owner: OWNER, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 20 }, verbose: true })));
        const a3 = d.attention.items.find((i) => i.key === '#3');
        expect(a3.next.map((n) => n.argv.join(' '))).toEqual(['omg factory run status 3']);
        expect(d.tasks.find((t) => t.key === '#1')).toMatchObject({ title: 'First', outcome: 'parked', gate: 'merge', pr: 101, credits: 3, tracker: null });
    });
    it('throughput: started and merge-ready per day, median and p90 engine time to merge-ready, median wait at the merge park', () => {
        // Engine times to the merge park: 152 s, 152 + 20 s, 152 + 40 s (an extra intake step).
        for (const [issue, extra] of [[1, 0], [2, 20], [3, 40]]) {
            const s = toMergePark(issue, `t${issue}`, issue * 1000);
            const h = s.history.map((e, i) => (i === 0 ? e : { ...e, at: new Date(Date.parse(e.at) + extra * 1000).toISOString() }));
            asEngine({ ...s, history: h, gate: { ...s.gate, at: h.at(-1).at }, updatedAt: h.at(-1).at });
        }
        const now = T0 + 10_000_000;
        const d = collectDashboardV2(root, opts(now));
        expect(d.throughput.engineToMergeReady).toEqual({ runs: 3, medianMs: 172_000, p90Ms: 192_000 });
        const waits = [1, 2, 3].map((i) => now - (T0 + (i * 1000 + 152 + [0, 20, 40][i - 1]) * 1000)).sort((a, b) => a - b);
        expect(d.throughput.waitingAtMerge).toEqual({ runs: 3, medianMs: waits[1] });
        expect(d.throughput.byDay.reduce((a, r) => a + r.started, 0)).toBe(3);
        expect(d.throughput.byDay.reduce((a, r) => a + r.mergeReady, 0)).toBe(3);
    });
    it('reads bench results from bench-results and --bench-dir, tolerates an old schema and skips run-state copies with one warning', () => {
        mkdirSync(join(root, 'bench-results'));
        writeFileSync(join(root, 'bench-results', '2026-11-21-live.json'), JSON.stringify({
            schemaVersion: 1, kind: 'omg-factory-bench', mode: 'live', omgVersion: '5.30.0', model: { id: 'm-1' }, startedAt: '2026-11-21T01:00:00.000Z', finishedAt: '2026-11-21T01:10:00.000Z',
            runs: [{ issue: 1 }], totals: { issues: 17, passed: 16, premiumRequests: 33, credits: 38.49, wallMs: 600_000 },
        }));
        const benchDir = join(dir, 'results');
        mkdirSync(benchDir);
        writeFileSync(join(benchDir, 'old.json'), JSON.stringify({ mode: 'fake', createdAt: '2026-11-01T00:00:00.000Z', totals: { passed: 3, premiumRequests: 9 }, issues: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
        writeFileSync(join(benchDir, 'run-1.json'), JSON.stringify({ version: 1, issue: 1, phase: 'merge' }));
        writeFileSync(join(benchDir, 'run-2.json'), JSON.stringify({ version: 1, issue: 2, phase: 'merge' }));
        writeFileSync(join(benchDir, 'broken.json'), '{nope');
        const d = collectDashboardV2(root, opts(T0, { benchDirs: [benchDir, join(dir, 'missing')] }));
        expect(d.bench).toEqual([
            { source: 'bench-dir', file: 'old.json', schemaVersion: null, mode: 'fake', omgVersion: null, model: null, startedAt: '2026-11-01T00:00:00.000Z', issues: 3, passed: 3, premiumRequests: 9, credits: null, wallMs: null },
            { source: 'bench-results', file: '2026-11-21-live.json', schemaVersion: 1, mode: 'live', omgVersion: '5.30.0', model: 'm-1', startedAt: '2026-11-21T01:00:00.000Z', issues: 17, passed: 16, premiumRequests: 33, credits: 38.49, wallMs: 600_000 },
        ]);
        expect(d.warnings.filter((w) => /broken\.json/.test(w))).toHaveLength(1);
        expect(d.warnings.filter((w) => /missing: not a readable directory/.test(w))).toHaveLength(1);
        expect(d.warnings.join('\n')).not.toMatch(/run-1|run-2/);
        // --since drops older bench rows too.
        expect(collectDashboardV2(root, opts(T0, { benchDirs: [benchDir], since: '2026-11-10' })).bench.map((b) => b.file)).toEqual(['2026-11-21-live.json']);
    });
    it('joins tracker columns only from a board handed in (--forge)', () => {
        asEngine(toMergePark(1, 'First'));
        const board = {
            schemaVersion: 1, ok: true, forge: 'github', limitations: [], repo: REPO, source: null, parent: null, outside: [], warnings: [],
            columns: [
                { stage: 'backlog', title: 'Backlog', items: [{ id: 9, title: 'Not started <b>', url: '', stage: {}, flags: [], check: { bucket: 'ready', priority: null, reasons: [], detail: '' } }] },
                { stage: 'ready-to-merge', title: 'Ready', items: [{ id: 1, title: 'First', url: '', stage: { live: 'ready-to-merge' }, liveText: 'factory:ready-to-merge', flags: [], check: { bucket: 'ready', priority: null, reasons: [], detail: '' } }] },
            ],
        };
        const d = collectDashboardV2(root, opts(T0 + 1_000_000, { board: { json: board, at: iso(999) } }));
        expect(d.forge).toEqual({ read: true, at: iso(999) });
        expect(d.tasks.map((t) => [t.key, t.outcome, t.tracker])).toEqual([
            ['#1', 'parked', { bucket: 'ready', stage: 'ready-to-merge', liveText: 'factory:ready-to-merge' }],
            ['#9', 'no run', { bucket: 'ready', stage: null, liveText: null }],
        ]);
    });
    it('empty repository: no runs, nothing needs you, valid sections', () => {
        const d = collectDashboardV2(root, opts(T0));
        expect(d.runs).toEqual([]);
        expect(d.attention.items).toEqual([]);
        expect(d.throughput.engineToMergeReady).toEqual({ runs: 0, medianMs: null, p90Ms: null });
    });
});
describe('renderDashboardHtml v2', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'` onload=x';
    it('escapes hostile titles, reasons, lane ids, gate names and bench names everywhere, with no script, handler or external URL', () => {
        const s = toMergePark(1, evil);
        asEngine({ ...s, gate: { ...s.gate, reason: evil }, lanes: [lane(evil, evil, 1, iso(30), { role: evil })] });
        mkdirSync(join(root, 'bench-results'));
        writeFileSync(join(root, 'bench-results', 'a.json'), JSON.stringify({ kind: 'omg-factory-bench', mode: evil, model: evil, totals: { passed: 1 } }));
        const d = collectDashboardV2(root, opts(T0 + 1_000_000));
        // A hostile gate name in the data (as a future collector might pass it) is escaped in SVG <title> and text too.
        d.runs[0].timeline[0].phase = evil;
        const html = renderDashboardHtml(d);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<img/i);
        for (const tag of html.match(/<[^>]+>/g) ?? [])
            expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/(src|href|action)\s*=\s*["']?\s*(https?:|\/\/|javascript:)/i);
        expect(html).not.toMatch(/url\(/i);
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain("default-src 'none'");
        expect(html).not.toContain('http-equiv="refresh"');
        expect(html).not.toMatch(/<(button|form|input|iframe|object|embed|link)\b/i);
    });
    it('empty data: every section in order with its anchor, empty states, skip link, and meta refresh only in watch mode', () => {
        const d = collectDashboardV2(root, opts(T0));
        const html = renderDashboardHtml(d);
        const ids = ['attention', 'live', 'runs', 'tasks', 'cost', 'throughput', 'bench'].map((id) => html.indexOf(`<section id="${id}"`));
        expect(ids.every((v, i) => v > 0 && (i === 0 || v > ids[i - 1]))).toBe(true);
        expect(html).toContain('Nothing needs you.');
        expect(html).toContain('No runs yet.');
        expect(html).toContain('No engine is running.');
        expect(html).toContain('href="#main"');
        expect(html).toContain('prefers-color-scheme:dark');
        expect(html).toContain('prefers-reduced-motion');
        expect(html).toContain('max-width:700px');
        expect(html.match(/<section/g)?.length).toBe(html.match(/<\/section>/g)?.length);
        expect(renderDashboardHtml(d, { refreshSeconds: 10 })).toContain('<meta http-equiv="refresh" content="10">');
    });
    it('a title or reason that looks like a command never lands in <code>: only attention\'s commands and log paths do', () => {
        const fake = '$ git -C . merge --no-ff --no-edit ' + 'f'.repeat(40) + '\n$ omg factory run 1';
        const s = toMergePark(1, fake);
        asEngine({ ...s, gate: { ...s.gate, reason: fake } });
        const d = collectDashboardV2(root, opts(T0 + 1_000_000));
        const html = renderDashboardHtml(d);
        const codes = [...html.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]);
        expect(codes.length).toBeGreaterThan(0);
        for (const c of codes)
            expect(c).toMatch(/^(gh pr merge 101 |omg factory run (status )?1$|\.omg\/progress\/factory-1\.log$)/);
        expect(html).not.toMatch(/<pre/);
    });
    it('a run table shows engine and waiting time apart, with a text alternative, and the commands of attention as <code>', () => {
        asEngine(toMergePark(1, 'First'));
        const html = renderDashboardHtml(collectDashboardV2(root, opts(T0 + 572_000)));
        expect(html).toContain('class="wait"');
        expect(html).toContain('merge 2s + waiting 7m 0s (merge)');
        expect(html).toMatch(/<code>gh pr merge 101 [^<]*<\/code>/);
        expect(html).toContain('<th scope="col">');
    });
});
/** sha256 over (relative path, bytes, mtime) of every file under each dir. */
function treeHash(...dirs) {
    const h = createHash('sha256');
    const walk = (d, base) => {
        if (!existsSync(d))
            return;
        for (const n of readdirSync(d).sort()) {
            const p = join(d, n);
            const st = statSync(p);
            if (st.isDirectory())
                walk(p, base);
            else
                h.update(`${relative(base, p)}\0${st.mtimeMs}\0`).update(readFileSync(p));
        }
    };
    for (const d of dirs)
        walk(d, d);
    return h.digest('hex');
}
describe('omg factory dashboard command', () => {
    let out;
    let err;
    beforeEach(() => { out = []; err = []; });
    const deps = (over = {}) => ({
        root: () => root, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(T0 + 1_000_000), ledgerDir, owner: OWNER, ...over,
    });
    const run = async (args, over = {}) => {
        process.exitCode = 0;
        await factoryDashboardCommand(deps(over)).parseAsync(args, { from: 'user' });
        return Number(process.exitCode ?? 0);
    };
    it('by default reads no forge and writes nothing: the state dir and the ledger are byte-identical, mtimes included', async () => {
        asEngine(toMergePark(1, 'First'));
        asEngine(moveTo(toMergePark(2), 'cancelled', 'cancelled', iso(900))); // a stopped run with a PR: a human-merge candidate
        const forgeRead = vi.fn(async () => ({ lines: [], board: null }));
        const before = treeHash(join(root, '.omg'), ledgerDir);
        expect(await run(['--json'], { forgeRead })).toBe(0);
        expect(await run([], { forgeRead })).toBe(0);
        expect(forgeRead).not.toHaveBeenCalled();
        expect(treeHash(join(root, '.omg'), ledgerDir)).toBe(before);
        expect(JSON.parse(out[0]).schemaVersion).toBe(2);
        expect(out[1]).toMatch(/^<!doctype html>/);
        expect(out[1]).toContain('Local state only: no forge read.');
    });
    it('--forge calls the forge reader once, prints its lines and fills the tracker columns', async () => {
        asEngine(toMergePark(1, 'First'));
        const board = { schemaVersion: 1, ok: true, forge: 'github', limitations: [], repo: REPO, source: null, parent: null, outside: [], warnings: [], columns: [{ stage: 'ready-to-merge', title: 'R', items: [{ id: 1, title: 'First', url: '', stage: { live: 'ready-to-merge' }, flags: [], check: { bucket: 'ready', priority: null, reasons: [], detail: '' } }] }] };
        const forgeRead = vi.fn(async () => ({ lines: ['run #2: PR #102 was merged by a human after cancelled; recorded the run as merged'], board }));
        expect(await run(['--forge', '--json'], { forgeRead })).toBe(0);
        expect(forgeRead).toHaveBeenCalledTimes(1);
        expect(forgeRead).toHaveBeenCalledWith(root);
        expect(err).toContain('run #2: PR #102 was merged by a human after cancelled; recorded the run as merged');
        const j = JSON.parse(out.join(''));
        expect(j.forge.read).toBe(true);
        expect(j.tasks[0].tracker).toEqual({ bucket: 'ready', stage: 'ready-to-merge', liveText: null });
    });
    it('--schema 1 keeps the old --json shape; usage errors exit 2', async () => {
        asEngine(toMergePark(1, 'First'));
        expect(await run(['--json', '--schema', '1'])).toBe(0);
        const v1 = JSON.parse(out.join(''));
        expect(v1.schemaVersion).toBe(1);
        expect(v1.totals.runs).toBe(1);
        expect(v1.phaseMs).toBeDefined();
        expect(await run(['--schema', '1'])).toBe(2);
        expect(await run(['--json', '--schema', '3'])).toBe(2);
        expect(await run(['--watch'])).toBe(2);
        expect(await run(['--out', join(dir, 'x.html'), '--watch', '1'])).toBe(2);
        expect(await run(['--since', 'bad'])).toBe(2);
    });
    it('--watch rewrites only when the page changed, atomically, reads the forge on the slow timer, and stops on interrupt', async () => {
        asEngine(toMergePark(1, 'First'));
        const file = join(dir, 'dash.html');
        let clock = T0 + 1_000_000;
        const writes = [];
        const forgeRead = vi.fn(async () => ({ lines: [], board: null }));
        let tick = 0;
        const sleep = vi.fn(async (ms) => {
            tick++;
            clock += ms;
            if (tick === 2)
                asEngine(toMergePark(2, 'Second', 1500)); // a new run between tick 2 and 3
            return tick < 4;
        });
        const code = await run(['--out', file, '--watch', '30', '--forge'], {
            now: () => new Date(clock), sleep, forgeRead,
            writeFile: (f, c) => { writes.push(c); writeFileAtomic(f, c); },
        });
        expect(code).toBe(0);
        expect(sleep).toHaveBeenCalledTimes(4);
        expect(sleep).toHaveBeenCalledWith(30_000);
        // Tick 1 writes, tick 2 nothing changed, tick 3 the new run, tick 4 nothing changed.
        expect(writes).toHaveLength(2);
        expect(writes[1]).toContain('Second');
        expect(readFileSync(file, 'utf8')).toBe(writes[1]);
        expect(readFileSync(file, 'utf8')).toContain('<meta http-equiv="refresh" content="30">');
        // 4 ticks over 90 s: one forge read (it refreshes every 5 minutes).
        expect(forgeRead).toHaveBeenCalledTimes(1);
        expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
        expect(err.filter((l) => l.includes(file))).toHaveLength(1);
    });
    it('writeFileAtomic replaces the file in one rename and leaves no temp file', () => {
        const file = join(dir, 'a.html');
        writeFileSync(file, 'old');
        writeFileAtomic(file, 'new');
        expect(readFileSync(file, 'utf8')).toBe('new');
        expect(readdirSync(dir).filter((n) => n.startsWith('a.html.'))).toEqual([]);
    });
});
//# sourceMappingURL=dashboard-v2.test.js.map