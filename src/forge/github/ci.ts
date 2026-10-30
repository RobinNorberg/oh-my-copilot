/**
 * GitHub Actions history for `omg factory heal` (factory forges design §2,
 * PR 2): the `gh run list` / `gh run view` reads moved verbatim from
 * src/factory/heal/history.ts, which re-exports these names. healGuardExec
 * still allows only these shapes.
 */

import type { Exec } from '../../ship/exec.js';
import type { HealJob, HealRun } from '../../factory/heal/history.js';
import { capLog } from '../../factory/heal/logs.js';
import type { ForgeCi } from '../types.js';

export const RUN_LIST_FIELDS = 'databaseId,conclusion,status,headSha,headBranch,event,createdAt';

const NUMBER = /^\d{1,20}$/;
const HEX40 = /^[0-9a-f]{40}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function runGh(exec: Exec, args: string[], cwd?: string): string {
  const r = exec('gh', args, cwd ? { cwd } : undefined);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.status}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

export function parseRunList(stdout: string): HealRun[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('gh run list: expected a JSON array');
  return parsed.flatMap((e: Record<string, unknown>) => {
    const id = typeof e?.databaseId === 'number' ? String(e.databaseId) : str(e?.databaseId);
    const headSha = str(e?.headSha);
    if (!NUMBER.test(id) || !HEX40.test(headSha)) return [];
    return [{ id, headSha, conclusion: str(e.conclusion), status: str(e.status), headBranch: str(e.headBranch), event: str(e.event), createdAt: str(e.createdAt) }];
  });
}

export function listRuns(exec: Exec, opts: { workflow: string; event: 'push' | 'pull_request'; branch?: string; limit: number; cwd?: string }): HealRun[] {
  const args = ['run', 'list', ...(opts.branch ? ['--branch', opts.branch] : []), '--workflow', opts.workflow, '--event', opts.event, '--json', RUN_LIST_FIELDS, '--limit', String(opts.limit)];
  // Newest first, whatever order gh returned.
  return parseRunList(runGh(exec, args, opts.cwd)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function parseRunJobs(stdout: string): HealJob[] {
  const jobs = (JSON.parse(stdout) as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) throw new Error('gh run view --json jobs: expected { jobs: [...] }');
  return jobs.flatMap((j: Record<string, unknown>) => {
    const jobId = typeof j?.databaseId === 'number' ? String(j.databaseId) : str(j?.databaseId);
    if (!NUMBER.test(jobId)) return [];
    const steps = Array.isArray(j.steps) ? (j.steps as Record<string, unknown>[]) : [];
    return [{
      jobId,
      name: str(j.name).slice(0, 200),
      conclusion: str(j.conclusion),
      failedSteps: steps.filter((s) => s?.conclusion === 'failure').map((s) => str(s.name).slice(0, 200)),
    }];
  });
}

export function viewRunJobs(exec: Exec, runId: string, cwd?: string): HealJob[] {
  return parseRunJobs(runGh(exec, ['run', 'view', runId, '--json', 'jobs'], cwd));
}

/** A job's log, capped (capLog) before anything parses it. */
export function jobLog(exec: Exec, jobId: string, cwd?: string): string {
  return capLog(runGh(exec, ['run', 'view', '--job', jobId, '--log'], cwd));
}

/** The rerun heal records for a human; healGuardExec refuses it and omg never issues it. */
export const githubRerunIntent = (runId: string): string => `gh run rerun ${runId} --failed`;

export function githubCi(exec: Exec, cwd?: string): ForgeCi {
  return {
    listRuns: (o) => listRuns(exec, { ...o, cwd }),
    runJobs: (runId) => viewRunJobs(exec, runId, cwd),
    jobLog: (jobId) => jobLog(exec, jobId, cwd),
    rerunIntent: githubRerunIntent,
  };
}
