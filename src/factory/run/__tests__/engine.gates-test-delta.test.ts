/**
 * The built-in vitest prepare check in the OS sandbox, judged per test
 * against the trusted base (test-delta.ts): a test that fails in the sandbox
 * on the base too is listed, not counted; a test the base passed (or a new
 * one) still fails the head; without a base report the run parks as before.
 * The engine on the local forge with fake lanes and a fake sandbox that
 * writes vitest's JSON report where the engine asked for it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { CONTAINER_SRC } from '../container-gate.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import type { LocalGateRunner } from '../local-gate.js';
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

/** vitest's console output of a run of TEST_FILE: a FAIL line and the summary (N3: a run without one parks). */
const outputOf = (results: Results) => {
  const failed = Object.values(results).filter((s) => s === 'failed').length;
  const total = Object.keys(results).length;
  return ` FAIL  ${TEST_FILE} > release > something\n\n Test Files  1 failed (1)\n      Tests  ${failed} failed | ${total - failed} passed (${total})\n`;
};

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
    return { ran: true, status: failed ? 1 : 0, output: failed ? `${outputOf(results ?? { x: 'failed' })}${extra}` : 'ok', timedOut: false };
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
    expect(cal).toEqual([expect.objectContaining({ ok: false, tests: { passed: 1, failed: [testId([TEST_FILE, 'release', KILL])], brokenFiles: [], failedFiles: 1 } })]);
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

/** The gate container's report: file names under its /work/src, handed back as the result's `report`. */
const containerResult = (req: SandboxRunRequest, results: Results): SandboxRunResult => {
  const failed = Object.values(results).includes('failed');
  // The engine asked for the report at a host path in the run dir (the container maps it into /work/src).
  expect(req.reportFile && dirname(req.reportFile)).toBe(req.cwd);
  expect(req.args).toContain(`--outputFile=${req.reportFile}`);
  return { ran: true, status: failed ? 1 : 0, output: failed ? outputOf(results) : 'ok', timedOut: false, ...(failed ? { report: reportOf(CONTAINER_SRC, results) } : {}) };
};

