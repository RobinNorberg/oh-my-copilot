/**
 * Night 3 goal 2 (L2b) on the local forge: a played-back review
 * (`omg factory pr review`) at the merge park starts a human fix lane; the
 * request on the older head then blocks until the same author approves.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { appendLocalReview, engineOwnedDir } from '../../../forge/local/store.js';
import { readShipState } from '../../../ship/state.js';
import { runFactoryEngine } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
vi.setConfig({ testTimeout: scaleTiming(300_000) });
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
describe('human review on the local forge', () => {
    it('request changes -> human fix lane -> review -> gate; the old request blocks until its author approves', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        const s1 = readFactoryState(w.root, LOCAL_ISSUE);
        const store = engineOwnedDir(w.config.repo.url.slice(0, -'.git'.length), []);
        appendLocalReview(store, { version: 1, id: 'r1', pr: s1.pr, author: 'robin', state: 'changes-requested', body: 'Name it hello', head: s1.head, at: '2026-11-09T11:00:00.000Z' });
        const lanes = lanesFor(w, [commitFile('src/greet.js', 'export const hello = () => "hi";\n'), review('approve')]);
        const second = await runFactoryEngine(localOpts(w, lanes));
        expect(lanes.started[0].prompt).toContain('robin on the pull request ---\nName it hello');
        const s2 = readFactoryState(w.root, LOCAL_ISSUE);
        expect(s2.lanes.find((l) => l.kind === 'fix')?.feedback).toEqual({ source: 'human', forge: 'local', items: 1 });
        expect(s2.head).not.toBe(s1.head);
        expect(readShipState(w.root, s1.pr).fixRounds).toBe(1);
        expect(second.gate?.name, second.message).toBe('human-review');
        expect(second.gate?.reason).toContain('changes requested on PR #1 by robin');
        // F52: the local way out is named, with the full head the command needs.
        expect(second.gate?.reason).toContain(`(omg factory pr review 1 --approve --head ${s2.head} by that reviewer; omg factory pr view 1 shows the request)`);
        appendLocalReview(store, { version: 1, id: 'r2', pr: s1.pr, author: 'robin', state: 'approved', body: '', head: s2.head, at: '2026-11-09T12:00:00.000Z' });
        const third = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
        expect(third.gate?.name, third.message).toBe('merge');
        expect(third.gate?.reason).toContain('approved at this head by robin');
    });
});
//# sourceMappingURL=engine.human-review.local.test.js.map