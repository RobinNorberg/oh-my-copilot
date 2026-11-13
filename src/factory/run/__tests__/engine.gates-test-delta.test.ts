/**
 * The built-in vitest prepare check in the OS sandbox, judged per test
 * against the trusted base (test-delta.ts): a test that fails in the sandbox
 * on the base too is listed, not counted; a test the base passed (or a new
 * one) still fails the head; without a base report the run parks as before.
 * The engine on the local forge with fake lanes and a fake sandbox that
 * writes vitest's JSON report where the engine asked for it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import { VITEST_SCRIPT } from '../../../ship/prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { readFactoryState } from '../state.js';
import { BASE_FAILURES_MAX, testId, testIdText } from '../test-delta.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';

const MULTI_RUN_MS = 300_000;
const TEST_FILE = 'src/release/engine.test.ts';
const KILL = 'a timeout kills the whole child tree';
let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const PASS: SandboxRunResult = { ran: true, status: 0, output: 'ok', timedOut: false };

/** A base with vitest in an ignored node_modules and the test file committed: the built-in tests check runs it. */
function vitestWorld(): LocalWorld {
  const world = localWorld();
  appendFileSync(join(world.root, '.gitignore'), 'node_modules\n');
  mkdirSync(join(world.root, 'src', 'release'), { recursive: true });
  writeFileSync(join(world.root, TEST_FILE), 'base\n');
  gitIn(world.root, 'add', '.');
  gitIn(world.root, 'commit', '-q', '-m', 'tests');
  mkdirSync(join(world.root, VITEST_SCRIPT, '..'), { recursive: true });
  writeFileSync(join(world.root, VITEST_SCRIPT), '\n');
  return world;
}

type Results = Record<string, 'passed' | 'failed'>;

/** vitest's JSON report of TEST_FILE in `cwd`, as the real reporter writes it (absolute forward-slash file names). */
const reportOf = (cwd: string, results: Results) => JSON.stringify({
  success: false,
  testResults: [{
    name: `${cwd.replace(/\\/g, '/')}/${TEST_FILE}`,
    status: Object.values(results).includes('failed') ? 'failed' : 'passed',
    message: '',
    assertionResults: Object.entries(results).map(([title, status]) => ({ ancestorTitles: ['release'], fullName: `release ${title}`, title, status, failureMessages: [] })),
  }],
});

/**
 * The fake sandbox: the vitest check writes `base` (calibration) or `head`
 * as its report and fails when a test failed; `base: null` writes none.
 * `headOutput`: more console output of the head run; `headThrows`: the head
 * run writes its report, then the sandbox call throws.
 */
function sandbox(base: Results | null, head: Results, more: { headOutput?: string; headThrows?: true } = {}) {
  const reqs: SandboxRunRequest[] = [];
  const strays: string[] = [];
  const run: SandboxRunner = async (req) => {
    reqs.push(req);
    // No report file is left in a checkout once a check is over.
    if (req.purpose === 'gate') strays.push(...readdirSync(req.cwd).filter((f) => f.startsWith('.omg-vitest-report-')));
    if (req.args[0] !== VITEST_SCRIPT) return PASS;
    const results = req.purpose === 'calibrate' ? base : head;
    const out = req.args.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length);
    if (results && out) writeFileSync(out, reportOf(req.cwd, results));
    if (req.purpose === 'prepare' && more.headThrows) throw new Error('the sandbox runtime went away');
    const failed = Object.values(results ?? { x: 'failed' }).includes('failed');
    const extra = req.purpose === 'prepare' ? more.headOutput ?? '' : '';
    return { ran: true, status: failed ? 1 : 0, output: failed ? ` FAIL  ${TEST_FILE} > release > something\n${extra}` : 'ok', timedOut: false };
  };
  return { reqs, strays, run };
}

/** A test's readable id (the hash part of the stored id left out). */
const readable = (ids: readonly string[] | undefined) => (ids ?? []).map(testIdText);

const opts = (run: SandboxRunner, warn?: (m: string) => void) =>
  localOpts(w, lanesFor(w, [commitFile(TEST_FILE, 'head\n'), review('approve')]), { gateSandbox: run, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxCiFixRounds: 0 }, ...(warn ? { warn } : {}) });

