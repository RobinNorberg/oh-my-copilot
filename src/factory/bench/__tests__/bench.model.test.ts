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
import { checkLaneModel, laneModelFor, nextLaneCap, resolvedLaneModels, resolveFactoryRunLimits, runCredits, runRequests } from '../../run/budget.js';
import { createBenchFixture, removeBenchDir } from '../fixture.js';
import { multiplierRefusal, probeLaneModel, type BenchModelProbe } from '../model-probe.js';
import { BenchUsageError, runBench } from '../runner.js';
import { BENCH_RESULTS_KIND, BENCH_RESULTS_SCHEMA_VERSION, compareResults, computeTotals, laneModelMismatches, modelLabel, modelsLabel, readBenchResults, renderResultsMarkdown, type BenchResults } from '../score.js';

const NODE_MODULES = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'node_modules');

let dir: string;
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

describe('factory.run.laneModels (budget.ts)', () => {
  it('resolves laneModels[kind] ?? laneModel ?? none per lane kind', () => {
    const { limits } = resolveFactoryRunLimits({ factory: { run: { laneModel: 'mai-code-2', laneModels: { review: 'mai-code-2-flash', conflictFix: 'claude-sonnet-5.5' } } } }, undefined);
    expect(limits.laneModels).toEqual({ review: 'mai-code-2-flash', conflictFix: 'claude-sonnet-5.5' });
    expect(['implement', 'review', 'fix', 'ci-fix', 'conflict-fix'].map((k) => laneModelFor(limits, k as never))).toEqual(['mai-code-2', 'mai-code-2-flash', 'mai-code-2', 'mai-code-2', 'claude-sonnet-5.5']);
    expect(resolvedLaneModels(limits)).toEqual({ implement: 'mai-code-2', review: 'mai-code-2-flash', fix: 'mai-code-2', ciFix: 'mai-code-2', conflictFix: 'claude-sonnet-5.5' });
    expect(resolvedLaneModels({ laneModels: { review: 'mai-code-2-flash' } })).toEqual({ implement: null, review: 'mai-code-2-flash', fix: null, ciFix: null, conflictFix: null });
    expect(laneModelFor({ laneModels: { review: 'mai-code-2-flash' } }, 'implement')).toBeUndefined();
    expect(resolveFactoryRunLimits(undefined, undefined).limits.laneModels).toBeUndefined();
    expect(resolveFactoryRunLimits({ factory: { run: { laneModels: {} } } }, undefined).limits.laneModels).toBeUndefined();
  });

  it('refuses an unknown id, an unknown kind and a non-object; the project config cannot set it', () => {
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneModels: { review: 'gpt-nope' } } } }, undefined)).toThrow(/factory\.run\.laneModels\.review "gpt-nope" is not a known Copilot model id; known ids: .*mai-code-2/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneModels: { 'ci-fix': 'mai-code-2' } } } }, undefined)).toThrow(/laneModels\.ci-fix is not a lane kind; use any of implement, review, fix, ciFix, conflictFix/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneModels: 'mai-code-2' } } }, undefined)).toThrow(/laneModels must be an object/);
    const fromProject = resolveFactoryRunLimits({ factory: { run: { laneModel: 'mai-code-2' } } }, { factory: { run: { laneModels: { implement: 'claude-opus-5.5' } } } });
    expect(fromProject.limits.laneModels).toBeUndefined();
    expect(laneModelFor(fromProject.limits, 'implement')).toBe('mai-code-2');
    expect(fromProject.warnings.join('\n')).toMatch(/ignoring factory\.run\.laneModels from the working-tree project config/);
  });

  it('budget accounting sums each lane\'s own recorded usage, whatever model it ran on', () => {
    const lane = (id: string, model: string, credits: number, premiumRequests: number) => ({ id, kind: 'implement' as const, startSha: 'x', status: 'completed' as const, maxCredits: 30, startedAt: '', model, usage: { credits, premiumRequests, source: 'measured' as const } });
    // An implement lane on a 1x model and two review lanes on a 0.33x model: no run-wide multiplier is applied.
    const state = { lanes: [lane('i', 'mai-code-2', 4, 3), lane('r1', 'mai-code-2-flash', 0.5, 0.33), lane('r2', 'mai-code-2-flash', 0.5, 0.33)] };
    expect(runCredits(state)).toBe(5);
    expect(runRequests(state)).toBeCloseTo(3.66);
    const { limits } = resolveFactoryRunLimits(undefined, undefined);
    expect(nextLaneCap(state, { ...limits, maxRunRequests: 4 })).toMatchObject({ ok: true });
    expect(nextLaneCap(state, { ...limits, maxRunRequests: 3.5 })).toMatchObject({ ok: false });
  });
});

