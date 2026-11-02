import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, noCommit, PR, remoteHead, review } from './fake-lanes.js';
import { h, useEngineHarness, limits, run } from './engine-harness.js';
useEngineHarness();
describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
    describe('two-axis review', () => {
        const withStandards = () => {
            mkdirSync(join(h.root, 'docs', 'standards'));
            writeFileSync(join(h.root, 'docs', 'standards', 'code.md'), '# Code\n\nNo default exports.\n');
            gitIn(h.root, 'add', '.');
            gitIn(h.root, 'commit', '-q', '-m', 'standards');
            gitIn(h.root, 'push', '-q', 'origin', 'dev');
        };
        it('no docs/standards/ on the base: the single-axis prompt', async () => {
            const { lanes, done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
            expect((await done).gate?.name).toBe('merge');
            expect(lanes.started[1].prompt).toContain('against the plan. Diff first');
            expect(lanes.started[1].prompt).not.toContain('axis');
        });
        it('docs/standards/ on the base: both axes, and a standards-axis blocker fails an approve', async () => {
            withStandards();
            const finding = { severity: 'blocker', axis: 'standards', summary: 'default export', file: 'src/greet.ts' };
            const { lanes, done } = run([commitFile('src/greet.ts', 'export default 1;\n'), review('approve', [finding])], { limits: limits({ maxFixRounds: 0 }) });
            const out = await done;
            expect(out.gate?.name).toBe('fix-rounds-spent');
            expect(lanes.started[1].prompt).toContain('on two axes');
            expect(lanes.started[1].prompt).toContain('- docs/standards/code.md');
            const state = readFactoryState(h.root, ISSUE);
            expect(state.lanes[1].verdict).toBe('changes-requested');
            expect(state.findings).toEqual([finding]);
            expect(readShipState(h.root, PR).verdicts[0].verdict).toBe('changes-requested');
        });
        it('docs/standards/ on the base: a finding without an axis is an invalid review', async () => {
            withStandards();
            const { done } = run([commitFile('src/greet.ts', 'x\n'), review('approve', [{ severity: 'nit', summary: 'no axis' }]), review('approve', [{ severity: 'nit', summary: 'no axis' }])]);
            const out = await done;
            expect(out.gate?.name).toBe('review-invalid');
            expect(readFactoryState(h.root, ISSUE).lanes[1]).toMatchObject({ verdict: 'invalid', note: expect.stringContaining('axis is not one of spec, standards') });
        });
    });
    it('no Acceptance criteria and no omg-plan link parks at needs-plan without a lane', async () => {
        h.gh.issue.body = 'please add greet';
        const { lanes, done } = run([]);
        const out = await done;
        expect(out.gate?.name).toBe('needs-plan');
        expect(lanes.started).toHaveLength(0);
    });
    describe('blocked-by intake gate (shipyard ↔ factory design §3.5)', () => {
        const DEP = 3;
        const MERGED_LOOKUP = `gh pr list --head factory/issue-${DEP} --base dev --state merged --json number`;
        /** #3: open unless closed; its factory PR into dev merged when `merged`. */
        const dep = { state: 'OPEN', merged: false };
        const depExec = () => (cmd, args, o) => {
            const key = `${cmd} ${args.join(' ')}`;
            if (key.startsWith(`gh issue view ${DEP} --json`)) {
                h.calls.push(key);
                return { status: 0, stdout: JSON.stringify({ title: 'A', body: '', state: dep.state, labels: [], comments: [], url: `https://github.com/o/r/issues/${DEP}` }), stderr: '' };
            }
            if (key === MERGED_LOOKUP) {
                h.calls.push(key);
                return { status: 0, stdout: JSON.stringify(dep.merged ? [{ number: 90 }] : []), stderr: '' };
            }
            return h.exec(cmd, args, o);
        };
        beforeEach(() => {
            dep.state = 'OPEN';
            dep.merged = false;
            h.gh.issue.body = `Blocked by #${DEP}\n\n## Acceptance criteria\n\n- greet() returns hi\n`;
        });
        it('B with an open A parks at blocked-by naming A, without a lane; a rerun proceeds once A\'s factory PR merged (A still open)', async () => {
            const first = await run([], { exec: depExec() }).done;
            expect(first.exitCode).toBe(EXIT_AWAITING_HUMAN);
            expect(first.gate?.name).toBe('blocked-by');
            expect(first.gate?.reason).toContain(`#${DEP}`);
            expect(first.phase).toBe('intake');
            expect(h.calls).toContain(MERGED_LOOKUP);
            expect(h.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
            expect(readFactoryState(h.root, ISSUE)).toMatchObject({ phase: 'intake', gate: { name: 'blocked-by' } });
            // Still unsatisfied: the rerun parks again, still no lane.
            const again = await run([], { exec: depExec() }).done;
            expect(again.gate?.name).toBe('blocked-by');
            dep.merged = true;
            const { lanes, done } = run([commitFile('a.ts'), review('approve')], { exec: depExec() });
            const out = await done;
            expect(out.exitCode, out.message).toBe(0);
            expect(out.gate?.name).toBe('merge');
            expect(lanes.started).toHaveLength(2);
        });
        it('a self-dependency parks at blocked-by naming blocked-by:self, without reading any dependency', async () => {
            h.gh.issue.body = `Blocked by #${ISSUE}\n\n## Acceptance criteria\n\n- greet() returns hi\n`;
            const out = await run([], { exec: depExec() }).done;
            expect(out.gate?.name).toBe('blocked-by');
            expect(out.gate?.reason).toContain('blocked-by:self');
            expect(h.calls.some((c) => c.includes(`factory/issue-${ISSUE} --base`))).toBe(false);
        });
        it('a closed dependency is satisfied: the run starts at once', async () => {
            dep.state = 'CLOSED';
            const out = await run([commitFile('a.ts'), review('approve')], { exec: depExec() }).done;
            expect(out.exitCode, out.message).toBe(0);
            expect(out.gate?.name).toBe('merge');
            expect(h.calls).not.toContain(MERGED_LOOKUP);
        });
    });
    it('an omg-plan link (optional) is read from the base branch with its blob sha', async () => {
        h.gh.issue.body = 'see plan';
        h.gh.issue.comments = [{ body: 'omg-plan: docs/plan.md', authorAssociation: 'MEMBER' }];
        const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
        await done;
        const state = readFactoryState(h.root, ISSUE);
        expect(state.plan).toMatchObject({ source: 'link', path: 'docs/plan.md', blob: gitIn(h.root, 'rev-parse', 'origin/dev:docs/plan.md') });
        expect(lanes.started[0].prompt).toContain('Add greet().');
    });
    it('a lane without commits gets one fresh retry, then implement-failed', async () => {
        const { lanes, done } = run([noCommit, noCommit]);
        const out = await done;
        expect(out.gate?.name).toBe('implement-failed');
        expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ISSUE}-implement-1`, `issue-${ISSUE}-implement-2`]);
        expect(remoteHead(h)).toBeNull();
    });
    it('a lane writing a merge-rule path parks at protected-paths and pushes nothing', async () => {
        const { done } = run([commitFile('.github/workflows/ci.yml', 'on: push\n')]);
        const out = await done;
        expect(out.gate?.name).toBe('protected-paths');
        expect(remoteHead(h)).toBeNull();
        expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
    });
    it('a completed write lane without a change summary parks at protected-paths and commits nothing', async () => {
        const { done } = run([(ctx) => { commitFile('.github/workflows/ci.yml', 'on: push\n')(ctx); return { noChanges: true }; }]);
        const out = await done;
        expect(out.gate?.name).toBe('protected-paths');
        expect(out.gate?.reason).toMatch(/no change summary/);
        expect(remoteHead(h)).toBeNull();
        expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
    });
    it.each([
        ['refused', 0, 'sandbox-unavailable: MXC is not available', 'sandbox-unavailable'],
        ['enforced', 1, 'sandbox-escaped: powershell call c1 ran outside the sandbox', 'sandbox-escaped'],
    ])('a write lane whose sandbox is %s parks at %s without a retry or a push', async (mode, unsandboxedCalls, error, gate) => {
        const sandbox = { mode, host: { supported: mode !== 'refused', capabilities: {} }, applied: 'none', canary: 'skipped', unsandboxedCalls, cliVersion: 'x', sdkVersion: 'y' };
        const { lanes, done } = run([() => ({ state: 'failed', error, sandbox })]);
        const out = await done;
        expect(out.gate?.name).toBe(gate);
        expect(out.gate?.reason).toContain(error);
        expect(lanes.started).toHaveLength(1);
        expect(remoteHead(h)).toBeNull();
    });
    it('a review lane that escaped its sandbox parks at sandbox-escaped; its verdict is invalid', async () => {
        const sandbox = { mode: 'enforced', host: { supported: true, capabilities: { shell: true } }, applied: 'options.update', canary: 'skipped', unsandboxedCalls: 1, cliVersion: 'x', sdkVersion: 'y' };
        const { done } = run([commitFile('a.ts'), () => ({ state: 'failed', error: 'sandbox-escaped: bash call c ran outside the sandbox', sandbox })]);
        const out = await done;
        expect(out.gate?.name).toBe('sandbox-escaped');
        expect(readFactoryState(h.root, ISSUE).lanes[1].verdict).toBe('invalid');
    });
});
//# sourceMappingURL=engine.intake.test.js.map