/**
 * Monorepos in the sandboxed gate (goal 5): the engine builds the gate's
 * node_modules trees from the TRUSTED BASE's workspace globs, so a
 * workspace self-link resolves to the gate checkout's package and a nested
 * package node_modules gets its own per-run tree; the PR head's globs never
 * count. A layout the gate does not support (Yarn PnP) parks the base
 * calibration at gate-sandbox-incompatible, naming the file.
 */
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeModulesTreeProblem } from '../../../copilot-run/sandbox.js';
import { ESLINT_SCRIPT, TSC_SCRIPT } from '../../../ship/prepare.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import { lanesFor, localOpts, localWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
const MULTI_RUN_MS = 300_000;
const PASS = { ran: true, status: 0, output: 'ok', timedOut: false };
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
let w;
afterEach(() => { rmSync(w.dir, { recursive: true, force: true }); });
function file(p, body = '{}\n') {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
}
/** An npm-workspaces base (packages/*; evil/x committed but not a workspace), tsc and eslint in your node_modules, a self-link and a nested node_modules of yours. */
function workspaceWorld() {
    const world = localWorld();
    const r = world.root;
    appendFileSync(join(r, '.gitignore'), 'node_modules\n.pnp.cjs\n');
    file(join(r, 'tsconfig.json'));
    file(join(r, 'eslint.config.js'), 'export default [];\n');
    file(join(r, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    file(join(r, 'packages', 'a', 'package.json'), JSON.stringify({ name: '@scope/a' }));
    file(join(r, 'packages', 'a', 'index.js'), 'export const a = 1;\n');
    file(join(r, 'evil', 'x', 'package.json'));
    gitIn(r, 'add', '.');
    gitIn(r, 'commit', '-q', '-m', 'workspaces');
    for (const script of [TSC_SCRIPT, ESLINT_SCRIPT])
        file(join(r, script), '\n');
    mkdirSync(join(r, 'node_modules', '@scope'), { recursive: true });
    symlinkSync(join(r, 'packages', 'a'), join(r, 'node_modules', '@scope', 'a'), linkType);
    file(join(r, 'packages', 'a', 'node_modules', 'left-pad', 'package.json'));
    file(join(r, 'evil', 'x', 'node_modules', 'dep', 'package.json'));
    return world;
}
function sandbox(answer) {
    const reqs = [];
    const run = async (req) => { reqs.push(req); return answer(req); };
    return { reqs, run };
}
const opts = (run, scripts = [commitFile('src/short.ts', 'export const x = 1;\n'), review('approve')]) => localOpts(w, lanesFor(w, scripts), { gateSandbox: run, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxCiFixRounds: 0 } });
describe('workspaces in the sandboxed gate', () => {
    it('npm: the self-link resolves to the gate checkout, the nested tree is there and granted; the head\'s added glob is not used', async () => {
        w = workspaceWorld();
        const seen = [];
        const s = sandbox((req) => {
            const tree = nodeModulesTreeProblem(req.cwd, req.nodeModulesTarget);
            seen.push({
                selfLink: realpathSync.native(join(req.cwd, 'node_modules', '@scope', 'a')),
                checkoutPkg: realpathSync.native(join(req.cwd, 'packages', 'a')),
                nested: existsSync(join(req.cwd, 'packages', 'a', 'node_modules', 'left-pad', 'package.json')),
                evil: existsSync(join(req.cwd, 'evil', 'x', 'node_modules')),
                problem: tree.problem,
                grants: tree.nested ?? [],
            });
            return PASS;
        });
        // The head widens the workspaces to evil/*: the base's globs decide.
        const out = await runFactoryEngine(opts(s.run, [commitFile('package.json', JSON.stringify({ private: true, workspaces: ['packages/*', 'evil/*'] })), review('approve')]));
        expect(out.gate?.name, out.message).not.toBe('lane-tampered');
        expect(seen.length).toBeGreaterThan(0);
        for (const v of seen) {
            expect(v.problem).toBeNull();
            expect(v.selfLink).toBe(v.checkoutPkg);
            expect(v.nested).toBe(true);
            expect(v.evil).toBe(false);
            expect(v.grants).toEqual([realpathSync.native(join(w.root, 'packages', 'a', 'node_modules'))]);
        }
        // Your packages and node_modules are untouched.
        expect(existsSync(join(w.root, 'packages', 'a', 'node_modules', 'left-pad', 'package.json'))).toBe(true);
        expect(existsSync(join(w.root, 'packages', 'a', 'node_modules', '.vite'))).toBe(false);
    }, MULTI_RUN_MS);
    it('a repository that ignores only the root node_modules: the nested tree is not counted as a change of the checkout', async () => {
        w = workspaceWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\n/node_modules\n.pnp.cjs\n');
        gitIn(w.root, 'commit', '-qam', 'root-only ignore');
        const s = sandbox(() => PASS);
        const out = await runFactoryEngine(opts(s.run));
        expect(out.gate?.name, out.message).not.toBe('lane-tampered');
        expect(out.gate?.reason ?? '').not.toMatch(/working tree differs/);
        expect(s.reqs.some((r) => existsSync(join(r.cwd, 'packages', 'a', 'node_modules')))).toBe(true);
    }, MULTI_RUN_MS);
    it('Yarn PnP: the base calibration parks at gate-sandbox-incompatible naming .pnp.cjs, without running the command', async () => {
        w = workspaceWorld();
        file(join(w.root, '.pnp.cjs'), '');
        const failing = { ran: true, status: 1, output: 'error TS2307: Cannot find module', timedOut: false };
        const warnings = [];
        const s = sandbox((req) => (req.args[0] === TSC_SCRIPT ? failing : PASS));
        const out = await runFactoryEngine({ ...opts(s.run), warn: (m) => warnings.push(m) });
        expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
        expect(out.gate?.reason).toMatch(/Plug'n'Play .*\.pnp\.cjs/);
        expect(s.reqs.map((r) => r.purpose)).not.toContain('calibrate');
        expect(warnings.join(' | ')).toMatch(/Plug'n'Play/);
    }, MULTI_RUN_MS);
});
//# sourceMappingURL=engine.gates-workspace.test.js.map