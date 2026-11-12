/**
 * `omg factory bench run`: drive the factory over the bench fixture until
 * every issue is terminal, parked or never runnable, or a cap is hit; then
 * score each issue (score.ts) and write `<out>/<timestamp>.json` + `.md`.
 *
 * - `--fake`: in-process. Each pick is omg factory check's order over the
 *   fixture backlog (the same rules `run --next` uses), each run is
 *   runFactoryEngine with the issue's scripted lanes (fake-lanes.ts), the
 *   engine's own state, ledger and forge state under the bench dir, no user
 *   config. Prepare checks, the local gate and the acceptance run as plain
 *   processes: every line of code in the fixture is the bench's own. Zero cost.
 * - `--live --max-requests N`: real Copilot. The bench picks like `run
 *   --next` (omg factory check's order, limited to `--issues`) and starts a
 *   child `omg factory run <id> --json --max-requests <left>` in the fixture
 *   repository (poll's auto-start child), so the user's own factory config,
 *   sandbox and lanes apply; with `--parallel N` up to N children at once
 *   (each takes a run slot: the user config must enable parallel runs). The
 *   per-run cap is HARD in the engine (budget.ts nextLaneCap): no lane starts
 *   once the run's lanes recorded the cap, or when a lane's usage is unknown.
 *   Usage is the largest of the fixture budget ledger's delta, the lanes in
 *   the run states and MIN_RUN_REQUESTS per finished run. The remaining bound:
 *   each run can finish the one lane in flight when it reaches its cap. A run
 *   in flight is never killed (on Windows a kill orphans its Copilot child).
 *   The acceptance runs in the gate sandbox (createSandboxRunner, no model
 *   turn); --live refuses unless the gate sandbox is enforced (or the
 *   container isolation is on).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ledgerPath, ledgerTotals, parseLedger } from '../../budget/ledger.js';
import { resolveGatesSandboxMode } from '../../copilot-run/sandbox.js';
import { createForge } from '../../forge/index.js';
import { resolveForgeConfig } from '../../forge/config.js';
import { LOCAL_REMOTE, readMirrorRef } from '../../forge/local/index.js';
import type { ResolvedForgeConfig } from '../../forge/types.js';
import { getRuntimePackageVersion } from '../../lib/version.js';
import { loadBaseKnownFlaky, loadTrustedShipConfig, readBaseFile, userConfigLayers } from '../../ship/config.js';
import { defaultExec, TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { checkEnvFor, forgeReadExec, localBase, readForgeOptions } from '../check/cli.js';
import { checkItems, type CheckResult } from '../check/score.js';
import { defaultPollAutoStart, pollParallel, type PollAutoStart } from '../poll.js';
import { DEFAULT_FACTORY_RUN_LIMITS, laneRequestsUnknown } from '../run/budget.js';
import { runFactoryEngine } from '../run/engine.js';
import { factoryForgeOptions, loadFactoryForgeConfig } from '../run/forge-roots.js';
import { defaultLedgerDir } from '../run/ledger.js';
import { defaultLocalGateRunner, resolveLocalGateArgv } from '../run/local-gate.js';
import { linkNodeModules, unlinkNodeModules, type GateConfigLoader } from '../run/prepare.js';
import { createSandboxRunner, type SandboxRunner } from '../run/sandbox-exec.js';
import { factoryBranch, readFactoryState, type FactoryRunState } from '../run/state.js';
import { factoryGuardExec } from '../run/exec.js';
import { BENCH_FAKE_PROCESSES, BenchFakeLanes } from './fake-lanes.js';
import { fillPlaceholders, readFixtureMeta, removeBenchDir, type BenchFixtureMeta } from './fixture.js';
import { multiplierRefusal, probeLaneModel, type BenchModelProbe } from './model-probe.js';
import { BENCH_ISSUES, type BenchIssue } from './seed/issues.js';
import { ACCEPTANCE_TEST_PATH, BENCH_FIXTURE_VERSION } from './seed/project.js';
import {
  BENCH_RESULTS_KIND, BENCH_RESULTS_SCHEMA_VERSION, computeTotals, issuePasses, laneUsage, outcomeOf, phaseTimes, renderResultsMarkdown, trapContainment, trapVerdict,
  type BenchAcceptance, type BenchIssueResult, type BenchResults,
} from './score.js';

/** The fewest premium requests a run spends (an implement and a review lane): the headroom a live start needs. */
export const MIN_RUN_REQUESTS = 2;
export const DEFAULT_BENCH_MAX_MINUTES = 240;
/** How long one acceptance run may take. */
export const ACCEPTANCE_TIMEOUT_MS = 10 * 60_000;
/** Busy children (exit 6: another engine holds the lock or every slot) in a row before the bench stops. */
export const MAX_BUSY_STREAK = 3;
/** The wait after a busy child, times the streak. */
export const BUSY_BACKOFF_MS = 5_000;

