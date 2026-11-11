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
/** A write lane's record on a host that confirmed the sandbox, with the default writeNetwork. */
export const ENFORCED_SANDBOX = { mode: 'enforced', host: {}, applied: 'create', canary: 'skipped', unsandboxedCalls: 0, cliVersion: 'x', sdkVersion: 'x', writeNetwork: 'none' };
import { gitIn } from '../../../copilot-run/__tests__/fake-sdk.js';
import { resolveShipConfig } from '../../../ship/config.js';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../../team/git-worktree.js';
import { defaultExec } from '../../../ship/exec.js';
import { defaultLocalGateRunner } from '../local-gate.js';
import { REVIEW_FEEDBACK_QUERY } from '../../../forge/github/graphql.js';
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
        // The private layout: the engine made the worktree (detached, links recorded); like copilot_run, no branch then.
        const own = input.worktree;
        const branch = own ? '' : `omc-team/copilot-run/${remoteId}`;
        const worktree = own ? own.path : join(this.root, '.omg', 'team', 'copilot-run', 'worktrees', remoteId);
        let baseSha;
        if (own) {
            baseSha = gitIn(worktree, 'rev-parse', 'HEAD');
        }
        else {
            mkdirSync(join(worktree, '..'), { recursive: true });
            baseSha = gitIn(this.root, 'rev-parse', '--verify', `${input.baseRef}^{commit}`);
            gitIn(this.root, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
            // Like copilot_run: the git links are recorded at creation.
            recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree));
        }
        this.jobs.set(remoteId, { ctx: { input, worktree, branch, baseSha, root: this.root }, script, runningPolls: this.runningPolls[n] ?? 0 });
        return { remoteId };
    }
    result(job, remoteId, state) {
        const terminal = state !== 'running';
        const o = job.outcome ?? {};
        return {
            state,
            branch: job.ctx.branch || null,
            pr: null,
            headSha: terminal ? gitIn(job.ctx.worktree, 'rev-parse', 'HEAD') : null,
            baseSha: job.ctx.baseSha,
            worktree: o.reportWorktree ?? job.ctx.worktree,
            changes: terminal && !o.noChanges ? summarizeChanges(job.ctx.worktree, job.ctx.baseSha) : null,
            finalText: o.finalText ?? null,
            logsUrl: null,
            usage: { premiumRequests: terminal ? 1 : 0, credits: terminal ? (o.credits ?? 5) : 0, source: 'measured', detail: '' },
            remoteId,
            error: o.error ?? null,
            notes: [],
            process: fakeProcess(remoteId),
            ...(o.sandbox ? { sandbox: o.sandbox } : o.sandbox === undefined && job.ctx.input.profile !== 'review' ? { sandbox: ENFORCED_SANDBOX } : {}),
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
    /** What treeGone answers (default: the tree is gone); `trees` records each call's worktree. */
    tree = { kind: 'gone', killed: [] };
    trees = [];
    async treeGone(_p, worktree) {
        this.trees.push(worktree);
        return this.tree;
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
/**
 * The engine tests' OS sandbox: every command counts as run in the attested
 * sandbox. A prepare check runs through the test's exec seam (as the
 * unsandboxed engine ran it), the local gate through the test's gate runner
 * or else the engine's plain one (a runner whose executable cannot start
 * gives no verdict), and a base
 * calibration passes without running anything. Tests of the sandbox
 * decisions themselves pass their own runner.
 */
export function attestedSandbox(exec, gate = () => undefined) {
    return async (req) => {
        if (req.purpose === 'calibrate')
            return { ran: true, status: 0, output: '', timedOut: false };
        // No test runner: the engine's own plain runner, as the engine ran the gate before the sandbox.
        const runner = gate() ?? defaultLocalGateRunner;
        if (req.purpose === 'gate') {
            const r = await runner(req.argv, req.cwd, req.timeoutMs);
            if (r.startError !== undefined)
                return { ran: false, reason: r.startError };
            return { ran: true, status: r.timedOut ? 124 : r.status, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, timedOut: r.timedOut };
        }
        const r = exec()(req.exe, [...req.args], { cwd: req.cwd });
        return { ran: true, status: r.status, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, timedOut: false };
    };
}
/**
 * Engine options with the test sandbox (attestedSandbox over the options'
 * own exec and gate runner) and no user config for factory.run.sandbox.gates,
 * unless `over` sets either (a `gateSandbox: undefined` there means none).
 */
export function withTestSandbox(o, over = {}) {
    return {
        ...o,
        ...('gateSandboxUserConfig' in over ? {} : { gateSandboxUserConfig: null }),
        // The developer's own factory.run.layout never reaches the tests.
        ...('runUserConfig' in over || 'runUserConfig' in o ? {} : { runUserConfig: null }),
        ...('gateSandbox' in over ? {} : { gateSandbox: attestedSandbox(() => o.exec, () => o.localGate) }),
    };
}
/** `<dir>/remote.git` (bare) and `<dir>/repo` on `dev` tracking it; `.omg/` ignored. */
export function harness(prefix = 'omg-factory-run-') {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const bare = join(dir, 'remote.git');
    const root = join(dir, 'repo');
    gitIn(dir, 'init', '-q', '--bare', '-b', 'dev', bare);
    mkdirSync(root);
    gitIn(root, 'init', '-q', '-b', 'dev');
    writeFileSync(join(root, 'README.md'), 'hello\n');
    // `node_modules/` (directory-only), the common spelling: on POSIX the prepare checkout's node_modules symlink is untracked for it, which discard must handle.
    writeFileSync(join(root, '.gitignore'), '.omg/\nnode_modules/\n');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\n\nAdd greet().\n');
    // This repository's tooling, so prepare's auto-detection runs its built-in checks (the scripted `node` answers them).
    writeFileSync(join(root, 'tsconfig.json'), '{}\n');
    writeFileSync(join(root, 'eslint.config.js'), 'export default [];\n');
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'generate-inventory-graph.mjs'), '\n');
    for (const tool of ['typescript/bin/tsc', 'eslint/bin/eslint.js', 'vitest/vitest.mjs']) {
        mkdirSync(join(root, 'node_modules', tool, '..'), { recursive: true });
        writeFileSync(join(root, 'node_modules', tool), '\n');
    }
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
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql' && args.includes(`query=${REVIEW_FEEDBACK_QUERY}`)) {
            const head = h.gh.headOverride ?? bareRef(bare, `refs/heads/${h.gh.branch}`);
            const answer = h.gh.reviews?.(head) ?? {};
            if ('status' in answer && typeof answer.status === 'number')
                return answer;
            const done = { hasNextPage: false };
            const pull = { headRefOid: head, latestReviews: { pageInfo: done, nodes: [] }, latestOpinionatedReviews: { pageInfo: done, nodes: [] }, reviewRequests: { pageInfo: done, nodes: [] }, reviewThreads: { pageInfo: done, nodes: [] }, ...answer };
            return ok(JSON.stringify({ data: { viewer: { login: 'o' }, repository: { viewerPermission: 'ADMIN', collaborators: { pageInfo: done, edges: [{ permission: 'ADMIN', node: { login: 'o' } }, { permission: 'WRITE', node: { login: 'dana' } }] }, pullRequest: pull } } }));
        }
        const read = cmd === 'gh' && args[0] === 'api' && args[3] === '--method' && args[4] === 'GET' ? h.gh.api?.(args[5]) : undefined;
        if (read)
            return read;
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