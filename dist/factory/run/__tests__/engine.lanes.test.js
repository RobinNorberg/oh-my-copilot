import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readShipState } from '../../../ship/state.js';
import { runFactoryEngine } from '../engine.js';
import { factoryStatePath, readFactoryState } from '../state.js';
import { commitFile, FakeLanes, gitIn, ISSUE, noCommit, PR, remoteHead, review } from './fake-lanes.js';
import { h, useEngineHarness, limits, opts, run } from './engine-harness.js';
useEngineHarness();
describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
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
    it('maxRunCredits stops at a step boundary with a resumable awaiting-human: budget', async () => {
        const first = run([commitFile('a.ts', 'a\n', 15)], { limits: limits({ maxRunCredits: 40 }) });
        const out = await first.done;
        expect(out.gate?.name).toBe('budget');
        expect(out.gate?.reason).toMatch(/15\.00 of factory\.run\.maxRunCredits 40/);
        expect(readFactoryState(h.root, ISSUE).phase).toBe('review');
        // The owner raises the limit and reruns: the run resumes at review, the lane cap is what is left.
        const second = run([review('approve')], { limits: limits({ maxRunCredits: 50 }) });
        const resumed = await second.done;
        expect(resumed.gate?.name).toBe('merge');
        expect(second.lanes.started[0].maxCredits).toBe(30);
        expect(readFactoryState(h.root, ISSUE).history.some((e) => e.note === 'rerun after awaiting-human: budget')).toBe(true);
    });
    it('lowers a lane cap to what maxRunCredits leaves', async () => {
        const { lanes, done } = run([commitFile('a.ts', 'a\n', 40), review('approve')], { limits: limits({ maxRunCredits: 75, laneMaxCredits: 40 }) });
        const out = await done;
        expect(out.gate?.name).toBe('merge');
        expect(lanes.started.map((s) => s.maxCredits)).toEqual([40, 35]);
    });
    it('refuses to start without a resolved per-lane credit cap at or above the CLI minimum', async () => {
        const lanes = new FakeLanes(h.root, []);
        await expect(runFactoryEngine(opts(lanes, { limits: limits({ laneMaxCredits: 10 }) }))).rejects.toThrow(/below the Copilot CLI minimum of 30/);
        await expect(runFactoryEngine(opts(lanes, { limits: { ...limits(), laneMaxCredits: undefined } }))).rejects.toThrow(/no per-lane AI-credit cap/);
        expect(existsSync(factoryStatePath(h.root, ISSUE))).toBe(false);
    });
    it('an invalid review output gets one fresh retry, then review-invalid; no verdict is recorded', async () => {
        const bad = () => ({ finalText: 'looks fine to me' });
        const { lanes, done } = run([commitFile('a.ts'), bad, bad]);
        const out = await done;
        expect(out.gate?.name).toBe('review-invalid');
        expect(lanes.started.filter((s) => s.profile === 'review')).toHaveLength(2);
        expect(readShipState(h.root, PR).verdicts).toHaveLength(0);
        expect(readFactoryState(h.root, ISSUE).lanes.slice(1).map((l) => l.verdict)).toEqual(['invalid', 'invalid']);
    });
    it.each([
        ['a new ref', (c) => gitIn(c.root, 'branch', 'evil', 'HEAD'), /ref refs\/heads\/evil was created/],
        ['an appended git config line', (c) => appendFileSync(join(c.root, '.git', 'config'), '[alias]\n\tp = push\n'), /common git config changed/],
    ])('a review lane that leaves %s fails as review-tampered and its approve is discarded', async (_name, tamper, problem) => {
        const { done } = run([commitFile('a.ts'), review('approve', [], tamper)]);
        const out = await done;
        expect(out.gate?.name).toBe('review-tampered');
        expect(out.gate?.reason).toMatch(problem);
        expect(readShipState(h.root, PR).verdicts).toHaveLength(0);
        expect(readFactoryState(h.root, ISSUE).lanes[1].verdict).toBe('invalid');
    });
});
//# sourceMappingURL=engine.lanes.test.js.map