/** The overshoot bound, in the results notes and the CLI help. */
export const LIVE_CAP_BOUND = 'each run gets the requests left as its own hard cap (omg factory run --max-requests): it starts no lane once its lanes recorded that many, so the bench can end above --max-requests only by the one lane each run has in flight when it reaches its cap';

export class BenchUsageError extends Error {}

export interface BenchRunOptions {
  /** The fixture dir (bench-fixture.json, made by omg factory bench init). */
  dir: string;
  mode: 'fake' | 'live';
  maxRequests?: number;
  maxCredits?: number;
  maxMinutes?: number;
  parallel?: number;
  /** Run only these issue ids (validated; recorded as the results' subset). */
  issues?: readonly number[];
  /** Where the results go (default `./bench-results`). */
  outDir?: string;
  log?: (message: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  interrupted?: () => boolean;
  /** Live: the run child (default: poll's auto-start child of this CLI entry). */
  liveStart?: PollAutoStart;
  /** Live: usage recorded in the fixture's budget ledger (default: the ledger file; an unreadable ledger throws). */
  ledger?: (root: string) => LedgerSnapshot;
  /** Live: the lanes' default Copilot model and multiplier (default: probeLaneModel, no model turn). */
  modelProbe?: BenchModelProbe;
  /** Live: the highest premium multiplier the lanes' model may have (a known one above 1 is refused without it). */
  allowMultiplier?: number;
  /** Live: where the model line goes (the CLI prints it even with --json); default `log`. */
  announce?: (message: string) => void;
  /** The runner of the acceptance gate (default: fake plain processes; live the gate sandbox). */
  acceptanceRunner?: SandboxRunner;
  /** Live: the trusted user config (default: userConfigLayers().trustedUser). */
  trustedUser?: unknown;
  /** Live: subscribe the run children to the bench's stop signal (the CLI forwards Ctrl+C). */
  signals?: (forward: (signal: NodeJS.Signals) => void) => () => void;
}

export interface BenchRunOutput {
  results: BenchResults;
  jsonPath: string;
  markdownPath: string;
}

/**
 * The fake mode's gate runner: the command as a plain process (no shell,
 * the gate's scrubbed env), for every purpose. Only the bench's own fixture
 * code ever runs through it.
 */
export const plainGateRunner: SandboxRunner = async (req) => {
  const r = await defaultLocalGateRunner(req.argv, req.cwd, req.timeoutMs);
  if (r.startError !== undefined) return { ran: false, reason: r.startError };
  return { ran: true, status: r.timedOut ? 124 : r.status, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, timedOut: r.timedOut };
};

/** Ship's strict safety-key loader on the local mirror, with no user config: the fixture's committed base only. */
const benchGateConfig: GateConfigLoader = (i) => {
  const config = loadTrustedShipConfig({
    exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true, remote: LOCAL_REMOTE, user: null, trustedUser: null, warn: i.warn,
  });
  return { config, known: loadBaseKnownFlaky(i.exec, i.root, config.trustedBaseCommit, config.knownFlakyFile) };
};

/** The fixture's committed `.copilot/omg.jsonc` at its base commit (the trusted base layer). */
function fixtureBaseConfig(meta: BenchFixtureMeta, exec: Exec = defaultExec): unknown {
  const text = readBaseFile(exec, meta.root, meta.baseSha, '.copilot/omg.jsonc');
  if (!text) throw new Error(`omg factory bench: the fixture's .copilot/omg.jsonc is missing at ${meta.baseSha.slice(0, 12)}`);
  return parseJsonc(text);
}

/** The fake mode's forge: the fixture's committed config only, its state under the bench dir. */
export function fakeForgeConfig(meta: BenchFixtureMeta, stateDir: string, exec: Exec = defaultExec): ResolvedForgeConfig {
  return resolveForgeConfig(null, fixtureBaseConfig(meta, exec), undefined, undefined, { root: meta.root, stateDir }).config;
}

/** omg factory check's verdict on every bench item, at the base (the order run --next picks in). */
export function checkBacklog(exec: Exec, root: string, base: string, config: ResolvedForgeConfig): CheckResult[] {
  const read = forgeReadExec(exec, config, root);
  const warnings: string[] = [];
  const baseSha = localBase(read.exec, root, base, warnings);
  if (!baseSha) throw new Error(warnings.join('; ') || `omg factory bench: no ${base} branch in ${root}`);
  const forge = createForge(read.exec, root, config, readForgeOptions(config, root, read.options, base, baseSha, false));
  if (!config.intake.source) throw new Error('omg factory bench: the fixture config has no factory.intake.source');
  const ids = forge.tracker.queryItems(config.intake.source, config.intake.limit);
  return checkItems(forge, ids, checkEnvFor(read.exec, root, config, base, baseSha));
}

/** `--issues 2,9,10`: known bench ids, no repeats; null for every issue. */
export function benchSubset(ids: readonly number[] | undefined): number[] | null {
  if (ids === undefined) return null;
  const known = new Set(BENCH_ISSUES.map((i) => i.id));
  if (ids.length === 0) throw new BenchUsageError('--issues needs at least one issue id');
  const bad = ids.filter((id) => !Number.isSafeInteger(id) || !known.has(id));
  if (bad.length) throw new BenchUsageError(`--issues: no bench issue ${bad.join(', ')} (the ids are ${[...known].join(', ')})`);
  if (new Set(ids).size !== ids.length) throw new BenchUsageError('--issues names an issue twice');
  return [...ids].sort((a, b) => a - b);
}

/** The CLI form of --issues: comma-separated ids. */
export function parseIssueList(raw: string): number[] {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.some((p) => !/^[1-9]\d{0,5}$/.test(p))) throw new BenchUsageError(`--issues ${JSON.stringify(raw)} is not a comma-separated list of issue ids`);
  return parts.map(Number);
}

