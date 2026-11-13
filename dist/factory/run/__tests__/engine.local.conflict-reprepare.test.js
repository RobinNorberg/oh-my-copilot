/**
 * The local forge (real git): a run in the gates phase whose head no longer
 * merges into the moved base (git merge-tree against the synced mirror base)
 * goes back to prepare, which merges the base and hands the conflict to the
 * conflict-fix lane, instead of judging a head that cannot merge.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
vi.setConfig({ testTimeout: scaleTiming(90_000) });
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const unsandboxed = { gateSandboxUserConfig: { factory: { run: { sandbox: { gates: 'unsandboxed' } } } } };
describe('local forge: gates -> prepare for a head that conflicts with the moved base', () => {
    it('a rerun in gates finds the head conflicting with the new base, prepares again and the conflict-fix lane resolves it', async () => {
        w = localWorld();
        // The first run parks in gates (the gate cannot start), at a head that merged cleanly then.
        w.gate = async () => ({ status: 127, stdout: '', stderr: '', timedOut: false, startError: 'npm is not on PATH' });
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('README.md', 'lane side\n'), review('approve')]), unsandboxed));
        expect(first.exitCode, first.message).toBe(EXIT_AWAITING_HUMAN);
        expect(first.gate?.name).toBe('gates');
        const parkedHead = readFactoryState(w.root, LOCAL_ISSUE).head;
        // The human moves the base into the PR's file, then fixes the gate and reruns.
        writeFileSync(join(w.root, 'README.md'), 'base side\n');
        gitIn(w.root, 'commit', '-q', '-am', 'base: README');
        const baseTip = gitIn(w.root, 'rev-parse', BASE);
        const runs = [];
        w.gate = async (_argv, cwd) => { runs.push(gitIn(cwd, 'rev-parse', 'HEAD')); return { status: 0, stdout: 'ok\n', stderr: '', timedOut: false }; };
        const resolve = ({ worktree }) => {
            writeFileSync(join(worktree, 'README.md'), 'both sides\n');
            return { finalText: 'Merged.' };
        };
        const lanes = lanesFor(w, [resolve, review('approve')]);
        const again = await runFactoryEngine(localOpts(w, lanes, unsandboxed));
        expect(again.gate?.name, again.message).toBe('merge');
        expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${LOCAL_ISSUE}-conflict-fix-1`, `issue-${LOCAL_ISSUE}-review-2`]);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.conflictReprepares).toBe(1);
        expect(state.history.some((e) => e.from === 'gates' && e.to === 'prepare' && e.note.includes(`conflicts with ${BASE} after it moved; preparing again`))).toBe(true);
        expect(gitIn(w.root, 'merge-base', '--is-ancestor', baseTip, state.head)).toBe('');
        expect(gitIn(w.root, 'show', `${state.head}:README.md`)).toBe('both sides');
        // The gate never judged the head that could not merge.
        expect(runs).not.toContain(parkedHead);
        expect(runs.at(-1)).toBe(state.head);
        expect(w.calls.some((c) => c.startsWith('git merge-tree --write-tree '))).toBe(true);
    });
});
//# sourceMappingURL=engine.local.conflict-reprepare.test.js.map