import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readShipState } from '../../../ship/state.js';
import { factoryGuardExec } from '../exec.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, noCommit, PR, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, usePrepareGatesHarness, run, moveBase, PREPARE_VIEW, before, events, pushes } from './prepare-gates-harness.js';
// Every engine run here drives a few hundred real git processes (the lane
// tamper snapshots, prepare merges, the bare remote). No assertion measures
// time, so the timeout only bounds a hang and must leave a loaded host's
// process spawns room.
vi.setConfig({ testTimeout: scaleTiming(90_000) });
usePrepareGatesHarness();
describe('conflict-fix lane', () => {
    it('a base conflict outside inventory/ discards the checkout and starts a fresh write lane at the PR head, then a new review', async () => {
        let baseSha = '';
        before(PREPARE_VIEW, () => { baseSha = moveBase('README.md', 'base side\n'); });
        let markers = '';
        // The lane starts at the engine's merge with the conflict markers in place; it resolves them and does not commit.
        const resolve = ({ worktree }) => {
            markers = readFileSync(join(worktree, 'README.md'), 'utf8');
            writeFileSync(join(worktree, 'README.md'), 'both sides\n');
            return { finalText: 'Merged.' };
        };
        const { lanes, done } = run([commitFile('README.md', 'lane side\n'), review('approve'), resolve, review('approve')]);
        const out = await done;
        expect(out.gate?.name, out.message).toBe('merge');
        const state = readFactoryState(h.root, ISSUE);
        expect(lanes.started.map((s) => [s.laneId, s.profile])).toEqual([
            [`issue-${ISSUE}-implement-1`, 'write'], [`issue-${ISSUE}-review-1`, 'review'],
            [`issue-${ISSUE}-conflict-fix-1`, 'write'], [`issue-${ISSUE}-review-2`, 'review'],
        ]);
        const firstHead = state.lanes[0].endSha;
        // The lane starts at the engine's merge-tree commit of the PR head and the base, conflict markers included.
        const start = lanes.started[2].baseRef;
        expect(gitIn(h.root, 'rev-parse', `${start}^1`, `${start}^2`).split(/\s+/)).toEqual([firstHead, baseSha]);
        expect(markers).toMatch(/^<<<<<<< /m);
        expect(lanes.started[2].engineCommits).toBe(true);
        expect(lanes.started[2].prompt).toContain('README.md');
        expect(lanes.started[2].prompt).toContain('conflict markers');
        expect(lanes.started[3].baseRef).toBe(state.head);
        // The engine's commit is the merge of the PR head and the base (never of the unresolved start), by the engine identity.
        expect(gitIn(h.root, 'rev-parse', `${state.head}^1`, `${state.head}^2`).split(/\s+/)).toEqual([firstHead, baseSha]);
        expect(gitIn(h.root, 'show', `${state.head}:README.md`)).toBe('both sides');
        expect(gitIn(h.root, 'log', '-1', '--format=%an <%ae>', state.head)).toBe('omg factory <omg-factory@oh-my-copilot.invalid>');
        expect(h.calls).toContain('git merge --abort');
        expect(state.history.some((e) => e.to === 'conflict-fix' && /README\.md/.test(e.note))).toBe(true);
        // The lane's merge is not housekeeping: ship holds a second approve on the new head.
        const ship = readShipState(h.root, PR);
        expect(ship.verdicts.map((v) => v.sha)).toEqual([firstHead, state.head]);
        expect(gitIn(h.root, 'merge-base', '--is-ancestor', baseSha, state.head)).toBe('');
    });
});
describe('merge gate (always human)', () => {
    it('parks with the exact command and a PR comment, never merges; a later run detects the human merge and finishes as merged', async () => {
        const first = await run([commitFile('a.ts'), review('approve')]).done;
        expect(first.exitCode).toBe(0);
        expect(first.gate?.name).toBe('merge');
        const head = readFactoryState(h.root, ISSUE).head;
        const cmd = `gh pr merge ${PR} --admin --merge --match-head-commit ${head}`;
        expect(first.mergeCommand).toBe(cmd);
        expect(first.message).toContain(cmd);
        const comment = h.calls.filter((c) => c.startsWith(`gh pr comment ${PR} --body-file `)).map((c) => c.split('--body-file ')[1]).find((f) => f.includes('merge'));
        expect(readFileSync(comment, 'utf8')).toContain(cmd);
        expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
        expect(events().at(-1)).toMatchObject({ phase: 'merge', status: 'blocked' });
        // A rerun before the human merged parks again without a second comment.
        const commentsBefore = h.calls.filter((c) => c.startsWith('gh pr comment ') || c.startsWith('gh issue comment ')).length;
        const again = await run([]).done;
        expect(again.gate?.name).toBe('merge');
        expect(h.calls.filter((c) => c.startsWith('gh pr comment ') || c.startsWith('gh issue comment ')).length).toBe(commentsBefore);
        h.gh.merged = true;
        const done = await run([]).done;
        expect(done.exitCode).toBe(0);
        expect(done.phase).toBe('merged');
        expect(readFactoryState(h.root, ISSUE).phase).toBe('merged');
        expect(readShipState(h.root, PR).phase).toBe('merged');
        expect(events().at(-1)).toMatchObject({ phase: 'merged', status: 'done' });
        expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    });
    it('the factory guard refuses gh pr merge outright', () => {
        expect(() => factoryGuardExec(h.exec)('gh', ['pr', 'merge', String(PR), '--admin', '--merge', '--match-head-commit', 'a'.repeat(40)])).toThrow(/refuses/);
    });
    it('every human gate posts one issue comment with the gate, its reason and the resume command', async () => {
        h.gh.issue.body = 'no plan here';
        const out = await run([]).done;
        expect(out.gate?.name).toBe('needs-plan');
        const files = h.calls.filter((c) => c.startsWith(`gh issue comment ${ISSUE} --body-file `)).map((c) => c.split('--body-file ')[1]);
        expect(files).toHaveLength(1);
        const body = readFileSync(files[0], 'utf8');
        expect(body).toContain('**needs-plan**');
        expect(body).toContain(`omg factory run ${ISSUE}`);
    });
});
describe('conflict-fix checks', () => {
    /** A conflict-fix lane that resolves README.md in the engine's merge, then (optionally) moves the base again. */
    const resolveAndMoveBase = (again) => ({ worktree }) => {
        writeFileSync(join(worktree, 'README.md'), `both sides ${again ?? ''}\n`);
        if (again)
            moveBase('README.md', `${again}\n`);
        return { finalText: 'Merged.' };
    };
    it('a conflict-fix lane that leaves the engine merge unresolved parks at conflict-fix-failed and nothing is pushed', async () => {
        before(PREPARE_VIEW, () => { moveBase('README.md', 'base side\n'); });
        const { done } = run([commitFile('README.md', 'lane side\n'), review('approve'), noCommit, noCommit]);
        const out = await done;
        expect(out.gate?.name, out.message).toBe('conflict-fix-failed');
        expect(out.message).toMatch(/left no changes/);
        expect(pushes()).toHaveLength(1);
    });
    it('base conflicts after two conflict-fix rounds park at merge-conflicts', async () => {
        before(PREPARE_VIEW, () => { moveBase('README.md', 'base side\n'); });
        const { lanes, done } = run([
            commitFile('README.md', 'lane side\n'), review('approve'),
            resolveAndMoveBase('base side 2'), review('approve'),
            resolveAndMoveBase('base side 3'), review('approve'),
        ]);
        const out = await done;
        expect(out.gate?.name, out.message).toBe('merge-conflicts');
        expect(lanes.started.filter((s) => s.laneId.includes('conflict-fix'))).toHaveLength(2);
    });
    it('a conflict-fix lane that changes shared git state parks at lane-tampered and nothing is pushed', async () => {
        before(PREPARE_VIEW, () => { moveBase('README.md', 'base side\n'); });
        const tampering = (ctx) => { const r = resolveAndMoveBase()(ctx); gitIn(h.root, 'config', 'core.sshCommand', 'evil'); return r; };
        const out = await run([commitFile('README.md', 'lane side\n'), review('approve'), tampering]).done;
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.message).toMatch(/conflict-fix lane/);
        expect(pushes()).toHaveLength(1);
    });
});
//# sourceMappingURL=prepare-gates.conflict.test.js.map