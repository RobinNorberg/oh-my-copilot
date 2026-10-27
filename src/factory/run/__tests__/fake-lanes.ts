/**
 * Test doubles for `omg factory run`: a scripted LaneBackend that creates a
 * real git worktree per lane (like copilot_run) and runs a script in it, a
 * repository with a local bare remote, and a scripted `gh` behind the exec
 * seam. No Copilot session, no network, no credits.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarizeChanges } from '../../../copilot-run/job.js';
import { gitIn } from '../../../copilot-run/__tests__/fake-sdk.js';
import { defaultExec, type Exec, type ExecResult } from '../../../ship/exec.js';
import { LaneLostError, type LaneBackend, type LaneResult, type LaneStartInput, type LaneState } from '../lane.js';

export { gitIn };

export interface LaneCtx {
  input: LaneStartInput;
  worktree: string;
  branch: string;
  baseSha: string;
  /** Main checkout. */
  root: string;
}

export interface LaneOutcome {
  state?: LaneState;
  finalText?: string;
  credits?: number;
  error?: string;
  /** wait() throws LaneLostError (the job vanished with its process). */
  lost?: boolean;
}

export type LaneScript = (ctx: LaneCtx) => LaneOutcome | void;

const generations = new Map<string, number>();

interface FakeJob {
  ctx: LaneCtx;
  script: LaneScript;
  outcome?: LaneOutcome;
  runningPolls: number;
}

export class FakeLanes implements LaneBackend {
  readonly kind = 'local-sdk' as const;
  readonly started: LaneStartInput[] = [];
  readonly cancelled: string[] = [];
  /** Called on every wait() that still reports `running`. */
  onRunningPoll: (remoteId: string) => void = () => {};
  private readonly jobs = new Map<string, FakeJob>();

  /** `scripts` is consumed in start order; `runningPolls[i]` makes lane i report `running` that many times first. */
  /** '' for the first backend on a repository, then `-g2`, `-g3`, ... */
  private readonly suffix: string;

  constructor(private readonly root: string, private readonly scripts: LaneScript[], private readonly runningPolls: number[] = []) {
    const n = (generations.get(root) ?? 0) + 1;
    generations.set(root, n);
    this.suffix = n === 1 ? '' : `-g${n}`;
  }

