/**
 * Test doubles for `omg factory run`: a scripted LaneBackend that creates a
 * real git worktree per lane (like copilot_run) and runs a script in it, a
 * repository with a local bare remote, and a scripted `gh` behind the exec
 * seam. No Copilot session, no network, no credits.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeChanges } from '../../../copilot-run/job.js';
import { gitIn } from '../../../copilot-run/__tests__/fake-sdk.js';
import { resolveShipConfig } from '../../../ship/config.js';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../../team/git-worktree.js';
import { defaultExec } from '../../../ship/exec.js';
import { LaneLostError } from '../lane.js';
export { gitIn };
const generations = new Map();
export class FakeLanes {
    root;
    scripts;
    runningPolls;
    kind = 'local-sdk';
    started = [];
    cancelled = [];
    /** Called on every wait() that still reports `running`. */
    onRunningPoll = () => { };
    jobs = new Map();
    /** `scripts` is consumed in start order; `runningPolls[i]` makes lane i report `running` that many times first. */
    /** '' for the first backend on a repository, then `-g2`, `-g3`, ... */
    suffix;
    constructor(root, scripts, runningPolls = []) {
        this.root = root;
        this.scripts = scripts;
        this.runningPolls = runningPolls;
        const n = (generations.get(root) ?? 0) + 1;
        generations.set(root, n);
        this.suffix = n === 1 ? '' : `-g${n}`;
    }
    async start(input) {
        const n = this.started.length;
        this.started.push(input);
        const script = this.scripts[n];
        if (!script)
            throw new Error(`fake lanes: no script for lane ${n + 1} (${input.laneId})`);
        // Unique across backends: a resumed run's lanes get new job ids (and lane branches), like copilot_run.
        const remoteId = `cr-fake${n + 1}${this.suffix}`;
        const branch = `omc-team/copilot-run/${remoteId}`;
        const worktree = join(this.root, '.omg', 'team', 'copilot-run', 'worktrees', remoteId);
        mkdirSync(join(worktree, '..'), { recursive: true });
        const baseSha = gitIn(this.root, 'rev-parse', '--verify', `${input.baseRef}^{commit}`);
        gitIn(this.root, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
        // Like copilot_run: the git links are recorded at creation.
        recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree));
        this.jobs.set(remoteId, { ctx: { input, worktree, branch, baseSha, root: this.root }, script, runningPolls: this.runningPolls[n] ?? 0 });
        return { remoteId };
    }
    result(job, remoteId, state) {
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
            process: fakeProcess(remoteId),
            ...(o.sandbox ? { sandbox: o.sandbox } : {}),
        };
    }
    async poll(remoteId) {
        return this.wait(remoteId, 0);
    }
    async wait(remoteId, _timeoutMs) {
        const job = this.jobs.get(remoteId);
        if (!job)
            throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
        if (job.runningPolls > 0) {
            job.runningPolls -= 1;
            this.onRunningPoll(remoteId);
            return this.result(job, remoteId, 'running');
        }
        if (!job.outcome)
            job.outcome = job.script(job.ctx) ?? {};
        if (job.outcome.lost)
            throw new LaneLostError(remoteId, 'job lost');
        return this.result(job, remoteId, job.outcome.state ?? 'completed');
    }
    /** cancel() throws a plain error (the backend cannot tell whether the job stopped). */
    cancelFails = false;
    async cancel(remoteId) {
        this.cancelled.push(remoteId);
        if (this.cancelFails)
            throw new Error(`fake lanes: cancel of ${remoteId} timed out`);
        const job = this.jobs.get(remoteId);
        // Like copilot_run after a restart: a job the backend does not know (or lost) is LaneLostError.
        if (!job || job.outcome?.lost)
            throw new LaneLostError(remoteId, `unknown job ${remoteId}`);
        job.outcome = { ...(job.outcome ?? {}), state: 'cancelled' };
        return { supported: true, result: this.result(job, remoteId, 'cancelled') };
    }
}
/** The fake Copilot child of a job: a pid no real process has, with a fake start identity. */
export const fakeProcess = (remoteId) => ({ pid: 4_000_000 + [...remoteId].reduce((n, c) => n + c.charCodeAt(0), 0), identity: `ticks:${remoteId}` });
/**
 * A scripted process seam (FactoryEngineOptions.processes): every child is
 * dead unless listed in `live` (killed by terminate only when `killable`) or
 * `unknown`. Records the pids it checked and killed.
 */
