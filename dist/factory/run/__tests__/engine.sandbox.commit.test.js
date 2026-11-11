import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../../team/git-worktree.js';
import { protectedChanges } from '../../../ship/merge.js';
import { commitLaneWork, isOmcRuntimePath, LANE_PROTECTED_PATHS, laneCommitMessage, outsideWorktree } from '../lane-commit.js';
import { readFactoryState } from '../state.js';
import { gitIn, ISSUE, noCommit, remoteHead, review } from './fake-lanes.js';
import { h, useSandboxHarness, run, sandboxOf, edit, dirLink, outsideDir } from './engine-sandbox-harness.js';
useSandboxHarness();
describe('engine-side commit of a write lane', () => {
    it('a lane that left no changes fails (the staged diff is empty) and nothing is pushed', async () => {
        const out = await run([noCommit, noCommit]).done;
        expect(out.gate?.name, out.message).toBe('implement-failed');
        expect(out.gate?.reason).toMatch(/left no changes/);
        expect(remoteHead(h)).toBeNull();
    });
    it('a lane that committed itself fails: write lanes leave their changes uncommitted', async () => {
        const committing = ({ worktree }) => {
            writeFileSync(join(worktree, 'a.ts'), 'a\n');
            gitIn(worktree, 'add', 'a.ts');
            gitIn(worktree, 'commit', '-q', '-m', 'lane commit');
            return { finalText: 'Committed.' };
        };
        const out = await run([committing, committing]).done;
        expect(out.gate?.name, out.message).toBe('implement-failed');
        expect(out.gate?.reason).toMatch(/moved its worktree's HEAD/);
        expect(remoteHead(h)).toBeNull();
    });
    it('a nested repository (a gitlink once staged) parks at sandbox-escaped before any commit', async () => {
        const nesting = ({ worktree }) => {
            const nested = join(worktree, 'vendor', 'x');
            mkdirSync(nested, { recursive: true });
            gitIn(nested, 'init', '-q');
            writeFileSync(join(nested, 'f.txt'), 'f\n');
            gitIn(nested, 'add', 'f.txt');
            gitIn(nested, 'commit', '-q', '-m', 'nested');
            return { finalText: 'Vendored.' };
        };
        const out = await run([nesting]).done;
        expect(out.gate?.name, out.message).toBe('sandbox-escaped');
        expect(out.gate?.reason).toMatch(/vendor\/x/);
        const lane = readFactoryState(h.root, ISSUE).lanes[0];
        expect(gitIn(lane.worktree, 'rev-parse', 'HEAD')).toBe(lane.startSha);
        expect(remoteHead(h)).toBeNull();
    });
    it('a detect-only lane is warned about and recorded on the PR body', async () => {
        const warn = vi.fn();
        const out = await run([edit('a.ts', 'a\n', sandboxOf('detect-only')), review('approve')], { warn }).done;
        // The merge step does not report the human review clean after an unsandboxed lane (PR #471 M-1).
        expect(out.gate?.name, out.message).toBe('human-review');
        expect(out.gate?.reason).toContain(`a lane ran without the enforced sandbox`);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ran without an OS sandbox'));
        const create = h.raw.find((c) => c.cmd === 'gh' && c.args.includes('create'));
        const body = readFileSync(create.args[create.args.indexOf('--body-file') + 1], 'utf8');
        expect(body).toContain('Sandbox: detect-only');
        expect(body).toContain(`issue-${ISSUE}-implement-1`);
        expect(readFactoryState(h.root, ISSUE).lanes[0].sandbox?.mode).toBe('detect-only');
    });
});
describe('commitLaneWork', () => {
    /** A lane worktree of h.root at HEAD, its git links recorded like copilot_run's. */
    function laneTree(name) {
        const worktree = join(h.dir, name);
        const branch = `omc-team/copilot-run/${name}`;
        const start = gitIn(h.root, 'rev-parse', 'HEAD');
        gitIn(h.root, 'worktree', 'add', '-q', '-b', branch, worktree, start);
        recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree));
        return { worktree, start, branch };
    }
    it('runs no hook and no filter the repository or the lane planted', () => {
        const { worktree, start, branch } = laneTree('cr-hooks');
        const marker = join(h.dir, 'ran').replace(/\\/g, '/');
        const common = gitIn(h.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
        for (const hook of ['pre-commit', 'post-commit', 'commit-msg', 'reference-transaction', 'post-index-change']) {
            writeFileSync(join(common, 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
        }
        gitIn(h.root, 'config', 'filter.evil.clean', `sh -c 'echo planted; echo filter >> "${marker}"'`);
        writeFileSync(join(worktree, '.gitattributes'), '* filter=evil\n');
        writeFileSync(join(worktree, 'a.ts'), 'raw bytes\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: laneCommitMessage('implement: x', 'y') });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const sha = res.sha;
        expect(existsSync(marker)).toBe(false);
        expect(gitIn(h.root, 'show', `${sha}:a.ts`)).toBe('raw bytes');
        expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(sha);
        // Control: plain git in the same worktree does run them.
        writeFileSync(join(worktree, 'b.ts'), 'b\n');
        gitIn(worktree, 'add', 'b.ts');
        gitIn(worktree, 'commit', '-q', '-m', 'control');
        expect(readFileSync(marker, 'utf8')).toMatch(/filter[\s\S]*pre-commit/);
    });
    it('refuses a merge-rule path before it commits; HEAD and branch stay', () => {
        const { worktree, start, branch } = laneTree('cr-protected');
        mkdirSync(join(worktree, '.github', 'workflows'), { recursive: true });
        writeFileSync(join(worktree, '.github', 'workflows', 'ci.yml'), 'on: push\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
        expect(res).toMatchObject({ ok: false, refusal: 'protected' });
        expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(start);
        expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(start);
    });
    it('refuses a lane branch rewritten as a symref after the lane ended; main does not move', () => {
        const { worktree, start, branch } = laneTree('cr-symref');
        // A copilot_run job worktree's HEAD is detached (the session commits on it).
        gitIn(worktree, 'checkout', '-q', '--detach');
        const mainRef = gitIn(h.root, 'symbolic-ref', 'HEAD');
        const main = gitIn(h.root, 'rev-parse', mainRef);
        const common = gitIn(h.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
        writeFileSync(join(common, 'refs', 'heads', ...branch.split('/')), `ref: ${mainRef}\n`);
        writeFileSync(join(worktree, 'a.ts'), 'a\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
        expect(res, JSON.stringify(res)).toMatchObject({ ok: false, refusal: 'escaped' });
        expect(res.reason).toMatch(/symbolic|plain commit id/);
        expect(gitIn(h.root, 'rev-parse', mainRef)).toBe(main);
    });
    it('refuses a worktree whose git links were never recorded, and never commits the lane\'s runtime state', () => {
        const unrecorded = join(h.dir, 'cr-unrecorded');
        const start = gitIn(h.root, 'rev-parse', 'HEAD');
        gitIn(h.root, 'worktree', 'add', '-q', '--detach', unrecorded, start);
        writeFileSync(join(unrecorded, 'a.ts'), 'a\n');
        expect(commitLaneWork({ worktree: unrecorded, start, parents: [start], repoRoot: h.root, branch: null, message: 'x' })).toMatchObject({ ok: false, refusal: 'error' });
        const { worktree } = laneTree('cr-state');
        // An untracked .omg/state the lane's hooks wrote, in a repository that does not ignore it.
        writeFileSync(join(worktree, '.gitignore'), '');
        mkdirSync(join(worktree, '.omg', 'state'), { recursive: true });
        writeFileSync(join(worktree, '.omg', 'state', 'session.json'), '{}');
        writeFileSync(join(worktree, 'a.ts'), 'a\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch: null, message: 'x' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.files.sort()).toEqual(['.gitignore', 'a.ts']);
    });
    it('laneCommitMessage drops control characters and bounds the text', () => {
        expect(laneCommitMessage('fix:\x1b[31m t\nitle', 'a\r\nb\x00c')).toBe('fix: [31m t itle\n\na\nb c');
        expect(laneCommitMessage('t', 'x'.repeat(10_000)).length).toBeLessThan(4_100);
    });
    it('laneCommitMessage drops skip-CI markers, lane trailers and format characters', () => {
        expect(laneCommitMessage('fix: t [skip ci]', 'Body [CI SKIP] x [no ci][Skip Actions]\n\nCo-authored-by: Evil <e@x.invalid>\nSigned-off-by: a\nskip-checks: true'))
            .toBe('fix: t\n\nBody  x');
        // A trailer-shaped line counts only in the last paragraph; the credit trailers count on any line.
        expect(laneCommitMessage('t', 'Note: kept\nco-authored-by: Evil <e@x.invalid>\n\nDone.\n\nKey: v\n  continued\nOther: w')).toBe('t\n\nNote: kept\n\nDone.');
        // A format or bidi character cannot hide or rebuild a marker.
        expect(laneCommitMessage('a‮b​c', '[sk​ip ci] [skip [ci skip]ci] ok')).toBe('abc\n\nok');
        expect(laneCommitMessage('t', 'Skip-Checks: true')).toBe('t');
    });
    it('a junction to outside the worktree refuses before anything is staged (win32 only: junctions are a Windows link type)', ({ skip }) => {
        if (process.platform !== 'win32')
            skip();
        const { worktree, start, branch } = laneTree('cr-junction');
        const unlink = dirLink(outsideDir(), join(worktree, 'junc'), 'junction');
        try {
            writeFileSync(join(worktree, 'a.ts'), 'a\n');
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(res).toMatchObject({ ok: false, refusal: 'escaped', reason: expect.stringContaining('link at junc') });
            expect(gitIn(worktree, 'ls-files', '--stage')).not.toMatch(/junc|a\.ts/);
            expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(start);
        }
        finally {
            unlink();
        }
    });
    it('a symlinked directory to outside the worktree refuses (POSIX only: a directory symlink on win32 needs Developer Mode)', ({ skip }) => {
        if (process.platform === 'win32')
            skip();
        const { worktree, start, branch } = laneTree('cr-dirlink');
        const unlink = dirLink(outsideDir(), join(worktree, 'junc'), 'dir');
        try {
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(res).toMatchObject({ ok: false, refusal: 'escaped', reason: expect.stringContaining('link at junc') });
            expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(start);
        }
        finally {
            unlink();
        }
    });
    it('a directory link deep in the tree refuses too, while one in an ignored directory is not entered', () => {
        const { worktree, start, branch } = laneTree('cr-deep');
        const target = outsideDir();
        const ignored = dirLink(target, join(worktree, 'build', 'cache', 'link'));
        writeFileSync(join(worktree, '.gitignore'), 'build/\n');
        writeFileSync(join(worktree, 'a.ts'), 'a\n');
        let deep = () => { };
        try {
            // The ignored link alone commits: git never enters build/.
            const ok = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(ok.ok, JSON.stringify(ok)).toBe(true);
            const sha = ok.sha;
            writeFileSync(join(worktree, 'b.ts'), 'b\n');
            deep = dirLink(target, join(worktree, 'src', 'a', 'b', 'c', 'd', 'junc'));
            const res = commitLaneWork({ worktree, start: sha, parents: [sha], repoRoot: h.root, branch, message: 'x' });
            expect(res).toMatchObject({ ok: false, refusal: 'escaped', reason: expect.stringContaining('link at src/a/b/c/d/junc') });
            expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(sha);
            expect(gitIn(h.root, 'ls-tree', '-r', '--name-only', sha)).not.toMatch(/id_rsa/);
        }
        finally {
            deep();
            ignored();
        }
    });
    it('a new symlink file refuses and leaves nothing staged', ({ skip }) => {
        const { worktree, start, branch } = laneTree('cr-symlink');
        const target = join(outsideDir(), 'id_rsa');
        const link = join(worktree, 'key.txt');
        try {
            symlinkSync(target, link, 'file');
        }
        catch (err) {
            // win32 without Developer Mode or admin rights cannot create a file symlink (EPERM).
            if (err.code === 'EPERM')
                return skip();
            throw err;
        }
        try {
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(res).toMatchObject({ ok: false, refusal: 'escaped' });
            expect(gitIn(worktree, 'ls-files', '--stage')).not.toMatch(/key\.txt/);
            expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(start);
        }
        finally {
            unlinkSync(link);
        }
    });
    it('a hard link to a file outside the worktree refuses and leaves nothing staged', () => {
        const { worktree, start, branch } = laneTree('cr-hardlink');
        const secret = join(outsideDir(), 'secret.txt');
        writeFileSync(secret, 'top secret\n');
        const stolen = join(worktree, 'stolen.txt');
        linkSync(secret, stolen);
        try {
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(res).toMatchObject({ ok: false, refusal: 'escaped', reason: expect.stringContaining('stolen.txt') });
            expect(gitIn(worktree, 'ls-files', '--stage')).not.toMatch(/stolen\.txt/);
            expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(start);
        }
        finally {
            unlinkSync(stolen);
        }
    });
    it('commits beside runtime state in a repository that ignores .omg/ (an exclude of an ignored path would fail add)', () => {
        const { worktree, start, branch } = laneTree('cr-ignored-state');
        writeFileSync(join(worktree, '.gitignore'), '.omg/\n');
        mkdirSync(join(worktree, '.omg', 'state'), { recursive: true });
        writeFileSync(join(worktree, '.omg', 'state', 'session.json'), '{}');
        writeFileSync(join(worktree, 'a.ts'), 'a\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.files).toContain('a.ts');
    });
    it('L5/L9: every oh-my-copilot runtime file under .omg/ is skipped (not refused), .omg/skills/ excepted; a change of only those is no change', () => {
        const { worktree, start, branch } = laneTree('cr-runtime');
        writeFileSync(join(worktree, '.gitignore'), '');
        const runtime = ['project-memory.json', 'notepad.md', 'plans/p.md', 'research/r.md', 'logs/l.log', 'artifacts/a.txt', 'handoffs/h.md', 'ultragoal/u.json', 'progress/x.json', 'release/r.md', 'state/s.json', 'sessions/x.json', 'anything-else.json'];
        for (const p of runtime) {
            mkdirSync(join(worktree, '.omg', p, '..'), { recursive: true });
            writeFileSync(join(worktree, '.omg', p), '{"projectRoot":"C:\\\\Users\\\\someone"}\n');
        }
        writeFileSync(join(worktree, 'a.ts'), 'a\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.files.sort()).toEqual(['.gitignore', 'a.ts']);
        expect(gitIn(h.root, 'show', '--name-only', '--format=', branch).split('\n').filter((p) => p.startsWith('.omg/'))).toEqual([]);
        const only = laneTree('cr-runtime-only');
        mkdirSync(join(only.worktree, '.omg'), { recursive: true });
        writeFileSync(join(only.worktree, '.omg', 'project-memory.json'), '{}\n');
        expect(commitLaneWork({ worktree: only.worktree, start: only.start, parents: [only.start], repoRoot: h.root, branch: only.branch, message: 'x' })).toMatchObject({ ok: false, refusal: 'empty' });
        expect(isOmcRuntimePath('.omg/skills/x/SKILL.md')).toBe(false);
        expect(isOmcRuntimePath('.omg/project-memory.json')).toBe(true);
        expect(isOmcRuntimePath('src/.omg/x')).toBe(false);
    });
    it('L1 (review-490): a TRACKED .omg/ path the lane changed or deleted is committed and listed; untracked runtime files are still never added', () => {
        const { worktree, branch } = laneTree('cr-runtime-tracked');
        writeFileSync(join(worktree, '.gitignore'), '');
        mkdirSync(join(worktree, '.omg', 'plans'), { recursive: true });
        mkdirSync(join(worktree, '.omg', 'research'), { recursive: true });
        writeFileSync(join(worktree, '.omg', 'plans', 'p.md'), 'plan v1\n');
        writeFileSync(join(worktree, '.omg', 'research', 'r.md'), 'notes\n');
        gitIn(worktree, 'add', '-A');
        gitIn(worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'commit .omg/plans');
        const start = gitIn(worktree, 'rev-parse', 'HEAD').trim();
        writeFileSync(join(worktree, '.omg', 'plans', 'p.md'), 'plan v2\n');
        rmSync(join(worktree, '.omg', 'research', 'r.md'));
        mkdirSync(join(worktree, '.omg', 'state'), { recursive: true });
        mkdirSync(join(worktree, '.omg', 'sessions'), { recursive: true });
        writeFileSync(join(worktree, '.omg', 'project-memory.json'), '{}\n');
        writeFileSync(join(worktree, '.omg', 'state', 's.json'), '{}\n');
        writeFileSync(join(worktree, '.omg', 'sessions', 'x.json'), '{}\n');
        writeFileSync(join(worktree, '.omg', 'plans', 'new-untracked.md'), 'x\n');
        const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.files.sort()).toEqual(['.omg/plans/p.md', '.omg/research/r.md']);
        const committed = gitIn(h.root, 'show', '--name-status', '--format=', branch).trim().split('\n').map((l) => l.replace(/\s+/, ' ')).sort();
        expect(committed).toEqual(['D .omg/research/r.md', 'M .omg/plans/p.md']);
    });
    it('outsideWorktree names a staged path whose real directory is outside the worktree', () => {
        const { worktree } = laneTree('cr-outside');
        const unlink = dirLink(outsideDir(), join(worktree, 'junc'));
        try {
            expect(outsideWorktree(worktree, ['junc/id_rsa', 'a.ts', 'gone/x.ts'])).toEqual(['junc/id_rsa']);
        }
        finally {
            unlink();
        }
    });
    it('refuses the lane-protected paths (agent instructions, hooks, skills, CI) and resets the index', () => {
        for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.github/dependabot.yml', '.copilot/hooks/hooks.json', '.claude/settings.json', '.vscode/tasks.json', '.mcp.json', '.husky/pre-commit', '.omg/skills/s/SKILL.md', '.omc/skills/s/SKILL.md']) {
            const { worktree, start, branch } = laneTree(`cr-p-${path.replace(/[^a-z]/gi, '')}`);
            // The harness repository ignores .omg/: a repository that commits its skills does not.
            writeFileSync(join(worktree, '.gitignore'), '');
            mkdirSync(join(worktree, path, '..'), { recursive: true });
            writeFileSync(join(worktree, path), 'x\n');
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(res, path).toMatchObject({ ok: false, refusal: 'protected', reason: expect.stringContaining(path) });
            expect(gitIn(worktree, 'diff', '--cached', '--name-only'), path).toBe('');
        }
    });
    it('refuses the Azure Pipelines definitions (the CI that gates an ADO PR), in any case', () => {
        for (const path of ['azure-pipelines.yml', 'Azure-Pipelines.YAML', '.azure-pipelines/ci.yml', '.azuredevops/pull_request_template.md', '.Pipelines/build.yml']) {
            const { worktree, start, branch } = laneTree(`cr-ado-${path.replace(/[^a-z]/gi, '')}`);
            mkdirSync(join(worktree, path, '..'), { recursive: true });
            writeFileSync(join(worktree, path), 'x\n');
            const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
            expect(res, path).toMatchObject({ ok: false, refusal: 'protected', reason: expect.stringContaining(path) });
            expect(gitIn(worktree, 'diff', '--cached', '--name-only'), path).toBe('');
        }
        // The Win32 forms protectedChanges normalizes (trailing dots and spaces, `\`, `.` segments) hit too.
        expect(protectedChanges(['azure-pipelines.yml.', 'AZURE-PIPELINES.YAML ', '.azure-pipelines.\\ci.yml', './.pipelines/x.yml', 'src/azure-pipelines.yml'], LANE_PROTECTED_PATHS))
            .toEqual(['azure-pipelines.yml.', 'AZURE-PIPELINES.YAML ', '.azure-pipelines.\\ci.yml', './.pipelines/x.yml']);
    });
});
//# sourceMappingURL=engine.sandbox.commit.test.js.map