/**
 * Gates driver for `omg factory run` (design §6): loops ship's `watchGates`
 * in-process, one ship window per call. A window that times out (the old
 * `omg ship gates --watch` exit 8) is a heartbeat, not a stop; the overall
 * bound is factory.run.gatesTimeoutMinutes.
 *
 * Head discipline: every read is for the head the engine pushed, and only
 * after GitHub reports that head. The PR's headRefOid must equal it before a
 * window starts (an ancestor of it is GitHub catching up, so the driver
 * waits; anything else moved the head externally). A green or failed read
 * is accepted only when the head is still the pushed one and every check
 * that names an Actions run belongs to a workflow run for that head
 * (`gh run list --commit <head>`); otherwise it is a stale read and the
 * driver polls again. Ship's gate API is used as is: watchGates with
 * `headSha` and fetchHeadSha / fetchWorkflowRuns.
 */

import type { KnownFlakyTest, ShipConfig } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { fetchWorkflowRuns, NO_WORKFLOWS_TRIGGERED, parseFailingTests, watchGates, type GateReport } from '../../ship/gates.js';

/** `pending: no-workflows-triggered` for this long goes to awaiting-human: no-workflows. */
export const NO_WORKFLOWS_GRACE_MS = 5 * 60_000;
/** Failed jobs whose logs are read for the ci-fix lane's test titles. */
const MAX_FAILED_LOGS = 5;

export interface GatesDriverInput {
  exec: Exec;
  cwd: string;
  pr: number;
  /** The head the engine pushed (state.head). */
  head: string;
  config: ShipConfig;
  known: readonly KnownFlakyTest[];
  /** Absolute end of the gates phase (ms, `now()` clock). */
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The ship state's rerun budget. */
  reruns: { count(runId: string): number; record(runId: string): void };
  /** Every accepted read (persist lastGates, heartbeat). */
  onReport: (report: GateReport, note: string) => void;
  /** A poll without an accepted read (waiting for GitHub, a stale read). */
  onWait: (note: string) => void;
  cancelled: () => boolean;
}

export type GatesOutcome =
  | { kind: 'green'; report: GateReport }
  | { kind: 'failed'; report: GateReport; tests: string[] }
  | { kind: 'flaky'; report: GateReport }
  | { kind: 'no-workflows'; report: GateReport }
  | { kind: 'timeout'; report?: GateReport }
  | { kind: 'head-moved'; headRefOid: string }
  | { kind: 'not-open'; state: string }
  | { kind: 'cancelled' };

interface PrHead { headRefOid: string; state: string }

/** `gh pr view <pr> --json headRefOid,state`; throws on anything but a full sha and a state. */
export function readPrHead(exec: Exec, pr: number, cwd: string): PrHead {
  const res = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,state'], { cwd });
  let v: { headRefOid?: unknown; state?: unknown } = {};
  try { v = JSON.parse(res.stdout) as typeof v; } catch { /* checked below */ }
  if (res.status !== 0 || typeof v.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(v.headRefOid) || typeof v.state !== 'string') {
    throw new Error(`gh pr view ${pr} did not return a head sha and state (exit ${res.status}): ${res.stderr.trim()}`);
  }
  return { headRefOid: v.headRefOid, state: v.state };
}

/** True when `sha` is an ancestor of `head` in the local object store (GitHub still reports an older engine push). */
function isAncestor(exec: Exec, cwd: string, sha: string, head: string): boolean {
  return exec('git', ['merge-base', '--is-ancestor', sha, head], { cwd, env: TRUSTED_READ_ENV }).status === 0;
}

/**
 * Why an accepted-looking read is stale (null: it is for `head`): the PR
 * head moved, or a reported check names an Actions run that is not one of
 * the head's workflow runs.
 */
