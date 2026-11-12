/**
 * The scripted lanes of `omg factory bench --fake`: the same shape as the
 * engine tests' fake lanes (a real git worktree per lane, like copilot_run;
 * the write lane leaves its change uncommitted for the engine to commit; a
 * review lane answers with a verdict block for the sha it started at), with
 * the steps of one bench issue (fixtures/issues.ts `fake`). No Copilot
 * session, no network, no credits: usage is reported as one premium request
 * and a fixed credit count per lane, marked `estimated`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { summarizeChanges } from '../../copilot-run/job.js';
import { defaultExec } from '../../ship/exec.js';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../team/git-worktree.js';
import { LaneLostError } from '../run/lane.js';
/** The credits a fake lane reports (a write lane and a review lane alike). */
export const FAKE_LANE_CREDITS = 1;
/** A write lane's sandbox record on a host that confirmed the sandbox (what a real enforced lane reports). */
const ENFORCED = { mode: 'enforced', host: {}, applied: 'create', canary: 'skipped', unsandboxedCalls: 0, cliVersion: 'fake', sdkVersion: 'fake', writeNetwork: 'none' };
function git(cwd, args) {
    const r = defaultExec('git', args, { cwd });
    if (r.status !== 0)
        throw new Error(`fake lane: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
}
let generation = 0;
export class BenchFakeLanes {
    root;
    steps;
    fill;
    kind = 'local-sdk';
    started = [];
    jobs = new Map();
    suffix = `b${++generation}`;
    /** `fill` resolves the fixture placeholders in a written file. */
    constructor(root, steps, fill) {
        this.root = root;
        this.steps = steps;
        this.fill = fill;
    }
    async start(input) {
        const n = this.started.length;
        this.started.push(input);
        const remoteId = `cr-bench-${this.suffix}-${n + 1}`;
        const own = input.worktree;
        let worktree;
        let branch = '';
        let baseSha;
        if (own) {
            worktree = own.path;
            baseSha = git(worktree, ['rev-parse', 'HEAD']);
        }
        else {
            branch = `omc-team/copilot-run/${remoteId}`;
            worktree = join(this.root, '.omg', 'team', 'copilot-run', 'worktrees', remoteId);
            mkdirSync(dirname(worktree), { recursive: true });
            baseSha = git(this.root, ['rev-parse', '--verify', `${input.baseRef}^{commit}`]);
            git(this.root, ['worktree', 'add', '-q', '-b', branch, worktree, baseSha]);
            recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree));
        }
        this.jobs.set(remoteId, { input, step: this.steps[n], worktree, branch, baseSha });
        return { remoteId };
    }
    run(job) {
        const step = job.step;
        if (!step)
            return { finalText: '', error: `bench fake: no scripted step for lane ${job.input.laneId}` };
        if (step.kind === 'review') {
            const block = JSON.stringify({ verdict: step.verdict, sha: job.baseSha, findings: step.findings ?? [], notes: '' });
            return { finalText: `Reviewed.\n\n\`\`\`json\n${block}\n\`\`\`\n`, error: null };
        }
        for (const [rel, text] of Object.entries(step.files)) {
            const abs = join(job.worktree, ...rel.split('/'));
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, this.fill(text));
        }
        return { finalText: step.text ?? `Changed ${Object.keys(step.files).join(', ')}.`, error: null };
    }
    result(job, remoteId, state) {
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
        };
    }
    async poll(remoteId) {
        return this.wait(remoteId, 0);
    }
    async wait(remoteId, _timeoutMs) {
        const job = this.jobs.get(remoteId);
        if (!job)
            throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
        if (!job.done)
            job.done = this.run(job);
        return this.result(job, remoteId, job.done.error ? 'failed' : 'completed');
    }
    async cancel(remoteId) {
        const job = this.jobs.get(remoteId);
        if (!job)
            throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
        job.done ??= { finalText: '', error: 'cancelled' };
        return { supported: true, result: this.result(job, remoteId, 'cancelled') };
    }
}
/** A pid no real process has (the fake Copilot child). */
const fakeProcess = (remoteId) => ({ pid: 4_100_000 + [...remoteId].reduce((n, c) => n + c.charCodeAt(0), 0), identity: `bench:${remoteId}` });
/** The fake lanes' process seam: every lane child is already gone. */
export const BENCH_FAKE_PROCESSES = {
    state: async () => 'dead',
    terminate: async () => { },
    treeGone: async () => ({ kind: 'gone', killed: [] }),
};
//# sourceMappingURL=fake-lanes.js.map