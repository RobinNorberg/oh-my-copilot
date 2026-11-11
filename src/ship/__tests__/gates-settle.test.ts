import { describe, expect, it } from 'vitest';
import { resolveShipConfig, type ShipConfig } from '../config.js';
import { applySettle, CHECK_SETTLE_MS, evaluateChecks, NO_CI_CHECKS_NOTE, NO_WORKFLOWS_TRIGGERED, watchGates, type GateForge, type GateHeadReads, type GhCheck, type WorkflowRun } from '../gates.js';
import type { Exec } from '../exec.js';

const HEAD = 'a'.repeat(40);
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const DEFAULT: ShipConfig = resolveShipConfig(undefined);
const NAMED: ShipConfig = resolveShipConfig({ requiredChecks: ['check', 'lint'], advisoryChecks: [] });
const done = (name: string, at: number, state = 'SUCCESS'): GhCheck => ({ name, state, startedAt: iso(at - 20_000), completedAt: iso(at) });
const noExec: Exec = () => { throw new Error('no gh call expected: the forge answers'); };
/** GitHub reads where the base commit reported no check and the head has no suite. */
const NO_CI_BASE: GateHeadReads = { baseChecks: () => [], ciDefinitions: () => [], suites: () => [], baseSuites: () => [], runApps: () => undefined };

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

  it('no check and no run at all: green with the no-CI note only after the settle window when the base commit reported no check either, never on a read without history', async () => {
    const c = clock();
    const r = await watchGates({ exec: noExec, pr: 1, config: DEFAULT, known: [], headSha: HEAD, watch: true, forge: forge(() => []), reads: NO_CI_BASE, ...c });
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

describe('review-493 fix round 1: no-CI only when the base ran none, NEUTRAL, check suites, required apps', () => {
  const reads = (o: Partial<GateHeadReads>): GateHeadReads => ({ ...NO_CI_BASE, ...o });
  const short = resolveShipConfig({ watchTimeoutMinutes: 10 });

  it('HIGH-1: a base with checks and a head with none stays pending past the window, saying the base ran CI', async () => {
    const c = clock();
    const r = await watchGates({ exec: noExec, pr: 1, config: short, known: [], headSha: HEAD, watch: true, forge: forge(() => []), reads: reads({ baseChecks: () => ['Build', 'Test', 'Lint', 'a', 'b', 'c'] }), ...c });
    expect(r.timedOut).toBe(true);
    expect(c.now() - T0).toBeGreaterThan(CHECK_SETTLE_MS);
    expect(r.report.verdict).toBe('pending');
    expect(r.report.noChecks).toBeUndefined();
    expect(r.report.pending).toEqual([NO_WORKFLOWS_TRIGGERED]);
    expect(r.report.noHeadChecks).toEqual({ base: ['Build', 'Test', 'Lint', 'a', 'b', 'c'] });
    const text = r.report.suggestions.join('\n');
    expect(text).toContain('the base commit ran CI (Build, Test, Lint, a, b, and 1 more) but nothing has reported for this head: Actions may be disabled, delayed, or the push did not trigger workflows');
    expect(text).not.toContain(NO_CI_CHECKS_NOTE);
  });

  it('HIGH-1: a base read failure (or no GitHub reads at all) never grants "no CI"', async () => {
    for (const r of [reads({ baseChecks: () => undefined }), undefined]) {
      const c = clock();
      const out = await watchGates({ exec: noExec, pr: 1, config: short, known: [], headSha: HEAD, watch: true, forge: forge(() => []), ...(r ? { reads: r } : {}), ...c });
      expect(out.report.verdict).toBe('pending');
      expect(out.report.noHeadChecks).toEqual({});
      expect(out.report.suggestions.join('\n')).toContain("the base commit's checks could not be read");
    }
  });

  it('M-1: a NEUTRAL check run passes; STALE, CANCELLED, TIMED_OUT and ACTION_REQUIRED stay failed', () => {
    expect(evaluateChecks(1, [done('codeql', T0, 'NEUTRAL')], DEFAULT).verdict).toBe('green');
    for (const state of ['STALE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']) expect(evaluateChecks(1, [done('x', T0, state)], DEFAULT).verdict).toBe('failed');
  });

  it('M-2: a queued Actions suite with no runs yet keeps the gates pending past the window', () => {
    const green = evaluateChecks(1, [done('check', T0)], DEFAULT);
    const late = T0 + 10 * CHECK_SETTLE_MS;
    const r = applySettle(green, DEFAULT, late, T0, reads({ suites: () => [{ status: 'queued', app: 'github-actions', runs: 0 }] }), HEAD);
    expect(r.verdict).toBe('pending');
    expect(r.pending).toEqual(['check suite github-actions (queued)']);
    // A head with nothing reported is not "no CI" while that suite is queued either.
    const none = applySettle({ ...evaluateChecks(1, [], DEFAULT), pending: [NO_WORKFLOWS_TRIGGERED] }, DEFAULT, late, T0, reads({ suites: () => [{ status: 'in_progress', runs: 0 }] }), HEAD);
    expect(none.verdict).toBe('pending');
    expect(none.noChecks).toBeUndefined();
  });

  it('M-2: an idle third-party suite (queued, no runs) blocks only inside the window; an unreadable suite list keeps the window rule', () => {
    const green = evaluateChecks(1, [done('check', T0)], DEFAULT);
    const idle = reads({ suites: () => [{ status: 'queued', app: 'some-app', runs: 0 }, { status: 'completed', app: 'github-actions', runs: 3 }] });
    expect(applySettle(green, DEFAULT, T0 + 30_000, T0, idle, HEAD).verdict).toBe('pending');
    expect(applySettle(green, DEFAULT, T0 + CHECK_SETTLE_MS, T0, idle, HEAD).verdict).toBe('green');
    // A third-party suite that is running (or has runs) blocks after the window too.
    expect(applySettle(green, DEFAULT, T0 + CHECK_SETTLE_MS, T0, reads({ suites: () => [{ status: 'in_progress', app: 'some-app', runs: 1 }] }), HEAD).verdict).toBe('pending');
    expect(applySettle(green, DEFAULT, T0 + CHECK_SETTLE_MS, T0, reads({ suites: () => undefined }), HEAD).verdict).toBe('green');
  });

  it('M-3: a required check bound to an app is satisfied only by a check run of that app; unreadable runs keep name matching', async () => {
    const config = resolveShipConfig({ requiredChecks: ['build'], advisoryChecks: [] });
    const bound = { ...config, requiredCheckApps: { build: 15368 } };
    const run = async (r: GateHeadReads, cfg: ShipConfig) => (await watchGates({ exec: noExec, pr: 1, config: cfg, known: [], headSha: HEAD, watch: false, forge: forge(() => [done('build', T0)]), reads: r, ...clock(T0 + CHECK_SETTLE_MS) })).report;
    const other = await run(reads({ runApps: () => [{ name: 'build', appId: 999 }] }), bound);
    expect(other.verdict).toBe('pending');
    expect(other.pending).toEqual(['build (required from GitHub App 15368; no check run of that app reported it)']);
    expect((await run(reads({ runApps: () => [{ name: 'build', appId: 15368 }] }), bound)).verdict).toBe('green');
    expect((await run(reads({ runApps: () => undefined }), bound)).verdict).toBe('green');
    expect((await run(reads({ runApps: () => [{ name: 'build', appId: 999 }] }), config)).verdict).toBe('green');
  });
});

describe('review-493b fix round 2: no-CI needs no CI definition and a readable empty suite list; idle apps judged by the base', () => {
  const reads = (o: Partial<GateHeadReads>): GateHeadReads => ({ ...NO_CI_BASE, ...o });
  const short = resolveShipConfig({ watchTimeoutMinutes: 10 });
  const watch = async (r: GateHeadReads) => {
    const c = clock();
    const out = await watchGates({ exec: noExec, pr: 1, config: short, known: [], headSha: HEAD, watch: true, forge: forge(() => []), reads: r, ...c });
    return { out, elapsed: c.now() - T0 };
  };

  it('B-1(a): a workflow in the tree, a base without checks (pull_request-only CI) and a silent head stay pending past the window', async () => {
    const { out, elapsed } = await watch(reads({ ciDefinitions: () => ['.github/workflows/x.yml'] }));
    expect(out.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThan(CHECK_SETTLE_MS);
    expect(out.report.verdict).toBe('pending');
    expect(out.report.noChecks).toBeUndefined();
    expect(out.report.noHeadChecks).toEqual({ base: [], ciDefinitions: ['.github/workflows/x.yml'] });
    const text = out.report.suggestions.join('\n');
    expect(text).toContain('this repository has CI definitions (.github/workflows/x.yml) but nothing reported for this commit');
    expect(text).not.toContain(NO_CI_CHECKS_NOTE);
  });

  it('B-1(a): a tree read failure never grants "no CI"', async () => {
    const { out } = await watch(reads({ ciDefinitions: () => undefined }));
    expect(out.report.verdict).toBe('pending');
    expect(out.report.noHeadChecks).toEqual({ base: [], ciDefinitions: [] });
    expect(out.report.suggestions.join('\n')).toContain('the CI definitions in the base and head trees could not be read');
  });

  it('B-1(b): an unreadable suite list never grants "no CI"', async () => {
    const { out } = await watch(reads({ suites: () => undefined }));
    expect(out.report.verdict).toBe('pending');
    expect(out.report.noChecks).toBeUndefined();
    expect(out.report.noHeadChecks).toEqual({ base: [], suites: 'unreadable' });
    expect(out.report.suggestions.join('\n')).toContain('its check suites could not be read');
  });

  it('no CI definition anywhere, base and head without checks, suites read and empty: green with the note', async () => {
    const { out } = await watch(reads({}));
    expect(out.report.verdict).toBe('green');
    expect(out.report.noChecks).toBe(true);
    expect(out.report.suggestions.join('\n')).toContain(NO_CI_CHECKS_NOTE);
  });

  it('N-1: a queued 0-run suite of an app that ran checks on the base keeps the gates pending; an app idle on both stops blocking', () => {
    const green = evaluateChecks(1, [done('check', T0)], DEFAULT);
    const late = T0 + 10 * CHECK_SETTLE_MS;
    const head = () => [{ status: 'queued', app: 'buildkite', runs: 0 }, { status: 'completed', app: 'github-actions', runs: 3 }];
    const ranOnBase = applySettle(green, DEFAULT, late, T0, reads({ suites: head, baseSuites: () => [{ status: 'completed', app: 'buildkite', runs: 2 }] }), HEAD);
    expect(ranOnBase.verdict).toBe('pending');
    expect(ranOnBase.pending).toEqual(['check suite buildkite (queued)']);
    expect(applySettle(green, DEFAULT, late, T0, reads({ suites: head, baseSuites: () => [{ status: 'queued', app: 'buildkite', runs: 0 }] }), HEAD).verdict).toBe('green');
    // An unreadable base suite list keeps the app blocking (fail closed).
    expect(applySettle(green, DEFAULT, late, T0, reads({ suites: head, baseSuites: () => undefined }), HEAD).verdict).toBe('pending');
  });
});