describe('the model probe with an explicit model', () => {
  class FakeClient {
    static calls: string[] = [];
    async start() { FakeClient.calls.push('start'); }
    async stop() { FakeClient.calls.push('stop'); return []; }
    async listModels() { return [{ id: 'mai-code-2', billing: { multiplier: 1 } }, { id: 'claude-opus-5.5', billing: { multiplier: 10 } }, { id: 'no-billing' }]; }
    async createSession() { FakeClient.calls.push('createSession'); throw new Error('no session for an explicit model'); }
    async deleteSession() {}
    async getStatus() { return {}; }
  }
  const loaded = { module: { CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } }, version: '1.0.16', from: 'test' };
  const deps = () => ({ env: { PATH: process.env.PATH }, platform: 'linux' as const, loadSdk: async () => loaded as never, resolveBin: () => '/bin/copilot', userConfigDir: () => join(dir, 'no-user'), killTree: () => { throw new Error('unexpected tree kill'); } });

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
  const explicitProbe = (offered: string[], multiplier: number | null = 1): BenchModelProbe => async (m) => ({ model: m ?? null, multiplier, detail: `listModels() billing.multiplier of ${m}`, explicit: true, offered });

  it('passes --model to each run child, checks THAT model, and records it in the results and the compare header', async () => {
    const bench = fixture();
    const args: string[][] = [];
    const probed: Array<string | undefined> = [];
    const lines: string[] = [];
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
    const base = { dir: bench, mode: 'live' as const, maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }), liveStart: start, announce: () => {} };
    await expect(runBench({ ...base, model: 'mai-code-2', modelProbe: explicitProbe(['claude-opus-5.5', 'gpt-6-luna']) })).rejects.toThrow('--model mai-code-2 is not offered to your account by Copilot; listModels() offers: claude-opus-5.5, gpt-6-luna');
    await expect(runBench({ ...base, model: 'mai-code-2', modelProbe: explicitProbe(['mai-code-2'], 3) })).rejects.toThrow(/bills 3x .*--allow-multiplier 3/);
    await expect(runBench({ ...base, model: 'gpt-nope', modelProbe: explicitProbe(['gpt-nope']) })).rejects.toThrow(BenchUsageError);
    await expect(runBench({ ...base, model: 'mai-code-2', modelProbe: async () => ({ model: 'default-model', multiplier: 1, detail: 'x' }) })).rejects.toThrow(/did not check --model mai-code-2 \(it reported default-model\)/);
    expect(start).not.toHaveBeenCalled();
  });

  it('without --model the probe is asked for the default and the child gets no --model', async () => {
    const bench = fixture();
    const args: string[][] = [];
    const probed: Array<string | undefined> = [];
    const out = await runBench({
      dir: bench, mode: 'live', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }), announce: () => {},
      modelProbe: async (m) => { probed.push(m); return { model: 'test-model', multiplier: 1, detail: 'test' }; },
      liveStart: async (o) => { args.push([...(o.args ?? [])]); return { exitCode: 4, parsed: true, next: null, message: 'merge' }; },
    });
    expect(probed).toEqual([undefined]);
    expect(args).toEqual([['--max-requests', '10']]);
    expect(out.results.model).toEqual({ id: 'test-model', multiplier: 1, explicit: false });
  });

  it('without --model takes the trusted user config\'s factory.run.laneModel: probes it, passes it to each child, records source user config', async () => {
    const bench = fixture();
    const args: string[][] = [];
    const probed: Array<string | undefined> = [];
    const lines: string[] = [];
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
    const args: string[][] = [];
    const probed: Array<string | undefined> = [];
    const base = { dir: bench, mode: 'live' as const, maxRequests: 10, issues: [1], outDir: join(dir, 'out'), ledger: () => ({ premiumRequests: 0, credits: 0 }), announce: () => {} };
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

describe('omg factory bench run --review-model (live runner, injected child and probe)', () => {
  const fixture = () => {
    const bench = join(dir, 'b');
    createBenchFixture(bench, { nodeModules: NODE_MODULES });
    return bench;
  };
  const probeWith = (offered: string[], multipliers: Record<string, number | null> = {}): BenchModelProbe => async (m) => ({ model: m ?? null, multiplier: m && m in multipliers ? multipliers[m] : 1, detail: `listModels() billing.multiplier of ${m}`, explicit: true, offered });
  const merge = { exitCode: 4, parsed: true, next: null, message: 'merge' };

  it('probes every distinct model, passes --review-model to each child, and records the per-kind models in the results, summary and compare header', async () => {
    const bench = fixture();
    const args: string[][] = [];
    const probed: Array<string | undefined> = [];
    const lines: string[] = [];
    const out = await runBench({
      dir: bench, mode: 'live', model: 'mai-code-2', reviewModel: 'mai-code-2-flash', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), ledger: () => ({ premiumRequests: 0, credits: 0 }),
      trustedUser: { factory: { run: { laneModels: { fix: 'mai-code-2', conflictFix: 'claude-sonnet-5.5' } } } },
      modelProbe: async (m) => { probed.push(m); return probeWith(['mai-code-2', 'mai-code-2-flash', 'claude-sonnet-5.5'], { 'mai-code-2-flash': 0.33 })(m); },
      announce: (m) => lines.push(m),
      liveStart: async (o) => { args.push([...(o.args ?? [])]); return merge; },
    });
    // The base model, then each other distinct one once (fix's mai-code-2 is the base, not probed again).
    expect(probed).toEqual(['mai-code-2', 'mai-code-2-flash', 'claude-sonnet-5.5']);
    expect(args).toEqual([['--max-requests', '10', '--model', 'mai-code-2', '--review-model', 'mai-code-2-flash']]);
    expect(lines[1]).toBe("review lanes' Copilot model (--review-model): mai-code-2-flash; premium multiplier: 0.33 (listModels() billing.multiplier of mai-code-2-flash)");
    expect(lines[2]).toMatch(/^conflictFix lanes' Copilot model \(factory\.run\.laneModels\.conflictFix\): claude-sonnet-5\.5;/);
    const expected = { review: { id: 'mai-code-2-flash', multiplier: 0.33, source: '--review-model' }, fix: { id: 'mai-code-2', multiplier: 1, source: 'user config' }, conflictFix: { id: 'claude-sonnet-5.5', multiplier: 1, source: 'user config' } };
    expect(out.results.laneModels).toEqual(expected);
    const read = readBenchResults(out.jsonPath);
    expect(read.laneModels).toEqual(expected);
    const label = 'mai-code-2 (--model, 1x); review mai-code-2-flash (--review-model, 0.33x); fix mai-code-2 (user config, 1x); conflictFix claude-sonnet-5.5 (user config, 1x)';
    expect(modelsLabel(read)).toBe(label);
    expect(renderResultsMarkdown(read)).toContain(`lane model ${label}`);
    const text = compareResults(read, { ...read, laneModels: undefined });
    expect(text).toContain(`lane model ${label})`);
    expect(text).toContain('lane model mai-code-2 (--model, 1x))');
    expect(text).toContain('Note: the lane models differ');
  });

  it('refuses before any child when the review model is not offered (listing the offered ids), unknown, unchecked, or above --allow-multiplier', async () => {
    const bench = fixture();
    const start = vi.fn(async () => merge);
    const base = { dir: bench, mode: 'live' as const, model: 'mai-code-2', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }), liveStart: start, announce: () => {} };
    await expect(runBench({ ...base, reviewModel: 'mai-code-2-flash', modelProbe: probeWith(['mai-code-2', 'gpt-6-luna']) })).rejects.toThrow('--review-model mai-code-2-flash is not offered to your account by Copilot; listModels() offers: mai-code-2, gpt-6-luna');
    await expect(runBench({ ...base, reviewModel: 'claude-opus-5.5', modelProbe: probeWith(['mai-code-2', 'claude-opus-5.5'], { 'claude-opus-5.5': 10 }) })).rejects.toThrow(/claude-opus-5\.5 \(--review-model\) bills 10x .*--allow-multiplier 10 .*cheaper --review-model/);
    await expect(runBench({ ...base, reviewModel: 'gpt-nope', modelProbe: probeWith(['gpt-nope']) })).rejects.toThrow(/--review-model "gpt-nope" is not a known Copilot model id/);
    await expect(runBench({ ...base, reviewModel: 'mai-code-2-flash', modelProbe: async (m) => (m === 'mai-code-2' ? probeWith(['mai-code-2'])(m) : { model: 'default-model', multiplier: 1, detail: 'x' }) })).rejects.toThrow(/did not check --review-model mai-code-2-flash/);
    await expect(runBench({ ...base, trustedUser: { factory: { run: { laneModels: { review: 'gpt-nope' } } } }, modelProbe: probeWith(['mai-code-2']) })).rejects.toThrow(/user config: factory\.run\.laneModels\.review "gpt-nope"/);
    expect(start).not.toHaveBeenCalled();
    // --allow-multiplier is applied per model: the 10x review model passes with 10, while the base stays 1x.
    const out = await runBench({ ...base, reviewModel: 'claude-opus-5.5', allowMultiplier: 10, modelProbe: probeWith(['mai-code-2', 'claude-opus-5.5'], { 'claude-opus-5.5': 10 }) });
    expect(out.results.laneModels).toEqual({ review: { id: 'claude-opus-5.5', multiplier: 10, source: '--review-model' } });
  });

  it('a per-kind model with an unknown multiplier accepted via --allow-multiplier gets the undercount note', async () => {
    const bench = fixture();
    const base = { dir: bench, mode: 'live' as const, model: 'mai-code-2', maxRequests: 10, issues: [1], outDir: join(dir, 'out'), trustedUser: null, ledger: () => ({ premiumRequests: 0, credits: 0 }), liveStart: async () => merge, announce: () => {}, allowMultiplier: 10 };
    const out = await runBench({ ...base, reviewModel: 'mai-code-2-flash', modelProbe: probeWith(['mai-code-2', 'mai-code-2-flash'], { 'mai-code-2-flash': null }) });
    expect(out.results.notes.filter((n) => n.includes('multiplier is unknown'))).toEqual([expect.stringContaining("the review lanes' multiplier is unknown")]);
  });

  it('the fake path starts review lanes on --review-model and the rest on the base model', async () => {
    const bench = fixture();
    const out = await runBench({ dir: bench, mode: 'fake', issues: [1], outDir: join(dir, 'out'), reviewModel: 'mai-code-2-flash', trustedUser: { factory: { run: { laneModel: 'mai-code-2' } } } });
    expect(out.results.laneModels).toEqual({ review: { id: 'mai-code-2-flash', multiplier: null, source: '--review-model' } });
    const lanes = out.results.issues.flatMap((i) => i.lanes);
    expect(lanes.some((l) => l.kind === 'review')).toBe(true);
    expect(lanes.every((l) => l.model === (l.kind === 'review' ? 'mai-code-2-flash' : 'mai-code-2'))).toBe(true);
    expect(out.results.notes.filter((n) => n.includes('the session reported'))).toEqual([]);
  });
});

