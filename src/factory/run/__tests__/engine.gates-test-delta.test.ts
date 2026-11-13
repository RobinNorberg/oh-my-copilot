/**
 * The built-in vitest prepare check in the OS sandbox, judged per test
 * against the trusted base (test-delta.ts): a test that fails in the sandbox
 * on the base too is listed, not counted; a test the base passed (or a new
 * one) still fails the head; without a base report the run parks as before.
 * The engine on the local forge with fake lanes and a fake sandbox that
 * writes vitest's JSON report where the engine asked for it.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import { VITEST_SCRIPT } from '../../../ship/prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { readFactoryState } from '../state.js';
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
 */
function sandbox(base: Results | null, head: Results) {
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
    const failed = Object.values(results ?? { x: 'failed' }).includes('failed');
    return { ran: true, status: failed ? 1 : 0, output: failed ? ` FAIL  ${TEST_FILE} > release > something` : 'ok', timedOut: false };
  };
  return { reqs, strays, run };
}

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
    expect(Object.values(state.gateCalibration ?? {})).toEqual([expect.objectContaining({ ok: false, tests: { passed: 1, failed: [`${TEST_FILE} > release > ${KILL}`], brokenFiles: [] } })]);
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
