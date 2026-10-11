/**
 * Gate engine for `omg ship gates`: classify `gh pr checks --json` output
 * under the fork's merge rule, attribute failures to known-flaky tests from
 * the failed job's log, and watch until green / failed / timeout.
 *
 * Merge rule: green only when every check outside the advisory list is
 * SUCCESS or SKIPPED. Unknown states count as failed (fail closed), and a PR
 * with no required checks yet is pending, never green.
 */

import type { ShipConfig, KnownFlakyTest } from './config.js';
import type { Exec } from './exec.js';

export const CHECK_FIELDS = 'name,state,bucket,link,workflow,event,startedAt,completedAt';

export interface GhCheck {
  name: string;
  state: string;
  bucket?: string;
  link?: string;
  workflow?: string;
  event?: string;
  startedAt?: string;
  completedAt?: string;
}

export type CheckClass = 'pass' | 'pending' | 'failed' | 'advisory';

export interface ClassifiedCheck extends GhCheck {
  class: CheckClass;
  runId?: string;
  jobId?: string;
}

export interface FailingTest {
  file: string;
  title?: string;
}

export interface FlakyAnalysis {
  check: string;
  runId?: string;
  failingTests: FailingTest[];
  /** True when at least one failing test was found and every one is on the known-flaky list. */
  knownFlaky: boolean;
  unknown: FailingTest[];
}

export type GateVerdict = 'green' | 'pending' | 'failed' | 'flaky';

export interface GateReport {
  pr: number;
  verdict: GateVerdict;
  checks: ClassifiedCheck[];
  pending: string[];
  failed: string[];
  advisoryFailed: string[];
  flaky: FlakyAnalysis[];
  /** Run ids whose failed jobs are all known-flaky and have no pending sibling jobs. */
  rerunnable: string[];
  suggestions: string[];
}

const PASS_STATES = new Set(['SUCCESS', 'SKIPPED']);
const PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

export class GhChecksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhChecksError';
  }
}

/** Parse `gh pr checks --json` stdout; throws GhChecksError on anything but an array of {name,state}. */
export function parseChecksJson(stdout: string): GhCheck[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GhChecksError('gh pr checks did not print JSON');
  }
  if (!Array.isArray(parsed)) throw new GhChecksError('gh pr checks JSON is not an array');
  return parsed.map((raw, i) => {
    const c = raw as Record<string, unknown>;
    if (typeof c?.name !== 'string' || typeof c.state !== 'string') {
      throw new GhChecksError(`gh pr checks entry ${i} lacks name/state`);
    }
    return c as unknown as GhCheck;
  });
}

function actionsIds(link: string | undefined): { runId?: string; jobId?: string } {
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link ?? '');
  return m ? { runId: m[1], jobId: m[2] } : {};
}

export function classifyCheck(check: GhCheck, advisory: readonly string[]): ClassifiedCheck {
  const state = check.state.toUpperCase();
  const cls: CheckClass = advisory.includes(check.name)
    ? 'advisory'
    : PASS_STATES.has(state) ? 'pass' : PENDING_STATES.has(state) ? 'pending' : 'failed';
  return { ...check, class: cls, ...actionsIds(check.link) };
}

