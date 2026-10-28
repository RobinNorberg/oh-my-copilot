/**
 * The `factory-run` / `factory-run-fix` tier 2 wiring with no Copilot: the
 * factory run tests' fake lanes (a real git worktree per lane), real git with
 * the scenario's bare remote, and the scenario's own scripted gh.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitFile, FakeLanes, FakeProcesses, gitIn, verdictBlock } from '../../factory/run/__tests__/fake-lanes.js';
import { FIX_REVIEW_INSTRUCTION, runFactoryRunScenario, scriptedFactoryGh } from '../copilot-factory-run-scenario.js';
import { ALL_SCENARIOS, DEFAULT_SCENARIOS, evaluateScenario, FACTORY_RUN_FILE, FACTORY_RUN_MAX_CREDITS, FACTORY_RUN_PR, KNOWN_SCENARIOS, OPT_IN_SCENARIOS, scenarioCheckIds, } from '../copilot-sdk-scenarios.js';
import { LIVE_PROCESS_SCENARIOS_REFUSED_DETAIL, liveRunRefusal } from '../copilot-smoke.js';
let dir;
let lanes;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-smoke-factory-'));
    lanes = undefined;
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
const approve = (ctx) => ({ finalText: verdictBlock('approve', ctx.baseSha), credits: 0.5 });
const requestChanges = (ctx) => ({
    finalText: verdictBlock('request-changes', ctx.baseSha, [{ severity: 'major', file: FACTORY_RUN_FILE, summary: 'add a second line containing exactly: reviewed' }]),
    credits: 0.5,
});
async function run(name, scripts) {
    const projectDir = join(dir, 'project');
    const result = await runFactoryRunScenario({
        name, root: dir, bin: 'copilot', env: {}, projectDir, home: join(dir, 'home'), timeoutMs: 1_000, maxCredits: 30, budget: 30,
        eventsPath: join(dir, `events-${name}.jsonl`), spawnSync: (() => { throw new Error('no spawnSync'); }),
        lanes: (repo) => { lanes = new FakeLanes(repo, scripts); return lanes; },
        engine: { pollMs: 5, processes: new FakeProcesses(), sleep: async () => { } },
    });
    const { wedged: _wedged, ...scenarioRun } = result;
    return { result, checks: Object.fromEntries(evaluateScenario({ ...scenarioRun, logText: '' }).checks.map((c) => [c.id, c])) };
}
describe('factory-run scenario', () => {
    it('implement + approve parks at awaiting-human: merge with the command printed, a draft PR, and no merge', async () => {
        const { result, checks } = await run('factory-run', [commitFile(FACTORY_RUN_FILE, 'hi\n', 1), approve]);
        for (const id of scenarioCheckIds('factory-run'))
            expect(checks[id], `${id}: ${checks[id]?.detail}`).toMatchObject({ ok: true });
        expect(result.factory.outcome.mergeCommand).toMatch(new RegExp(`^gh pr merge ${FACTORY_RUN_PR} `));
        expect(result.factory.gh.mergeCalls).toEqual([]);
        expect(result.factory.cost.credits).toBe(1.5);
        // Every lane started at the runtime minimum, the first review without the fix instruction.
        expect(lanes.started.map((s) => s.maxCredits)).toEqual([30, 30]);
        expect(lanes.started.some((s) => s.prompt.includes(FIX_REVIEW_INSTRUCTION))).toBe(false);
    });
    it('a review lane that changes shared git state fails the tamper and park checks', async () => {
        const tamper = (ctx) => {
            gitIn(ctx.root, 'branch', 'smuggled', ctx.baseSha);
            return approve(ctx);
        };
        const { checks } = await run('factory-run', [commitFile(FACTORY_RUN_FILE, 'hi\n', 1), tamper]);
        expect(checks['scn.factory-run.tamper'].ok).toBe(false);
        expect(checks['scn.factory-run.parked'].ok).toBe(false);
        expect(checks['scn.factory-run.exit'].ok).toBe(false);
        expect(checks['scn.factory-run.no_merge'].ok).toBe(true);
    });
    it('credits above the ceiling fail scn.factory-run.credits', async () => {
        const { checks } = await run('factory-run', [commitFile(FACTORY_RUN_FILE, 'hi\n', FACTORY_RUN_MAX_CREDITS['factory-run']), approve]);
        expect(checks['scn.factory-run.credits']).toMatchObject({ ok: false });
        expect(checks['scn.factory-run.parked'].ok).toBe(true);
    });
});
describe('factory-run-fix scenario', () => {
    it('the first review requests changes (operator instruction on its prompt only), a fix round runs and a new review approves', async () => {
        const { result, checks } = await run('factory-run-fix', [
            commitFile(FACTORY_RUN_FILE, 'hi\n', 1),
            requestChanges,
            commitFile(FACTORY_RUN_FILE, 'hi\nreviewed\n', 1),
            approve,
        ]);
        for (const id of scenarioCheckIds('factory-run-fix'))
            expect(checks[id], `${id}: ${checks[id]?.detail}`).toMatchObject({ ok: true });
        expect(result.factory.lanes.map((l) => l.kind)).toEqual(['implement', 'review', 'fix', 'review']);
        const reviews = lanes.started.filter((s) => s.profile === 'review');
        expect(reviews.map((s) => s.prompt.includes(FIX_REVIEW_INSTRUCTION))).toEqual([true, false]);
    });
    it('an approve on the first review is not the fix loop', async () => {
        const { checks } = await run('factory-run-fix', [commitFile(FACTORY_RUN_FILE, 'hi\n', 1), approve]);
        expect(checks['scn.factory-run-fix.lanes'].ok).toBe(false);
        expect(checks['scn.factory-run-fix.parked'].ok).toBe(true);
    });
});
describe('scripted gh', () => {
    it('refuses and records gh pr merge, and refuses anything unscripted', () => {
        const { exec, record } = scriptedFactoryGh(join(dir, 'none.git'));
        expect(exec('gh', ['pr', 'merge', String(FACTORY_RUN_PR), '--admin', '--merge']).status).toBe(1);
        expect(exec('gh', ['api', `repos/o/r/pulls/${FACTORY_RUN_PR}/merge`, '-X', 'PUT']).status).toBe(1);
        expect(record.mergeCalls).toHaveLength(2);
        expect(exec('gh', ['repo', 'delete']).status).toBe(1);
        expect(exec('curl', ['https://example.invalid']).status).toBe(1);
    });
});
describe('registry', () => {
    it('both variants are opt-in only: known, never in all or the default', () => {
        for (const name of ['factory-run', 'factory-run-fix']) {
            expect(KNOWN_SCENARIOS).toContain(name);
            expect(OPT_IN_SCENARIOS).toContain(name);
            expect(ALL_SCENARIOS).not.toContain(name);
            expect(DEFAULT_SCENARIOS).not.toContain(name);
            expect(scenarioCheckIds(name).slice(-3)).toEqual([`scn.${name}.exit`, `scn.${name}.adapter_errors`, `scn.${name}.cost`]);
        }
    });
    it('no evidence fails every own check', () => {
        const run = { name: 'factory-run', events: [], idle: false, timedOut: false, timeoutMs: 1, logText: null, model: 'm', maxCredits: 30, error: 'boom' };
        const own = evaluateScenario(run).checks.slice(0, 11);
        expect(own.map((c) => c.id)).toEqual(scenarioCheckIds('factory-run').slice(0, 11));
        expect(own.every((c) => !c.ok)).toBe(true);
    });
    it('the no-billing guard refuses the factory run scenarios without an injected runFactory', () => {
        const test = { VITEST: 'true' };
        const loadSdk = async () => null;
        expect(liveRunRefusal(2, ['factory-run'], { loadSdk }, test)).toBe(`${LIVE_PROCESS_SCENARIOS_REFUSED_DETAIL}: factory-run`);
        expect(liveRunRefusal(2, ['factory-run-fix'], { loadSdk, runFactory: async () => { throw new Error('fake'); } }, test)).toBeNull();
    });
});
//# sourceMappingURL=copilot-factory-run-scenario.test.js.map