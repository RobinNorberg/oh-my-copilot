import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HEAL_CONFIG, resolveHealConfig } from '../config.js';
import { foldSignature, healLimitReason, healStateDir, healStatePath, listHealStates, readDailyCounters, readHealState, writeHealState } from '../state.js';
const NOW = new Date('2026-10-27T12:00:00Z');
const ZERO = { day: '2026-10-27', healRuns: 0, debugLanes: 0, credits: 0 };
const SHA = '15e3c590ca6eaadf0a0d1efe38f89092b3ae6269';
function cls(over = {}) {
    return { class: 'regression', signature: 'f'.repeat(64), sig8: 'ffffffff', firstRed: { runId: '1', sha: SHA }, jobs: [], laneEligible: true, ...over };
}
describe('heal signature state', () => {
    it('dedupes by run id and counts each new run once', () => {
        const a = foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
        expect(a).toMatchObject({ changed: true, state: { count: 1, next: 'debug-lane', firstSeen: { runId: '1' } } });
        expect(foldSignature(a.state, { classification: cls(), runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW).changed).toBe(false);
        const b = foldSignature(a.state, { classification: cls(), runId: '2', source: 'pr' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
        expect(b.state).toMatchObject({ count: 2, source: 'push', firstSeen: { runId: '1' }, lastSeen: { runId: '2' } });
    });
    it('records at most one rerun intent per signature, never issued', () => {
        const c = cls({ class: 'known-flaky', laneEligible: false, rerun: { runId: '1', command: 'gh run rerun 1 --failed', issued: false } });
        const a = foldSignature(null, { classification: c, runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
        const b = foldSignature(a.state, { classification: { ...c, rerun: { runId: '2', command: 'gh run rerun 2 --failed', issued: false } }, runId: '2', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
        expect(a.state.next).toBe('rerun-probe');
        expect(b.state.rerunIntents).toEqual([{ runId: '1', command: 'gh run rerun 1 --failed', issued: false }]);
    });
    it('env-change waits at rerun-probe: no probe outcome is recorded, so no lane is queued', () => {
        const c = cls({ class: 'env-change', rerun: { runId: '1', command: 'gh run rerun 1 --failed', issued: false } });
        const a = foldSignature(null, { classification: c, runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
        expect(a.state.next).toBe('rerun-probe');
        expect(foldSignature(a.state, { classification: c, runId: '2', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW).state.next).toBe('rerun-probe');
    });
    it('queues a lane candidate as blocked: rate-limit over the open-run and daily limits', () => {
        const open = { ...foldSignature(null, { classification: cls({ sig8: 'aaaaaaaa' }), runId: '9', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW).state, healRun: { id: 'heal-aaaaaaaa', open: true, startedAt: NOW.toISOString() } };
        expect(foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [open], ZERO, DEFAULT_HEAL_CONFIG, NOW).state.blocked).toBe('rate-limit');
        expect(foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [], { ...ZERO, healRuns: 3 }, DEFAULT_HEAL_CONFIG, NOW).state.blocked).toBe('rate-limit');
        expect(healLimitReason([], { ...ZERO, debugLanes: 4 }, DEFAULT_HEAL_CONFIG)).toMatch(/dailyDebugLanes 4/);
        expect(healLimitReason([], { ...ZERO, healRuns: 2, debugLanes: 3 }, DEFAULT_HEAL_CONFIG)).toBeNull();
    });
    it('an open heal run or a won\'t-fix within 14 days only increments the count', () => {
        const base = foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW).state;
        const wontFix = { ...base, wontFixAt: '2026-10-20T00:00:00Z' };
        const r = foldSignature(wontFix, { classification: cls({ class: 'infra' }), runId: '2', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
        expect(r).toMatchObject({ suppressed: true, state: { count: 2, class: 'regression' } });
        const later = foldSignature(wontFix, { classification: cls({ class: 'infra', laneEligible: false }), runId: '2', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, new Date('2026-11-05T00:00:00Z'));
        expect(later).toMatchObject({ suppressed: false, state: { class: 'infra' } });
    });
    describe('persistence', () => {
        let root;
        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'omg-heal-state-'));
            execFileSync('git', ['init', '-q'], { cwd: root });
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));
        it('writes .omg/state/factory/heal/<sig8>.json and reads it back; refuses a bad id', () => {
            const { state } = foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW);
            writeHealState(root, state);
            expect(healStatePath(root, 'ffffffff').replace(/\\/g, '/')).toMatch(/\.omg\/state\/factory\/heal\/ffffffff\.json$/);
            expect(readHealState(root, 'ffffffff')).toMatchObject({ sig8: 'ffffffff', count: 1 });
            expect(() => healStatePath(root, '../x')).toThrow(/8 hex/);
        });
        it('skips a corrupt signature file with a warning instead of throwing', () => {
            writeHealState(root, foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW).state);
            writeFileSync(join(healStateDir(root), 'deadbeef.json'), '{ not json');
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
            expect(listHealStates(root).map((s) => s.sig8)).toEqual(['ffffffff']);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('deadbeef.json'));
            warn.mockRestore();
        });
        it('daily counters reset on a new UTC day (fake clock)', () => {
            writeHealState(root, foldSignature(null, { classification: cls(), runId: '1', source: 'push' }, [], ZERO, DEFAULT_HEAL_CONFIG, NOW).state);
            writeFileSync(join(healStateDir(root), 'limits.json'), JSON.stringify({ day: '2026-10-27', healRuns: 3, debugLanes: 1 }));
            expect(readDailyCounters(root, NOW)).toEqual({ day: '2026-10-27', healRuns: 3, debugLanes: 1, credits: 0 });
            expect(readDailyCounters(root, new Date('2026-10-28T00:00:01Z'))).toEqual({ day: '2026-10-28', healRuns: 0, debugLanes: 0, credits: 0 });
        });
    });
});
describe('factory.heal config', () => {
    it('user config sets, the project config only lowers and never adds ignored jobs', () => {
        const user = { factory: { heal: { dailyRuns: 5, ignoreJobs: ['Policy'] } } };
        const project = { factory: { heal: { dailyRuns: 9, dailyDebugLanes: 1, ignoreJobs: ['Test'] } } };
        const { config, warnings } = resolveHealConfig(user, project);
        expect(config).toEqual({ ignoreJobs: ['Policy'], dailyRuns: 5, dailyDebugLanes: 1, debugLaneMaxCredits: 30, maxRunCredits: 120, dailyCredits: 150, autoImplement: false });
        expect(warnings).toHaveLength(2);
        expect(() => resolveHealConfig({ factory: { heal: { dailyRuns: -1 } } }, undefined)).toThrow(/non-negative integer/);
    });
    it('autoImplement defaults to false; only the user config turns it on, the project config only turns it off', () => {
        expect(resolveHealConfig(undefined, undefined).config.autoImplement).toBe(false);
        const fromProject = resolveHealConfig(undefined, { factory: { heal: { autoImplement: true } } });
        expect(fromProject.config.autoImplement).toBe(false);
        expect(fromProject.warnings.join('\n')).toMatch(/autoImplement .* only the user config turns it on/);
        expect(resolveHealConfig({ factory: { heal: { autoImplement: true } } }, undefined).config.autoImplement).toBe(true);
        expect(resolveHealConfig({ factory: { heal: { autoImplement: true } } }, { factory: { heal: { autoImplement: false } } }).config.autoImplement).toBe(false);
        expect(() => resolveHealConfig({ factory: { heal: { autoImplement: 'yes' } } }, undefined)).toThrow(/true or false/);
    });
    it('credit caps: the lane cap never goes under the CLI floor, the project only lowers', () => {
        expect(() => resolveHealConfig({ factory: { heal: { debugLaneMaxCredits: 10 } } }, undefined)).toThrow(/below the Copilot CLI minimum of 30/);
        expect(() => resolveHealConfig(undefined, { factory: { heal: { debugLaneMaxCredits: 29 } } })).toThrow(/below the Copilot CLI minimum/);
        const { config, warnings } = resolveHealConfig({ factory: { heal: { debugLaneMaxCredits: 40, dailyCredits: 200 } } }, { factory: { heal: { debugLaneMaxCredits: 35, dailyCredits: 500 } } });
        expect(config).toMatchObject({ debugLaneMaxCredits: 35, dailyCredits: 200, maxRunCredits: 120 });
        expect(warnings.join('\n')).toMatch(/dailyCredits 500 .* only lower/);
        expect(() => resolveHealConfig({ factory: { heal: { debugLaneMaxCredits: 60, maxRunCredits: 50 } } }, undefined)).toThrow(/maxRunCredits 50 is below one debugger lane's cap/);
    });
});
//# sourceMappingURL=state.test.js.map