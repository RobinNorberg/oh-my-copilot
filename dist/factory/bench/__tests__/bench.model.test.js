/**
 * The explicit lane model: factory.run.laneModel (budget.ts), `omg factory
 * bench run --model` through the live runner (an injected run child and
 * model probe, no Copilot), the probe's explicit-model read (a fake SDK
 * client, no session), and the results / compare recording.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLaneModel, resolveFactoryRunLimits } from '../../run/budget.js';
import { createBenchFixture, removeBenchDir } from '../fixture.js';
import { multiplierRefusal, probeLaneModel } from '../model-probe.js';
import { BenchUsageError, runBench } from '../runner.js';
import { BENCH_RESULTS_KIND, BENCH_RESULTS_SCHEMA_VERSION, compareResults, computeTotals, laneModelMismatches, modelLabel, readBenchResults, renderResultsMarkdown } from '../score.js';
const NODE_MODULES = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'node_modules');
let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-bench-m-'));
    vi.stubEnv('OMC_HOME', join(dir, 'omc-home'));
    vi.stubEnv('OMC_STATE_DIR', '');
});
afterEach(() => {
    vi.unstubAllEnvs();
    removeBenchDir(dir);
});
describe('factory.run.laneModel (budget.ts)', () => {
    it('reads a known id from the trusted user config, refuses an unknown or ill-typed one, and ignores the project config with a warning', () => {
        expect(resolveFactoryRunLimits(undefined, undefined).limits.laneModel).toBeUndefined();
        expect(resolveFactoryRunLimits({ factory: { run: { laneModel: 'mai-code-2' } } }, undefined).limits.laneModel).toBe('mai-code-2');
        expect(() => resolveFactoryRunLimits({ factory: { run: { laneModel: 'gpt-nope' } } }, undefined)).toThrow(/factory\.run\.laneModel "gpt-nope" is not a known Copilot model id; known ids: .*mai-code-2/);
        expect(() => resolveFactoryRunLimits({ factory: { run: { laneModel: 3 } } }, undefined)).toThrow(/must be a Copilot model id/);
        const fromProject = resolveFactoryRunLimits(undefined, { factory: { run: { laneModel: 'mai-code-2' } } });
        expect(fromProject.limits.laneModel).toBeUndefined();
        expect(fromProject.warnings.join('\n')).toMatch(/ignoring factory\.run\.laneModel from the working-tree project config/);
        expect(checkLaneModel(' mai-code-2 ', '--model')).toBe('mai-code-2');
    });
});
describe('the model probe with an explicit model', () => {
    class FakeClient {
        static calls = [];
        async start() { FakeClient.calls.push('start'); }
        async stop() { FakeClient.calls.push('stop'); return []; }
        async listModels() { return [{ id: 'mai-code-2', billing: { multiplier: 1 } }, { id: 'claude-opus-5.5', billing: { multiplier: 10 } }, { id: 'no-billing' }]; }
        async createSession() { FakeClient.calls.push('createSession'); throw new Error('no session for an explicit model'); }
        async deleteSession() { }
        async getStatus() { return {}; }
    }
    const loaded = { module: { CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } }, version: '1.0.16', from: 'test' };
    const deps = () => ({ env: { PATH: process.env.PATH }, platform: 'linux', loadSdk: async () => loaded, resolveBin: () => '/bin/copilot', userConfigDir: () => join(dir, 'no-user'), killTree: () => { throw new Error('unexpected tree kill'); } });
    it('reads that id\'s multiplier and the offered ids from listModels(), makes no session, and stops the runtime', async () => {
        FakeClient.calls = [];
        const info = await probeLaneModel(join(dir, 'probe'), deps(), 'mai-code-2');
        expect(info).toEqual({ model: 'mai-code-2', multiplier: 1, explicit: true, offered: ['mai-code-2', 'claude-opus-5.5', 'no-billing'], detail: 'listModels() billing.multiplier of mai-code-2' });
        expect(FakeClient.calls).toEqual(['start', 'stop']);
        expect(existsSync(join(dir, 'probe'))).toBe(false);
        expect(await probeLaneModel(join(dir, 'probe'), deps(), 'claude-opus-5.5')).toMatchObject({ model: 'claude-opus-5.5', multiplier: 10 });
        expect(await probeLaneModel(join(dir, 'probe'), deps(), 'gpt-6-luna')).toMatchObject({ model: 'gpt-6-luna', multiplier: null, detail: 'listModels() does not offer gpt-6-luna' });
        // Unreadable: explicit, without offered (the runner refuses).
        const none = await probeLaneModel(join(dir, 'probe'), { ...deps(), loadSdk: async () => null }, 'mai-code-2');
        expect(none).toMatchObject({ model: 'mai-code-2', multiplier: null, explicit: true });
        expect(none.offered).toBeUndefined();
    });
    it('multiplierRefusal checks the explicit model: offered, then its multiplier', () => {
        const offered = ['mai-code-2', 'claude-opus-5.5'];
        expect(multiplierRefusal({ model: 'mai-code-2', multiplier: 1, detail: '', explicit: true, offered }, undefined)).toBeNull();
        expect(multiplierRefusal({ model: 'gpt-6-luna', multiplier: null, detail: '', explicit: true, offered }, 100)).toBe('--model gpt-6-luna is not offered to your account by Copilot; listModels() offers: mai-code-2, claude-opus-5.5');
        expect(multiplierRefusal({ model: 'claude-opus-5.5', multiplier: 10, detail: '', explicit: true, offered }, undefined)).toMatch(/claude-opus-5\.5 \(--model\) bills 10x .*--allow-multiplier 10 .*cheaper --model/);
        expect(multiplierRefusal({ model: 'claude-opus-5.5', multiplier: 10, detail: '', explicit: true, offered }, 10)).toBeNull();
        expect(multiplierRefusal({ model: 'mai-code-2', multiplier: null, detail: 'no billing', explicit: true, offered }, undefined)).toMatch(/mai-code-2 has no known premium multiplier \(no billing\)/);
        expect(multiplierRefusal({ model: 'mai-code-2', multiplier: null, detail: 'no billing', explicit: true, offered }, 1)).toBeNull();
        expect(multiplierRefusal({ model: 'mai-code-2', multiplier: null, detail: 'sdk missing', explicit: true }, 5)).toMatch(/could not be checked against your account's models \(sdk missing\)/);
    });
});
describe('omg factory bench run --model (live runner, injected child and probe)', () => {
    const fixture = () => {
        const bench = join(dir, 'b');
        createBenchFixture(bench, { nodeModules: NODE_MODULES });
        return bench;
    };
    const explicitProbe = (offered, multiplier = 1) => async (m) => ({ model: m ?? null, multiplier, detail: `listModels() billing.multiplier of ${m}`, explicit: true, offered });
    it('passes --model to each run child, checks THAT model, and records it in the results and the compare header', async () => {
        const bench = fixture();
        const args = [];
        const probed = [];
        const lines = [];
        const out = await runBench({
            dir: bench, mode: 'live', model: 'mai-code-2', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }),
            modelProbe: async (m) => { probed.push(m); return explicitProbe(['mai-code-2', 'claude-opus-5.5'])(m); },
            announce: (m) => lines.push(m),
            liveStart: async (o) => { args.push([...(o.args ?? [])]); return { exitCode: 4, parsed: true, next: null, message: 'merge' }; },
        });
        expect(probed).toEqual(['mai-code-2']);
        expect(args).toEqual([['--max-requests', '10', '--model', 'mai-code-2']]);
        expect(lines[0]).toBe('lanes\' Copilot model (--model): mai-code-2; premium multiplier: 1 (listModels() billing.multiplier of mai-code-2)');
        expect(out.results.model).toEqual({ id: 'mai-code-2', multiplier: 1, explicit: true, source: '--model' });
        const read = readBenchResults(out.jsonPath);
        expect(read.model).toEqual({ id: 'mai-code-2', multiplier: 1, explicit: true, source: '--model' });
        const text = compareResults(read, { ...read, model: { id: 'claude-sonnet-5.5', multiplier: 1, explicit: false } });
        expect(text).toContain('lane model mai-code-2 (--model, 1x))');
        expect(text).toContain('lane model default claude-sonnet-5.5 (1x))');
        expect(text).toContain('Note: the lane models differ');
    });
    it('refuses before any child when the account does not offer the id (listing the offered ids), the id is unknown, or the probe ignored it', async () => {
        const bench = fixture();
        const start = vi.fn(async () => ({ exitCode: 4, parsed: true, next: null, message: 'merge' }));
        const base = { dir: bench, mode: 'live', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }), liveStart: start, announce: () => { } };
        await expect(runBench({ ...base, model: 'mai-code-2', modelProbe: explicitProbe(['claude-opus-5.5', 'gpt-6-luna']) })).rejects.toThrow('--model mai-code-2 is not offered to your account by Copilot; listModels() offers: claude-opus-5.5, gpt-6-luna');
        await expect(runBench({ ...base, model: 'mai-code-2', modelProbe: explicitProbe(['mai-code-2'], 3) })).rejects.toThrow(/bills 3x .*--allow-multiplier 3/);
        await expect(runBench({ ...base, model: 'gpt-nope', modelProbe: explicitProbe(['gpt-nope']) })).rejects.toThrow(BenchUsageError);
        await expect(runBench({ ...base, model: 'mai-code-2', modelProbe: async () => ({ model: 'default-model', multiplier: 1, detail: 'x' }) })).rejects.toThrow(/did not check --model mai-code-2 \(it reported default-model\)/);
        expect(start).not.toHaveBeenCalled();
    });
    it('without --model the probe is asked for the default and the child gets no --model', async () => {
        const bench = fixture();
        const args = [];
        const probed = [];
        const out = await runBench({
            dir: bench, mode: 'live', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }), announce: () => { },
            modelProbe: async (m) => { probed.push(m); return { model: 'test-model', multiplier: 1, detail: 'test' }; },
            liveStart: async (o) => { args.push([...(o.args ?? [])]); return { exitCode: 4, parsed: true, next: null, message: 'merge' }; },
        });
        expect(probed).toEqual([undefined]);
        expect(args).toEqual([['--max-requests', '10']]);
        expect(out.results.model).toEqual({ id: 'test-model', multiplier: 1, explicit: false });
    });
    it('without --model takes the trusted user config\'s factory.run.laneModel: probes it, passes it to each child, records source user config', async () => {
        const bench = fixture();
        const args = [];
        const probed = [];
        const lines = [];
        const out = await runBench({
            dir: bench, mode: 'live', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: { factory: { run: { laneModel: 'claude-opus-5.5' } } }, ledger: () => ({ premiumRequests: 0, credits: 0 }),
            modelProbe: async (m) => { probed.push(m); return explicitProbe(['claude-opus-5.5'])(m); },
            announce: (m) => lines.push(m),
            liveStart: async (o) => { args.push([...(o.args ?? [])]); return { exitCode: 4, parsed: true, next: null, message: 'merge' }; },
        });
        expect(probed).toEqual(['claude-opus-5.5']);
        expect(args).toEqual([['--max-requests', '10', '--model', 'claude-opus-5.5']]);
        expect(lines[0]).toMatch(/^lanes' Copilot model \(factory\.run\.laneModel\): claude-opus-5\.5;/);
        expect(out.results.model).toEqual({ id: 'claude-opus-5.5', multiplier: 1, explicit: true, source: 'user config' });
        expect(readBenchResults(out.jsonPath).model).toEqual({ id: 'claude-opus-5.5', multiplier: 1, explicit: true, source: 'user config' });
        expect(modelLabel(out.results.model)).toBe('claude-opus-5.5 (user config, 1x)');
    });
    it('--model wins over the user config; an unknown user-config laneModel is refused before any child', async () => {
        const bench = fixture();
        const args = [];
        const probed = [];
        const base = { dir: bench, mode: 'live', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), ledger: () => ({ premiumRequests: 0, credits: 0 }), announce: () => { } };
        const out = await runBench({
            ...base, model: 'mai-code-2', trustedUser: { factory: { run: { laneModel: 'claude-opus-5.5' } } },
            modelProbe: async (m) => { probed.push(m); return explicitProbe(['mai-code-2'])(m); },
            liveStart: async (o) => { args.push([...(o.args ?? [])]); return { exitCode: 4, parsed: true, next: null, message: 'merge' }; },
        });
        expect(probed).toEqual(['mai-code-2']);
        expect(args).toEqual([['--max-requests', '10', '--model', 'mai-code-2']]);
        expect(out.results.model).toMatchObject({ id: 'mai-code-2', source: '--model' });
        const start = vi.fn(async () => ({ exitCode: 4, parsed: true, next: null, message: 'merge' }));
        await expect(runBench({ ...base, trustedUser: { factory: { run: { laneModel: 'gpt-nope' } } }, modelProbe: explicitProbe(['gpt-nope']), liveStart: start })).rejects.toThrow(/user config: factory\.run\.laneModel "gpt-nope" is not a known Copilot model id/);
        await expect(runBench({ ...base, trustedUser: { factory: { run: { laneModel: 'claude-opus-5.5' } } }, modelProbe: async () => ({ model: 'default-model', multiplier: 1, detail: 'x' }), liveStart: start })).rejects.toThrow(/did not check factory\.run\.laneModel claude-opus-5\.5/);
        expect(start).not.toHaveBeenCalled();
    });
    it('the fake path runs every lane on the user config\'s laneModel', async () => {
        const bench = fixture();
        const out = await runBench({ dir: bench, mode: 'fake', issues: [1], outDir: join(dir, 'out'), trustedUser: { factory: { run: { laneModel: 'claude-opus-5.5' } } } });
        expect(out.results.model).toEqual({ id: 'claude-opus-5.5', multiplier: null, explicit: true, source: 'user config' });
        const lanes = out.results.issues.flatMap((i) => i.lanes);
        expect(lanes.length).toBeGreaterThan(0);
        expect(lanes.every((l) => l.model === 'claude-opus-5.5')).toBe(true);
        expect(out.results.notes.filter((n) => n.includes('the session reported'))).toEqual([]);
    });
});
describe('lane model mismatches', () => {
    it('lists each lane whose session reported another model than the bench asked for', () => {
        const lane = (id, model) => ({ id, kind: 'implement', premiumRequests: 1, credits: 0, source: 'none', ...(model ? { model } : {}) });
        const issues = [
            { id: 1, lanes: [lane('r1-implement-1', 'mai-code-2'), lane('r1-review-1', 'gpt-5.5-mini')] },
            { id: 2, lanes: [lane('r2-implement-1')] },
        ];
        expect(laneModelMismatches(issues, 'mai-code-2')).toEqual(['#1 lane r1-review-1: asked for model mai-code-2, the session reported gpt-5.5-mini']);
    });
});
describe('results recording', () => {
    const results = (over = {}) => ({
        schemaVersion: BENCH_RESULTS_SCHEMA_VERSION, kind: BENCH_RESULTS_KIND, mode: 'fake', omgVersion: 'x', fixtureVersion: 1, startedAt: '2026-11-12T00:00:00.000Z', finishedAt: '2026-11-12T00:10:00.000Z',
        caps: { maxRequests: null, maxCredits: null, maxMinutes: 240, parallel: 1 }, subset: null, stopped: null, ledger: null, notes: [], issues: [], totals: computeTotals([]), ...over,
    });
    it('labels the model (absent and null read as the default) and puts it in the markdown header', () => {
        expect(modelLabel(undefined)).toBe('default');
        expect(modelLabel(null)).toBe('default');
        expect(modelLabel({ id: null, multiplier: null, explicit: false })).toBe('default');
        expect(modelLabel({ id: 'mai-code-2', multiplier: null, explicit: true })).toBe('mai-code-2 (--model)');
        expect(renderResultsMarkdown(results({ model: { id: 'mai-code-2', multiplier: 1, explicit: true } }))).toContain('fixture v1; lane model mai-code-2 (--model, 1x)');
        // Results written before the field existed still compare.
        expect(compareResults(results(), results())).toContain('lane model default)');
    });
    it('readBenchResults refuses an ill-typed model', () => {
        const path = join(dir, 'bad.json');
        writeFileSync(path, JSON.stringify(results({ model: { id: 3, multiplier: 'x', explicit: true } })));
        expect(() => readBenchResults(path)).toThrow(/model is neither null nor \{ id, multiplier, explicit \}/);
        writeFileSync(path, JSON.stringify(results({ model: null })));
        expect(readBenchResults(path).model).toBeNull();
    });
});
//# sourceMappingURL=bench.model.test.js.map