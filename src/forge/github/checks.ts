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

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[a-z0-9.-]+$/i;

/** `host/owner/name` (ghRepoArg) split and checked, else undefined. */
function repoParts(repoArg: string | undefined): [string, string, string] | undefined {
  const parts = repoArg?.split('/') ?? [];
  return parts.length === 3 && HOST.test(parts[0]) && SEGMENT.test(parts[1]) && SEGMENT.test(parts[2]) ? [parts[0], parts[1], parts[2]] : undefined;
}

/** The read-only GETs of the forge's required checks and of a commit's checks: exact argv, built and matched here only. */
const apiGet = (host: string, path: string): string[] => ['api', '--hostname', host, '--method', 'GET', path];

/**
 * The two GETs of ghRequiredChecks for `base` of `repoArg` (ghRepoArg):
 * the branch (its `protection.required_status_checks`) and the rules that
 * apply to it (rulesets' `required_status_checks`).
 */
export function requiredChecksArgs(repoArg: string, base: string): string[][] {
  const [host, owner, name] = repoParts(repoArg) ?? [];
  if (!host) throw new Error(`not a GitHub repository argument: ${repoArg}`);
  const b = encodeURIComponent(base);
  return [apiGet(host, `repos/${owner}/${name}/branches/${b}`), apiGet(host, `repos/${owner}/${name}/rules/branches/${b}`)];
}

/** The GETs of latestChecks for `ref` of `repoArg`: the commit's check runs and its combined status. */
export function commitChecksArgs(repoArg: string, ref: string): string[][] {
  const [host, owner, name] = repoParts(repoArg) ?? [];
  if (!host) throw new Error(`not a GitHub repository argument: ${repoArg}`);
  const r = encodeURIComponent(ref);
  return [apiGet(host, `repos/${owner}/${name}/commits/${r}/check-runs?per_page=100`), apiGet(host, `repos/${owner}/${name}/commits/${r}/status?per_page=100`)];
}

const BRANCH_PATH = /^repos\/([^/]+)\/([^/]+)\/(?:branches|rules\/branches)\/([A-Za-z0-9_.%-]+)$/;
const COMMIT_PATH = /^repos\/([^/]+)\/([^/]+)\/commits\/([A-Za-z0-9_.%-]+)\/(?:check-runs|status)\?per_page=100$/;

/**
 * True for exactly one of the GETs above on `repoArg` (the guards of
 * factory run, setup and check allow these reads and nothing broader).
 * `commits` also allows the commit-check reads (setup and check only).
 */
export function isRequiredChecksArgs(args: readonly string[], repoArg: string | undefined, commits = false): boolean {
  const parts = repoParts(repoArg);
  if (!parts || args.length !== 6) return false;
  const [host, owner, name] = parts;
  if (args[0] !== 'api' || args[1] !== '--hostname' || args[2].toLowerCase() !== host.toLowerCase() || args[3] !== '--method' || args[4] !== 'GET') return false;
  const m = BRANCH_PATH.exec(args[5]) ?? (commits ? COMMIT_PATH.exec(args[5]) : null);
  return m !== null && m[1] === owner && m[2] === name && !/^\.+$/.test(m[3]);
}

function readJson(exec: Exec, args: string[], cwd?: string): unknown {
  let res: ReturnType<Exec>;
  try {
    res = exec('gh', args, { cwd });
  } catch {
    return undefined;
  }
  if (res.status !== 0) return undefined;
  try {
    return JSON.parse(res.stdout) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The status checks GitHub requires on `base` (the default of an empty
 * `ship.requiredChecks`): the branch protection's required contexts plus
 * the `required_status_checks` rules of the rulesets that apply to it. Read
 * from the forge API with the user's token, never from the repository tree.
 * undefined = neither read worked (the caller falls back to every reported
 * check); a readable empty list is [].
 */
export function ghRequiredChecks(exec: Exec, repoArg: string, base: string, cwd?: string): string[] | undefined {
  const [branchArgs, rulesArgs] = requiredChecksArgs(repoArg, base);
  const names = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && v.length > 0) names.add(v); };
  const branch = readJson(exec, branchArgs, cwd) as { protection?: { required_status_checks?: { contexts?: unknown; checks?: unknown } } } | undefined;
  const rules = readJson(exec, rulesArgs, cwd);
  if ((branch === undefined || typeof branch !== 'object') && !Array.isArray(rules)) return undefined;
  const rsc = branch?.protection?.required_status_checks;
  for (const c of Array.isArray(rsc?.contexts) ? rsc!.contexts as unknown[] : []) add(c);
  for (const c of Array.isArray(rsc?.checks) ? rsc!.checks as Array<{ context?: unknown }> : []) add(c?.context);
  for (const rule of Array.isArray(rules) ? rules : []) {
    const r = rule as { type?: unknown; parameters?: { required_status_checks?: unknown } };
    if (r?.type !== 'required_status_checks') continue;
    const list = r.parameters?.required_status_checks;
    for (const c of Array.isArray(list) ? list as Array<{ context?: unknown }> : []) add(c?.context);
  }
  return [...names];
}

/** The check names (check runs and commit statuses) GitHub reports for `ref`; undefined = unreadable. */
export function ghCommitCheckNames(exec: Exec, repoArg: string, ref: string, cwd?: string): string[] | undefined {
  const [runsArgs, statusArgs] = commitChecksArgs(repoArg, ref);
  const runs = readJson(exec, runsArgs, cwd) as { check_runs?: unknown } | undefined;
  const status = readJson(exec, statusArgs, cwd) as { statuses?: unknown } | undefined;
  if (!runs && !status) return undefined;
  const names = new Set<string>();
  for (const r of Array.isArray(runs?.check_runs) ? runs!.check_runs as Array<{ name?: unknown }> : []) if (typeof r?.name === 'string' && r.name) names.add(r.name);
  for (const s of Array.isArray(status?.statuses) ? status!.statuses as Array<{ context?: unknown }> : []) if (typeof s?.context === 'string' && s.context) names.add(s.context);
  return [...names];
}
