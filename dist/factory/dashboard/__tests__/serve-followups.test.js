/**
 * Follow-ups of the `dashboard --serve` review: untrusted rows carry no age
 * and are ordered by key (L3), an event stream that reads nothing is dropped
 * (L4), and bench rows from unsealed files are labelled and sanitised (M1)
 * in the collector, the static page and (client test) the live page.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { BENCH_NOT_SHOWN, BENCH_UNSEALED_NOTE, collectDashboardV2 } from '../collect-v2.js';
import { renderDashboardHtml } from '../render.js';
import { dropStalledStreams, orderServedItems, servedItem, servedSummary } from '../serve.js';
const item = (key, trust, group, ageMs) => ({
    key, group, gate: 'merge', phase: 'merge', ageMs, credits: null, cap: null, pr: null, head: null, title: 't', why: 'w', next: [], trust, notes: [],
});
describe('served attention rows (L3)', () => {
    it('an untrusted row carries no age from its state', () => {
        expect(servedItem(item('#3', 'seal', 'inspect', 123_456)).ageMs).toBeNull();
        expect(servedItem(item('#3', 'ok', 'merge', 123_456)).ageMs).toBe(123_456);
    });
    it('untrusted rows are ordered by run key inside their group, before the trusted rows, which keep the collector order', () => {
        const served = [
            item('#9', 'ok', 'inspect', 5), item('#12', 'seal', 'inspect', 1), item('heal-0000abcd', 'ledger', 'inspect', 9), item('#2', 'missing', 'inspect', 999),
            item('#7', 'ok', 'merge', 50), item('#1', 'ok', 'merge', 10),
        ].map((i) => servedItem(i));
        expect(orderServedItems(served).map((i) => i.key)).toEqual(['#2', '#12', 'heal-0000abcd', '#9', '#7', '#1']);
    });
    it('servedSummary applies both', () => {
        const d = { attention: { schemaVersion: 1, repo: 'r', forge: null, generatedAt: '', summary: { byGroup: {}, engines: { live: 0, runs: [] } }, items: [item('#5', 'seal', 'inspect', 10), item('#4', 'seal', 'inspect', 99)], warnings: [] },
            runs: [], tasks: [], live: { engines: 0, slots: 0, runs: [], inFlightCredits: 0 }, cost: { excluded: { runs: 0, missing: 0 } }, warnings: [] };
        const s = servedSummary(d, 'r');
        expect(s.attention.items.map((i) => [i.key, i.ageMs])).toEqual([['#4', null], ['#5', null]]);
    });
});
describe('event streams that read nothing (L4)', () => {
    it('a stream whose buffer has not drained for `limit` pings is destroyed; one that drains is kept', () => {
        const mk = () => ({ writableLength: 0, destroyed: false, destroy() { this.destroyed = true; return this; } });
        const stuck = mk();
        const fine = mk();
        const streams = new Set([stuck, fine]);
        const stalls = new Map();
        stuck.writableLength = 10;
        fine.writableLength = 10;
        expect(dropStalledStreams(streams, stalls, 3)).toEqual([]);
        fine.writableLength = 0;
        expect(dropStalledStreams(streams, stalls, 3)).toEqual([]);
        fine.writableLength = 10;
        expect(dropStalledStreams(streams, stalls, 3)).toEqual([stuck]);
        expect(stuck.destroyed).toBe(true);
        expect(fine.destroyed).toBe(false);
        expect([...streams]).toEqual([fine]);
        expect(stalls.has(stuck)).toBe(false);
    });
});
describe('bench rows from unsealed files (M1)', () => {
    let dir;
    let root;
    beforeEach(() => {
        vi.stubEnv('OMC_STATE_DIR', '');
        dir = mkdtempSync(join(tmpdir(), 'omg-bench-'));
        root = join(dir, 'repo');
        mkdirSync(join(root, 'bench-results'), { recursive: true });
        execFileSync('git', ['init', '-q', root]);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });
    it('keeps only plain words and finite numbers >= 0, marks the rest, and the static page labels the section', () => {
        writeFileSync(join(root, 'bench-results', 'evil name (1).json'), JSON.stringify({
            kind: 'omg-factory-bench', schemaVersion: -2, mode: 'live; rm -rf /', omgVersion: '5.30.0', model: 'gpt‮5', startedAt: '2026-11-21T01:00:00.000Z',
            totals: { issues: 3, passed: 'many', premiumRequests: -4, credits: '12', wallMs: 60_000 },
        }));
        writeFileSync(join(root, 'bench-results', 'fine.json'), JSON.stringify({ kind: 'omg-factory-bench', mode: 'fake', model: 'm-1.2', totals: { issues: 2, passed: 2, premiumRequests: 0, credits: 0.5 } }));
        const d = collectDashboardV2(root, { ledgerDir: join(dir, 'ledger'), now: () => Date.parse('2026-11-22T00:00:00.000Z'), limits: DEFAULT_FACTORY_RUN_LIMITS });
        const [evil, fine] = [d.bench.find((b) => b.file !== 'fine.json'), d.bench.find((b) => b.file === 'fine.json')];
        expect(evil).toMatchObject({ file: BENCH_NOT_SHOWN, mode: BENCH_NOT_SHOWN, omgVersion: '5.30.0', model: BENCH_NOT_SHOWN, schemaVersion: null, issues: 3, passed: null, premiumRequests: null, credits: null, wallMs: 60_000 });
        expect(evil.invalid?.sort()).toEqual(['credits', 'passed', 'premiumRequests', 'schemaVersion']);
        expect(fine).toMatchObject({ file: 'fine.json', mode: 'fake', model: 'm-1.2', passed: 2, premiumRequests: 0, credits: 0.5 });
        expect(fine.invalid).toBeUndefined();
        const html = renderDashboardHtml(d);
        expect(html).toContain(BENCH_UNSEALED_NOTE);
        expect(html).not.toContain('rm -rf');
        expect(html).not.toContain('‮');
        expect(html.match(/>invalid</g)?.length).toBe(3);
    });
});
//# sourceMappingURL=serve-followups.test.js.map