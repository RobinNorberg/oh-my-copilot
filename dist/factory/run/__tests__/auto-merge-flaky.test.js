/**
 * Auto-merge never takes a check that did not succeed. ship's human merge
 * gate reads a known-flaky failure as `flaky` (rerun by hand); auto-merge
 * must not merge such a head with or without ship.requiredChecks, nor one
 * with any raw FAILURE / ERROR / CANCELLED / TIMED_OUT / ACTION_REQUIRED /
 * STARTUP_FAILURE. Checks in ship.advisoryChecks stay ignored. The real
 * mergeDecision (ship's gate read through a fake forge) feeds autoMergeVerdict.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIP_CONFIG } from '../../../ship/config.js';
import { createShipState, recordVerdict, sealShipState, transition } from '../../../ship/state.js';
import { autoMergeVerdict, classifyChanges } from '../auto-merge.js';
import { mergeDecision } from '../merge-policy.js';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const AT = '2026-11-12T00:00:00Z';
const FLAKY_LOG = ' FAIL  src/x.test.ts > grp > sometimes fails';
const KNOWN = [{ file: 'src/x.test.ts', title: 'sometimes fails' }];
const all = { enabled: true, tiers: ['docs', 'tests', 'small'] };
/** git diff base...head lists one docs file; nothing else runs (the verdict is on the head, so no commit walk). */
const exec = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'diff')
        return { status: 0, stdout: 'docs/a.md\0', stderr: '' };
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
};
const job = (n) => `https://github.com/o/r/actions/runs/${n}/job/${n + 1000}`;
/** A forge whose head reports `list`; every failed job's log is the known-flaky vitest failure. */
const forgeWith = (list) => ({
    reviews: { prHead: () => ({ headRefOid: HEAD }) },
    checks: { checks: () => list, runsForHead: () => [], jobLog: () => ({ ok: true, text: FLAKY_LOG }) },
    merge: { blockingPolicies: () => [], humanMergeCommand: () => ['gh', 'api', 'merge'] },
});
const ship = sealShipState(transition(transition(recordVerdict(createShipState({ pr: 17, base: 'dev', implementer: 'lane', maxFixRounds: 2 }, AT), { reviewer: 'factory-review', verdict: 'approve', sha: HEAD, at: AT }), 'gates', 'prepared', AT), 'ready', 'gates green', AT));
const view = { number: 17, state: 'OPEN', isDraft: false, baseRefName: 'dev', baseRefOid: BASE, headRefOid: HEAD };
const decide = (list, config = {}) => mergeDecision(exec, '/repo', ship, view, { ...DEFAULT_SHIP_CONFIG, ...config }, KNOWN, forgeWith(list));
const verdict = (decision, requiredChecks = []) => autoMergeVerdict({
    head: HEAD,
    config: all,
    run: { ciHeal: false, forgeKind: 'github', history: [{ note: 'implement' }] },
    decision,
    requiredChecks,
    verdict: { sha: HEAD, verdict: 'approve', reviewer: 'factory-review' },
    human: { commentOnly: 0 },
    labels: [],
    changes: classifyChanges([{ path: 'docs/a.md', status: 'M', oldMode: '100644', newMode: '100644', added: 1, deleted: 0 }], all),
});
describe('auto-merge and checks that did not succeed', () => {
    it('all SUCCESS: eligible, with and without required checks', () => {
        const list = [{ name: 'Test', state: 'SUCCESS' }, { name: 'Lint', state: 'SUCCESS' }];
        expect(verdict(decide(list))).toMatchObject({ ok: true, tier: 'docs' });
        expect(verdict(decide(list, { requiredChecks: ['Test'] }), ['Test'])).toMatchObject({ ok: true, tier: 'docs' });
    });
    it('a known-flaky FAILURE without required checks leaves the merge to a human, naming the check', () => {
        const d = decide([{ name: 'Lint', state: 'SUCCESS' }, { name: 'Test', state: 'FAILURE', link: job(1) }]);
        const v = verdict(d);
        expect(v.ok).toBe(false);
        expect(v.reasons.join('\n')).toMatch(/Test \(FAILURE, known-flaky\)/);
    });
    it('a known-flaky FAILURE with required checks leaves the merge to a human, naming the check', () => {
        const d = decide([{ name: 'Lint', state: 'SUCCESS' }, { name: 'Test', state: 'FAILURE', link: job(1) }], { requiredChecks: ['Lint'] });
        const v = verdict(d, ['Lint']);
        expect(v.ok).toBe(false);
        expect(v.reasons.join('\n')).toMatch(/Test \(FAILURE, known-flaky\)/);
    });
    it('even if the merge rule allowed the head, a check that did not succeed keeps the merge human (fail closed)', () => {
        // Defence in depth: auto-merge does not lean on the gate verdict alone.
        const d = decide([{ name: 'Lint', state: 'SUCCESS' }, { name: 'Test', state: 'FAILURE', link: job(1) }], { requiredChecks: ['Lint'] });
        const v = verdict({ ...d, ok: true, reasons: [] }, ['Lint']);
        expect(v.ok).toBe(false);
        expect(v.reasons.join('\n')).toMatch(/did not succeed on this head: Test \(FAILURE, known-flaky\)/);
        // An older decision without the check states fails closed too.
        const { blocking: _, ...old } = d;
        expect(verdict({ ...old, ok: true, reasons: [] }, ['Lint']).reasons.join('\n')).toMatch(/check states on this head were not read/);
    });
    it.each(['ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'IN_PROGRESS'])('a raw %s never auto-merges, with or without required checks', (state) => {
        const list = [{ name: 'Lint', state: 'SUCCESS' }, { name: 'Build', state }];
        expect(verdict(decide(list)).ok).toBe(false);
        const d = decide(list, { requiredChecks: ['Lint'] });
        const v = verdict({ ...d, ok: true, reasons: [] }, ['Lint']);
        expect(v.ok).toBe(false);
        expect(v.reasons.join('\n')).toContain(`Build (${state})`);
    });
    it('a failing or skipped check in ship.advisoryChecks is ignored: still eligible', () => {
        const list = [{ name: 'Test', state: 'SUCCESS' }, { name: 'No Committed Build Artifacts', state: 'FAILURE' }, { name: 'Preview', state: 'SKIPPED' }];
        const advisoryChecks = ['No Committed Build Artifacts', 'Preview'];
        expect(verdict(decide(list, { advisoryChecks }))).toMatchObject({ ok: true, tier: 'docs' });
        expect(verdict(decide(list, { advisoryChecks, requiredChecks: ['Test'] }), ['Test'])).toMatchObject({ ok: true, tier: 'docs' });
    });
    it('a check name is sanitised in the reason: one line, no backticks, capped', () => {
        const name = `Evil\`name\n@team ${'x'.repeat(300)}`;
        const d = decide([{ name: 'Lint', state: 'SUCCESS' }, { name, state: 'CANCELLED' }], { requiredChecks: ['Lint'] });
        const line = verdict({ ...d, ok: true, reasons: [] }, ['Lint']).reasons.find((r) => r.includes('did not succeed'));
        expect(line).not.toMatch(/[`\n]/);
        expect(line.length).toBeLessThan(260);
        expect(line).toContain('Evil');
    });
    it('duplicate check names (one SUCCESS, one FAILURE, same name) leave the merge to a human, in either order', () => {
        for (const list of [[{ name: 'Test', state: 'SUCCESS' }, { name: 'Test', state: 'FAILURE' }], [{ name: 'Test', state: 'FAILURE' }, { name: 'Test', state: 'SUCCESS' }]]) {
            expect(verdict(decide(list)).ok, JSON.stringify(list)).toBe(false);
            const d = decide(list, { requiredChecks: ['Test'] });
            expect(verdict(d, ['Test']).ok, JSON.stringify(list)).toBe(false);
            // Even when the merge rule allowed the head, the FAILURE entry blocks.
            const v = verdict({ ...d, ok: true, reasons: [] }, ['Test']);
            expect(v.ok).toBe(false);
            expect(v.reasons.join('\n')).toContain('Test (FAILURE');
        }
    });
    it('a check name loses format characters (bidi, zero-width) and its "@" cannot mention anyone', () => {
        const name = ['Te', String.fromCharCode(0x202e), 'st', String.fromCharCode(0x200b), ' @org/team ', String.fromCharCode(0x2066), 'x', String.fromCharCode(0x2069)].join('');
        const d = decide([{ name: 'Lint', state: 'SUCCESS' }, { name, state: 'CANCELLED' }], { requiredChecks: ['Lint'] });
        const line = verdict({ ...d, ok: true, reasons: [] }, ['Lint']).reasons.find((r) => r.includes('did not succeed'));
        expect(line).not.toMatch(/\p{Cf}/u);
        expect(line).not.toContain('@');
        expect(line).toContain('Test ＠org/team x (CANCELLED)');
    });
});
//# sourceMappingURL=auto-merge-flaky.test.js.map