export function staleRead(exec: Exec, pr: number, head: string, report: GateReport, cwd: string): string | null {
  const now = readPrHead(exec, pr, cwd).headRefOid;
  if (now !== head) return `the PR head is ${now.slice(0, 12)}, not ${head.slice(0, 12)}`;
  const runs = new Set(fetchWorkflowRuns(exec, head, cwd).map((r) => String(r.databaseId)));
  const foreign = report.checks.filter((c) => c.class !== 'advisory' && c.runId && !runs.has(c.runId)).map((c) => c.name);
  return foreign.length > 0 ? `checks ${foreign.join(', ')} belong to workflow runs of another commit` : null;
}

/** `file > title` of the failing tests in the failed checks' job logs (at most MAX_FAILED_LOGS jobs). */
export function failingTestTitles(exec: Exec, report: GateReport, cwd: string): string[] {
  const out = new Set<string>();
  const jobs = report.checks.filter((c) => c.class === 'failed' && c.jobId).slice(0, MAX_FAILED_LOGS);
  for (const c of jobs) {
    const log = exec('gh', ['run', 'view', '--job', c.jobId!, '--log'], { cwd });
    if (log.status !== 0) continue;
    for (const t of parseFailingTests(log.stdout)) out.add(t.title ? `${t.file} > ${t.title}` : t.file);
  }
  return [...out];
}

export async function driveGates(o: GatesDriverInput): Promise<GatesOutcome> {
  const pollMs = Math.max(1, o.config.pollIntervalSeconds * 1000);
  const wait = async (note: string) => {
    o.onWait(note);
    await o.sleep(Math.max(0, Math.min(pollMs, o.deadline - o.now())));
  };
  let noWorkflowsSince: number | null = null;
  let last: GateReport | undefined;
  for (;;) {
    if (o.cancelled()) return { kind: 'cancelled' };
    const left = o.deadline - o.now();
    if (left <= 0) return { kind: 'timeout', ...(last ? { report: last } : {}) };
    const view = readPrHead(o.exec, o.pr, o.cwd);
    if (view.state !== 'OPEN') return { kind: 'not-open', state: view.state };
    if (view.headRefOid !== o.head) {
      if (!isAncestor(o.exec, o.cwd, view.headRefOid, o.head)) return { kind: 'head-moved', headRefOid: view.headRefOid };
      await wait(`waiting for GitHub to report head ${o.head.slice(0, 12)} (it shows ${view.headRefOid.slice(0, 12)})`);
      continue;
    }
    const windowMin = Math.min(o.config.watchTimeoutMinutes > 0 ? o.config.watchTimeoutMinutes : Infinity, left / 60_000);
    const res = await watchGates({
      exec: o.exec, pr: o.pr, config: { ...o.config, watchTimeoutMinutes: windowMin }, known: o.known, cwd: o.cwd, headSha: o.head,
      watch: true, reruns: o.reruns, sleep: o.sleep, now: o.now,
    });
    const report = res.report;
    if (report.verdict === 'green' || report.verdict === 'failed' || report.verdict === 'flaky') {
      const stale = staleRead(o.exec, o.pr, o.head, report, o.cwd);
      if (stale) {
        await wait(`ignored a ${report.verdict} read: ${stale}`);
        continue;
      }
    }
    last = report;
    o.onReport(report, res.timedOut ? 'watch window elapsed (exit 8); polling on' : report.verdict);
    if (report.verdict === 'green') return { kind: 'green', report };
    if (report.verdict === 'failed') return { kind: 'failed', report, tests: failingTestTitles(o.exec, report, o.cwd) };
    if (report.verdict === 'flaky' && !res.timedOut) return { kind: 'flaky', report };
    if (report.pending.includes(NO_WORKFLOWS_TRIGGERED)) {
      noWorkflowsSince ??= o.now();
      if (o.now() - noWorkflowsSince >= NO_WORKFLOWS_GRACE_MS) return { kind: 'no-workflows', report };
    } else {
      noWorkflowsSince = null;
    }
    // watchGates returns pending only at its window's end; a rerun failure returns at once, so poll before the next window.
    if (!res.timedOut) await wait(`gates ${report.verdict}`);
  }
}
