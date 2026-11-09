import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerByTag, ledgerPath, ledgerTotals, mergeRecord, readLedger, recordUsage, resetLedger, sanitizeTag } from '../ledger.js';
let root;
const rec = (credits, over = {}) => ({ credits, premiumRequests: 1, source: 'measured', detail: 'test', updatedAt: '2026-11-09T00:00:00.000Z', ...over });
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-tags-'));
    vi.stubEnv('OMC_STATE_DIR', join(root, 'state'));
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});
describe('usage tags', () => {
    it('reads an old ledger without tags, totals it and buckets it as untagged', () => {
        const path = ledgerPath(root);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({
            version: 1, since: '2026-10-01T00:00:00.000Z', notified: {},
            sessions: { old1: rec(2), old2: rec(1, { source: 'estimated' }) },
            teams: { alpha: { 'w1:a': rec(4) } },
        }));
        const ledger = readLedger(path);
        expect(ledgerTotals(ledger)).toMatchObject({ credits: 7, sessions: 2 });
        for (const by of ['role', 'kind', 'run']) {
            expect(ledgerByTag(ledger, by)).toEqual([{ key: 'untagged', credits: 7, premiumRequests: 3, records: 3, estimatedRecords: 1 }]);
        }
    });
    it('groups tagged and untagged records side by side, most credits first', () => {
        const path = ledgerPath(root);
        recordUsage(path, 'factory-lane:issue-1-implement-1', rec(3, { tag: { kind: 'factory-lane', role: 'implement', run: 'issue-1' } }));
        recordUsage(path, 'factory-lane:issue-1-review-1', rec(1, { tag: { kind: 'factory-lane', role: 'review', run: 'issue-1' } }));
        recordUsage(path, 'factory-lane:issue-2-implement-1', rec(2, { tag: { kind: 'factory-lane', role: 'implement', run: 'issue-2' } }));
        recordUsage(path, 'w1:a', rec(6, { tag: { kind: 'team-worker' } }), 'alpha');
        recordUsage(path, 'plain', rec(0.5));
        const ledger = readLedger(path);
        expect(ledgerByTag(ledger, 'role').map((g) => [g.key, g.credits])).toEqual([['team-worker', 6], ['implement', 5], ['review', 1], ['untagged', 0.5]]);
        expect(ledgerByTag(ledger, 'kind').map((g) => g.key)).toEqual(['factory-lane', 'team-worker', 'untagged']);
        expect(ledgerByTag(ledger, 'run').map((g) => [g.key, g.credits])).toEqual([['untagged', 6.5], ['issue-1', 4], ['issue-2', 2]]);
    });
    it('drops a malformed or unsafe tag instead of storing it', () => {
        expect(sanitizeTag({ kind: 'bogus' })).toBeUndefined();
        expect(sanitizeTag('x')).toBeUndefined();
        expect(sanitizeTag({ kind: 'factory-lane', role: 'a b', run: 'x'.repeat(65) })).toEqual({ kind: 'factory-lane' });
        const path = ledgerPath(root);
        recordUsage(path, 's1', rec(1, { tag: { kind: 'nope' } }));
        expect(readLedger(path).sessions.s1?.tag).toBeUndefined();
    });
    it('survives a hand-edited ledger with a garbage tag', () => {
        const path = ledgerPath(root);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 1, since: 'x', notified: {}, teams: {}, sessions: { a: { ...rec(1), tag: 7 }, b: { ...rec(1), tag: { kind: 'session', role: {} } } } }));
        expect(ledgerByTag(readLedger(path), 'role').map((g) => [g.key, g.records])).toEqual([['session', 1], ['untagged', 1]]);
    });
    it('keeps the owner tag when an untagged refresh updates the record', () => {
        const tag = { kind: 'factory-lane', role: 'fix', run: 'issue-3' };
        expect(mergeRecord(rec(1, { tag }), rec(2, { source: 'estimated' }))).toMatchObject({ tag, credits: 1 });
        expect(mergeRecord(rec(1, { source: 'estimated', tag }), rec(2))).toMatchObject({ tag, credits: 2 });
        expect(mergeRecord(rec(1, { tag }), rec(1, { tag: { kind: 'session' } }))).toMatchObject({ tag: { kind: 'session' } });
    });
    it('keeps tags across a budget reset baseline', () => {
        const path = ledgerPath(root);
        const tag = { kind: 'factory-lane', role: 'implement', run: 'issue-1' };
        recordUsage(path, 'k1', rec(3, { tag }));
        const ledger = readLedger(path);
        resetLedger(ledger);
        expect(ledgerByTag(ledger, 'role')).toEqual([]);
    });
});
//# sourceMappingURL=ledger.tags.test.js.map