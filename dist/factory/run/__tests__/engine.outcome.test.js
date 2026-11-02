/**
 * Outcome write-back (shipyard ↔ factory design §3.6, §9 PR 6): the engine
 * posts one outcome comment on the item per terminal phase and one rollup
 * line on the parent spec, exactly once per (child, phase, head), through the
 * real factory guard; a comment failure never blocks a transition and the
 * spec body is never edited.
 */
import { describe, expect, it } from 'vitest';
import { runFactoryEngine } from '../engine.js';
import { outcomeMarker } from '../outcome.js';
import { readFactoryState } from '../state.js';
import { ISSUE, PR, REPO_URL } from './fake-lanes.js';
import { SPEC, h, posted, setCommentResult, warnings, useOutcomeHarness, opts, happy, on, outcomes } from './engine-outcome-harness.js';
useOutcomeHarness();
describe('outcome and rollup comments (fake gh, real git, real guard)', () => {
    it('ready to merge, then merged: one rollup per (child, phase, head), one outcome comment on the item', async () => {
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.gate?.name, parked.message).toBe('merge');
        const head12 = readFactoryState(h.root, ISSUE).head.slice(0, 12);
        expect(on(SPEC).map((p) => p.body)).toEqual([`- #${ISSUE} ready to merge: ${REPO_URL}/pull/${PR}\n\n${outcomeMarker('rollup', ISSUE, 'ready-to-merge', head12)}\n`]);
        expect(outcomes()).toEqual([]);
        // A rerun at the same merge park posts nothing again.
        await runFactoryEngine(opts([]));
        expect(on(SPEC)).toHaveLength(1);
        h.gh.merged = true;
        const merged = await runFactoryEngine(opts([]));
        expect(merged.phase, merged.message).toBe('merged');
        expect(outcomes()).toHaveLength(1);
        const body = outcomes()[0].body;
        expect(body).toContain(`Factory run for #${ISSUE} is **merged**: PR #${PR} (${REPO_URL}/pull/${PR}).`);
        expect(body).toContain('- Review rounds: 1');
        expect(body).toContain(`- Gates: green at ${head12}`);
        expect(body).toMatch(/- AI credits: \d+\.\d\d/);
        expect(body).toContain('- Human gates: merge');
        expect(body).toContain(outcomeMarker('outcome', ISSUE, 'merged', head12));
        expect(on(SPEC).map((p) => p.body.split('\n')[0])).toEqual([
            `- #${ISSUE} ready to merge: ${REPO_URL}/pull/${PR}`,
            `- #${ISSUE} merged (${REPO_URL}/pull/${PR})`,
        ]);
        // Reruns on the merged run post nothing and read nothing more.
        const reads = h.calls.filter((c) => c.startsWith('gh issue view')).length;
        await runFactoryEngine(opts([]));
        await runFactoryEngine(opts([]));
        expect(posted.filter((p) => p.body.includes('omg-factory-'))).toHaveLength(3);
        expect(h.calls.filter((c) => c.startsWith('gh issue view')).length).toBe(reads);
    });
    it('no parent: no rollup, no read of another item; the outcome comment still goes on the item', async () => {
        h.gh.issue.body = h.gh.issue.body.replace(`Part of #${SPEC}`, '');
        await runFactoryEngine(opts(happy()));
        h.gh.merged = true;
        expect((await runFactoryEngine(opts([]))).phase).toBe('merged');
        expect(on(SPEC)).toEqual([]);
        expect(h.calls.some((c) => c.startsWith(`gh issue view ${SPEC}`))).toBe(false);
        expect(outcomes()).toHaveLength(1);
    });
    it('a comment failure never blocks a transition; the next invocation posts what is missing, once', async () => {
        setCommentResult(() => ({ status: 1, stdout: '', stderr: 'HTTP 502' }));
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.exitCode).toBe(0);
        expect(parked.gate?.name).toBe('merge');
        h.gh.merged = true;
        const merged = await runFactoryEngine(opts([]));
        expect(merged.phase).toBe('merged');
        expect(merged.exitCode).toBe(0);
        expect(posted).toEqual([]);
        expect(warnings.join('\n')).toMatch(/could not post the merged outcome on #7: HTTP 502/);
        expect(readFactoryState(h.root, ISSUE).gateComments ?? []).not.toContain(expect.stringMatching(/^outcome-done:/));
        // The tracker is back: a rerun on the terminal state posts the merged outcome and rollup (the merge park's rollup is past).
        setCommentResult(() => ({ status: 0, stdout: '', stderr: '' }));
        expect((await runFactoryEngine(opts([]))).phase).toBe('merged');
        expect(outcomes()).toHaveLength(1);
        expect(on(SPEC).map((p) => p.body.split('\n')[0])).toEqual([`- #${ISSUE} merged (${REPO_URL}/pull/${PR})`]);
        await runFactoryEngine(opts([]));
        expect(posted.filter((p) => p.body.includes('omg-factory-'))).toHaveLength(2);
    });
    it('a read failure (the parent cannot be read) is a warning, and the run still parks', async () => {
        h.gh.issue.body = h.gh.issue.body.replace(`Part of #${SPEC}`, 'Part of #99');
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.gate?.name).toBe('merge');
        expect(warnings.join('\n')).toMatch(/ready-to-merge outcome comments failed/);
    });
});
//# sourceMappingURL=engine.outcome.test.js.map