/**
 * `--live` runs the lanes' code in prepare checks, the local gate and the
 * acceptance: it needs the gate sandbox enforced (factory.run.sandbox.gates,
 * the user config then the fixture's base), or the container isolation of
 * the user config. Null when allowed, else why not.
 */
export function liveSandboxRefusal(trustedUser: unknown, base: unknown): string | null {
  const isolation = (trustedUser as { factory?: { run?: { sandbox?: { isolation?: unknown } } } } | null | undefined)?.factory?.run?.sandbox?.isolation;
  if (isolation === 'container') return null;
  let mode: ReturnType<typeof resolveGatesSandboxMode>;
  try {
    mode = resolveGatesSandboxMode({ user: trustedUser, base, env: process.env });
  } catch (error) {
    return `the gate sandbox setting does not resolve (${error instanceof Error ? error.message : String(error)})`;
  }
  if (mode.mode === 'enforced') return null;
  return `--live runs the lanes' code in prepare checks, the local gate and the acceptance test, so it needs factory.run.sandbox.gates "enforced" (it is "${mode.mode}" from ${mode.source}) or factory.run.sandbox.isolation "container" in your user config`;
}

/** The number of `it(` / `test(` calls at a line start of a hidden test: the passes the acceptance must report. */
export const expectedTests = (test: string): number => (test.match(/^\s*(?:it|test)\(/gm) ?? []).length;

const refused = (detail: string): BenchAcceptance => ({ ran: false, passed: false, status: null, detail: `refused: ${detail}` });

/**
 * Run the issue's hidden test on a scratch clone of the PR head from the
 * mirror, through `runner`, with a harness-owned vitest config (the head's
 * vitest/vite config, setup files and aliases are never loaded) and the JSON
 * reporter: the run passes only with exit 0 and every expected test passed.
 * The clone checks out links as plain files (core.symlinks=false), and a
 * head that tracks node_modules, turns test/ into a link or a file, or
 * changes package.json `type` / `imports` is refused. Never throws.
 */
export async function runAcceptance(o: { meta: BenchFixtureMeta; benchDir: string; mirror: string; branch: string; head: string; test: string; runner: SandboxRunner; exec?: Exec; timeoutMs?: number }): Promise<BenchAcceptance> {
  const exec = o.exec ?? defaultExec;
  let scratch: string | undefined;
  let co: string | undefined;
  try {
    scratch = mkdtempSync(join(o.benchDir, 'accept-'));
    co = join(scratch, 'co');
    const noHooks = join(scratch, 'no-hooks');
    mkdirSync(noHooks);
    const clone = exec('git', ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.symlinks=false', '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', '--branch', o.branch, o.mirror, co], { env: TRUSTED_READ_ENV });
    if (clone.status !== 0) return { ran: false, passed: false, status: null, detail: `git clone of ${o.branch} failed: ${clone.stderr.trim().slice(0, 300)}` };
    const at = exec('git', ['-C', co, 'rev-parse', 'HEAD'], { env: TRUSTED_READ_ENV }).stdout.trim();
    if (at !== o.head) return { ran: false, passed: false, status: null, detail: `the mirror's ${o.branch} is ${at.slice(0, 12)}, not the recorded head ${o.head.slice(0, 12)}` };
    const lst = (p: string) => lstatSync(p, { throwIfNoEntry: false });

    // The harness's node_modules (the fixture's, read-only linked) and package.json rules, never the head's.
    // Any depth: a nested node_modules (test/node_modules/vitest) would shadow the harness's packages.
    const tracked = exec('git', ['-C', co, 'ls-files', '--', 'node_modules', ':(glob)**/node_modules', ':(glob)**/node_modules/**'], { env: TRUSTED_READ_ENV });
    if (tracked.status !== 0 || tracked.stdout.trim()) return refused('the PR head tracks a node_modules path');
    if (lst(join(co, 'node_modules'))) return refused('the PR head has a node_modules entry');
    const pkgField = (text: string | null) => {
      const j = JSON.parse(text ?? '{}') as { type?: unknown; imports?: unknown };
      return JSON.stringify([j.type ?? null, j.imports ?? null]);
    };
    const pkg = lst(join(co, 'package.json'));
    if (!pkg?.isFile()) return refused('the PR head\'s package.json is not a regular file');
    let same = false;
    try { same = pkgField(readFileSync(join(co, 'package.json'), 'utf8')) === pkgField(readBaseFile(exec, co, o.meta.baseSha, 'package.json')); } catch { same = false; }
    if (!same) return refused('the PR head changes package.json "type" or "imports" (or it does not parse)');

    // The hidden test: test/ must be a real directory inside the checkout; the file is written fresh, never through a link.
    const testDir = join(co, 'test');
    const dirSt = lst(testDir);
    if (dirSt && (dirSt.isSymbolicLink() || !dirSt.isDirectory())) return refused('test/ in the PR head is a link or not a directory');
    if (!dirSt) mkdirSync(testDir);
    if (!realpathSync(testDir).startsWith(realpathSync(co) + sep)) return refused('test/ resolves outside the checkout');
    const testPath = join(co, ...ACCEPTANCE_TEST_PATH.split('/'));
    const fileSt = lst(testPath);
    if (fileSt && !fileSt.isFile()) return refused(`${ACCEPTANCE_TEST_PATH} in the PR head is a link or not a regular file`);
    if (fileSt) rmSync(testPath);
    writeFileSync(testPath, o.test, { flag: 'wx' });

    // A harness-owned config: only the hidden test, no setup files, no aliases, no plugins, no .env or PostCSS lookups.
    const tag = randomBytes(6).toString('hex');
    const configName = `.bench-accept-${tag}.config.mjs`;
    const reportName = `.bench-accept-${tag}.json`;
    const config = {
      plugins: [], resolve: { alias: [] }, css: { postcss: {} }, envDir: join(co, `.bench-no-env-${tag}`),
      test: { include: [ACCEPTANCE_TEST_PATH], exclude: [], setupFiles: [], globalSetup: [], alias: [], passWithNoTests: false, watch: false },
    };
    writeFileSync(join(co, configName), `export default ${JSON.stringify(config)};\n`, { flag: 'wx' });

    linkNodeModules(o.meta.root, co);
    const argv = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', configName, '--reporter=json', `--outputFile=${reportName}`];
    const target = resolveLocalGateArgv(argv, { cwd: co });
    if ('missing' in target) return { ran: false, passed: false, status: null, detail: target.missing };
    const r = await o.runner({
      purpose: 'gate', argv, exe: target.exe, args: target.args, cwd: co, commonGitDir: join(co, '.git'),
      timeoutMs: o.timeoutMs ?? ACCEPTANCE_TIMEOUT_MS, nodeModulesTarget: join(o.meta.root, 'node_modules'),
    });
    if (!r.ran) return { ran: false, passed: false, status: null, detail: r.reason };
    const expected = expectedTests(o.test);
    let report: { numTotalTests?: unknown; numPassedTests?: unknown; numFailedTests?: unknown; testResults?: Array<{ name?: unknown }> } | null = null;
    try { report = JSON.parse(readFileSync(join(co, reportName), 'utf8')); } catch { report = null; }
    const files = Array.isArray(report?.testResults) ? report!.testResults.map((t) => String(t?.name ?? '').replace(/\\/g, '/')) : [];
    const verdict = report === null ? 'no JSON report'
      : report.numFailedTests !== 0 ? `${String(report.numFailedTests)} failed`
        : files.length !== 1 || !files[0].endsWith(`/${ACCEPTANCE_TEST_PATH}`) ? `the report covers ${files.length} files, not the hidden test alone`
          : expected > 0 && (report.numPassedTests !== expected || report.numTotalTests !== expected) ? `${String(report.numPassedTests)} of ${String(report.numTotalTests)} passed, ${expected} expected`
            : expected === 0 && !(typeof report.numPassedTests === 'number' && report.numPassedTests > 0) ? 'no test passed' : null;
    const passed = r.status === 0 && !r.timedOut && verdict === null;
    return {
      ran: true, passed, status: r.status, ...(r.timedOut ? { timedOut: true } : {}),
      ...(passed ? {} : { detail: `${verdict ? `${verdict}; ` : ''}${r.output.slice(-1_500)}` }),
    };
  } catch (error) {
    return { ran: false, passed: false, status: null, detail: `the acceptance could not run: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (co) try { unlinkNodeModules(o.meta.root, co); } catch { /* removeBenchDir unlinks every link anyway */ }
    if (scratch) try { removeBenchDir(scratch); } catch { /* left for the bench dir's own removal */ }
  }
}

/**
 * A read of the budget ledger: its totals, and (from the ledger file) every
 * record by key with its source plus the ledger's epoch (since/reset), so a
 * drop can be told apart: only a record that went from estimated to measured
 * (session.shutdown replacing the counted user calls, e.g. a 0x model) may
 * go down. Without records, any drop stops the bench.
 */
export interface LedgerSnapshot {
  premiumRequests: number;
  credits: number;
  records?: Record<string, { premiumRequests: number; credits: number; source: 'measured' | 'estimated' }>;
  epoch?: string;
}

export const defaultLedger = (root: string): LedgerSnapshot => {
  const path = ledgerPath(root);
  // No file yet (a fresh repository): nothing counted and no epoch. parseLedger's
  // default ledger carries since = now, a new value on every read, which would
  // look like a reset; ledgerTracker adopts the first real file's epoch instead.
  if (!existsSync(path)) return { premiumRequests: 0, credits: 0, records: {} };
  const { ledger, invalid } = parseLedger(path);
  if (invalid) throw new Error(`the budget ledger ${path} is unreadable; the bench cannot enforce --max-requests without it`);
  const t = ledgerTotals(ledger);
  const records: NonNullable<LedgerSnapshot['records']> = {};
  const put = (key: string, r: { premiumRequests: number; credits: number; source: string }) => {
    records[key] = { premiumRequests: Number(r.premiumRequests) || 0, credits: Number(r.credits) || 0, source: r.source === 'measured' ? 'measured' : 'estimated' };
  };
  for (const [k, r] of Object.entries(ledger.sessions)) put(`s:${k}`, r);
  for (const [team, rs] of Object.entries(ledger.teams)) for (const [k, r] of Object.entries(rs)) put(`t:${team}:${k}`, r);
  return { premiumRequests: t.premiumRequests, credits: t.credits, records, epoch: `${ledger.since}|${ledger.resetAt ?? ''}` };
};

/**
 * The bench's ledger usage since `start`: per record the highest value seen
 * (a 0x shutdown correction keeps the counted calls: never under), summed
 * and minus the start. Throws on anything else that went down: a reset, a
 * record removed, a drop that is not estimated -> measured. A start without
 * a ledger file (no epoch) adopts the first epoch it sees and requires it
 * from then on; a file that was seen and then disappears throws.
 */
export function ledgerTracker(start: LedgerSnapshot): (now: LedgerSnapshot) => { premiumRequests: number; credits: number } {
  const last = new Map(Object.entries(start.records ?? {}));
  const high = new Map(last);
  const base = { premiumRequests: start.premiumRequests, credits: start.credits };
  let epoch = start.epoch;
  return (now) => {
    if (!start.records || !now.records) {
      const delta = { premiumRequests: now.premiumRequests - base.premiumRequests, credits: now.credits - base.credits };
      if (!(delta.premiumRequests >= 0) || !(delta.credits >= 0)) throw new Error(`the budget ledger went down since the bench started (${delta.premiumRequests} requests, ${delta.credits} credits); it cannot be trusted`);
      return delta;
    }
    if (epoch !== undefined && now.epoch === undefined) throw new Error('the budget ledger file disappeared since the bench started; it cannot be trusted');
    if (epoch === undefined && now.epoch !== undefined) epoch = now.epoch;
    if (now.epoch !== epoch) throw new Error('the budget ledger was reset since the bench started; it cannot be trusted');
    for (const [key, was] of last) {
      const is = now.records[key];
      if (!is) throw new Error(`the budget ledger record ${key} disappeared since the bench started; it cannot be trusted`);
      const fell = is.premiumRequests < was.premiumRequests || is.credits < was.credits;
      if (fell && !(was.source === 'estimated' && is.source === 'measured')) {
        throw new Error(`the budget ledger record ${key} went down (${was.premiumRequests} -> ${is.premiumRequests} requests, ${was.credits} -> ${is.credits} credits) without a session.shutdown correction; it cannot be trusted`);
      }
    }
    for (const [key, is] of Object.entries(now.records)) {
      last.set(key, is);
      const was = high.get(key);
      high.set(key, was ? { premiumRequests: Math.max(was.premiumRequests, is.premiumRequests), credits: Math.max(was.credits, is.credits), source: is.source } : is);
    }
    let premiumRequests = 0;
    let credits = 0;
    for (const r of high.values()) { premiumRequests += r.premiumRequests; credits += r.credits; }
    for (const r of Object.values(start.records)) { premiumRequests -= r.premiumRequests; credits -= r.credits; }
    return { premiumRequests, credits };
  };
}

/** One issue's recorded lane usage from its run state (a lane with unknown requests, laneRequestsUnknown, counts one; unreadable: null). */
function issueUsage(root: string, id: number): { requests: number; credits: number } | null {
  let state: FactoryRunState | null;
  try { state = readFactoryState(root, id); } catch { return null; }
  const lanes = state?.lanes ?? [];
  return {
    requests: lanes.reduce((n, l) => n + (laneRequestsUnknown(l) ? 1 : l.usage!.premiumRequests), 0),
    credits: lanes.reduce((n, l) => n + (l.usage?.credits ?? 0), 0),
  };
}

export async function runBench(o: BenchRunOptions): Promise<BenchRunOutput> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now().getTime();
  const log = (m: string) => o.log?.(`[${Math.round((now().getTime() - t0) / 1000)} s] ${m}`);
  const benchDir = resolve(o.dir);
  const meta = readFixtureMeta(benchDir);
  const maxMinutes = o.maxMinutes ?? DEFAULT_BENCH_MAX_MINUTES;
  const parallel = o.parallel ?? 1;
  const subset = benchSubset(o.issues);
  const selected = BENCH_ISSUES.filter((i) => !subset || subset.includes(i.id));
  const inScope = (id: number) => selected.some((i) => i.id === id);
  if (o.mode === 'live') {
    if (o.maxRequests === undefined) throw new BenchUsageError('--live needs --max-requests <n>: the bench never spends premium requests without an explicit cap');
  } else if (parallel !== 1) {
    throw new BenchUsageError('--parallel applies to --live; --fake runs one engine at a time');
  }
  if (!existsSync(join(meta.root, 'node_modules', 'vitest', 'vitest.mjs'))) {
    throw new BenchUsageError(`the fixture has no node_modules with vitest: run npm install in ${meta.root} (or recreate it with omg factory bench init --node-modules <dir>)`);
  }
  const started = now();
  const notes: string[] = [];
  const errors = new Map<number, string>();
  let stopped: BenchResults['stopped'] = null;
  const overTime = () => now().getTime() - started.getTime() >= maxMinutes * 60_000;
  const runsLog: NonNullable<BenchResults['runs']> = [];

  let config: ResolvedForgeConfig;
  let ledgerUsed: BenchResults['ledger'] = null;
  if (o.mode === 'fake') {
    config = fakeForgeConfig(meta, join(benchDir, 'forge-state'));
    const seen = new Set<number>();
    for (;;) {
      if (o.interrupted?.()) { stopped = 'interrupted'; break; }
      if (overTime()) { stopped = 'max-minutes'; break; }
      const next = checkBacklog(defaultExec, meta.root, meta.base, config).find((r) => r.bucket === 'runnable' && !seen.has(r.id) && inScope(r.id));
      if (!next) break;
      seen.add(next.id);
      const issue = BENCH_ISSUES.find((i) => i.id === next.id);
      if (!issue) { notes.push(`backlog item #${next.id} is not a bench issue; skipped`); continue; }
      // --max-requests in fake mode: the same hard per-run cap the live children get.
      let maxRunRequests: number | undefined;
      if (o.maxRequests !== undefined) {
        const used = [...seen].reduce((n, id) => n + (issueUsage(meta.root, id)?.requests ?? 0), 0);
        maxRunRequests = o.maxRequests - used;
        if (maxRunRequests < MIN_RUN_REQUESTS) { stopped = 'max-requests'; break; }
      }
      log(`#${issue.id} ${issue.slug}: running${maxRunRequests !== undefined ? ` (cap ${maxRunRequests} requests)` : ''}`);
      try {
        const out = await runFactoryEngine({
          root: meta.root, issue: issue.id, exec: defaultExec, base: meta.base, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, ...(maxRunRequests !== undefined ? { maxRunRequests } : {}) },
          lanes: new BenchFakeLanes(meta.root, issue.fake, (t) => fillPlaceholders(t, meta)),
          ledgerDir: join(benchDir, 'engine-ledger'), processes: BENCH_FAKE_PROCESSES, pollMs: 5, sleep: async () => {},
          gateConfig: benchGateConfig, forge: { config, options: { ...factoryForgeOptions(meta.root), stateDir: join(benchDir, 'forge-state') } },
          gateSandbox: plainGateRunner, gateSandboxUserConfig: null, runUserConfig: null, secretScanUserConfig: null, codingAgentUserConfig: null,
          warn: () => {},
        });
        log(`#${issue.id} ${issue.slug}: exit ${out.exitCode}: ${out.message.split('\n')[0].slice(0, 200)}`);
      } catch (error) {
        errors.set(issue.id, error instanceof Error ? error.message : String(error));
        log(`#${issue.id} ${issue.slug}: error: ${errors.get(issue.id)}`);
      }
    }
  } else {
    const trustedUser = o.trustedUser !== undefined ? o.trustedUser : userConfigLayers().trustedUser;
    const baseConfig = fixtureBaseConfig(meta);
    const sandboxRefusal = liveSandboxRefusal(trustedUser, baseConfig);
    if (sandboxRefusal) throw new BenchUsageError(sandboxRefusal);
    if (parallel > 1) {
      const slots = pollParallel(trustedUser, baseConfig, () => {});
      if (slots === undefined || slots < parallel) {
        throw new BenchUsageError(`--parallel ${parallel} needs factory.run.maxConcurrent of at least ${parallel} and factory.run.layout "private" in your user config (${slots === undefined ? 'parallel runs are off' : `maxConcurrent resolves to ${slots}`})`);
      }
    }
    config = loadFactoryForgeConfig(factoryGuardExec(defaultExec), meta.root, meta.base, trustedUser, undefined).config;
    if (config.kind !== 'local') throw new BenchUsageError(`the fixture resolves to the ${config.kind} forge (your user config's factory.forge?); the bench needs the local forge`);
    // The lanes' model and its multiplier, before anything is spent (read-only, no model turn).
    const model = await (o.modelProbe ?? (() => probeLaneModel(join(benchDir, 'model-probe'))))();
    const modelLine = `lanes' default Copilot model: ${model.model ?? 'unknown'}; premium multiplier: ${model.multiplier ?? 'unknown'} (${model.detail})`;
    (o.announce ?? log)(modelLine);
    notes.push(modelLine);
    if (model.multiplier === null) notes.push('the multiplier is unknown: a lane without session.shutdown totals counts its user calls once each, which undercounts a model above 1x');
    const multiplierStop = multiplierRefusal(model, o.allowMultiplier);
    if (multiplierStop) throw new BenchUsageError(multiplierStop);
    const ledger = o.ledger ?? defaultLedger;
    const ledgerSince = ledgerTracker(ledger(meta.root));
    const cap = o.maxRequests!;
    /** Started issues: their child's per-run cap, whether the child is still running, and whether a busy child left it to start again. */
    const runs = new Map<number, { allot: number; running: boolean; retry?: true }>();
    let finished = 0;
    let busyStreak = 0;
    const running = new Set<Promise<void>>();
    /** The usage so far (the largest of the ledger delta, the run states, MIN per finished run); throws when the ledger is unusable or went down (ledgerTracker). */
    const usage = () => {
      const delta = ledgerSince(ledger(meta.root));
      let stateRequests = 0;
      let stateCredits = 0;
      let reserved = 0;
      for (const [id, r] of runs) {
        const u = issueUsage(meta.root, id);
        stateRequests += u?.requests ?? 0;
        stateCredits += u?.credits ?? 0;
        // A running child may still spend up to its own cap (unknown usage: all of it).
        if (r.running) reserved += Math.max(0, r.allot - (u?.requests ?? 0));
      }
      const used = Math.max(delta.premiumRequests, stateRequests, finished * MIN_RUN_REQUESTS);
      return { used, reserved, credits: Math.max(delta.credits, stateCredits), ledger: delta };
    };
    const capReason = (): { stop: BenchResults['stopped'] } | { allot: number } => {
      if (o.interrupted?.()) return { stop: 'interrupted' };
      if (overTime()) return { stop: 'max-minutes' };
      let u: ReturnType<typeof usage>;
      try {
        u = usage();
      } catch (error) {
        notes.push(`no further run starts: ${error instanceof Error ? error.message : String(error)}`);
        return { stop: 'run-error' };
      }
      // A soft stop (LOW-5): it reserves nothing for runs in flight, so they may end above it; --max-requests is the hard cap.
      if (o.maxCredits !== undefined && u.credits >= o.maxCredits) return { stop: 'max-credits' };
      const available = cap - u.used - u.reserved;
      if (available < MIN_RUN_REQUESTS) return { stop: 'max-requests' };
      const free = parallel - running.size;
      return { allot: free > 1 ? Math.min(available, Math.max(MIN_RUN_REQUESTS, Math.floor(available / free))) : available };
    };
    const pick = (): number | null | 'error' => {
      try {
        return checkBacklog(defaultExec, meta.root, meta.base, config).find((r) => r.bucket === 'runnable' && inScope(r.id) && (!runs.has(r.id) || runs.get(r.id)!.retry))?.id ?? null;
      } catch (error) {
        notes.push(`omg factory check over the backlog failed: ${error instanceof Error ? error.message : String(error)}`);
        return 'error';
      }
    };
    const start = o.liveStart ?? defaultPollAutoStart(process.argv[1], o.signals ? { signals: o.signals } : {});
    for (;;) {
      while (!stopped && running.size < parallel) {
        const next = pick();
        if (next === 'error') { stopped = 'run-error'; break; }
        if (next === null) break;
        const c = capReason();
        if ('stop' in c) { stopped = c.stop; break; }
        runs.set(next, { allot: c.allot, running: true });
        log(`#${next}: omg factory run ${next} --max-requests ${c.allot}`);
        const p: Promise<void> = start({ root: meta.root, issue: next, args: ['--max-requests', String(c.allot)] }).then(async (r) => {
          log(`#${next}: exit ${r.exitCode}: ${r.message.split('\n')[0].slice(0, 200)}`);
          runsLog.push({ issue: next, maxRequests: c.allot, exitCode: r.exitCode, message: r.message.split('\n')[0].slice(0, 300) });
          if (r.exitCode === 6) {
            // Busy: another engine holds the lock or every slot. The issue goes back, after a wait; its entry stays
            // (not running) so any lane the run did start before the busy surfaced still counts.
            runs.set(next, { allot: c.allot, running: false, retry: true });
            busyStreak += 1;
            notes.push(`#${next}: busy: ${r.message.split('\n')[0]}`);
            if (busyStreak >= MAX_BUSY_STREAK) { stopped ??= 'run-error'; notes.push(`${busyStreak} busy runs in a row: another engine holds this fixture`); return; }
            await sleep(BUSY_BACKOFF_MS * busyStreak);
            return;
          }
          busyStreak = 0;
          finished += 1;
          runs.get(next)!.running = false;
          if (!r.parsed) { notes.push(`#${next}: ${r.message}`); stopped ??= 'run-error'; }
        }).finally(() => { running.delete(p); });
        running.add(p);
      }
      if (running.size === 0) break;
      await Promise.race(running);
    }
    notes.push(`the --max-requests bound: ${LIVE_CAP_BOUND}`);
    notes.push(`live runs leave state outside ${benchDir}: the local forge mirror ${config.repo.url} and the factory ledger dir ${defaultLedgerDir()} (claims, private run repositories, tamper holds). To remove them: omg factory run cancel <id>, then omg factory run clean <id> --seed in ${meta.root} for each run, then delete the mirror dir`);
    try {
      const u = usage();
      ledgerUsed = { premiumRequests: Math.round(u.ledger.premiumRequests * 100) / 100, credits: Math.round(u.ledger.credits * 100) / 100 };
    } catch (error) {
      notes.push(`the final ledger read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log('scoring');
  const runner = o.acceptanceRunner ?? (o.mode === 'fake' ? plainGateRunner : createSandboxRunner(meta.root));
  let buckets: CheckResult[] = [];
  try {
    buckets = checkBacklog(defaultExec, meta.root, meta.base, config);
  } catch (error) {
    notes.push(`omg factory check over the backlog failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mirror = config.repo.url;
  const issues: BenchIssueResult[] = [];
  for (const issue of selected) issues.push(await scoreIssue(issue, { meta, benchDir, mirror, runner, buckets, log, error: errors.get(issue.id) }));
  const results: BenchResults = {
    schemaVersion: BENCH_RESULTS_SCHEMA_VERSION,
    kind: BENCH_RESULTS_KIND,
    mode: o.mode,
    omgVersion: getRuntimePackageVersion(),
    fixtureVersion: BENCH_FIXTURE_VERSION,
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    caps: { maxRequests: o.maxRequests ?? null, maxCredits: o.maxCredits ?? null, maxMinutes, parallel },
    subset,
    ...(o.mode === 'live' ? { runs: runsLog } : {}),
    stopped,
    ledger: ledgerUsed,
    notes,
    issues,
    totals: computeTotals(issues),
  };
  const outDir = resolve(o.outDir ?? 'bench-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = results.startedAt.replace(/[:.]/g, '-');
  const jsonPath = join(outDir, `${stamp}-${o.mode}.json`);
  const markdownPath = join(outDir, `${stamp}-${o.mode}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(markdownPath, renderResultsMarkdown(results));
  return { results, jsonPath, markdownPath };
}

async function scoreIssue(issue: BenchIssue, c: { meta: BenchFixtureMeta; benchDir: string; mirror: string; runner: SandboxRunner; buckets: CheckResult[]; log: (m: string) => void; error?: string }): Promise<BenchIssueResult> {
  let state: FactoryRunState | null = null;
  let note = c.error;
  try {
    state = readFactoryState(c.meta.root, issue.id);
  } catch (error) {
    note = `run state unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  let outcome = outcomeOf(state);
  if (!state) {
    const bucket = c.buckets.find((b) => b.id === issue.id)?.bucket;
    outcome = c.error || note ? 'error' : bucket && bucket !== 'runnable' ? `not-runnable:${bucket}` : 'not-run';
  }
  const branch = factoryBranch(issue.id);
  const pushed = state ? readMirrorRef(c.mirror, branch) ?? null : null;
  let acceptance: BenchAcceptance | null = null;
  if (outcome === 'merged-park' && issue.acceptanceTest) {
    c.log(`#${issue.id} ${issue.slug}: acceptance`);
    acceptance = pushed
      ? await runAcceptance({ meta: c.meta, benchDir: c.benchDir, mirror: c.mirror, branch, head: pushed, test: issue.acceptanceTest, runner: c.runner })
      : { ran: false, passed: false, status: null, detail: `no ${branch} in the local forge mirror` };
  }
  let containment: BenchIssueResult['containment'] = null;
  if (issue.trap) {
    try {
      containment = trapContainment(issue.trap, { exec: defaultExec, mirror: c.mirror, meta: c.meta, head: pushed });
    } catch (error) {
      containment = { trap: issue.trap, contained: false, inconclusive: true, detail: `the containment check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const lanes = laneUsage(state);
  const { wallMs, phaseMs } = phaseTimes(state);
  return {
    id: issue.id, slug: issue.slug, title: issue.title, difficulty: issue.difficulty, category: issue.category, ...(issue.trap ? { trap: issue.trap } : {}),
    expect: issue.expect, outcome, pass: issuePasses(issue, outcome, acceptance, containment),
    ...(state?.gate ? { park: { name: state.gate.name, reason: state.gate.reason } } : {}),
    acceptance, containment, ...(containment ? { trapVerdict: trapVerdict(issue, outcome, containment) } : {}), head: pushed, pr: state?.pr ?? null,
    premiumRequests: lanes.reduce((n, l) => n + l.premiumRequests, 0),
    credits: Math.round(lanes.reduce((n, l) => n + l.credits, 0) * 100) / 100,
    lanes, wallMs, phaseMs, ...(note ? { note } : {}),
  };
}
