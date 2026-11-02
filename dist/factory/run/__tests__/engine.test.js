import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProgressLog } from '../../../lib/agent-progress.js';
import { readShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN } from '../engine.js';
import { factoryProgressFile } from '../progress.js';
import { factoryOwnerPath, readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, PR, remoteHead, review } from './fake-lanes.js';
import { h, useEngineHarness, limits, run } from './engine-harness.js';
useEngineHarness();
describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
    it('happy path: implement -> push -> draft PR -> independent review approve -> prepare -> green gates -> park at the human merge', async () => {
        const { lanes, done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
        const out = await done;
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        const state = readFactoryState(h.root, ISSUE);
        expect(state.phase).toBe('merge');
        expect(state.pr).toBe(PR);
        expect(state.head).toBe(remoteHead(h));
        expect(state.plan?.source).toBe('issue-body');
        // Lanes: write profile for the implementer, review profile on the exact head, every start capped.
        expect(lanes.started.map((s) => [s.laneId, s.profile, s.maxCredits])).toEqual([
            [`issue-${ISSUE}-implement-1`, 'write', 30],
            [`issue-${ISSUE}-review-1`, 'review', 30],
        ]);
        expect(lanes.started[0].baseRef).toBe(gitIn(h.root, 'rev-parse', 'origin/dev'));
        expect(lanes.started[1].baseRef).toBe(state.head);
        expect(lanes.started[1].prompt).toContain('greet');
        expect(lanes.started[1].prompt).not.toContain('Committed.');
        // Engine-only push and draft PR; credits recorded per lane.
        expect(h.calls).toContain(`git push origin ${state.head}:refs/heads/factory/issue-${ISSUE}`);
        const create = h.calls.find((c) => c.startsWith('gh pr create'));
        expect(create).toContain('--draft --base dev --head factory/issue-7');
        const body = readFileSync(create.split('--body-file ')[1], 'utf8');
        expect(body).toContain(`Closes #${ISSUE}`);
        expect(state.lanes.map((l) => [l.status, l.usage?.credits])).toEqual([['completed', 5], ['completed', 3]]);
        expect(state.lanes[1].verdict).toBe('approve');
        // Ship holds the verdict, by a reviewer that is not the implementer.
        const ship = readShipState(h.root, PR);
        expect(ship.implementer).toBe(`factory-impl-${ISSUE}`);
        expect(ship.phase).toBe('ready');
        expect(ship.verdicts).toHaveLength(1);
        expect(ship.verdicts[0]).toMatchObject({ verdict: 'approve', sha: state.head, reviewer: `factory-review-${ISSUE}-cr-fake2` });
        expect(h.calls.some((c) => c.startsWith(`gh pr comment ${PR}`))).toBe(true);
        // Progress: phases start/ok, the gate is blocked.
        const events = parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
        expect(events.every((e) => e.agent === `factory-${ISSUE}`)).toBe(true);
        for (const phase of ['intake', 'plan', 'implement', 'publish', 'review', 'prepare', 'gates']) {
            expect(events.some((e) => e.phase === phase && e.status === 'start')).toBe(true);
            expect(events.some((e) => e.phase === phase && e.status === 'ok')).toBe(true);
        }
        expect(events.at(-1)).toMatchObject({ phase: 'merge', status: 'blocked' });
        expect(events.at(-1).note).toMatch(/^merge:/);
        expect(existsSync(factoryOwnerPath(h.root, ISSUE))).toBe(false);
    });
    it('changes-requested: a fresh fix lane at the head, a plain push, then a new review on the new head', async () => {
        const finding = { severity: 'major', file: 'src/greet.ts', line: 1, summary: 'greet must return hi' };
        const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('request-changes', [finding]), commitFile('src/greet.ts', 'hi\n'), review('approve')]);
        const out = await done;
        expect(out.gate?.name).toBe('merge');
        const state = readFactoryState(h.root, ISSUE);
        expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ISSUE}-implement-1`, `issue-${ISSUE}-review-1`, `issue-${ISSUE}-fix-1`, `issue-${ISSUE}-review-2`]);
        const firstHead = state.lanes[0].endSha;
        expect(lanes.started[2].baseRef).toBe(firstHead);
        expect(lanes.started[2].profile).toBe('write');
        expect(lanes.started[2].prompt).toContain('greet must return hi');
        expect(lanes.started[3].baseRef).toBe(state.head);
        expect(state.head).not.toBe(firstHead);
        expect(h.calls.filter((c) => c.startsWith('git push '))).toHaveLength(2);
        expect(h.calls.filter((c) => c.startsWith('gh pr create'))).toHaveLength(1);
        const ship = readShipState(h.root, PR);
        expect(ship.fixRounds).toBe(1);
        expect(ship.verdicts.map((v) => v.verdict)).toEqual(['changes-requested', 'approve']);
    });
    it('an approve carrying a blocker or major finding counts as changes-requested', async () => {
        const { done } = run([commitFile('a.ts'), review('approve', [{ severity: 'blocker', summary: 'breaks build' }])], { limits: limits({ maxFixRounds: 0 }) });
        const out = await done;
        expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe('fix-rounds-spent');
        const ship = readShipState(h.root, PR);
        expect(ship.verdicts[0].verdict).toBe('changes-requested');
        expect(ship.phase).toBe('blocked');
        expect(readFactoryState(h.root, ISSUE).lanes[1].verdict).toBe('changes-requested');
    });
});
//# sourceMappingURL=engine.test.js.map