describe('the built-in vitest check judged per test against the base', () => {
  it('a test that fails on the base too is not counted: prepare passes, the base failure is noted, nothing parks', async () => {
    w = vitestWorld();
    const warnings: string[] = [];
    const s = sandbox({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed', 'a new test': 'passed' });
    const out = await runFactoryEngine(opts(s.run, (m) => warnings.push(m)));
    expect(out.gate?.name, out.message).toBe('merge');
    // The head ran with the report args; the base calibration too, on its own copy.
    const vitest = s.reqs.filter((r) => r.args[0] === VITEST_SCRIPT);
    expect(vitest.map((r) => r.purpose)).toEqual(['prepare', 'calibrate']);
    for (const r of vitest) expect(r.args).toEqual(expect.arrayContaining(['--reporter=default', '--reporter=json']));
    expect(vitest[0].args.slice(0, 3)).toEqual([VITEST_SCRIPT, 'run', TEST_FILE]);
    // The record of what ran (argv) is the check's own, without the report file.
    expect(vitest[0].argv.some((a) => a.startsWith('--outputFile='))).toBe(false);
    expect(s.strays).toEqual([]);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    const note = `1 test(s) fail in the OS sandbox on the base`;
    expect(state.history.some((h) => h.note.includes(note) && h.note.includes(`${TEST_FILE} > release > ${KILL}`))).toBe(true);
    expect(warnings.join('\n')).toContain('and were not counted');
    const cal = Object.values(state.gateCalibration ?? {});
    expect(cal).toEqual([expect.objectContaining({ ok: false, tests: { passed: 1, failed: [testId([TEST_FILE, 'release', KILL])], brokenFiles: [] } })]);
    expect(readable(cal[0].tests?.failed)).toEqual([`${TEST_FILE} > release > ${KILL}`]);
    // L3: this head passed only because a base failure was not counted, so auto-merge refuses it.
    expect(state.testDeltaExcusedHead).toMatch(/^[0-9a-f]{40}$/);
  }, MULTI_RUN_MS);

  it('M1: a colored "Errors  1 error" line on the head only fails the head even though its one failing test is excused', async () => {
    w = vitestWorld();
    const colored = '\x1b[2m     Errors \x1b[22m \x1b[1m\x1b[31m1 error\x1b[39m\x1b[22m\n';
    const s = sandbox({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed' }, { headOutput: colored });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.ciFailure?.detail).toContain('errors outside any test');
    expect(state.testDeltaExcusedHead).toBeUndefined();
  }, MULTI_RUN_MS);

  it('M1: a coverage threshold the head misses fails the head', async () => {
    w = vitestWorld();
    const s = sandbox({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed' }, { headOutput: 'ERROR: Coverage for lines (12%) does not meet global threshold (80%)\n' });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.ciFailure?.detail).toContain('a coverage threshold is not met');
  }, MULTI_RUN_MS);

  it(`a base with more than ${BASE_FAILURES_MAX} failing tests keeps today's park`, async () => {
    w = vitestWorld();
    const many: Results = Object.fromEntries(Array.from({ length: BASE_FAILURES_MAX + 1 }, (_, i) => [`broken ${i}`, 'failed' as const]));
    const s = sandbox({ ...many, plans: 'passed' }, { ...many, plans: 'passed' });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(Object.values(state.gateCalibration ?? {}).every((c) => c.tests === undefined)).toBe(true);
    expect(state.testDeltaExcusedHead).toBeUndefined();
  }, MULTI_RUN_MS);

  it('L4: a sandbox call that throws after vitest wrote its report leaves no report file in the checkout', async () => {
    w = vitestWorld();
    const s = sandbox({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed' }, { headThrows: true });
    await runFactoryEngine(opts(s.run)).catch(() => undefined);
    const head = s.reqs.find((r) => r.purpose === 'prepare' && r.args[0] === VITEST_SCRIPT);
    expect(head).toBeDefined();
    expect(existsSync(head!.cwd)).toBe(true);
    expect(readdirSync(head!.cwd).filter((f) => f.startsWith('.omg-vitest-report-'))).toEqual([]);
  }, MULTI_RUN_MS);

  it('a test the base passed fails on the head: a FAILURE of prepare tests that names it (ci-fix material), no park', async () => {
    w = vitestWorld();
    const s = sandbox({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'failed' });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.ciFailure?.checks).toEqual(['prepare tests']);
    expect(state.ciFailure?.detail).toContain(`1 test(s) fail on ${state.head!.slice(0, 12)} that did not fail on the base`);
    expect(state.ciFailure?.detail).toContain(`${TEST_FILE} > release > plans`);
  }, MULTI_RUN_MS);

  it('a new test that fails on the head counts', async () => {
    w = vitestWorld();
    const s = sandbox({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed', 'a new test': 'failed' });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.ciFailure?.detail).toContain(`${TEST_FILE} > release > a new test`);
  }, MULTI_RUN_MS);

  it('no base report: today\'s gate-sandbox-incompatible park, no ci-fix lane', async () => {
    w = vitestWorld();
    const s = sandbox(null, { [KILL]: 'failed', plans: 'passed' });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.ciFailure).toBeUndefined();
  }, MULTI_RUN_MS);

  it('every selected test fails on the base: today\'s park', async () => {
    w = vitestWorld();
    const s = sandbox({ [KILL]: 'failed', plans: 'failed' }, { [KILL]: 'failed', plans: 'failed' });
    const out = await runFactoryEngine(opts(s.run));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
  }, MULTI_RUN_MS);
});
