/**
 * GitHub checks (factory forges design §2, PR 2): `gh pr checks`, the PR
 * head, `gh run list --commit`, job logs and `gh run rerun --failed`. The
 * bodies moved verbatim from src/ship/gates.ts and gates-driver.ts, whose
 * exported names now delegate here; argv, cwd and error text are unchanged.
 */

import type { Exec } from '../../ship/exec.js';
import { CHECK_FIELDS, GhChecksError, parseChecksJson, parseRunsJson, RUN_FIELDS, TRANSIENT_GH_ERROR, type GhCheck, type WorkflowRun } from '../../ship/gates.js';
import type { ForgeChecks } from '../types.js';

/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list. */
export function ghPrChecks(exec: Exec, pr: number, cwd?: string): GhCheck[] {
  const res = exec('gh', ['pr', 'checks', String(pr), '--json', CHECK_FIELDS], { cwd });
  const out = res.stdout.trim();
  if (out.startsWith('[')) return parseChecksJson(out);
  if (/no checks reported/i.test(res.stderr) || /no checks reported/i.test(res.stdout)) return [];
  throw new GhChecksError(`gh pr checks ${pr} failed (exit ${res.status}): ${res.stderr.trim() || out}`);
}

/** The PR head sha from `gh pr view <pr> --json headRefOid`. */
export function ghHeadSha(exec: Exec, pr: number, cwd?: string): string {
  const res = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd });
  let sha: unknown;
  try {
    sha = (JSON.parse(res.stdout) as { headRefOid?: unknown }).headRefOid;
  } catch {
    sha = undefined;
  }
  if (res.status !== 0 || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GhChecksError(`gh pr view ${pr} did not return a head sha (exit ${res.status}): ${res.stderr.trim()}`);
  }
  return sha;
}

/**
 * Run `gh run list --commit <sha> --json ...`: every Actions workflow run for
 * the head sha. A run whose reported head_sha is another commit is dropped, so
 * a previous head's failed run never counts against this one.
 */
export function ghRunsForHead(exec: Exec, headSha: string, cwd?: string): WorkflowRun[] {
  const res = exec('gh', ['run', 'list', '--commit', headSha, '--json', RUN_FIELDS, '--limit', '100'], { cwd });
  if (res.status !== 0) throw new GhChecksError(`gh run list --commit ${headSha.slice(0, 12)} failed (exit ${res.status}): ${res.stderr.trim()}`);
  return parseRunsJson(res.stdout.trim() || '[]').filter((r) => !r.headSha || r.headSha === headSha);
}

/** `gh run view --job <id> --log`; `ok: false` (text = whatever stdout held) when gh failed. */
export function ghJobLog(exec: Exec, jobId: string, cwd?: string): { ok: boolean; text: string } {
  const res = exec('gh', ['run', 'view', '--job', jobId, '--log'], { cwd });
  return { ok: res.status === 0, text: res.stdout };
}

/** `gh run rerun <id> --failed`. */
export function ghRerun(exec: Exec, runId: string, cwd?: string): { ok: boolean; stderr: string } {
  const res = exec('gh', ['run', 'rerun', runId, '--failed'], { cwd });
  return { ok: res.status === 0, stderr: res.stderr };
}

/** ForgeChecks on GitHub: `pr checks` already reports the PR head, and a run list is per commit, so `headSha` / `pr` are not needed there. */
export function githubChecks(exec: Exec, cwd?: string): ForgeChecks {
  return {
    checks: (pr) => ghPrChecks(exec, pr, cwd),
    runsForHead: (_pr, headSha) => ghRunsForHead(exec, headSha, cwd),
    jobLog: (jobId) => ghJobLog(exec, jobId, cwd),
    rerun: (_pr, runId) => ghRerun(exec, runId, cwd),
    transientError: TRANSIENT_GH_ERROR,
  };
}
