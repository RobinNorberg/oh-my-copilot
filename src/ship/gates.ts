/**
 * Gate engine for `omg ship gates`: classify `gh pr checks --json` output
 * under the fork's merge rule, attribute failures to known-flaky tests from
 * the failed job's log, and watch until green / failed / timeout.
 *
 * Merge rule: green only when every check outside the advisory list is
 * SUCCESS or SKIPPED, every name in `ship.requiredChecks` has been reported
 * (a missing one is pending: `needs:`-dependent jobs appear late), and every
 * Actions workflow run for the head sha has status `completed`. Unknown
 * states count as failed (fail closed), and a PR with no required checks yet
 * is pending, never green.
 */

import type { ShipConfig, KnownFlakyTest } from './config.js';
import type { Exec } from './exec.js';
import { ghHeadSha, ghJobLog, ghPrChecks, ghRerun, ghRunsForHead } from '../forge/github/checks.js';
import type { ForgeChecks, ForgeReviews } from '../forge/types.js';

/**
 * The forge reads of a gate evaluation (factory forges design §2): the PR
 * head and its checks, runs, logs and reruns. Omitted = GitHub through the
 * gh calls in this file, unchanged; the factory engine passes the Azure
 * DevOps adapter's.
 */
export interface GateForge {
  checks: ForgeChecks;
  reviews: Pick<ForgeReviews, 'prHead'>;
}

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
  /** Actions job id the log came from; analyses are matched to checks by it. */
  jobId?: string;
  failingTests: FailingTest[];
  /**
   * True when at least one failing test was found, every one is on the
   * known-flaky list, and the log shows no non-test failure (`blockers`).
   */
  knownFlaky: boolean;
  unknown: FailingTest[];
  /** Log evidence that the job failed for a reason other than its failing tests. */
  blockers: string[];
}

/** One `gh run list --commit <sha> --json ...` entry. */
export interface WorkflowRun {
  databaseId: number;
  status: string;
  conclusion?: string;
  workflowName?: string;
  headSha?: string;
}

export const RUN_FIELDS = 'databaseId,status,conclusion,workflowName,headSha';

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

/** A transient GitHub failure (5xx, GraphQL "Something went wrong"): worth a retry, never a verdict. */
export const TRANSIENT_GH_ERROR = /Something went wrong|HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error/i;

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

/** `advisory` is set only by a forge adapter (an ADO non-blocking policy); gh's JSON has no such field. */
export function classifyCheck(check: GhCheck & { advisory?: boolean }, advisory: readonly string[]): ClassifiedCheck {
  const state = check.state.toUpperCase();
  const cls: CheckClass = advisory.includes(check.name) || check.advisory === true
    ? 'advisory'
    : PASS_STATES.has(state) ? 'pass' : PENDING_STATES.has(state) ? 'pending' : 'failed';
  return { ...check, class: cls, ...actionsIds(check.link) };
}

/**
 * Pure merge-rule evaluation without log analysis (failed stays failed). A
 * `requiredChecks` name absent from `checks` is listed as pending.
 */
export function evaluateChecks(pr: number, checks: GhCheck[], config: Pick<ShipConfig, 'advisoryChecks' | 'requiredChecks'>): GateReport {
  const classified = checks.map((c) => classifyCheck(c, config.advisoryChecks));
  const names = (cls: CheckClass) => classified.filter((c) => c.class === cls).map((c) => c.name);
  const reported = new Set(classified.map((c) => c.name));
  const missing = config.requiredChecks.filter((n) => !reported.has(n) && !config.advisoryChecks.includes(n));
  const pending = [...names('pending'), ...missing];
  const failed = names('failed');
  const required = classified.filter((c) => c.class !== 'advisory');
  const advisoryFailed = classified
    .filter((c) => c.class === 'advisory' && !PASS_STATES.has(c.state.toUpperCase()))
    .map((c) => c.name);
  const verdict: GateVerdict = failed.length > 0 ? 'failed' : pending.length > 0 || required.length === 0 ? 'pending' : 'green';
  const suggestions: string[] = [];
  if (required.length === 0) suggestions.push('No required checks reported yet; CI may not have started.');
  if (missing.length > 0) suggestions.push(`Required checks not reported yet (counted as pending): ${missing.join(', ')}`);
  return { pr, verdict, checks: classified, pending, failed, advisoryFailed, flaky: [], rerunnable: [], suggestions };
}

