import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The CI helper is intentionally dependency-free ESM without declarations.
import * as evidence from '../../scripts/ci/tree-reuse.mjs';
const { createApi, findEvidence, rejectRun, sameTreeCommits, cliMain, REQUIRED_JOBS } = evidence;
const REPO = 'RobinNorberg/oh-my-copilot';
const T = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const TAG = '1'.repeat(40); // main merge commit, tree T
const DEV = '2'.repeat(40); // dev merge commit, tree T
const HEAD = '3'.repeat(40); // release PR head, tree T
const OLD_MAIN = '4'.repeat(40);
const OLD_DEV = '5'.repeat(40);
const NOW = Date.parse('2026-11-01T12:00:00Z');
const ALL_JOBS = [...REQUIRED_JOBS, 'Test (Windows path suite)', 'Copilot smoke (tier 2)', 'omg update + session-start hook', 'Tree evidence'];
const greenJobs = (gateId = 900) => [
    ...ALL_JOBS.map((name, i) => ({ id: name === 'CI Gate' ? gateId : i + 1, name, conclusion: 'success' })),
    { id: 50, name: 'No Committed Build Artifacts', conclusion: 'failure' },
    { id: 51, name: 'Create GitHub Release', conclusion: 'skipped' },
    { id: 52, name: 'Release tree evidence', conclusion: 'skipped' },
];
const gateLog = (tree) => `2026-11-01T09:51:40.1234567Z ##[group]Run echo "ci-evidence v1 tree=$TREE"\n2026-11-01T09:51:40.2234567Z every needed job succeeded or was skipped\n2026-11-01T09:51:40.3234567Z ci-evidence v1 tree=${tree}\n`;
function run(overrides = {}) {
    return {
        id: 41293676875,
        html_url: 'https://github.com/RobinNorberg/oh-my-copilot/actions/runs/41293676875',
        path: '.github/workflows/ci.yml',
        head_sha: HEAD,
        event: 'pull_request',
        created_at: '2026-11-01T09:33:55Z',
        repository: { full_name: REPO },
        head_repository: { full_name: REPO },
        ...overrides,
    };
}
/** In-memory GitHub: commits (tree + parents), runs per head sha, jobs per run, CI Gate logs per job. */
function fakeApi({ runs = { [HEAD]: [run()] }, jobs = { 41293676875: greenJobs() }, logs = { 900: gateLog(T) } } = {}) {
    const commits = {
        [TAG]: { tree: T, parents: [OLD_MAIN, DEV] },
        [DEV]: { tree: T, parents: [OLD_DEV, HEAD] },
        [HEAD]: { tree: T, parents: [OLD_DEV] },
        [OLD_MAIN]: { tree: OTHER_TREE, parents: [] },
        [OLD_DEV]: { tree: OTHER_TREE, parents: [] },
    };
    const calls = [];
    return {
        calls,
        async json(path) {
            calls.push(path);
            let m = /^commits\/([0-9a-f]{40})$/.exec(path);
            if (m) {
                const c = commits[m[1]];
                if (!c)
                    throw new Error(`GET ${path}: HTTP 404`);
                return { sha: m[1], commit: { tree: { sha: c.tree } }, parents: c.parents.map((sha) => ({ sha })) };
            }
            m = /^actions\/workflows\/ci\.yml\/runs\?head_sha=([0-9a-f]{40})&per_page=20$/.exec(path);
            if (m)
                return { workflow_runs: runs[m[1]] ?? [] };
            m = /^actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(path);
            if (m)
                return { jobs: jobs[Number(m[1])] ?? [] };
            throw new Error(`unexpected GET ${path}`);
        },
        async jobLog(id) {
            calls.push(`log ${id}`);
            if (!(id in logs))
                throw new Error(`job ${id} log: HTTP 404`);
            return logs[id];
        },
    };
}
const ctx = { repo: REPO, sha: HEAD, tree: T, now: NOW, currentRunId: '1' };
describe('scripts/ci/tree-reuse.mjs: which runs prove a tree', () => {
    it('walks from a tag through the main and dev merges to the release PR head, keeping only same-tree commits', async () => {
        expect(await sameTreeCommits(fakeApi(), TAG, T)).toEqual([TAG, DEV, HEAD]);
        expect(await sameTreeCommits(fakeApi(), TAG, OTHER_TREE)).toEqual([]);
    });
    it('reuses the release PR run for the tag and names it', async () => {
        const api = fakeApi();
        const result = await findEvidence(api, { repo: REPO, sha: TAG, tree: T, now: NOW, currentRunId: '1' });
        expect(result).toMatchObject({ reused: true, sha: HEAD, runUrl: 'https://github.com/RobinNorberg/oh-my-copilot/actions/runs/41293676875' });
        expect(api.calls).toContain('log 900');
    });
    it('accepts a green same-repo pull_request or push run', async () => {
        expect(await rejectRun(fakeApi(), run(), ctx)).toBeNull();
        expect(await rejectRun(fakeApi(), run({ event: 'push' }), ctx)).toBeNull();
    });
    it.each([
        ['a fork pull request', { head_repository: { full_name: 'evil/oh-my-copilot' } }, /head repository evil/],
        ['another repository', { repository: { full_name: 'evil/oh-my-copilot' } }, /head repository/],
        ['pull_request_target', { event: 'pull_request_target' }, /event pull_request_target/],
        ['workflow_dispatch', { event: 'workflow_dispatch' }, /event workflow_dispatch/],
        ['another workflow', { path: '.github/workflows/evil.yml' }, /workflow \.github\/workflows\/evil\.yml/],
        ['another commit', { head_sha: DEV }, /head 2{40}/],
        ['a run older than 14 days', { created_at: '2026-10-17T11:59:59Z' }, /created/],
        ['a run dated in the future', { created_at: '2026-11-02T00:00:00Z' }, /created/],
        ['an unparseable date', { created_at: 'yesterday' }, /created/],
        ['the current run', { id: 1 }, /this run/],
    ])('rejects %s', async (_label, overrides, reason) => {
        expect(await rejectRun(fakeApi(), run(overrides), ctx)).toMatch(reason);
    });
    it('rejects a run with any non-success job, including one that itself reused evidence (skipped)', async () => {
        for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
            const jobs = greenJobs().map((j) => (j.name === 'Test' ? { ...j, conclusion } : j));
            expect(await rejectRun(fakeApi({ jobs: { 41293676875: jobs } }), run(), ctx)).toMatch(/^Test: /);
        }
    });
    it('rejects a run missing a required job', async () => {
        const jobs = greenJobs().filter((j) => j.name !== 'Version Consistency Check');
        expect(await rejectRun(fakeApi({ jobs: { 41293676875: jobs } }), run(), ctx)).toBe('no job Version Consistency Check');
    });
    it('binds the run to the tree its CI Gate logged: a stale PR merge tree, two lines, or no line is not evidence', async () => {
        const reject = (log) => rejectRun(fakeApi({ logs: { 900: log } }), run(), ctx);
        expect(await reject(gateLog(OTHER_TREE))).toMatch(/recorded tree b{40}/);
        expect(await reject(gateLog(T) + gateLog(OTHER_TREE))).toMatch(/recorded tree/);
        expect(await reject('2026-11-01T09:51:40.1Z no tree evidence recorded\n')).toMatch(/recorded tree none/);
        // The echoed script line and an untimestamped copy do not count.
        expect(await reject(`2026-11-01T09:51:40.1Z echo ci-evidence v1 tree=${T}\nci-evidence v1 tree=${T}\n`)).toMatch(/recorded tree none/);
        expect(await reject(gateLog(T).replace(/\n/g, '\r\n'))).toBeNull();
    });
    it('falls back to no reuse when there is no run, and skips the rejected ones it lists', async () => {
        expect(await findEvidence(fakeApi({ runs: {} }), { ...ctx, sha: TAG })).toEqual({ reused: false, considered: [] });
        const fork = run({ id: 41293676876, html_url: 'https://x/7', head_repository: { full_name: 'evil/x' } });
        const result = await findEvidence(fakeApi({ runs: { [HEAD]: [fork, run()] } }), { ...ctx, sha: TAG });
        expect(result.reused).toBe(true);
        expect(result.considered).toEqual([`https://x/7 (${HEAD.slice(0, 12)}): head repository evil/x`]);
    });
    it('propagates API errors so the caller runs the jobs', async () => {
        await expect(findEvidence(fakeApi(), { ...ctx, sha: 'f'.repeat(40) })).rejects.toThrow(/HTTP 404/);
    });
});
describe('scripts/ci/tree-reuse.mjs: GitHub client', () => {
    it('follows the job-log redirect without sending the token off api.github.com', async () => {
        const seen = [];
        const fetchImpl = async (url, init = {}) => {
            seen.push({ url, auth: init.headers?.authorization, redirect: init.redirect });
            if (url.endsWith('/logs'))
                return new Response(null, { status: 302, headers: { location: 'https://blob.example/log?sig=1' } });
            return new Response('log text', { status: 200 });
        };
        const api = createApi({ repo: REPO, token: 'tkn', fetchImpl });
        expect(await api.jobLog(900)).toBe('log text');
        expect(seen).toEqual([
            { url: `https://api.github.com/repos/${REPO}/actions/jobs/900/logs`, auth: 'Bearer tkn', redirect: 'manual' },
            { url: 'https://blob.example/log?sig=1', auth: undefined, redirect: undefined },
        ]);
    });
    it('throws on a non-2xx API response', async () => {
        const api = createApi({ repo: REPO, token: 't', fetchImpl: async () => new Response('{}', { status: 403 }) });
        await expect(api.json('commits/x')).rejects.toThrow('GET commits/x: HTTP 403');
    });
});
describe('scripts/ci/tree-reuse.mjs: CLI outputs', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    function withFiles(fn) {
        const dir = mkdtempSync(join(tmpdir(), 'ci-evidence-'));
        const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't', GITHUB_RUN_ID: '1' };
        return fn(env, (name) => readFileSync(join(dir, name), 'utf8')).finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    it('writes the tree and reused=false when reuse is disabled, without calling the API', async () => {
        await withFiles(async (env, read) => {
            const fetchImpl = async () => { throw new Error('no network expected'); };
            const result = await cliMain({ env: { ...env, CI_EVIDENCE_REUSE: 'false' }, argv: ['--sha', head], fetchImpl, log: () => { } });
            expect(result.reused).toBe(false);
            expect(read('out')).toBe(`tree=${tree}\nreused=false\nrun_url=\n`);
            expect(read('summary')).toContain('reuse disabled');
        });
    });
    it('fails open: an API error still writes reused=false and the tree', async () => {
        await withFiles(async (env, read) => {
            const fetchImpl = async () => new Response('{}', { status: 500 });
            const lines = [];
            await cliMain({ env, argv: ['--sha', head], fetchImpl, log: (l) => lines.push(l) });
            expect(read('out')).toBe(`tree=${tree}\nreused=false\nrun_url=\n`);
            expect(lines.join('\n')).toMatch(/lookup failed, running the jobs: GET commits\/[0-9a-f]{40}: HTTP 500/);
        });
    });
    it('reads the tree of a commit missing from the trusted clone (a PR merge commit) from the API', async () => {
        await withFiles(async (env, read) => {
            const absent = 'c'.repeat(40);
            const fetchImpl = async (url) => {
                expect(url).toBe(`https://api.github.com/repos/${REPO}/commits/${absent}`);
                return new Response(JSON.stringify({ sha: absent, commit: { tree: { sha: T } } }));
            };
            const result = await cliMain({ env: { ...env, CI_EVIDENCE_REUSE: 'false' }, argv: ['--sha', absent], fetchImpl, log: () => { } });
            expect(result.reused).toBe(false);
            expect(read('out')).toBe(`tree=${T}\nreused=false\nrun_url=\n`);
        });
    });
    it('a commit the API answers for with another sha writes no tree', async () => {
        await withFiles(async (env, read) => {
            const absent = 'c'.repeat(40);
            const fetchImpl = async () => new Response(JSON.stringify({ sha: HEAD, commit: { tree: { sha: T } } }));
            await cliMain({ env, argv: ['--sha', absent], fetchImpl, log: () => { } });
            expect(read('out')).toBe('tree=\nreused=false\nrun_url=\n');
        });
    });
    it('a bad --sha writes no tree, so CI Gate records no evidence', async () => {
        await withFiles(async (env, read) => {
            await cliMain({ env, argv: ['--sha', 'not-a-sha'], fetchImpl: async () => new Response('{}'), log: () => { } });
            expect(read('out')).toBe('tree=\nreused=false\nrun_url=\n');
        });
    });
});
//# sourceMappingURL=ci-evidence.test.js.map