/** Pure merge-rule evaluation without log analysis (failed stays failed). */
export function evaluateChecks(pr: number, checks: GhCheck[], config: Pick<ShipConfig, 'advisoryChecks'>): GateReport {
  const classified = checks.map((c) => classifyCheck(c, config.advisoryChecks));
  const names = (cls: CheckClass) => classified.filter((c) => c.class === cls).map((c) => c.name);
  const pending = names('pending');
  const failed = names('failed');
  const required = classified.filter((c) => c.class !== 'advisory');
  const advisoryFailed = classified
    .filter((c) => c.class === 'advisory' && !PASS_STATES.has(c.state.toUpperCase()))
    .map((c) => c.name);
  const verdict: GateVerdict = failed.length > 0 ? 'failed' : pending.length > 0 || required.length === 0 ? 'pending' : 'green';
  const suggestions: string[] = [];
  if (required.length === 0) suggestions.push('No required checks reported yet; CI may not have started.');
  return { pr, verdict, checks: classified, pending, failed, advisoryFailed, flaky: [], rerunnable: [], suggestions };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const GH_LOG_PREFIX = /^[^\t]*\t[^\t]*\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?/;
const FAIL_LINE = /^\s*FAIL\s+(\S+\.(?:test|spec|bench)\.[cm]?[jt]sx?)(.*)$/;

/** Extract vitest ` FAIL  <file> > <title>` lines from a (GitHub Actions) log. */
export function parseFailingTests(log: string): FailingTest[] {
  const seen = new Set<string>();
  const out: FailingTest[] = [];
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, '').replace(GH_LOG_PREFIX, '');
    const m = FAIL_LINE.exec(line);
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/');
    const rest = m[2].trim();
    const title = rest.startsWith('>') ? rest.slice(1).split(/\s+>\s+/).map((s) => s.trim()).join(' > ') : undefined;
    const key = `${file}\u0000${title ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title ? { file, title } : { file });
  }
  return out;
}

export function isKnownFlaky(test: FailingTest, known: readonly KnownFlakyTest[]): boolean {
  return known.some((k) => k.file === test.file && (k.title === undefined || (test.title ?? '').includes(k.title)));
}

export function analyzeFailedLog(check: string, runId: string | undefined, log: string, known: readonly KnownFlakyTest[]): FlakyAnalysis {
  const failingTests = parseFailingTests(log);
  const unknown = failingTests.filter((t) => !isKnownFlaky(t, known));
  return { check, runId, failingTests, unknown, knownFlaky: failingTests.length > 0 && unknown.length === 0 };
}

/**
 * Fold log analyses into a report: verdict becomes `flaky` when every failed
 * required check is a known-flaky failure; a run is rerunnable only when all
 * its required jobs are finished.
 */
export function applyFlakyAnalysis(report: GateReport, analyses: FlakyAnalysis[]): GateReport {
  const byCheck = new Map(analyses.map((a) => [a.check, a]));
  const failedChecks = report.checks.filter((c) => c.class === 'failed');
  const allFlaky = failedChecks.length > 0 && failedChecks.every((c) => byCheck.get(c.name)?.knownFlaky === true);
  const runIds = [...new Set(failedChecks.map((c) => c.runId).filter((id): id is string => Boolean(id)))];
  const rerunnable = allFlaky
    ? runIds.filter((id) => !report.checks.some((c) => c.runId === id && c.class === 'pending'))
    : [];
  const suggestions = [...report.suggestions];
  for (const a of analyses) {
    if (a.knownFlaky) {
      suggestions.push(`${a.check}: known-flaky failure (${a.failingTests.map((t) => t.title ?? t.file).join('; ')}) -> gh run rerun ${a.runId ?? '<run-id>'} --failed`);
    } else if (a.failingTests.length > 0) {
      suggestions.push(`${a.check}: real failure: ${a.unknown.map((t) => (t.title ? `${t.file} > ${t.title}` : t.file)).join('; ')}`);
    }
  }
  return {
    ...report,
    verdict: report.verdict === 'failed' && allFlaky ? 'flaky' : report.verdict,
    flaky: analyses,
    rerunnable,
    suggestions,
  };
}

/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list. */
export function fetchChecks(exec: Exec, pr: number, cwd?: string): GhCheck[] {
  const res = exec('gh', ['pr', 'checks', String(pr), '--json', CHECK_FIELDS], { cwd });
  const out = res.stdout.trim();
  if (out.startsWith('[')) return parseChecksJson(out);
  if (/no checks reported/i.test(res.stderr) || /no checks reported/i.test(res.stdout)) return [];
  throw new GhChecksError(`gh pr checks ${pr} failed (exit ${res.status}): ${res.stderr.trim() || out}`);
}

/** One gate evaluation: fetch, classify, and read the logs of failed Actions jobs. */
export function evaluateGates(exec: Exec, pr: number, config: ShipConfig, known: readonly KnownFlakyTest[], cwd?: string): GateReport {
  const report = evaluateChecks(pr, fetchChecks(exec, pr, cwd), config);
  if (report.verdict !== 'failed' || known.length === 0) return report;
  const analyses: FlakyAnalysis[] = [];
  for (const check of report.checks) {
    if (check.class !== 'failed' || !check.jobId) continue;
    const log = exec('gh', ['run', 'view', '--job', check.jobId, '--log'], { cwd });
    analyses.push(analyzeFailedLog(check.name, check.runId, log.status === 0 ? log.stdout : '', known));
  }
  return applyFlakyAnalysis(report, analyses);
}

export interface WatchOptions {
  exec: Exec;
  pr: number;
  config: ShipConfig;
  known: readonly KnownFlakyTest[];
  cwd?: string;
  watch: boolean;
  /** Rerun budget lookup/record (persisted in the ship state); omitted = never rerun. */
  reruns?: { count(runId: string): number; record(runId: string): void };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onReport?: (report: GateReport) => void;
}

export interface WatchResult {
  report: GateReport;
  /** Run ids rerun during this watch. */
  rerun: string[];
  timedOut: boolean;
}

/**
 * Poll until green, a real failure, a flaky failure that is out of rerun
 * budget, or the per-invocation timeout. Each run id is rerun at most once
 * across invocations (the budget lives in the ship state).
 */
export async function watchGates(opts: WatchOptions): Promise<WatchResult> {
  const { config } = opts;
  const deadline = config.watchTimeoutMinutes > 0 ? opts.now() + config.watchTimeoutMinutes * 60_000 : Infinity;
  const rerun: string[] = [];
  for (;;) {
    const report = evaluateGates(opts.exec, opts.pr, config, opts.known, opts.cwd);
    opts.onReport?.(report);
    if (!opts.watch || report.verdict === 'green' || report.verdict === 'failed') {
      return { report, rerun, timedOut: false };
    }
    if (report.verdict === 'flaky') {
      const budget = opts.reruns;
      const ready = budget && config.autoRerunFlaky ? report.rerunnable.filter((id) => budget.count(id) < 1) : [];
      // Empty rerunnable = the flaky run still has pending jobs; keep polling.
      const waitingOnSiblings = report.rerunnable.length === 0;
      if (ready.length === 0 && !waitingOnSiblings) return { report, rerun, timedOut: false };
      for (const id of ready) {
        const res = opts.exec('gh', ['run', 'rerun', id, '--failed'], { cwd: opts.cwd });
        budget!.record(id);
        if (res.status !== 0) {
          report.suggestions.push(`gh run rerun ${id} --failed failed: ${res.stderr.trim()}`);
          return { report, rerun, timedOut: false };
        }
        rerun.push(id);
      }
    }
    if (opts.now() >= deadline) return { report, rerun, timedOut: true };
    await opts.sleep(Math.min(config.pollIntervalSeconds * 1000, Math.max(0, deadline - opts.now())));
  }
}