describe('the same per-test verdict in the git-transport fallback\'s gate container and plain run', () => {
  const TRANSPORT_OUT = 'Error: Command failed: git push -q origin dev\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights';
  /** A declared Windows host whose OS sandbox fails the base with git's transport error and cannot start sh.exe. */
  const win32 = () => {
    const sh = join(w.dir, 'sh.exe');
    writeFileSync(sh, '');
    return { sh, host: { platform: 'win32' as const, shell: () => sh } };
  };
  /** The OS sandbox: transport failure on both; the container: `container` (or unavailable). */
  const fallbackSandbox = (sh: string, container: { base: Results; head: Results } | null) => {
    const reqs: SandboxRunRequest[] = [];
    const run: SandboxRunner = async (req) => {
      reqs.push(req);
      if (req.exe === sh) return { ran: true, status: 0xc0000142, output: '', timedOut: false };
      if (req.args[0] !== VITEST_SCRIPT) return PASS;
      if (!req.container) return { ran: true, status: 1, output: TRANSPORT_OUT, timedOut: false };
      if (!container) return { ran: false, reason: 'docker was not found', unavailable: true };
      return containerResult(req, req.purpose === 'calibrate' ? container.base : container.head);
    };
    return { reqs, run };
  };
  /** The plain runner: the vitest check writes its report where the args say, in its own run dir (head: the checkout, base: a base- dir). */
  const plainGate = (base: Results, head: Results): { runs: Array<{ argv: readonly string[]; cwd: string }>; gate: LocalGateRunner } => {
    const runs: Array<{ argv: readonly string[]; cwd: string }> = [];
    return {
      runs,
      gate: async (argv, cwd) => {
        runs.push({ argv, cwd });
        if (argv[1] !== VITEST_SCRIPT) return { status: 0, stdout: 'ok', stderr: '', timedOut: false };
        const results = basename(cwd).startsWith('base-') ? base : head;
        const out = argv.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length);
        if (out) writeFileSync(out, reportOf(cwd, results));
        const failed = Object.values(results).includes('failed');
        return { status: failed ? 1 : 0, stdout: failed ? outputOf(results) : 'ok', stderr: '', timedOut: false };
      },
    };
  };
  const fallbackOpts = (run: SandboxRunner, host: ReturnType<typeof win32>['host'], gate: LocalGateRunner, warn: (m: string) => void, lanes = lanesFor(w, [commitFile(TEST_FILE, 'head\n'), review('approve')])) =>
    localOpts(w, lanes, { gateSandbox: run, gateSandboxUserConfig: {}, gitTransportHost: host, localGate: gate, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxCiFixRounds: 0 }, warn });

  it('the gate container: the base fails there too, the same test only: the head passes on the container\'s verdict', async () => {
    w = vitestWorld();
    const { sh, host } = win32();
    const s = fallbackSandbox(sh, { base: { [KILL]: 'failed', plans: 'passed' }, head: { [KILL]: 'failed', plans: 'passed' } });
    const p = plainGate({}, {});
    const warnings: string[] = [];
    const out = await runFactoryEngine(fallbackOpts(s.run, host, p.gate, (m) => warnings.push(m)));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(p.runs.filter((r) => r.argv[1] === VITEST_SCRIPT)).toEqual([]);
    const text = warnings.join('\n');
    expect(text).toMatch(/1 test\(s\) fail in the gate container \(docker node:\d+-bookworm\) on the base/);
    expect(text).not.toContain('it fails there on the base too');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.testDeltaExcusedHead).toMatch(/^[0-9a-f]{40}$/);
    expect(state.gitTransportPlainHead).toBeUndefined();
  }, MULTI_RUN_MS);

  it('the gate container: a test the base passed there fails on the head: a FAILURE, nothing runs plainly', async () => {
    w = vitestWorld();
    const { sh, host } = win32();
    const s = fallbackSandbox(sh, { base: { [KILL]: 'failed', plans: 'passed' }, head: { [KILL]: 'failed', plans: 'failed' } });
    const p = plainGate({}, {});
    const out = await runFactoryEngine(fallbackOpts(s.run, host, p.gate, () => undefined));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.ciFailure?.detail).toContain(`${TEST_FILE} > release > plans`);
    expect(p.runs.filter((r) => r.argv[1] === VITEST_SCRIPT)).toEqual([]);
  }, MULTI_RUN_MS);

  it('the plain run (no container): the base fails plainly on the same test only: the head passes, flagged twice for auto-merge (run #536)', async () => {
    w = vitestWorld();
    const { sh, host } = win32();
    const s = fallbackSandbox(sh, null);
    const p = plainGate({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed', 'a new test': 'passed' });
    const warnings: string[] = [];
    const out = await runFactoryEngine(fallbackOpts(s.run, host, p.gate, (m) => warnings.push(m)));
    expect(out.gate?.name, out.message).toBe('merge');
    const vitest = p.runs.filter((r) => r.argv[1] === VITEST_SCRIPT);
    expect(vitest.map((r) => basename(r.cwd).startsWith('base-'))).toEqual([false, true]);
    for (const r of vitest) expect(r.argv.some((a) => a.startsWith(`--outputFile=${r.cwd}`))).toBe(true);
    // No report file is left in the head's checkout.
    expect(readdirSync(vitest[0].cwd).filter((f) => f.startsWith('.omg-vitest-report-'))).toEqual([]);
    expect(warnings.join('\n')).toMatch(/1 test\(s\) fail in a plain run \(no sandbox\) on the base [0-9a-f]{12} too and were not counted/);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.testDeltaExcusedHead).toMatch(/^[0-9a-f]{40}$/);
    expect(state.gitTransportPlainHead).toBe(state.testDeltaExcusedHead);
  }, MULTI_RUN_MS);

  it('the plain run: a new failure counts (ci-fix material); a plain base without a report keeps today\'s park', async () => {
    w = vitestWorld();
    const { sh, host } = win32();
    const p = plainGate({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'failed' });
    const out = await runFactoryEngine(fallbackOpts(fallbackSandbox(sh, null).run, host, p.gate, () => undefined));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.ciFailure?.detail).toContain(`${TEST_FILE} > release > plans`);
    rmSync(w.dir, { recursive: true, force: true });

    w = vitestWorld();
    const w2 = win32();
    const q = plainGate({ [KILL]: 'failed', plans: 'passed' }, { [KILL]: 'failed', plans: 'passed' });
    // The base's plain run writes no report (an old vitest, a config that drops reporters).
    const noBaseReport: LocalGateRunner = async (argv, cwd, ...rest) => (basename(cwd).startsWith('base-') ? q.gate(argv.filter((a) => !a.startsWith('--outputFile=')), cwd, ...rest) : q.gate(argv, cwd, ...rest));
    const parked = await runFactoryEngine(fallbackOpts(fallbackSandbox(w2.sh, null).run, w2.host, noBaseReport, () => undefined));
    expect(parked.gate?.name, parked.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(parked.gate?.reason).toContain('fails in a plain run (no sandbox) on the base');
  }, 2 * MULTI_RUN_MS);
});
