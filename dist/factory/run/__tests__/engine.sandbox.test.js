/**
 * Sandboxed write lanes (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.3,
 * §9 PR 2): the lane leaves its changes uncommitted and the engine commits
 * them through hardened host git (lane-commit.ts); the lane's sandbox is
 * recorded in its lane state and a detect-only lane on the PR.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_COMMIT_IDENTITY } from '../lane-commit.js';
import { readFactoryState } from '../state.js';
import { gitIn, ISSUE, remoteHead, review } from './fake-lanes.js';
import { h, useSandboxHarness, run, sandboxOf, edit, dirLink, outsideDir } from './engine-sandbox-harness.js';
useSandboxHarness();
describe('engine-side commit of a write lane', () => {
    it('a lane that leaves a directory link to outside its worktree parks at sandbox-escaped; nothing is committed or pushed', async () => {
        const target = outsideDir();
        let unlink = () => { };
        const linking = ({ worktree }) => {
            writeFileSync(join(worktree, 'a.ts'), 'a\n');
            unlink = dirLink(target, join(worktree, 'junc'));
            return { finalText: 'Linked.' };
        };
        try {
            const out = await run([linking]).done;
            expect(out.gate?.name, out.message).toBe('sandbox-escaped');
            expect(out.gate?.reason).toMatch(/link at junc/);
            const lane = readFactoryState(h.root, ISSUE).lanes[0];
            expect(gitIn(lane.worktree, 'rev-parse', 'HEAD')).toBe(lane.startSha);
            expect(gitIn(lane.worktree, 'ls-files', '--stage')).not.toMatch(/junc/);
            expect(remoteHead(h)).toBeNull();
        }
        finally {
            unlink();
        }
    });
    it('a detect-only fix lane after the PR exists is recorded in a PR comment', async () => {
        const finding = { severity: 'major', file: 'a.ts', line: 1, summary: 'a must be b' };
        const out = await run([edit('a.ts', 'a\n'), review('request-changes', [finding]), edit('a.ts', 'b\n', sandboxOf('detect-only')), review('approve')]).done;
        expect(out.gate?.name, out.message).toBe('merge');
        const create = h.raw.find((c) => c.cmd === 'gh' && c.args.includes('create'));
        expect(readFileSync(create.args[create.args.indexOf('--body-file') + 1], 'utf8')).not.toContain('detect-only');
        const notes = h.raw.filter((c) => c.cmd === 'gh' && c.args[1] === 'comment').map((c) => readFileSync(c.args[c.args.indexOf('--body-file') + 1], 'utf8'));
        expect(notes.filter((b) => b.includes('Sandbox: detect-only'))).toEqual([expect.stringContaining(`fix lane issue-${ISSUE}-fix-1`)]);
    });
    it('commits the lane\'s uncommitted changes with the engine identity and the lane\'s summary, and records the lane\'s sandbox', async () => {
        const { lanes, done } = run([edit('src/greet.ts', 'export const greet = () => "hi";\n', sandboxOf('enforced')), review('approve')]);
        const out = await done;
        expect(out.gate?.name, out.message).toBe('merge');
        expect(lanes.started.map((s) => s.engineCommits)).toEqual([true, undefined]);
        const state = readFactoryState(h.root, ISSUE);
        const lane = state.lanes[0];
        const commit = lane.endSha;
        expect(commit).not.toBe(lane.startSha);
        expect(gitIn(h.root, 'rev-parse', `${commit}^`)).toBe(lane.startSha);
        expect(gitIn(h.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', commit)).toBe(`${ENGINE_COMMIT_IDENTITY.name} <${ENGINE_COMMIT_IDENTITY.email}>|${ENGINE_COMMIT_IDENTITY.name} <${ENGINE_COMMIT_IDENTITY.email}>`);
        expect(gitIn(h.root, 'log', '-1', '--format=%B', commit)).toBe(`implement: Add greet() (#${ISSUE})\n\nAdded src/greet.ts.\nTests pass.`);
        expect(gitIn(h.root, 'show', `${commit}:src/greet.ts`)).toBe('export const greet = () => "hi";');
        // The lane's worktree HEAD and branch moved to the commit; nothing is left uncommitted.
        expect(gitIn(lane.worktree, 'rev-parse', 'HEAD')).toBe(commit);
        expect(gitIn(h.root, 'rev-parse', `refs/heads/omc-team/copilot-run/${lane.jobId}`)).toBe(commit);
        expect(gitIn(lane.worktree, 'status', '--porcelain')).toBe('');
        expect(remoteHead(h)).toBe(state.head);
        // The sandbox round-trips through the lane state.
        expect(lane.sandbox).toMatchObject({ mode: 'enforced', applied: 'options.update', unsandboxedCalls: 0 });
        expect(state.lanes[1].sandbox).toBeUndefined();
    });
});
//# sourceMappingURL=engine.sandbox.test.js.map