describe('lane model mismatches', () => {
  it('compares each lane against its own kind\'s model', () => {
    const lane = (id: string, kind: string, model?: string) => ({ id, kind, premiumRequests: 1, credits: 0, source: 'none', ...(model ? { model } : {}) });
    const issues = [{ id: 1, lanes: [lane('r1-implement-1', 'implement', 'mai-code-2'), lane('r1-review-1', 'review', 'mai-code-2-flash'), lane('r1-review-2', 'review', 'mai-code-2')] }] as never;
    expect(laneModelMismatches(issues, (k) => (k === 'review' ? 'mai-code-2-flash' : 'mai-code-2'))).toEqual(['#1 lane r1-review-2: asked for model mai-code-2-flash, the session reported mai-code-2']);
    // A kind on the default model is not checked.
    expect(laneModelMismatches(issues, (k) => (k === 'review' ? 'mai-code-2-flash' : undefined))).toEqual(['#1 lane r1-review-2: asked for model mai-code-2-flash, the session reported mai-code-2']);
  });

  it('lists each lane whose session reported another model than the bench asked for', () => {
    const lane = (id: string, model?: string) => ({ id, kind: 'implement', premiumRequests: 1, credits: 0, source: 'none', ...(model ? { model } : {}) });
    const issues = [
      { id: 1, lanes: [lane('r1-implement-1', 'mai-code-2'), lane('r1-review-1', 'gpt-5.5-mini')] },
      { id: 2, lanes: [lane('r2-implement-1')] },
    ] as never;
    expect(laneModelMismatches(issues, 'mai-code-2')).toEqual(['#1 lane r1-review-1: asked for model mai-code-2, the session reported gpt-5.5-mini']);
  });
});

