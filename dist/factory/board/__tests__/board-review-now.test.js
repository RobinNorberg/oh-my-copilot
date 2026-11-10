/**
 * F50 (dogfood round 3): on the local forge, a run parked at the merge gate
 * shows the PR's review state now, not the "no open trusted threads or
 * change requests" clause the engine wrote when it parked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveForgeConfig } from '../../../forge/config.js';
import { computeFactoryIntegrity, createFactoryState, factoryStatePath, moveTo, runKeyOf, setGate } from '../../run/state.js';
import { collectBoard } from '../collect.js';
import { runLine } from '../render.js';
const HEAD = 'b'.repeat(40);
const T0 = '2026-11-10T07:00:00.000Z';
const PARKED = `merge is a human step; review approved and gates green at ${HEAD.slice(0, 12)}; human review: no open trusted threads or change requests; if the PR gets new review comments before you merge, rerun omg factory run 3 first: run git merge --no-ff --no-edit ${HEAD}, then omg factory run 3`;
let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-board-review-'));
    // A repository, so the run state lives under its own .omg (never a home one).
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
    expect(factoryStatePath(root, 3).startsWith(root)).toBe(true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function save(s) {
    const path = factoryStatePath(root, runKeyOf(s));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}
function boardWith(fb, kind = 'local') {
    save({ ...setGate(moveTo({ ...createFactoryState({ issue: 3, repoUrl: '', base: 'main' }, T0), forgeKind: 'local', remote: 'omg-local' }, 'merge', 'gates green', T0), 'merge', PARKED, T0), pr: 2, head: HEAD });
    const { config } = resolveForgeConfig({ factory: { forge: { kind: 'local' } } }, undefined, undefined, undefined, { root, stateDir: join(root, 'forge') });
    const read = [];
    const forge = {
        kind,
        tracker: { viewItem: (id) => ({ id, title: 'Add div()', url: '', labels: [], rawState: 'open', body: '', state: 'open' }) },
        reviews: { reviewFeedback: (pr, head) => { read.push([pr, head]); return fb; } },
    };
    const warnings = [];
    const b = collectBoard({ forge, config, root, ids: [3], check: null, now: Date.parse(T0), warnings });
    expect(warnings).toEqual([]);
    const row = b.columns.flatMap((c) => c.items).find((r) => r.id === 3);
    return { row, read, warnings };
}
const none = { decisions: [], threads: [], pendingReviewers: [], ignored: [] };
describe('board/poll merge park on the local forge (F50)', () => {
    it('a change request recorded after the park replaces the stale "no change requests" clause with a do-not-merge line', () => {
        const { row, read } = boardWith({ ...none, decisions: [{ author: 'norbe', state: 'changes-requested', at: T0, head: HEAD }], threads: [{ id: 'n1', author: 'norbe', body: 'div by zero', at: T0 }] });
        expect(read).toEqual([[2, HEAD]]);
        const reason = row.run.gate.reason;
        expect(reason).not.toContain('no open trusted threads or change requests');
        expect(reason).toContain('human review now: 1 open review note(s) and changes requested by norbe on local PR #2: do not merge; omg factory run 3 reads it');
        expect(reason).toContain('review approved and gates green at');
        // L5: the parked "run <merge command>" step is gone too.
        expect(reason).not.toContain('run git merge');
        expect(runLine(row, '#')).toContain('do not merge');
    });
    it('no review since the park keeps the parked text; another forge is never read', () => {
        expect(boardWith(none).row.run.gate.reason).toBe(PARKED);
        const gh = boardWith({ ...none, decisions: [{ author: 'x', state: 'changes-requested', at: T0 }] }, 'github');
        expect(gh.read).toEqual([]);
        expect(gh.row.run.gate.reason).toBe(PARKED);
    });
});
//# sourceMappingURL=board-review-now.test.js.map