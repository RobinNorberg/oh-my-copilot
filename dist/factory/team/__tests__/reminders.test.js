import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFactoryState, setGate } from '../../run/state.js';
import { TEAM_ROUTING_PATH } from '../context.js';
import { remindersPath, staleGateReminders } from '../reminders.js';
const T0 = Date.parse('2026-11-09T00:00:00.000Z');
const H = 3_600_000;
let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-remind-'));
    execFileSync('git', ['init', '-q', root]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const parked = (issue, at, plan = 'edit src/a/b.ts') => [issue,
    setGate({ ...createFactoryState({ issue, repoUrl: 'u', base: 'dev' }, new Date(at).toISOString()), plan: { source: 'issue-body', text: plan } }, 'merge', 'ready‮', new Date(at).toISOString())];
const readBase = (p) => (p === TEAM_ROUTING_PATH ? '| src/** | - | core | @robin |\n| ** | - | all | @lead |' : undefined);
describe('staleGateReminders', () => {
    it('is off without a window', () => {
        const runs = new Map([parked(1, T0)]);
        expect(staleGateReminders({ root, runs, nowMs: T0 + 99 * H, afterHours: 0 })).toEqual([]);
        expect(staleGateReminders({ root, runs, nowMs: T0 + 99 * H, afterHours: undefined })).toEqual([]);
        expect(existsSync(remindersPath(root))).toBe(false);
    });
    it('waits for the window, reminds once, then again a window later', () => {
        const runs = new Map([parked(1, T0)]);
        const at = (h) => staleGateReminders({ root, runs, nowMs: T0 + h * H, afterHours: 24, readBase });
        expect(at(23)).toEqual([]);
        const first = at(25);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ run: 1, gate: 'merge', hours: 25, handles: ['@robin'] });
        expect(first[0].reason).toContain('<U+202E>');
        expect(at(26)).toEqual([]);
        expect(at(48)).toEqual([]);
        expect(at(49)).toHaveLength(1);
    });
    it('a new gate on the same run restarts the window; a cleared gate is forgotten', () => {
        const runs = new Map([parked(1, T0)]);
        expect(staleGateReminders({ root, runs, nowMs: T0 + 30 * H, afterHours: 24 })).toHaveLength(1);
        const renewed = new Map([parked(1, T0 + 40 * H)]);
        expect(staleGateReminders({ root, runs: renewed, nowMs: T0 + 50 * H, afterHours: 24 })).toEqual([]);
        expect(staleGateReminders({ root, runs: new Map(), nowMs: T0 + 60 * H, afterHours: 24 })).toEqual([]);
        expect(JSON.parse(readFileSync(remindersPath(root), 'utf8'))).toEqual({});
    });
    it('falls back to the catch-all handle when the plan names no path, and works without a base', () => {
        const runs = new Map([parked(2, T0, 'no paths here')]);
        expect(staleGateReminders({ root, runs, nowMs: T0 + 30 * H, afterHours: 24, readBase })[0].handles).toEqual(['@lead']);
        const runs2 = new Map([parked(3, T0)]);
        expect(staleGateReminders({ root, runs: runs2, nowMs: T0 + 30 * H, afterHours: 24 })[0].handles).toEqual([]);
    });
    it('skips terminal runs and runs without a gate', () => {
        const [, gated] = parked(4, T0);
        const { gate: _g, ...noGate } = gated;
        const runs = new Map([[4, noGate], [5, { ...gated, phase: 'merged' }]]);
        expect(staleGateReminders({ root, runs, nowMs: T0 + 99 * H, afterHours: 24, readBase })).toEqual([]);
    });
    it('a throwing base read warns and still reminds without handles', () => {
        const warns = [];
        const r = staleGateReminders({ root, runs: new Map([parked(6, T0)]), nowMs: T0 + 30 * H, afterHours: 24, readBase: () => { throw new Error('boom'); }, warn: (m) => warns.push(m) });
        expect(r[0].handles).toEqual([]);
        expect(warns[0]).toContain('boom');
    });
});
//# sourceMappingURL=reminders.test.js.map