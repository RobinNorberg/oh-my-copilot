/**
 * Read-only GitHub and git access for `omg factory heal` through an injected
 * Exec. healGuardExec allows only the fixed read shapes below; PR 1 issues no
 * GitHub write (a rerun is recorded as an intent, never run), so `gh run
 * rerun`, `gh api` and every other command are refused before they spawn.
 */

import type { Exec } from '../../ship/exec.js';
import { ShipSafetyError, TRUSTED_READ_ENV } from '../../ship/exec.js';
import { capLog } from './logs.js';

export class HealSafetyError extends ShipSafetyError {
  constructor(message: string) {
    super(message);
    this.name = 'HealSafetyError';
  }
}

export const RUN_LIST_FIELDS = 'databaseId,conclusion,status,headSha,headBranch,event,createdAt';

const NUMBER = /^\d{1,20}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const BRANCH = /^[\w.][\w./-]*$/;
const WORKFLOW = /^[\w.-]+\.ya?ml$/;
const REPO_PATH = /^[\w.][\w.-]*(?:\/[\w.][\w.-]*)*$/;
const same = (args: string[], shape: string[]) => args.length === shape.length && shape.every((v, i) => args[i] === v);
const isBranch = (s: string | undefined) => typeof s === 'string' && BRANCH.test(s) && !s.includes('..');

function ghAllowed(a: string[]): boolean {
  const [group, sub, ...r] = a;
  if (group !== 'run') return false;
  if (sub === 'list') {
    // gh run list [--branch <b>] --workflow <file> --event <push|pull_request> --json <fields> --limit <n>
    const rest = r[0] === '--branch' && isBranch(r[1]) ? r.slice(2) : r;
    return rest.length === 8 && rest[0] === '--workflow' && WORKFLOW.test(rest[1])
      && rest[2] === '--event' && (rest[3] === 'push' || rest[3] === 'pull_request')
      && rest[4] === '--json' && rest[5] === RUN_LIST_FIELDS && rest[6] === '--limit' && NUMBER.test(rest[7]);
  }
  if (sub === 'view') {
    return (r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && r[2] === 'jobs')
      || (r.length === 3 && r[0] === '--job' && NUMBER.test(r[1]) && r[2] === '--log');
  }
  return false;
}

function gitAllowed(a: string[]): boolean {
  const [sub, ...r] = a;
  switch (sub) {
    case 'rev-parse':
      return same(r, ['--show-toplevel']);
    case 'cat-file':
      return r.length === 2 && r[0] === '-e' && /^[0-9a-f]{40}\^\{commit\}$/.test(r[1]);
    case 'merge-base': {
      // Is the first red sha on the integration branch: git merge-base --is-ancestor <sha> refs/remotes/origin/<base>
      const m = r.length === 3 && r[0] === '--is-ancestor' && /^[0-9a-f]{40}$/.test(r[1]) ? /^refs\/remotes\/origin\/(.+)$/.exec(r[2]) : null;
      return Boolean(m) && isBranch(m![1]);
    }
    case 'rev-list':
      return r.length === 2 && r[0] === '--count' && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(r[1]);
    case 'log':
      // Evidence bundle commit subjects: git log --oneline --no-decorate --no-color -n <n> <green>..<red>
      return r.length === 6 && r[0] === '--oneline' && r[1] === '--no-decorate' && r[2] === '--no-color' && r[3] === '-n'
        && /^\d{1,3}$/.test(r[4]) && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(r[5]);
    case 'diff':
      return r.length === 3 && r[0] === '--name-only' && r[1] === '--no-renames' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[2]);
    case 'show': {
      const m = r.length === 1 ? /^refs\/remotes\/origin\/([\w.][\w./-]*):(.+)$/.exec(r[0]) : null;
      return Boolean(m) && isBranch(m![1]) && REPO_PATH.test(m![2]) && !m![2].split('/').includes('..');
    }
    default:
      return false;
  }
}

const gitBase = (cmd: string): string => cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');

export function assertHealCommand(cmd: string, args: string[]): void {
  const base = gitBase(cmd);
  const ok = args.every((x) => typeof x === 'string') && (base === 'gh' ? ghAllowed(args) : base === 'git' ? gitAllowed(args) : false);
  if (!ok) throw new HealSafetyError(`omg factory heal refuses \`${base} ${args.join(' ')}\`: not one of its read-only command shapes`);
}

/** The exec every heal command runs through: allowlisted read shapes, git with replace refs off. */
export function healGuardExec(exec: Exec): Exec {
  return (cmd, args, opts) => {
    assertHealCommand(cmd, args);
    return exec(cmd, args, gitBase(cmd) === 'git' ? { ...opts, env: TRUSTED_READ_ENV } : opts);
  };
}

export interface HealRun {
  id: string;
  conclusion: string;
  status: string;
  headSha: string;
  headBranch: string;
  event: string;
  createdAt: string;
}

export interface HealJob {
  jobId: string;
  name: string;
  conclusion: string;
  failedSteps: string[];
}

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

export interface ShaRange {
  /** Commits in the red sha that the green sha lacks. */
  commits: number;
  /** Changed files under src/, tests/, scripts/ or package*.json (a range touching none cannot explain a test failure). */
  codeFiles: number;
  /** The first MAX_RANGE_FILES files the red sha changed since the merge base with the green sha. */
  files: string[];
}

export const MAX_RANGE_FILES = 50;
const CODE_PATH = /^(?:src\/|tests\/|scripts\/|package(?:-lock)?\.json$)/;

/** The range lastGreen..firstRed from local git; undefined when either commit is not fetched. */
export function shaRange(exec: Exec, root: string, green: string, red: string): ShaRange | undefined {
  if (!HEX40.test(green) || !HEX40.test(red)) return undefined;
  for (const sha of [green, red]) {
    if (exec('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status !== 0) return undefined;
  }
  const count = exec('git', ['rev-list', '--count', `${green}..${red}`], { cwd: root });
  const diff = exec('git', ['diff', '--name-only', '--no-renames', `${green}...${red}`], { cwd: root });
  if (count.status !== 0 || diff.status !== 0) return undefined;
  const files = diff.stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
  return { commits: Number(count.stdout.trim()) || 0, codeFiles: files.filter((f) => CODE_PATH.test(f)).length, files: files.slice(0, MAX_RANGE_FILES) };
}
