/**
 * The scripted lanes of `omg factory bench --fake`: the same shape as the
 * engine tests' fake lanes (a real git worktree per lane, like copilot_run;
 * the write lane leaves its change uncommitted for the engine to commit; a
 * review lane answers with a verdict block for the sha it started at), with
 * the steps of one bench issue (seed/issues.ts `fake`). No Copilot
 * session, no network, no credits: usage is reported as one premium request
 * and a fixed credit count per lane, marked `estimated`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { summarizeChanges } from '../../copilot-run/job.js';
import type { CopilotRunSandboxState } from '../../copilot-run/sandbox.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { defaultExec } from '../../ship/exec.js';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../team/git-worktree.js';
import type { LaneProcessOps } from '../run/engine.js';
import { LaneLostError, type LaneBackend, type LaneProcess, type LaneResult, type LaneStartInput } from '../run/lane.js';
import type { FakeStep } from './seed/issues.js';

/** The credits a fake lane reports (a write lane and a review lane alike). */
export const FAKE_LANE_CREDITS = 1;

/** A write lane's sandbox record on a host that confirmed the sandbox (what a real enforced lane reports). */
const ENFORCED: CopilotRunSandboxState = { mode: 'enforced', host: {}, applied: 'create', canary: 'skipped', unsandboxedCalls: 0, cliVersion: 'fake', sdkVersion: 'fake', writeNetwork: 'none' } as unknown as CopilotRunSandboxState;

function git(cwd: string, args: string[]): string {
  const r = defaultExec('git', args, { cwd });
  if (r.status !== 0) throw new Error(`fake lane: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

interface Job {
  input: LaneStartInput;
  step: FakeStep | undefined;
  worktree: string;
  branch: string;
  baseSha: string;
  remoteId: string;
  done?: { finalText: string; error: string | null };
}

let generation = 0;

export class BenchFakeLanes implements LaneBackend {
  readonly kind = 'local-sdk' as const;
  readonly started: LaneStartInput[] = [];
  private readonly jobs = new Map<string, Job>();
  private readonly suffix = `b${++generation}`;

  /** `fill` resolves the fixture placeholders in a written file. */
  constructor(private readonly root: string, private readonly steps: readonly FakeStep[], private readonly fill: (text: string) => string) {}

  async start(input: LaneStartInput): Promise<{ remoteId: string }> {
    const n = this.started.length;
    this.started.push(input);
    const remoteId = `cr-bench-${this.suffix}-${n + 1}`;
    const own = input.worktree;
    let worktree: string;
    let branch = '';
    let baseSha: string;
    if (own) {
      worktree = own.path;
      baseSha = git(worktree, ['rev-parse', 'HEAD']);
    } else {
      branch = `omc-team/copilot-run/${remoteId}`;
      worktree = join(getOmcRoot(this.root), 'team', 'copilot-run', 'worktrees', remoteId);
      mkdirSync(dirname(worktree), { recursive: true });
      baseSha = git(this.root, ['rev-parse', '--verify', `${input.baseRef}^{commit}`]);
      git(this.root, ['worktree', 'add', '-q', '-b', branch, worktree, baseSha]);
      recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree)!);
    }
    this.jobs.set(remoteId, { input, step: this.steps[n], worktree, branch, baseSha, remoteId });
    return { remoteId };
  }

  private run(job: Job): { finalText: string; error: string | null } {
    const step = job.step;
    if (!step) return { finalText: '', error: `bench fake: no scripted step for lane ${job.input.laneId}` };
    if (step.kind === 'review') {
      const block = JSON.stringify({ verdict: step.verdict, sha: job.baseSha, findings: step.findings ?? [], notes: '' });
      return { finalText: `Reviewed.\n\n\`\`\`json\n${block}\n\`\`\`\n`, error: null };
    }
    for (const [rel, text] of Object.entries(step.files)) {
      const abs = join(job.worktree, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, this.fill(text));
    }
    for (const rel of step.delete ?? []) rmSync(join(job.worktree, ...rel.split('/')), { force: true });
    if (step.guardDenials?.length) this.writeGuardDenials(job, step.guardDenials);
    return { finalText: step.text ?? `Changed ${[...Object.keys(step.files), ...(step.delete ?? [])].join(', ')}.`, error: null };
  }

  /**
   * The events a real lane's job writes when git-guardrails denies a shell
   * call (copilot-run events.jsonl: tool.execution_start, the preToolUse
   * hook.end carrying the guard's message, tool.execution_complete with
   * error.code "denied"), in the job dir a real lane uses.
   */
  private writeGuardDenials(job: Job, commands: readonly string[]): void {
    const dir = join(getOmcRoot(this.root), 'state', 'copilot-run', job.remoteId);
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const lines = commands.flatMap((command, n) => {
      const toolCallId = `call_bench_${n + 1}`;
      const message = `Git guardrail: blocked "${command.startsWith('git push') ? 'git push' : 'git reset --hard'}".\nYou do not have authority for this operation - it destroys or publishes state the user owns.`;
      return [
        { at, type: 'tool.execution_start', data: { toolCallId, toolName: 'bash', arguments: { command } } },
        { at, type: 'hook.end', data: { hookType: 'preToolUse', success: true, output: { permissionDecision: 'deny', permissionDecisionReason: message } } },
        { at, type: 'tool.execution_complete', data: { toolCallId, success: false, error: { code: 'denied', message } } },
      ];
    });
    writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { flag: 'a' });
  }

  private result(job: Job, remoteId: string, state: LaneResult['state']): LaneResult {
    const review = job.input.profile === 'review';
    return {
      state,
      branch: job.branch || null,
      pr: null,
      headSha: git(job.worktree, ['rev-parse', 'HEAD']),
      baseSha: job.baseSha,
      worktree: job.worktree,
      changes: summarizeChanges(job.worktree, job.baseSha),
      finalText: job.done?.finalText ?? null,
      logsUrl: null,
      usage: { premiumRequests: 1, credits: FAKE_LANE_CREDITS, source: 'estimated', detail: 'omg factory bench --fake' },
      remoteId,
      error: job.done?.error ?? null,
      notes: [],
      process: fakeProcess(remoteId),
      ...(review ? {} : { sandbox: ENFORCED }),
      // Like copilot_run's snapshot.model: the session runs on the model it was started with.
      ...(job.input.model ? { model: job.input.model } : {}),
    };
  }

  async poll(remoteId: string): Promise<LaneResult> {
    return this.wait(remoteId, 0);
  }

  async wait(remoteId: string, _timeoutMs: number): Promise<LaneResult> {
    const job = this.jobs.get(remoteId);
    if (!job) throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
    if (!job.done) job.done = this.run(job);
    return this.result(job, remoteId, job.done.error ? 'failed' : 'completed');
  }

  async cancel(remoteId: string): Promise<{ supported: boolean; result: LaneResult }> {
    const job = this.jobs.get(remoteId);
    if (!job) throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
    job.done ??= { finalText: '', error: 'cancelled' };
    return { supported: true, result: this.result(job, remoteId, 'cancelled') };
  }
}

/** A pid no real process has (the fake Copilot child). */
const fakeProcess = (remoteId: string): LaneProcess => ({ pid: 4_100_000 + [...remoteId].reduce((n, c) => n + c.charCodeAt(0), 0), identity: `bench:${remoteId}` });

/** The fake lanes' process seam: every lane child is already gone. */
export const BENCH_FAKE_PROCESSES: LaneProcessOps = {
  state: async () => 'dead',
  terminate: async () => {},
  treeGone: async () => ({ kind: 'gone', killed: [] }),
};
