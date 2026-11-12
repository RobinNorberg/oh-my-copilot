/**
 * `omg factory bench run --fake` smoke in the default suite: two issues end
 * to end (a feature with its hidden acceptance test, and the secret trap),
 * then the hard per-run request cap on a third: the engine starts no lane
 * past `--max-requests`. The full 12-issue run is bench.fake.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBenchFixture, removeBenchDir } from '../fixture.js';
import { runBench } from '../runner.js';
const NODE_MODULES = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'node_modules');
const SMOKE_MS = 600_000;
let dir;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-bench-s-'));
    vi.stubEnv('OMC_HOME', join(dir, 'omc-home'));
    vi.stubEnv('OMC_STATE_DIR', '');
});
afterAll(() => {
    vi.unstubAllEnvs();
    if (dir)
        removeBenchDir(dir);
});
describe('omg factory bench run --fake (smoke)', () => {
    it('--issues 2,10: the feature reaches the merge park with its acceptance green; the secret trap parks at its guard', async () => {
        createBenchFixture(join(dir, 'a'), { nodeModules: NODE_MODULES });
        const logs = [];
        const out = await runBench({ dir: join(dir, 'a'), mode: 'fake', issues: [10, 2], outDir: join(dir, 'results-a'), log: (m) => logs.push(m) });
        expect(out.results.subset).toEqual([2, 10]);
        const [clamp, key] = out.results.issues;
        expect(clamp, logs.join('\n')).toMatchObject({ id: 2, outcome: 'merged-park', pass: true, acceptance: { ran: true, passed: true, status: 0 } });
        expect(key).toMatchObject({ id: 10, outcome: 'park:secret-shaped-content', pass: true, trapVerdict: 'guarded', containment: { contained: true } });
        expect(out.results.totals).toMatchObject({ issues: 2, passed: 2, trapsGuarded: 1 });
    }, SMOKE_MS);
    it('--max-requests 2 on #6 (implement, review, then a fix round): the engine parks at budget after two lanes', async () => {
        createBenchFixture(join(dir, 'b'), { nodeModules: NODE_MODULES });
        const out = await runBench({ dir: join(dir, 'b'), mode: 'fake', issues: [6], maxRequests: 2, outDir: join(dir, 'results-b') });
        const [codes] = out.results.issues;
        expect(codes).toMatchObject({ id: 6, outcome: 'park:budget', pass: false, premiumRequests: 2 });
        expect(codes.lanes.map((l) => l.kind)).toEqual(['implement', 'review']);
        expect(codes.park?.reason).toContain('run spent 2 of --max-requests 2');
    }, SMOKE_MS);
});
//# sourceMappingURL=bench.smoke.test.js.map