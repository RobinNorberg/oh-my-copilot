/**
 * Built-in prepare checks in the OS sandbox (review 482 #1): a built-in
 * eslint or vitest argv holds the PR's changed file names, so a refusal of
 * it never gets the --allow-unsandboxed-gates offer. One changed file name
 * too long for the sandbox shell is a plain FAILURE of that check, decided
 * before any sandbox call. A name of that length cannot be checked out on
 * every CI host (Linux caps a path far below the 120 000-character shell
 * limit), so the sizing alone is replaced here for one marked file name; the
 * split, the engine and prepare run as they are.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { BUILT_IN_FILE_NAME_TOO_LONG, GATE_NO_VERDICT_GATE, runFactoryEngine } from '../engine.js';
import { ESLINT_SCRIPT, TSC_SCRIPT } from '../../../ship/prepare.js';
import { readFactoryState } from '../state.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
const LONG_FILE = 'src/over-long-name.ts';
vi.mock('../sandbox-exec.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        sandboxCommandTooLong: (platform, argv, cwd) => argv.includes(LONG_FILE) || real.sandboxCommandTooLong(platform, argv, cwd),
    };
});
const MULTI_RUN_MS = 300_000;
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const PASS = { ran: true, status: 0, output: 'ok', timedOut: false };
function sandbox(answer) {
    const reqs = [];
    const run = async (req) => { reqs.push(req); return answer(req); };
    return { reqs, run };
}
/** A base with tsconfig.json and an eslint config committed, and the two tools in an ignored node_modules: built-in tsc and lint run. */
function builtInWorld() {
    const world = localWorld();
    appendFileSync(join(world.root, '.gitignore'), 'node_modules\n');
    writeFileSync(join(world.root, 'tsconfig.json'), '{}\n');
    writeFileSync(join(world.root, 'eslint.config.js'), 'export default [];\n');
    gitIn(world.root, 'add', '.');
    gitIn(world.root, 'commit', '-q', '-m', 'tooling');
    for (const script of [TSC_SCRIPT, ESLINT_SCRIPT]) {
        mkdirSync(join(world.root, script, '..'), { recursive: true });
        writeFileSync(join(world.root, script), '\n');
    }
    return world;
}
const opts = (file, run) => localOpts(w, lanesFor(w, [commitFile(file, 'export const x = 1;\n'), review('approve')]), { gateSandbox: run, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxCiFixRounds: 0 } });
describe('built-in prepare checks in the OS sandbox (review 482 #1)', () => {
    it('one changed file name too long for the sandbox shell, after a sandboxed tsc: a FAILURE of lint with the fixed text, no offer, no unsandboxed run', async () => {
        w = builtInWorld();
        const s = sandbox(() => PASS);
        const out = await runFactoryEngine(opts(LONG_FILE, s.run));
        expect(out.gate?.name, out.message).toBe('ci-failed');
        expect(out.gate?.reason).toContain('prepare lint');
        expect(out.gate?.reason).not.toContain('--allow-unsandboxed-gates');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.ciFailure?.checks).toEqual(['prepare lint']);
        expect(state.ciFailure?.detail).toContain(BUILT_IN_FILE_NAME_TOO_LONG);
        // tsc ran in the sandbox; lint never reached it (decided before any sandbox call), and nothing ran plainly.
        expect(s.reqs.map((r) => r.args[0])).toEqual([TSC_SCRIPT]);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('any other refusal of a built-in part after the head\'s code ran parks gate-no-verdict, without the --allow-unsandboxed-gates offer', async () => {
        w = builtInWorld();
        const refused = { ran: false, refused: true, reason: 'the command cannot be passed to the sandbox shell unchanged (a NUL, or on Windows an empty argument or a double quote)' };
        const s = sandbox((req) => (req.args[0] === ESLINT_SCRIPT ? refused : PASS));
        const out = await runFactoryEngine(opts('src/short.ts', s.run));
        expect(out.gate?.name, out.message).toBe(GATE_NO_VERDICT_GATE);
        expect(out.gate?.reason).toContain('--allow-unsandboxed-gates does not apply here');
        expect(out.gate?.reason).not.toContain('Acknowledging trusts');
        expect(s.reqs.map((r) => r.args[0])).toEqual([TSC_SCRIPT, ESLINT_SCRIPT]);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
});
//# sourceMappingURL=engine.gates-sandbox.builtin.test.js.map