import { describe, expect, it } from 'vitest';
import { resolveShipConfig, type ShipConfig } from '../config.js';
import { applySettle, CHECK_SETTLE_MS, evaluateChecks, NO_CI_CHECKS_NOTE, NO_WORKFLOWS_TRIGGERED, watchGates, type GateForge, type GhCheck, type WorkflowRun } from '../gates.js';
import type { Exec } from '../exec.js';

const HEAD = 'a'.repeat(40);
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const DEFAULT: ShipConfig = resolveShipConfig(undefined);
const NAMED: ShipConfig = resolveShipConfig({ requiredChecks: ['check', 'lint'], advisoryChecks: [] });
const done = (name: string, at: number, state = 'SUCCESS'): GhCheck => ({ name, state, startedAt: iso(at - 20_000), completedAt: iso(at) });
const noExec: Exec = () => { throw new Error('no gh call expected: the forge answers'); };

/** A forge that reports `checks()` / `runs()` for HEAD on every read. */
function forge(checks: () => GhCheck[], runs: () => WorkflowRun[] = () => []): GateForge {
  return {
    checks: {
      checks: () => checks(),
      runsForHead: () => runs(),
      jobLog: () => ({ ok: false, text: '' }),
      rerun: () => ({ ok: false, stderr: 'no' }),
      transientError: /never/,
    },
    reviews: { prHead: () => ({ headRefOid: HEAD, state: 'OPEN' }) },
  };
}