export class FakeProcesses {
    live = new Set();
    unknown = new Set();
    killable = true;
    checked = [];
    killed = [];
    async state(p) {
        this.checked.push(p.pid);
        if (this.unknown.has(p.pid))
            return 'unknown';
        return this.live.has(p.pid) ? 'live' : 'dead';
    }
    async terminate(p) {
        this.killed.push(p.pid);
        if (this.killable)
            this.live.delete(p.pid);
    }
}
/** Lane scripts. A write lane leaves its change uncommitted: the engine commits it (lane-commit.ts). */
export const commitFile = (path, content = 'work\n', credits = 5) => ({ worktree }) => {
    mkdirSync(join(worktree, path, '..'), { recursive: true });
    writeFileSync(join(worktree, path), content);
    return { finalText: `Changed ${path}.`, credits };
};
export const noCommit = () => ({ finalText: 'Nothing to do.' });
export function verdictBlock(verdict, sha, findings = [], notes = '') {
    return `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ verdict, sha, findings, notes })}\n\`\`\`\n`;
}
/** A review lane answering for the sha it was started at; `tamper` runs in the lane first. */
export const review = (verdict, findings = [], tamper) => (ctx) => {
    tamper?.(ctx);
    return { finalText: verdictBlock(verdict, ctx.baseSha, findings), credits: 3 };
};
export const ISSUE = 7;
export const REPO_URL = 'https://github.com/o/r';
export const PR = 42;
/** One required check `Test` from Actions run 100 (job 200), and that run. */
export const greenGates = (runId = 100) => ({
    checks: [{ name: 'Test', state: 'SUCCESS', link: `${REPO_URL}/actions/runs/${runId}/job/${runId * 2}` }],
    runs: [{ databaseId: runId, status: 'completed', conclusion: 'success', workflowName: 'CI' }],
});
export const pendingGates = (runId = 100) => ({
    checks: [{ name: 'Test', state: 'IN_PROGRESS', link: `${REPO_URL}/actions/runs/${runId}/job/${runId * 2}` }],
    runs: [{ databaseId: runId, status: 'in_progress', workflowName: 'CI' }],
});
export const failedGates = (runId = 100) => ({
    checks: [{ name: 'Test', state: 'FAILURE', link: `${REPO_URL}/actions/runs/${runId}/job/${runId * 2}` }],
    runs: [{ databaseId: runId, status: 'completed', conclusion: 'failure', workflowName: 'CI' }],
});
/** Ship's gate config without a fetch: the one required check `Test`, no advisory checks, no known-flaky tests. */
export const testGateConfig = () => ({
    config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [] },
    known: [],
});
/** `<dir>/remote.git` (bare) and `<dir>/repo` on `dev` tracking it; `.omg/` ignored. */
export function harness(prefix = 'omg-factory-run-') {
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
    const h = {
        dir, root, bare, ledgerDir: join(dir, 'ledger'), calls: [], raw: [],
        gh: {
            issue: { title: 'Add greet()', body: '## Acceptance criteria\n\n- greet() returns hi\n', state: 'OPEN', author: { login: 'o' }, comments: [] },
            prCreated: false, branch: `factory/issue-${ISSUE}`, openPrs: [], headSequence: [], ready: false, merged: false, gates: [greenGates()], logs: {},
        },
        node: () => ok(''),
        exec: () => ({ status: 1, stdout: '', stderr: '' }),
    };
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    let gatesRead = 0;
    const currentGates = () => h.gh.gates[Math.min(Math.max(gatesRead - 1, 0), h.gh.gates.length - 1)];
    h.exec = (cmd, rawArgs, opts) => {
        h.raw.push({ cmd, args: rawArgs, ...(opts?.env ? { env: opts.env } : {}) });
        let args = rawArgs;
        while (cmd === 'git' && args[0] === '-c')
            args = args.slice(2);
        const isNode = cmd === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(cmd);
        const key = `${isNode ? 'node' : cmd} ${args.join(' ')}`;
        h.calls.push(key);
        h.onCall?.(key);
        if (isNode)
            return h.node(args);
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url')
            return ok(`${REPO_URL}.git\n`);
        if (cmd === 'git')
            return defaultExec(cmd, rawArgs, opts);
        if (key.startsWith(`gh pr view ${PR} --json `)) {
            const remote = bareRef(bare, `refs/heads/${h.gh.branch}`);
            const base = bareRef(bare, 'refs/heads/dev');
            const headRefOid = h.gh.headSequence.shift() ?? h.gh.headOverride ?? remote;
            return ok(JSON.stringify({ number: PR, headRefOid, state: h.gh.merged ? 'MERGED' : 'OPEN', isDraft: !h.gh.ready, baseRefName: 'dev', baseRefOid: base }));
        }
        if (key === `gh pr ready ${PR}`) {
            h.gh.ready = true;
            return ok('');
        }
        if (key.startsWith(`gh pr checks ${PR} --json`)) {
            gatesRead += 1;
            return ok(JSON.stringify(currentGates().checks));
        }
        if (key.startsWith('gh run list --commit '))
            return ok(JSON.stringify(currentGates().runs));
        if (key.startsWith('gh run view --job '))
            return ok(h.gh.logs[args[3]] ?? '');
        if (key.startsWith('gh run rerun '))
            return ok('');
        if (key.startsWith(`gh issue view ${ISSUE} --json`))
            return ok(JSON.stringify({ ...h.gh.issue, labels: [], url: `${REPO_URL}/issues/${ISSUE}` }));
        if (key === 'gh repo view --json url')
            return ok(JSON.stringify({ url: REPO_URL }));
        if (key.startsWith('gh pr list --head factory/'))
            return ok(JSON.stringify(h.gh.openPrs.map((number) => ({ number, state: 'OPEN' }))));
        if (key.startsWith('gh pr create ')) {
            h.gh.prCreated = true;
            h.gh.openPrs = [PR];
            return ok(`${REPO_URL}/pull/${PR}\n`);
        }
        if (key.startsWith('gh pr comment ') || key.startsWith('gh issue comment '))
            return ok('');
        return { status: 1, stdout: '', stderr: `unscripted: ${key}` };
    };
    return h;
}
/** A ref of the bare remote: its loose ref file (pushes write one), else ls-remote. */
function bareRef(bare, ref) {
    const loose = join(bare, ...ref.split('/'));
    if (existsSync(loose))
        return readFileSync(loose, 'utf8').trim();
    return defaultExec('git', ['ls-remote', bare, ref]).stdout.split(/\s+/)[0];
}
export function remoteHead(h) {
    return defaultExec('git', ['ls-remote', h.bare, `refs/heads/${h.gh.branch}`]).stdout.split(/\s+/)[0] || null;
}
//# sourceMappingURL=fake-lanes.js.map