describe('results recording', () => {
  const results = (over: Partial<BenchResults> = {}): BenchResults => ({
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
    writeFileSync(path, JSON.stringify(results({ model: { id: 3, multiplier: 'x', explicit: true } as never })));
    expect(() => readBenchResults(path)).toThrow(/model is neither null nor \{ id, multiplier, explicit \}/);
    writeFileSync(path, JSON.stringify(results({ model: null })));
    expect(readBenchResults(path).model).toBeNull();
  });

  it('readBenchResults reads an older results file without laneModels and labels it by its base model', () => {
    const path = join(dir, 'old.json');
    const old = results({ model: { id: 'mai-code-2', multiplier: 1, explicit: true } }) as unknown as Record<string, unknown>;
    delete old.laneModels;
    writeFileSync(path, JSON.stringify(old));
    const read = readBenchResults(path);
    expect(read.laneModels).toBeUndefined();
    expect(modelsLabel(read)).toBe(modelLabel(read.model));
    expect(modelsLabel(read)).toBe('mai-code-2 (--model, 1x)');
    expect(compareResults(read, read)).toContain('lane model mai-code-2 (--model, 1x))');
  });

  it('readBenchResults refuses an ill-typed laneModels', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify(results({ laneModels: { 'ci-fix': { id: 'mai-code-2', multiplier: 1, source: 'user config' } } as never })));
    expect(() => readBenchResults(path)).toThrow(/laneModels is not a map of lane kind to \{ id, multiplier, source \}/);
    writeFileSync(path, JSON.stringify(results({ laneModels: { review: { id: 'mai-code-2-flash', multiplier: null, source: '--model' } } as never })));
    expect(() => readBenchResults(path)).toThrow(/laneModels is not a map/);
    writeFileSync(path, JSON.stringify(results({ laneModels: { review: { id: 'mai-code-2-flash', multiplier: null, source: '--review-model' } } })));
    expect(readBenchResults(path).laneModels).toEqual({ review: { id: 'mai-code-2-flash', multiplier: null, source: '--review-model' } });
  });
});