function clock(start = T0) {
  let now = start;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe('M1: the reported-checks rule (no ship.requiredChecks)', () => {
  it('the built-in default names no check', () => {
    expect(DEFAULT.requiredChecks).toEqual([]);
  });

  it('green waits out the settle window after the newest check activity', () => {
    const report = evaluateChecks(1, [done('check', T0)], DEFAULT);
    expect(report.verdict).toBe('green');
    const early = applySettle(report, DEFAULT, T0 + CHECK_SETTLE_MS - 1, T0);
    expect(early.verdict).toBe('pending');
    expect(early.pending.join('\n')).toMatch(/settle window: waiting 120 s/);
    expect(applySettle(report, DEFAULT, T0 + CHECK_SETTLE_MS, T0).verdict).toBe('green');
  });

  it('a check without a timestamp counts from when the watch first read the head; a read without history fails closed', () => {
    const report = evaluateChecks(1, [{ name: 'ci/external', state: 'SUCCESS' }], DEFAULT);
    expect(applySettle(report, DEFAULT, T0 + CHECK_SETTLE_MS, T0).verdict).toBe('green');
    expect(applySettle(report, DEFAULT, T0 + CHECK_SETTLE_MS, undefined).verdict).toBe('pending');
  });

  it('every reported check must pass: a failed one is failed as before', () => {
    expect(evaluateChecks(1, [done('check', T0), done('lint', T0, 'FAILURE')], DEFAULT).verdict).toBe('failed');
  });

  it('no check and no run at all: green with the no-CI note only after the settle window, never on a read without history', async () => {
    const c = clock();
    const r = await watchGates({ exec: noExec, pr: 1, config: DEFAULT, known: [], headSha: HEAD, watch: true, forge: forge(() => []), ...c });
    expect(r.report.verdict).toBe('green');
    expect(r.report.noChecks).toBe(true);
    expect(r.report.pending).toEqual([]);
    expect(r.report.suggestions.join('\n')).toContain(NO_CI_CHECKS_NOTE);
    expect(c.now() - T0).toBeGreaterThanOrEqual(CHECK_SETTLE_MS);
    const once = await watchGates({ exec: noExec, pr: 1, config: DEFAULT, known: [], headSha: HEAD, watch: false, forge: forge(() => []), ...clock() });
    expect(once.report.verdict).toBe('pending');
    expect(once.report.pending).toEqual([NO_WORKFLOWS_TRIGGERED]);
  });

  it('a check that appears late inside the window is waited for and judged', async () => {
    const c = clock();
    // Nothing for the first minute, then a late external check that fails.
    const checks = () => (c.now() - T0 >= 60_000 ? [done('ci/late', c.now(), 'FAILURE')] : []);
    const r = await watchGates({ exec: noExec, pr: 1, config: DEFAULT, known: [], headSha: HEAD, watch: true, forge: forge(checks), ...c });
    expect(r.report.verdict).toBe('failed');
    expect(r.report.failed).toEqual(['ci/late']);
  });

  it('an open workflow run keeps the gates pending (a late needs: job), as before', () => {
    const open: WorkflowRun[] = [{ databaseId: 7, status: 'in_progress', workflowName: 'CI', headSha: HEAD }];
    return watchGates({ exec: noExec, pr: 1, config: { ...DEFAULT, watchTimeoutMinutes: 5 }, known: [], headSha: HEAD, watch: true, forge: forge(() => [done('check', T0)], () => open), ...clock() })
      .then((r) => {
        expect(r.timedOut).toBe(true);
        expect(r.report.pending).toEqual(['workflow run CI (in_progress)']);
      });
  });
});

describe('M1: a configured (or branch-protection) name that never reports', () => {
  it('is missing, with how to fix it, once every reported check completed and the window passed', () => {
    const base = evaluateChecks(1, [done('check', T0)], NAMED);
    expect(base.pending).toEqual(['lint']);
    expect(applySettle(base, NAMED, T0 + CHECK_SETTLE_MS - 1, T0).missing).toBeUndefined();
    const settled = applySettle(base, NAMED, T0 + CHECK_SETTLE_MS, T0);
    expect(settled.verdict).toBe('pending');
    expect(settled.missing).toEqual(['lint']);
    expect(settled.suggestions.join('\n')).toContain('required check(s) lint never reported for this head: no CI job has that name; fix ship.requiredChecks in your user config or in the base branch');
    const fromProtection = applySettle(base, { ...NAMED, requiredChecksFrom: 'branch-protection' }, T0 + CHECK_SETTLE_MS, T0);
    expect(fromProtection.suggestions.join('\n')).toContain('protection requires them');
  });

  it('is not missing while another check is still pending, or after a failure', () => {
    const running = evaluateChecks(1, [done('check', T0), { name: 'test', state: 'IN_PROGRESS', startedAt: iso(T0) }], NAMED);
    expect(applySettle(running, NAMED, T0 + 10 * CHECK_SETTLE_MS, T0).missing).toBeUndefined();
    const failed = evaluateChecks(1, [done('check', T0, 'FAILURE')], NAMED);
    expect(applySettle(failed, NAMED, T0 + 10 * CHECK_SETTLE_MS, T0).missing).toBeUndefined();
  });

  it('watchGates returns at once with stopOnMissing (the factory) and polls on to its timeout without it (omg ship, omg release)', async () => {
    const f = forge(() => [done('check', T0)]);
    const stop = await watchGates({ exec: noExec, pr: 1, config: NAMED, known: [], headSha: HEAD, watch: true, forge: f, stopOnMissing: true, ...clock() });
    expect(stop.timedOut).toBe(false);
    expect(stop.report.missing).toEqual(['lint']);
    const c = clock();
    const on = await watchGates({ exec: noExec, pr: 1, config: NAMED, known: [], headSha: HEAD, watch: true, forge: f, ...c });
    expect(on.timedOut).toBe(true);
    expect(c.now() - T0).toBe(NAMED.watchTimeoutMinutes * 60_000);
  });

  it('the settle clock a caller keeps survives watch windows', async () => {
    const settle = {};
    const f = forge(() => [{ name: 'check', state: 'SUCCESS' }]);
    const c = clock();
    const short = { ...NAMED, watchTimeoutMinutes: 1 };
    const first = await watchGates({ exec: noExec, pr: 1, config: short, known: [], headSha: HEAD, watch: true, forge: f, stopOnMissing: true, settle, ...c });
    expect(first.timedOut).toBe(true);
    const second = await watchGates({ exec: noExec, pr: 1, config: short, known: [], headSha: HEAD, watch: true, forge: f, stopOnMissing: true, settle, ...c });
    expect(second.report.missing).toEqual(['lint']);
    expect(c.now() - T0).toBeLessThanOrEqual(2 * 60_000 + 30_000);
  });
});