/** Parse `gh run list --json` stdout; throws GhChecksError on anything but an array of {databaseId,status}. */
export function parseRunsJson(stdout: string): WorkflowRun[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GhChecksError('gh run list did not print JSON');
  }
  if (!Array.isArray(parsed)) throw new GhChecksError('gh run list JSON is not an array');
  return parsed.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (typeof r?.databaseId !== 'number' || typeof r.status !== 'string') {
      throw new GhChecksError(`gh run list entry ${i} lacks databaseId/status`);
    }
    return r as unknown as WorkflowRun;
  });
}

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/** Pending label when the head sha has no checks and no workflow runs at all. */
export const NO_WORKFLOWS_TRIGGERED = 'no-workflows-triggered';

/**
 * A green report stays green only when every workflow run for the head sha is
 * `completed`; a queued / in-progress run (jobs not yet reported) is pending.
 * The latest run of each workflow that completed with a conclusion other than
 * success / skipped / neutral and reported no check (a workflow that failed at
 * startup, e.g. an invalid workflow file) is failed. A run whose jobs did
 * report is judged by its checks (its advisory jobs may fail).
 */
export function applyWorkflowRuns(report: GateReport, runs: WorkflowRun[]): GateReport {
  const open = runs.filter((r) => r.status.toLowerCase() !== 'completed');
  const latest = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const key = r.workflowName ?? `#${r.databaseId}`;
    const seen = latest.get(key);
    if (!seen || r.databaseId > seen.databaseId) latest.set(key, r);
  }
  const reportedRuns = new Set(report.checks.map((c) => c.runId).filter(Boolean));
  const broken = [...latest.values()].filter((r) => r.status.toLowerCase() === 'completed'
    && !OK_CONCLUSIONS.has((r.conclusion ?? '').toLowerCase())
    && !reportedRuns.has(String(r.databaseId)));
  if (open.length === 0 && broken.length === 0) return report;
  const label = (r: WorkflowRun, what: string) => `workflow run ${r.workflowName ?? r.databaseId} (${what})`;
  const failed = [...report.failed, ...broken.map((r) => label(r, `${(r.conclusion || 'no conclusion').toLowerCase()}, no checks reported`))];
  const pending = [...report.pending, ...open.map((r) => label(r, r.status.toLowerCase()))];
  const verdict: GateVerdict = broken.length > 0 ? 'failed' : report.verdict === 'green' ? 'pending' : report.verdict;
  return { ...report, verdict, failed, pending };
}

/**
 * No check and no workflow run for the head: a PR opened or pushed with the
 * Actions GITHUB_TOKEN (draft bot PRs) triggers no workflows, so waiting
 * would be pending forever. Reported as a distinct pending reason.
 */
