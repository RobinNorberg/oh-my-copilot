/**
 * `omg port drive` against fixture repos: a fake upstream, a fake fork that
 * shares its history, and a bare `origin`. Real git and the real drift
 * script; the gate scripts, inventory and `gh` are stubbed through the Exec
 * seam, and the reconcile lane is a mock LaneBackend (no live Copilot).
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { DRIFT_SCRIPT, laneForbidden, runPortDrive } from '../engine.js';
const REPO = join(import.meta.dirname, '../../..');
const roots = [];
const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=dev'];
function git(cwd, ...args) {
    const res = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8' });
    if (res.status !== 0)
        throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
}
function commit(repo, message, files) {
    for (const [path, content] of Object.entries(files)) {
        const abs = join(repo, path);
        if (content === null) {
            rmSync(abs);
            continue;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
}
const pkg = (version, extra = {}) => `${JSON.stringify({ name: 'oh-my-claudecode', version, ...extra }, null, 2)}\n`;
/** Header the fork renamed, far enough from upstream's later hunk to apply cleanly. */
const GAP = "// oh-my-claudecode\n// one\n// two\n// three\n// four\n";
const RUNBOOK = '# Port Upstream\n\n## Fork Features to Preserve\n\n- `RecentTools` in HUD\n\n## Key Gotchas\n\n- none\n';
function fixture(base, forkChange, change) {
    const root = mkdtempSync(join(tmpdir(), 'port-drive-'));
    roots.push(root);
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q');
    const baseSha = commit(upstream, 'base', base);
    git(root, 'clone', '-q', upstream, 'fork');
    const fork = join(root, 'fork');
    git(fork, 'config', 'core.autocrlf', 'false');
    git(fork, 'config', 'user.name', 'fixture');
    git(fork, 'config', 'user.email', 'fixture@example.invalid');
    git(fork, 'remote', 'rename', 'origin', 'upstream');
    commit(fork, 'fork', {
        ...forkChange,
        '.gitignore': '.omg/\n*.log\n',
        '.omc/skills/port-upstream.md': RUNBOOK,
        '.github/upstream-port.json': `${JSON.stringify({ upstream_sha: baseSha, upstream_branch: 'dev', ported_at: '2026-10-01', fork_version: '5.0.0' }, null, 2)}\n`,
    });
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', 'origin.git');
    git(fork, 'remote', 'add', 'origin', origin);
    const head = commit(upstream, 'upstream: next', change);
    git(fork, 'fetch', '-q', 'upstream');
    return { fork, origin, head, base: baseSha };
}
/** git and the drift script run for real; gate scripts, inventory and gh are recorded and stubbed. */
function harnessExec(h) {
    return (cmd, args, opts) => {
        h.calls.push([cmd, ...args]);
        if (cmd === 'gh')
            return h.failGh ? { status: 1, stdout: '', stderr: 'HTTP 502' } : { status: 0, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' };
        if (cmd === 'git') {
            const r = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8' });
            return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        }
        if (args[0] === DRIFT_SCRIPT) {
            const r = spawnSync(process.execPath, [join(REPO, DRIFT_SCRIPT), ...args.slice(1)], { cwd: opts?.cwd, encoding: 'utf8' });
            return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        }
        if (h.failGate && args.join(' ').includes(h.failGate))
            return { status: 1, stdout: '  3:1  error  unused import  no-unused-vars\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    };
}
function drive(f, h, extra = {}) {
    const events = [];
    const promise = runPortDrive({
        cwd: f.fork, head: f.head, exec: harnessExec(h), node: 'node', date: '2026-10-28',
        progress: (phase, status, note) => events.push(`${phase} ${status} ${note}`),
        log: () => { },
        ...extra,
    });
    return { events, promise };
}
const lastCommitFiles = (repo, rev = 'HEAD') => git(repo, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean).sort();
afterAll(() => {
    for (const root of roots)
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
describe('omg port drive: clean range', () => {
    it('applies, drops .gjc, ignores a version-only delta, runs the gates, commits, pushes and opens a draft PR', async () => {
        const f = fixture({ 'src/a.ts': `${GAP}export const a = 1;\n`, 'package.json': pkg('1.0.0') }, { 'src/a.ts': `${GAP.replace('oh-my-claudecode', 'oh-my-copilot')}export const a = 1;\n`, 'package.json': pkg('5.0.0') }, { 'src/a.ts': `${GAP}export const a = 1;\nexport const b = 'oh-my-claudecode';\n`, 'src/a.test.ts': 'test\n', 'src/__tests__/fixtures/run.log': 'captured\n', '.gjc/session.json': '{}\n', 'package.json': pkg('1.1.0') });
        const h = { calls: [] };
        const { events, promise } = drive(f, h);
        const r = await promise;
        expect(r.status, r.message).toBe('done');
        expect(r.exitCode).toBe(0);
        expect(r.branch).toBe(`port/upstream-${f.head.slice(0, 9)}`);
        expect(git(f.fork, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(r.branch);
        expect(r.packageDelta).toEqual([{ key: 'version', before: '1.0.0', after: '1.1.0', action: 'ignored' }]);
        expect(r.blockers).toEqual([]);
        // the gitignored `.log` fixture is ported too (a manual `git add -A` port once dropped one)
        expect(lastCommitFiles(f.fork)).toEqual(['.github/upstream-port.json', 'src/__tests__/fixtures/run.log', 'src/a.test.ts', 'src/a.ts']);
        expect(readFileSync(join(f.fork, 'src/a.ts'), 'utf8')).toBe(`${GAP.replace('oh-my-claudecode', 'oh-my-copilot')}export const a = 1;\nexport const b = 'oh-my-copilot';\n`);
        expect(git(f.origin, 'rev-parse', `refs/heads/${r.branch}`)).toBe(git(f.fork, 'rev-parse', 'HEAD'));
        expect(r.gates).toEqual(['tsc', 'eslint', 'path gate', 'prompt projections', 'copilot hooks', 'copilot agents', 'tests']);
        const scripts = h.calls.filter((c) => c[0] === 'node').map((c) => c.slice(1).join(' '));
        expect(scripts).toContain('node_modules/eslint/bin/eslint.js src');
        expect(scripts).toContain('scripts/ci/check-multirepo-paths.mjs');
        expect(scripts).toContain('node_modules/vitest/vitest.mjs run src/a.test.ts');
        const gh = h.calls.find((c) => c[0] === 'gh');
        expect(gh.slice(1, 7)).toEqual(['pr', 'create', '--draft', '--base', 'dev', '--head']);
        expect(r.pr).toBe('https://github.com/o/r/pull/7');
        const pushes = h.calls.filter((c) => c[0] === 'git' && c.includes('push'));
        expect(pushes).toHaveLength(1);
        expect(pushes[0].slice(-3)).toEqual(['push', 'origin', `HEAD:refs/heads/${r.branch}`]);
        // every host git runs hardened
        for (const c of h.calls.filter((x) => x[0] === 'git' && x[1] !== 'config')) {
            expect(c).toContain('--no-pager');
            expect(c.join(' ')).toMatch(/-c core\.hooksPath=\S+ -c core\.fsmonitor=false/);
        }
        expect(events.at(-1)).toMatch(/^report done draft PR/);
    });
    it('fails the gates on an eslint error and commits nothing', async () => {
        const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'b\n' });
        const before = git(f.fork, 'rev-parse', 'HEAD');
        const r = await drive(f, { calls: [], failGate: 'eslint' }).promise;
        expect(r.status).toBe('fail');
        expect(r.exitCode).toBe(1);
        expect(r.message).toContain('eslint failed');
        expect(r.message).toContain('3:1  error  unused import');
        expect(r.next).toContain('--continue');
        expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(before);
    });
});
describe('omg port drive: human gates', () => {
    it('blocks on a scripts/files/deps delta, then --continue finishes after the human staged it', async () => {
        const f = fixture({ 'src/a.ts': 'a\n', 'package.json': pkg('1.0.0', { scripts: { test: 'vitest' } }) }, {}, { 'src/a.ts': 'b\n', 'package.json': pkg('1.0.1', { scripts: { test: 'vitest run' }, dependencies: { x: '^1.0.0' } }) });
        const h = { calls: [] };
        const first = await drive(f, h).promise;
        expect(first.status).toBe('blocked');
        expect(first.exitCode).toBe(3);
        expect(first.blockers[0]).toContain('package.json delta needs a human: dependencies.x, scripts.test');
        expect(first.next).toBe(`omg port drive --head ${f.head} --continue`);
        expect(h.calls.some((c) => c[0] === 'gh')).toBe(false);
        const resumed = await drive(f, { calls: [] }, { resume: true }).promise;
        expect(resumed.status, resumed.message).toBe('done');
        expect(lastCommitFiles(f.fork)).toEqual(['.github/upstream-port.json', 'src/a.ts']);
    });
    it('blocks on conflicts without --reconcile-lane and writes a brief with the conflict list and the fork features', async () => {
        const f = fixture({ 'src/a.ts': 'base\n' }, { 'src/a.ts': 'fork\n' }, { 'src/a.ts': 'upstream\n' });
        let started = 0;
        const lanes = () => ({ start: () => { started++; throw new Error('no'); } });
        const { events, promise } = drive(f, { calls: [] }, { lanes });
        const r = await promise;
        expect(r.status).toBe('blocked');
        expect(started).toBe(0);
        expect(r.brief).toBeTruthy();
        const brief = readFileSync(r.brief, 'utf8');
        expect(brief).toContain('- `UU` src/a.ts');
        expect(brief).toContain(`--apply --head ${f.head}`);
        expect(brief).toContain('`RecentTools` in HUD');
        expect(brief).toContain('take THEIRS');
        expect(events.some((e) => e.startsWith('reconcile blocked reconcile: 1 files; brief '))).toBe(true);
    });
    it('never starts the lane for conflicts in src/release (human review before PR)', async () => {
        const f = fixture({ 'src/release/x.ts': 'base\n' }, { 'src/release/x.ts': 'fork\n' }, { 'src/release/x.ts': 'upstream\n' });
        let started = 0;
        const lanes = () => ({ start: () => { started++; throw new Error('no'); } });
        const r = await drive(f, { calls: [] }, { lanes, reconcileLane: { maxCredits: 30, timeoutMs: 60_000 } }).promise;
        expect(r.status).toBe('blocked');
        expect(started).toBe(0);
        expect(r.blockers[0]).toContain('1 need human review (src/release/x.ts)');
    });
    it('blocks on a leak the rename map could not fix', async () => {
        const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'see github.com/Yeachan-Heo/oh-my-copilot\n' });
        const r = await drive(f, { calls: [] }).promise;
        expect(r.status).toBe('blocked');
        expect(r.blockers.join(' ')).toContain('leak sweep: 1 new');
    });
});
/** A write lane that applies the range in its own worktree, resolves src/a.ts to `resolved`, and commits. */
function mockLane(f, resolved, seen, s = {}) {
    let headSha = null;
    const wt = join(dirname(f.fork), 'lane-wt');
    const result = (state, credits, source) => ({
        state, branch: 'lane', pr: null, headSha, baseSha: null, worktree: wt, changes: null, finalText: 'staged',
        logsUrl: null, usage: { premiumRequests: 1, credits, source, detail: '' }, remoteId: 'job-1', error: null, notes: [], process: null,
    });
    return {
        kind: 'local-sdk',
        start: async (input) => {
            seen.push(input);
            git(f.fork, 'worktree', 'add', '-q', '--detach', wt, input.baseRef);
            spawnSync(process.execPath, [join(REPO, DRIFT_SCRIPT), '--apply', '--head', f.head, '--date', '2026-10-28'], { cwd: wt, encoding: 'utf8' });
            writeFileSync(join(wt, 'src/a.ts'), resolved);
            s.edit?.(wt);
            git(wt, 'add', '-A');
            s.stage?.(wt);
            git(wt, 'commit', '-q', '--no-verify', '-m', 'port: reconcile upstream conflicts');
            headSha = git(wt, 'rev-parse', 'HEAD');
            s.plant?.(wt);
            return { remoteId: 'job-1' };
        },
        poll: async () => result(s.waitState ?? 'completed', 2.5, 'measured'),
        wait: async () => (s.waitState && s.waitState !== 'completed' ? result(s.waitState, 0.5, 'estimated') : result('completed', 2.5, 'measured')),
        cancel: async (id) => {
            s.cancels?.push(id);
            return { supported: true, result: result(s.cancelState ?? 'cancelled', 1.5, 'measured') };
        },
    };
}
const conflictFixture = (extraBase = {}, extraFork = {}) => fixture({ 'src/a.ts': 'base\n', 'src/b.ts': 'b\n', ...extraBase }, { 'src/a.ts': 'fork\n', ...extraFork }, { 'src/a.ts': 'upstream\n', 'src/b.ts': 'b2\n' });
const LANE = { maxCredits: 30, timeoutMs: 60_000 };
describe('omg port drive: reconcile lane', () => {
    it('runs the brief as a capped write lane and adopts its tree into the port commit', async () => {
        const f = fixture({ 'src/a.ts': 'base\n', 'src/b.ts': 'b\n' }, { 'src/a.ts': 'fork\n' }, { 'src/a.ts': 'upstream\n', 'src/b.ts': 'b2\n', 'src/c.ts': 'c\n' });
        const seen = [];
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', seen), reconcileLane: { maxCredits: 40, timeoutMs: 600_000 } }).promise;
        expect(r.status, r.message).toBe('done');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ profile: 'write', maxCredits: 40, timeoutMs: 600_000 });
        expect(seen[0].prompt).toContain('- `UU` src/a.ts');
        expect(r.laneCredits).toBe(2.5);
        expect(readFileSync(join(f.fork, 'src/a.ts'), 'utf8')).toBe('fork+upstream\n');
        expect(git(f.fork, 'show', 'HEAD:src/c.ts')).toBe('c');
        expect(lastCommitFiles(f.fork)).toEqual(['.github/upstream-port.json', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
        expect(existsSync(join(f.fork, '.git', 'MERGE_HEAD'))).toBe(false);
    });
    it('blocks when the lane leaves conflict markers', async () => {
        const f = fixture({ 'src/a.ts': 'base\n' }, { 'src/a.ts': 'fork\n' }, { 'src/a.ts': 'upstream\n' });
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, '<<<<<<< HEAD\nfork\n=======\nupstream\n>>>>>>> x\n', []), reconcileLane: { maxCredits: 30, timeoutMs: 60_000 } }).promise;
        expect(r.status).toBe('blocked');
        expect(r.message).toContain('conflict markers: src/a.ts');
    });
    it('blocks on a lone ======= separator line too', async () => {
        const f = conflictFixture();
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork\n=======\nupstream\n', []), reconcileLane: LANE }).promise;
        expect(r.status).toBe('blocked');
        expect(r.message).toContain('conflict markers: src/a.ts');
    });
});
describe('omg port drive: the lane may change only the conflicted paths', () => {
    const cases = [
        ['edits a non-conflicted file', {}, (wt) => writeFileSync(join(wt, 'src/b.ts'), 'lane rewrote it\n'), 'src/b.ts'],
        ['adds a workflow', {}, (wt) => { mkdirSync(join(wt, '.github/workflows'), { recursive: true }); writeFileSync(join(wt, '.github/workflows/x.yml'), 'on: push\n'); }, '.github/workflows/x.yml'],
        ['edits a gate script', {}, (wt) => { mkdirSync(join(wt, 'scripts/ci'), { recursive: true }); writeFileSync(join(wt, 'scripts/ci/check-multirepo-paths.mjs'), 'process.exit(0)\n'); }, 'scripts/ci/check-multirepo-paths.mjs'],
        ['deletes a fork-owned file', { 'src/fork-only.ts': 'ours\n' }, (wt) => rmSync(join(wt, 'src/fork-only.ts')), 'src/fork-only.ts'],
    ];
    for (const [name, forkExtra, edit, path] of cases) {
        it(`blocks a lane that ${name}, adopting and committing nothing`, async () => {
            const f = conflictFixture({}, forkExtra);
            const before = git(f.fork, 'rev-parse', 'HEAD');
            const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { edit }), reconcileLane: LANE }).promise;
            expect(r.status, r.message).toBe('blocked');
            expect(r.message).toContain(`outside the conflict list, so nothing was adopted: ${path}`);
            expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(before);
            expect(git(f.fork, 'ls-files', '-u')).not.toBe('');
            expect(git(f.origin, 'for-each-ref')).toBe('');
        });
    }
    it('blocks a lane that resolves a conflicted path as a symlink', async () => {
        const f = conflictFixture();
        const stage = (wt) => { git(wt, 'update-index', '--cacheinfo', `120000,${git(wt, 'rev-parse', 'HEAD:src/b.ts')},src/a.ts`); };
        const before = git(f.fork, 'rev-parse', 'HEAD');
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { stage }), reconcileLane: LANE }).promise;
        expect(r.status, r.message).toBe('blocked');
        expect(r.message).toContain('symlink, gitlink or other non-regular entry, so nothing was adopted: src/a.ts');
        expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(before);
        expect(git(f.origin, 'for-each-ref')).toBe('');
    });
    it('never starts the lane when a conflict is on a protected path (eslint config)', async () => {
        const f = fixture({ 'eslint.config.js': 'base\n' }, { 'eslint.config.js': 'fork\n' }, { 'eslint.config.js': 'upstream\n' });
        let started = 0;
        const lanes = () => ({ start: () => { started++; throw new Error('no'); } });
        const r = await drive(f, { calls: [] }, { lanes, reconcileLane: LANE }).promise;
        expect(r.status).toBe('blocked');
        expect(started).toBe(0);
        expect(r.blockers[0]).toContain('1 need human review (eslint.config.js)');
    });
    it('forbids what the drift script excludes or skips, ship protects, and the gates run', async () => {
        // @ts-expect-error -- plain .mjs script without type declarations
        const drift = (await import('../../../scripts/port/upstream-drift.mjs'));
        const probe = [...drift.EXCLUDED_PATHS, ...drift.SKIPPED_PATHS.map((p) => `${p}/x.yml`), '.copilot/omg.jsonc', '.github/known-flaky-tests.json',
            'scripts/ci/check-multirepo-paths.mjs', 'scripts/generate-inventory-graph.mjs', 'scripts/copilot/build-hooks.mjs', 'eslint.config.js',
            'src/port/engine.ts', 'src/x/.gitattributes'];
        expect(laneForbidden(probe)).toEqual(probe);
        expect(laneForbidden(['src/a.ts', 'scripts/dev/x.mjs', 'docs/README.md'])).toEqual([]);
    });
});
describe('omg port drive: tamper check around the reconcile lane', () => {
    const sentinel = (f) => join(dirname(f.fork), 'EXECUTED').replace(/\\/g, '/');
    const hook = (f) => `#!/bin/sh\necho ran > "${sentinel(f)}"\n`;
    const cases = [
        ['a post-commit hook', (f) => () => writeFileSync(join(f.fork, '.git/hooks/post-commit'), hook(f), { mode: 0o755 }), 'the hooks/ directory changed'],
        ['a pre-push hook', (f) => () => writeFileSync(join(f.fork, '.git/hooks/pre-push'), hook(f), { mode: 0o755 }), 'the hooks/ directory changed'],
        ['a credential.helper', (f) => () => { git(f.fork, 'config', 'credential.helper', `!echo ran > "${sentinel(f)}"`); }, 'the common git config changed'],
        ['a filter driver', (f) => () => {
                git(f.fork, 'config', 'filter.evil.clean', `sh -c 'echo ran > "${sentinel(f)}"; cat'`);
                git(f.fork, 'config', 'filter.evil.smudge', `sh -c 'echo ran > "${sentinel(f)}"; cat'`);
                writeFileSync(join(f.fork, '.git/info/attributes'), '* filter=evil\n');
            }, 'the common git config changed'],
    ];
    for (const [name, plant, problem] of cases) {
        it(`parks the run when the lane plants ${name}; nothing runs, nothing is committed or pushed`, async () => {
            const f = conflictFixture();
            const before = git(f.fork, 'rev-parse', 'HEAD');
            const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { plant: plant(f) }), reconcileLane: LANE }).promise;
            expect(r.status, r.message).toBe('blocked');
            expect(r.message).toContain('changed shared git state, so nothing was adopted, committed or pushed');
            expect(r.message).toContain(problem);
            expect(r.laneCredits).toBe(2.5);
            expect(existsSync(sentinel(f))).toBe(false);
            expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(before);
            expect(git(f.origin, 'for-each-ref')).toBe('');
        });
    }
    it('parks the run when the lane re-stages a non-conflicted path in the main index and matches it in its own tree', async () => {
        const f = conflictFixture();
        const edit = (wt) => writeFileSync(join(wt, 'src/b.ts'), 'swapped\n');
        const plant = () => { writeFileSync(join(f.fork, 'src/b.ts'), 'swapped\n'); git(f.fork, 'add', '--', 'src/b.ts'); };
        const before = git(f.fork, 'rev-parse', 'HEAD');
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { edit, plant }), reconcileLane: LANE }).promise;
        expect(r.status, r.message).toBe('blocked');
        expect(r.message).toContain("the main checkout's index changed");
        expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(before);
        expect(git(f.origin, 'for-each-ref')).toBe('');
    });
    const hostCases = [
        ['rewrites the main copy of a conflicted file', (f) => () => writeFileSync(join(f.fork, 'src/a.ts'), 'swapped\n'), 'copy of a tracked file changed'],
        ['rewrites a gate entry file in node_modules', (f) => () => {
                mkdirSync(join(f.fork, 'node_modules/vitest'), { recursive: true });
                writeFileSync(join(f.fork, 'node_modules/vitest/vitest.mjs'), 'process.exit(0)\n');
            }, 'a node_modules file the gates run changed'],
        // git status trusts the stat cache: both rewrites below leave it empty.
        ['marks a gate script assume-unchanged and rewrites it', (f) => () => {
                git(f.fork, 'update-index', '--assume-unchanged', 'scripts/ci/check-multirepo-paths.mjs');
                writeFileSync(join(f.fork, 'scripts/ci/check-multirepo-paths.mjs'), 'process.exit(0)\n');
            }, 'copy of a tracked file changed'],
        ['rewrites a config file at the same size and restores its mtime', (f) => () => {
                const path = join(f.fork, 'vitest.config.ts');
                const st = statSync(path);
                writeFileSync(path, 'pwned!\n');
                utimesSync(path, st.atime, st.mtime);
            }, 'copy of a tracked file changed'],
        ['adds a skip-worktree flag', (f) => () => { git(f.fork, 'update-index', '--skip-worktree', 'src/b.ts'); }, "the main index's flags changed"],
    ];
    for (const [name, plant, problem] of hostCases) {
        it(`parks the run when the lane ${name}`, async () => {
            const f = conflictFixture({ 'scripts/ci/check-multirepo-paths.mjs': 'gate\n', 'vitest.config.ts': 'config\n' });
            const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { plant: plant(f) }), reconcileLane: LANE }).promise;
            expect(r.status, r.message).toBe('blocked');
            expect(r.message).toContain(problem);
            expect(git(f.origin, 'for-each-ref')).toBe('');
        });
    }
    it('parks the run when the lane plants a credential.helper in the global git config', async () => {
        const f = conflictFixture();
        const globalFile = join(dirname(f.fork), 'global.gitconfig');
        writeFileSync(globalFile, '');
        const saved = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = globalFile;
        try {
            const plant = () => writeFileSync(globalFile, `[credential]\n\thelper = "!echo ran > ${sentinel(f)}"\n`);
            const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { plant }), reconcileLane: LANE }).promise;
            expect(r.status).toBe('blocked');
            expect(r.message).toContain('the global git config');
            expect(existsSync(sentinel(f))).toBe(false);
            expect(git(f.origin, 'for-each-ref')).toBe('');
        }
        finally {
            if (saved === undefined)
                delete process.env.GIT_CONFIG_GLOBAL;
            else
                process.env.GIT_CONFIG_GLOBAL = saved;
        }
    });
});
describe('omg port drive: lane timeout', () => {
    it('cancels a lane still running at the timeout, confirms its end, records usage and blocks', async () => {
        const f = conflictFixture();
        const cancels = [];
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { waitState: 'running', cancels }), reconcileLane: LANE }).promise;
        expect(cancels).toEqual(['job-1']);
        expect(r.status).toBe('blocked');
        expect(r.laneCredits).toBe(1.5);
        expect(r.message).toContain('ended timeout: the lane was still running after 1 min and was cancelled');
    });
    it('blocks without reading the repository when the cancel is not confirmed', async () => {
        const f = conflictFixture();
        const cancels = [];
        const r = await drive(f, { calls: [] }, { lanes: () => mockLane(f, 'fork+upstream\n', [], { waitState: 'running', cancelState: 'running', cancels }), reconcileLane: LANE }).promise;
        expect(cancels).toEqual(['job-1']);
        expect(r.status).toBe('blocked');
        expect(r.laneCredits).toBe(1.5);
        expect(r.message).toContain('its cancel was not confirmed (state running)');
        expect(r.message).toContain('nothing committed or pushed');
    });
});
describe('omg port drive: --continue', () => {
    it('resumes at the PR step when the port commit exists (gh pr create failed)', async () => {
        const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'b\n' });
        const first = await drive(f, { calls: [], failGh: true }).promise;
        expect(first.status).toBe('fail');
        expect(first.message).toContain('gh pr create failed');
        expect(first.next).toBe(`omg port drive --head ${f.head} --continue`);
        const portCommit = git(f.fork, 'rev-parse', 'HEAD');
        expect(first.commits).toEqual([portCommit]);
        const h = { calls: [] };
        const resumed = await drive(f, h, { resume: true }).promise;
        expect(resumed.status, resumed.message).toBe('done');
        expect(resumed.commits).toEqual([portCommit]);
        expect(git(f.fork, 'rev-parse', 'HEAD')).toBe(portCommit);
        expect(resumed.pr).toBe('https://github.com/o/r/pull/7');
        expect(h.calls.some((c) => c[0] === 'node' && c[1] === DRIFT_SCRIPT && c[2] === '--apply')).toBe(false);
        const gh = h.calls.find((c) => c[0] === 'gh');
        expect(gh[gh.indexOf('--title') + 1]).toBe(`port: upstream ${f.base.slice(0, 9)}..${f.head.slice(0, 9)}`);
    });
    it('recomputes the package delta when the run stopped before the delta phase', async () => {
        const f = fixture({ 'src/a.ts': 'a\n', 'package.json': pkg('1.0.0') }, {}, { 'src/a.ts': 'b\n', 'package.json': pkg('1.0.1', { dependencies: { x: '^1.0.0' } }) });
        // A run that died after apply: the branch exists and the range is applied, no delta was recorded.
        git(f.fork, 'switch', '-q', '-c', `port/upstream-${f.head.slice(0, 9)}`);
        spawnSync(process.execPath, [join(REPO, DRIFT_SCRIPT), '--apply', '--head', f.head, '--date', '2026-10-28'], { cwd: f.fork, encoding: 'utf8' });
        const r = await drive(f, { calls: [] }, { resume: true }).promise;
        expect(r.status).toBe('blocked');
        expect(r.blockers[0]).toContain('package.json delta needs a human: dependencies.x');
    });
});
describe('omg port drive: --accept-leaks', () => {
    it('accepts the leak lines of the named head and records them in the commit and the PR body', async () => {
        const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'see github.com/Yeachan-Heo/oh-my-copilot\n' });
        const r = await drive(f, { calls: [] }, { acceptLeaks: f.head }).promise;
        expect(r.status, r.message).toBe('done');
        expect(r.acceptedLeaks).toEqual(['src/a.ts:1']);
        expect(git(f.fork, 'log', '-1', '--format=%B')).toContain(`Leak sweep: 1 line(s) accepted with --accept-leaks ${f.head}: src/a.ts:1`);
        const body = readFileSync(join(f.fork, '.omg', 'port', f.head.slice(0, 9), 'pr-body.md'), 'utf8');
        expect(body).toContain('leak sweep: 1 line(s) accepted with --accept-leaks: src/a.ts:1');
        expect(existsSync(join(f.fork, '.omg', 'port', f.head.slice(0, 9), 'accepted-leaks.json'))).toBe(true);
    });
    it('refuses an --accept-leaks sha that is not the upstream head', async () => {
        const f = fixture({ 'src/a.ts': 'a\n' }, {}, { 'src/a.ts': 'see github.com/Yeachan-Heo/oh-my-copilot\n' });
        const r = await drive(f, { calls: [] }, { acceptLeaks: f.base }).promise;
        expect(r.status).toBe('fail');
        expect(r.message).toContain('does not name the upstream head');
    });
});
//# sourceMappingURL=engine.test.js.map