  async start(input: LaneStartInput): Promise<{ remoteId: string }> {
    const n = this.started.length;
    this.started.push(input);
    const script = this.scripts[n];
    if (!script) throw new Error(`fake lanes: no script for lane ${n + 1} (${input.laneId})`);
    // Unique across backends: a resumed run's lanes get new job ids (and lane branches), like copilot_run.
    const remoteId = `cr-fake${n + 1}${this.suffix}`;
    const branch = `omc-team/copilot-run/${remoteId}`;
    const worktree = join(this.root, '.omg', 'team', 'copilot-run', 'worktrees', remoteId);
    mkdirSync(join(worktree, '..'), { recursive: true });
    const baseSha = gitIn(this.root, 'rev-parse', '--verify', `${input.baseRef}^{commit}`);
    gitIn(this.root, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
    this.jobs.set(remoteId, { ctx: { input, worktree, branch, baseSha, root: this.root }, script, runningPolls: this.runningPolls[n] ?? 0 });
    return { remoteId };
  }

  private result(job: FakeJob, remoteId: string, state: LaneState): LaneResult {
    const terminal = state !== 'running';
    const o = job.outcome ?? {};
    return {
      state,
      branch: job.ctx.branch,
      pr: null,
      headSha: terminal ? gitIn(job.ctx.worktree, 'rev-parse', 'HEAD') : null,
      baseSha: job.ctx.baseSha,
      worktree: job.ctx.worktree,
      changes: terminal ? summarizeChanges(job.ctx.worktree, job.ctx.baseSha) : null,
      finalText: o.finalText ?? null,
      logsUrl: null,
      usage: { premiumRequests: terminal ? 1 : 0, credits: terminal ? (o.credits ?? 5) : 0, source: 'measured', detail: '' },
      remoteId,
      error: o.error ?? null,
      notes: [],
    };
  }

  async poll(remoteId: string): Promise<LaneResult> {
    return this.wait(remoteId, 0);
  }

  async wait(remoteId: string, _timeoutMs: number): Promise<LaneResult> {
    const job = this.jobs.get(remoteId);
    if (!job) throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
    if (job.runningPolls > 0) {
      job.runningPolls -= 1;
      this.onRunningPoll(remoteId);
      return this.result(job, remoteId, 'running');
    }
    if (!job.outcome) job.outcome = job.script(job.ctx) ?? {};
    if (job.outcome.lost) throw new LaneLostError(remoteId, 'job lost');
    return this.result(job, remoteId, job.outcome.state ?? 'completed');
  }

  async cancel(remoteId: string): Promise<{ supported: boolean; result: LaneResult }> {
    this.cancelled.push(remoteId);
    const job = this.jobs.get(remoteId)!;
    job.outcome = { ...(job.outcome ?? {}), state: 'cancelled' };
    return { supported: true, result: this.result(job, remoteId, 'cancelled') };
  }
}

/** Lane scripts. */
export const commitFile = (path: string, content = 'work\n', credits = 5): LaneScript => ({ worktree }) => {
  mkdirSync(join(worktree, path, '..'), { recursive: true });
  writeFileSync(join(worktree, path), content);
  gitIn(worktree, 'add', '--', path);
  gitIn(worktree, 'commit', '-q', '-m', `lane: ${path}`);
  return { finalText: 'Committed.', credits };
};

export const noCommit: LaneScript = () => ({ finalText: 'Nothing to do.' });

export function verdictBlock(verdict: 'approve' | 'request-changes', sha: string, findings: unknown[] = [], notes = ''): string {
  return `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ verdict, sha, findings, notes })}\n\`\`\`\n`;
}

/** A review lane answering for the sha it was started at; `tamper` runs in the lane first. */
export const review = (verdict: 'approve' | 'request-changes', findings: unknown[] = [], tamper?: (ctx: LaneCtx) => void): LaneScript => (ctx) => {
  tamper?.(ctx);
  return { finalText: verdictBlock(verdict, ctx.baseSha, findings), credits: 3 };
};

export const ISSUE = 7;
export const REPO_URL = 'https://github.com/o/r';
export const PR = 42;

export interface Harness {
  dir: string;
  root: string;
  bare: string;
  exec: Exec;
  calls: string[];
  gh: {
    issue: { title: string; body: string; state: string; comments: Array<{ body: string }> };
    prCreated: boolean;
    /** Override what `gh pr view` reports as the head (default: the bare remote's factory branch). */
    headOverride?: string;
    openPrs: number[];
  };
}

/** `<dir>/remote.git` (bare) and `<dir>/repo` on `dev` tracking it; `.omg/` ignored. */
export function harness(prefix = 'omg-factory-run-'): Harness {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bare = join(dir, 'remote.git');
  const root = join(dir, 'repo');
  gitIn(dir, 'init', '-q', '--bare', '-b', 'dev', bare);
  mkdirSync(root);
  gitIn(root, 'init', '-q', '-b', 'dev');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  writeFileSync(join(root, '.gitignore'), '.omg/\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\n\nAdd greet().\n');
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-q', '-m', 'init');
  gitIn(root, 'remote', 'add', 'origin', bare);
  gitIn(root, 'push', '-q', 'origin', 'dev');
  const h: Harness = {
    dir, root, bare, calls: [],
    gh: { issue: { title: 'Add greet()', body: '## Acceptance criteria\n\n- greet() returns hi\n', state: 'OPEN', comments: [] }, prCreated: false, openPrs: [] },
    exec: () => ({ status: 1, stdout: '', stderr: '' }),
  };
  const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
  h.exec = (cmd, args, opts) => {
    const key = `${cmd} ${args.join(' ')}`;
    h.calls.push(key);
    if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return ok(`${REPO_URL}.git\n`);
    if (cmd === 'git') return defaultExec(cmd, args, opts);
    if (key.startsWith(`gh issue view ${ISSUE} --json`)) return ok(JSON.stringify({ ...h.gh.issue, labels: [], url: `${REPO_URL}/issues/${ISSUE}` }));
    if (key.startsWith('gh pr list --head factory/issue-')) return ok(JSON.stringify(h.gh.openPrs.map((number) => ({ number, state: 'OPEN' }))));
    if (key.startsWith('gh pr create ')) {
      h.gh.prCreated = true;
      h.gh.openPrs = [PR];
      return ok(`${REPO_URL}/pull/${PR}\n`);
    }
    if (key.startsWith(`gh pr view ${PR} --json headRefOid`)) {
      const remote = defaultExec('git', ['ls-remote', bare, `refs/heads/factory/issue-${ISSUE}`]).stdout.split(/\s+/)[0];
      return ok(JSON.stringify({ headRefOid: h.gh.headOverride ?? remote, state: 'OPEN' }));
    }
    if (key.startsWith('gh pr comment ') || key.startsWith('gh issue comment ')) return ok('');
    return { status: 1, stdout: '', stderr: `unscripted: ${key}` };
  };
  return h;
}

export function remoteHead(h: Harness): string | null {
  return defaultExec('git', ['ls-remote', h.bare, `refs/heads/factory/issue-${ISSUE}`]).stdout.split(/\s+/)[0] || null;
}