export function applyNoWorkflows(report: GateReport, runs: WorkflowRun[], headSha: string): GateReport {
  if (report.checks.length > 0 || runs.length > 0) return report;
  return {
    ...report,
    verdict: 'pending',
    pending: [...report.pending.filter((p) => p !== NO_WORKFLOWS_TRIGGERED), NO_WORKFLOWS_TRIGGERED],
    suggestions: [
      ...report.suggestions,
      `${NO_WORKFLOWS_TRIGGERED}: no checks and no workflow runs exist for head ${headSha.slice(0, 12)}. A PR opened or pushed with the Actions GITHUB_TOKEN triggers no workflows: push the branch from a PAT, or close and reopen the PR.`,
    ],
  };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const GH_LOG_PREFIX = /^[^\t]*\t[^\t]*\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?/;
/** An Azure Pipelines log line's timestamp (after a byte-order mark on the first line); stripped only when the GitHub prefix is absent. */
export const ADO_LOG_PREFIX = /^\p{Cf}?\d{4}-\d\d-\d\dT[\d:.]+Z /u;
const FAIL_LINE = /^\s*FAIL\s+(\S+\.(?:test|spec|bench)\.[cm]?[jt]sx?)(.*)$/;

/** Extract vitest ` FAIL  <file> > <title>` lines from a GitHub Actions or Azure Pipelines log. */
export function parseFailingTests(log: string): FailingTest[] {
  const seen = new Set<string>();
  const out: FailingTest[] = [];
  for (const rawLine of log.split(/\r?\n/)) {
    const plain = rawLine.replace(ANSI, '');
    const line = GH_LOG_PREFIX.test(plain) ? plain.replace(GH_LOG_PREFIX, '') : plain.replace(ADO_LOG_PREFIX, '');
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

/** A file-level failure (no title) never matches: it is a collection error, not a flaky test. */
export function isKnownFlaky(test: FailingTest, known: readonly KnownFlakyTest[]): boolean {
  return test.title !== undefined && known.some((k) => k.file === test.file && Boolean(k.title) && test.title!.includes(k.title));
}

const UNHANDLED = /\bUnhandled (?:Errors?|Rejections?)\b/;
const FAILED_SUITES = /\bFailed Suites \d+/;
const STEP_ERROR = /##\[error\]/;

/**
 * Evidence in a job log that the job did not fail only because of its failing
 * tests: vitest unhandled errors, failed suites (collection errors), or an
 * `##[error]` in a step that printed no FAIL line (a non-test step failed).
 */
export function logBlockers(log: string): string[] {
  const blockers = new Set<string>();
  const testSteps = new Set<string>();
  const errorSteps = new Set<string>();
  for (const rawLine of log.split(/\r?\n/)) {
    const step = rawLine.split('\t').length >= 3 ? rawLine.split('\t')[1] : '';
    const plain = rawLine.replace(ANSI, '');
    const line = GH_LOG_PREFIX.test(plain) ? plain.replace(GH_LOG_PREFIX, '') : plain.replace(ADO_LOG_PREFIX, '');
    if (UNHANDLED.test(line)) blockers.add('vitest reported unhandled errors');
    if (FAILED_SUITES.test(line)) blockers.add('vitest reported failed suites (collection errors)');
    if (FAIL_LINE.test(line)) testSteps.add(step);
    if (STEP_ERROR.test(line)) errorSteps.add(step);
  }
  for (const step of errorSteps) {
    if (!testSteps.has(step)) blockers.add(`step "${step || '(unnamed)'}" failed without a failing test`);
  }
  return [...blockers];
}

export function analyzeFailedLog(check: string, runId: string | undefined, log: string, known: readonly KnownFlakyTest[], jobId?: string): FlakyAnalysis {
  const failingTests = parseFailingTests(log);
  const unknown = failingTests.filter((t) => !isKnownFlaky(t, known));
  const blockers = logBlockers(log);
  return {
    check,
    runId,
    ...(jobId ? { jobId } : {}),
    failingTests,
    unknown,
    blockers,
    knownFlaky: failingTests.length > 0 && unknown.length === 0 && blockers.length === 0,
  };
}

const analysisKey = (jobId: string | undefined, name: string) => (jobId ? `job:${jobId}` : `name:${name}`);

/**
 * Fold log analyses into a report: verdict becomes `flaky` when every failed
 * required check is a known-flaky failure (matched by job id); a run is
 * rerunnable only when all its required jobs are finished.
 */
export function applyFlakyAnalysis(report: GateReport, analyses: FlakyAnalysis[]): GateReport {
  const byJob = new Map(analyses.map((a) => [analysisKey(a.jobId, a.check), a]));
  const failedChecks = report.checks.filter((c) => c.class === 'failed');
  const allFlaky = failedChecks.length > 0 && failedChecks.every((c) => byJob.get(analysisKey(c.jobId, c.name))?.knownFlaky === true);
  const runIds = [...new Set(failedChecks.map((c) => c.runId).filter((id): id is string => Boolean(id)))];
  const rerunnable = allFlaky
    ? runIds.filter((id) => !report.checks.some((c) => c.runId === id && c.class === 'pending'))
    : [];
  const suggestions = [...report.suggestions];
  for (const a of analyses) {
    if (a.knownFlaky) {
      suggestions.push(`${a.check}: known-flaky failure (${a.failingTests.map((t) => t.title ?? t.file).join('; ')}) -> gh run rerun ${a.runId ?? '<run-id>'} --failed`);
    } else if (a.blockers.length > 0) {
      suggestions.push(`${a.check}: not flaky: ${a.blockers.join('; ')}`);
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

/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list (the GitHub forge's checks). */
export function fetchChecks(exec: Exec, pr: number, cwd?: string): GhCheck[] { return ghPrChecks(exec, pr, cwd); }

/** The PR head sha from `gh pr view <pr> --json headRefOid`. */
export function fetchHeadSha(exec: Exec, pr: number, cwd?: string): string { return ghHeadSha(exec, pr, cwd); }

/**
 * Every Actions workflow run for the head sha (`gh run list --commit`); a run
 * whose reported head_sha is another commit is dropped (the GitHub forge's runsForHead).
 */
export function fetchWorkflowRuns(exec: Exec, headSha: string, cwd?: string): WorkflowRun[] { return ghRunsForHead(exec, headSha, cwd); }

/**
 * One gate evaluation against a single head sha: resolve the head first
 * (unless given), read the checks and the workflow runs for it, then re-read
 * the head; a head that moved in between is pending whatever the verdict
 * (green, failed or flaky), since the read may mix two heads. Failed Actions
 * jobs' logs are read for known-flaky attribution. `forge` replaces the gh
 * reads (GateForge); without it every call is the GitHub one.
 */
export function evaluateGates(exec: Exec, pr: number, config: ShipConfig, known: readonly KnownFlakyTest[], cwd?: string, headSha?: string, forge?: GateForge): GateReport {
  const readHead = () => (forge ? forge.reviews.prHead(pr).headRefOid : fetchHeadSha(exec, pr, cwd));
  const head = headSha ?? readHead();
  const checked = evaluateChecks(pr, forge ? forge.checks.checks(pr, head) : fetchChecks(exec, pr, cwd), config);
  const runs = forge ? forge.checks.runsForHead(pr, head) : fetchWorkflowRuns(exec, head, cwd);
  const report = applyNoWorkflows(applyWorkflowRuns(checked, runs), runs, head);
  const after = readHead();
  if (after !== head) {
    return {
      ...report,
      verdict: 'pending',
      pending: [...report.pending, `head moved from ${head.slice(0, 12)} to ${after.slice(0, 12)} during the gate read`],
    };
  }
  if (report.verdict !== 'failed' || known.length === 0) return report;
  const analyses: FlakyAnalysis[] = [];
  for (const check of report.checks) {
    if (check.class !== 'failed' || !check.jobId) continue;
    const log = forge ? forge.checks.jobLog(check.jobId) : ghJobLog(exec, check.jobId, cwd);
    analyses.push(analyzeFailedLog(check.name, check.runId, log.ok ? log.text : '', known, check.jobId));
  }
  return applyFlakyAnalysis(report, analyses);
}

export interface WatchOptions {
  exec: Exec;
  pr: number;
  config: ShipConfig;
  known: readonly KnownFlakyTest[];
  cwd?: string;
  /** PR head sha for the workflow-run check (looked up per poll when omitted). */
  headSha?: string;
  watch: boolean;
  /** Rerun budget lookup/record (persisted in the ship state); omitted = never rerun. */
  reruns?: { count(runId: string): number; record(runId: string): void };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onReport?: (report: GateReport) => void;
  /** Drive mode: a transient GitHub error while reading the gates is a pending poll, not a thrown error. */
  retryTransient?: boolean;
  onTransient?: (message: string) => void;
  /** The forge reads (GateForge); omitted = GitHub. */
  forge?: GateForge;
}

export interface WatchResult {
  report: GateReport;
  /** Run ids rerun during this watch. */
  rerun: string[];
  /** The window elapsed while waiting (pending, or a flaky run's reruns / sibling jobs still going). */
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
    let report: GateReport;
    try {
      report = evaluateGates(opts.exec, opts.pr, config, opts.known, opts.cwd, opts.headSha, opts.forge);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!opts.retryTransient || !opts.watch || !(error instanceof GhChecksError) || !TRANSIENT_GH_ERROR.test(message)) throw error;
      opts.onTransient?.(message);
      if (opts.now() >= deadline) throw error;
      await opts.sleep(Math.min(config.pollIntervalSeconds * 1000, Math.max(0, deadline - opts.now())));
      continue;
    }
    opts.onReport?.(report);
    if (!opts.watch || report.verdict === 'green' || report.verdict === 'failed') {
      return { report, rerun, timedOut: false };
    }
    // A fixed head that moved will never settle: hand the pending report back so the caller re-views the PR.
    if (opts.headSha && report.pending.some((p) => p.startsWith('head moved from '))) return { report, rerun, timedOut: false };
    if (report.verdict === 'flaky') {
      const budget = opts.reruns;
      const ready = budget && config.autoRerunFlaky ? report.rerunnable.filter((id) => budget.count(id) < 1) : [];
      // Empty rerunnable = the flaky run still has pending jobs; keep polling.
      const waitingOnSiblings = report.rerunnable.length === 0;
      if (ready.length === 0 && !waitingOnSiblings) return { report, rerun, timedOut: false };
      for (const id of ready) {
        // Spend the budget first: a crash after the rerun must not allow a second one.
        budget!.record(id);
        const res = opts.forge ? opts.forge.checks.rerun(opts.pr, id) : ghRerun(opts.exec, id, opts.cwd);
        if (!res.ok) {
          report.suggestions.push(`${opts.forge ? `rerun of ${id}` : `gh run rerun ${id} --failed`} failed: ${res.stderr.trim()}`);
          return { report, rerun, timedOut: false };
        }
        rerun.push(id);
      }
    }
    if (opts.now() >= deadline) return { report, rerun, timedOut: true };
    await opts.sleep(Math.min(config.pollIntervalSeconds * 1000, Math.max(0, deadline - opts.now())));
  }
}
