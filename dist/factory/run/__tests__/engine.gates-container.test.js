/**
 * factory.run.sandbox.isolation "container" in the engine: the user config
 * (never the base's committed omg.jsonc) sends prepare checks, the local
 * gate and their base calibration to the gate container with this run's
 * label; a container that is not available parks at
 * gate-container-unavailable, never the weaker sandbox and never the
 * --allow-unsandboxed-gates offer. A recording fake runner: no runtime.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveShipConfig } from '../../../ship/config.js';
import { defaultGateImage } from '../../../copilot-run/sandbox.js';
import { EXIT_AWAITING_HUMAN, GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import { CONTAINER_INCOMPATIBLE_ADVICE, containerRunLabel, GATE_CONTAINER_UNAVAILABLE_GATE } from '../container-gate.js';
import { cleanFactoryRun } from '../clean.js';
import { checkoutPath } from '../prepare.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
/** N3: when set, removing the engine's node_modules link from the prepare checkout throws (a busy file on win32). */
const removal = vi.hoisted(() => ({ fail: false }));
vi.mock('../prepare.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        unlinkNodeModules: (root, checkout) => {
            if (removal.fail)
                throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${checkout}'`), { code: 'EBUSY' });
            return real.unlinkNodeModules(root, checkout);
        },
    };
});
const MULTI_RUN_MS = 300_000;
let w;
afterEach(() => { removal.fail = false; rmSync(w.dir, { recursive: true, force: true }); });
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const PREPARE_CHECK = ['node', 'check.js'];
const gateConfig = (trustedBase = false) => () => ({
    config: {
        ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [PREPARE_CHECK],
        ...(trustedBase ? { trustedBaseCommit: gitIn(w.root, 'rev-parse', BASE) } : {}),
    },
    known: [],
});
const userContainer = { factory: { run: { sandbox: { isolation: 'container' } } } };
function sandbox(answer = () => ({ ran: true, status: 0, output: 'ok', timedOut: false })) {
    const reqs = [];
    const run = async (req) => { reqs.push(req); return answer(req); };
    return { reqs, run };
}
function opts(lanes, over = {}) {
    return localOpts(w, lanes, { gateConfig: gateConfig(), ...over });
}
describe('isolation "container"', () => {
    it('sends the prepare check and the local gate to the container with this run\'s label and the user\'s settings', async () => {
        w = localWorld();
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'gate']);
        for (const r of s.reqs) {
            expect(r.container).toMatchObject({ runtime: 'docker', image: defaultGateImage(), pidsLimit: 1024 });
            expect(r.runLabel).toBe(containerRunLabel(w.root, LOCAL_ISSUE));
        }
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('the default (no isolation key) sends nothing to the container', async () => {
        w = localWorld();
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: {} }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.every((r) => r.container === undefined && r.runLabel === undefined)).toBe(true);
    }, MULTI_RUN_MS);
    it('a container that is not available parks gate-container-unavailable: no ack offer, nothing runs plainly, the flag does not help', async () => {
        w = localWorld();
        const none = sandbox(() => ({ ran: false, reason: 'the container runtime docker does not answer (daemon down)', unavailable: true }));
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: none.run, gateSandboxUserConfig: userContainer }));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe(GATE_CONTAINER_UNAVAILABLE_GATE);
        expect(out.gate?.reason).toContain('factory.run.sandbox.isolation is "container" and the gate container is not available (the container runtime docker does not answer (daemon down))');
        expect(out.gate?.reason).toContain('never falls back to the Copilot sandbox');
        expect(out.gate?.reason).not.toContain('--allow-unsandboxed-gates to run');
        expect(w.gateRuns).toEqual([]);
        const again = await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: none.run, gateSandboxUserConfig: userContainer, allowUnsandboxedGates: true }));
        expect(again.gate?.name).toBe(GATE_CONTAINER_UNAVAILABLE_GATE);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('a local gate the container cannot run parks gate-container-unavailable, not gates-unsandboxed', async () => {
        w = localWorld();
        const s = sandbox((req) => (req.purpose === 'gate' ? { ran: false, reason: 'the gate image node:x is not present and docker pull failed', unavailable: true } : { ran: true, status: 0, output: '', timedOut: false }));
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(out.gate?.name, out.message).toBe(GATE_CONTAINER_UNAVAILABLE_GATE);
        expect(out.gate?.reason).toContain('the local gate `node --test`');
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('calibrates in the container too: a gate failing there on the base parks gate-sandbox-incompatible naming the container', async () => {
        w = localWorld();
        const s = sandbox((req) => (req.purpose === 'prepare' ? { ran: true, status: 0, output: '', timedOut: false } : { ran: true, status: 1, output: 'ENOTFOUND registry', timedOut: false }));
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
        expect(out.gate?.reason).toContain(`fails in the gate container (docker ${defaultGateImage()}) on the base`);
        expect(out.gate?.reason).toContain(CONTAINER_INCOMPATIBLE_ADVICE);
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'gate', 'calibrate']);
        expect(s.reqs[2].container).toBeDefined();
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.history.some((h) => h.note.includes('in the gate container (docker'))).toBe(true);
    }, MULTI_RUN_MS);
    it('a committed isolation or container block in the base omg.jsonc is ignored with a notice', async () => {
        w = localWorld();
        mkdirSync(join(w.root, '.copilot'), { recursive: true });
        writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), `${JSON.stringify({ factory: { run: { sandbox: { isolation: 'container', container: { image: 'evil/image' } } } } })}\n`);
        gitIn(w.root, 'add', '.copilot/omg.jsonc');
        gitIn(w.root, 'commit', '-q', '-m', 'isolation from the repository');
        const warnings = [];
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateConfig: gateConfig(true), gateSandboxUserConfig: {}, warn: (m) => warnings.push(m) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.every((r) => r.container === undefined)).toBe(true);
        expect(warnings.join('\n')).toContain('ignoring factory.run.sandbox.isolation and factory.run.sandbox.container in the base .copilot/omg.jsonc');
    }, MULTI_RUN_MS);
    it('clean removes this run\'s leftover gate containers and volumes by label only; without container isolation it never calls the runtime', async () => {
        w = localWorld();
        const first = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: sandbox().run, gateSandboxUserConfig: userContainer }));
        expect(first.gate?.name, first.message).toBe('merge');
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        const cancelled = await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: sandbox().run, gateSandboxUserConfig: userContainer }));
        expect(cancelled.phase, cancelled.message).toBe('cancelled');
        const label = containerRunLabel(w.root, LOCAL_ISSUE);
        const calls = [];
        const execSync = (bin, args) => {
            calls.push([bin, ...args]);
            if (args[0] === 'ps')
                return { status: 0, stdout: `omg-gate-${label}-01234567\nomg-gate-other-issue-9-01234567\nsome-ci-runner\n` };
            if (args[0] === 'volume' && args[1] === 'ls')
                return { status: 0, stdout: `omg-gate-${label}-01234567\nomg-gate-cache-0123456789abcdef\n` };
            return { status: 0, stdout: '' };
        };
        const owner = { pid: 4242, hostname: 'test-host', isAlive: () => false };
        const none = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner, runUserConfig: {}, containerExecSync: execSync });
        expect(none.kept, JSON.stringify(none.kept)).toEqual([]);
        expect(calls).toEqual([]);
        const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner, runUserConfig: userContainer, containerExecSync: execSync });
        expect(cleaned.removed.filter((r) => r.startsWith('docker '))).toEqual([`docker omg-gate-${label}-01234567`, `docker omg-gate-${label}-01234567`]);
        expect(calls.filter((c) => c.includes('rm')).map((c) => c.slice(1))).toEqual([['rm', '-f', `omg-gate-${label}-01234567`], ['volume', 'rm', '-f', `omg-gate-${label}-01234567`]]);
    }, MULTI_RUN_MS);
    it('C1: no link or tree of your node_modules in the checkout the container copies (prepare and base calibration); the default still links it', async () => {
        w = localWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\nnode_modules/\n');
        gitIn(w.root, 'add', '.gitignore');
        gitIn(w.root, 'commit', '-q', '-m', 'ignore node_modules');
        mkdirSync(join(w.root, 'node_modules', 'vitest'), { recursive: true });
        writeFileSync(join(w.root, 'node_modules', 'vitest', 'vitest.mjs'), 'real\n');
        const seen = [];
        const s = sandbox((req) => {
            seen.push({ purpose: req.purpose, nodeModules: existsSync(join(req.cwd, 'node_modules')) });
            return req.purpose === 'gate' ? { ran: true, status: 1, output: 'FAIL', timedOut: false } : { ran: true, status: 0, output: '', timedOut: false };
        });
        await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(seen.map((x) => x.purpose)).toEqual(['prepare', 'gate', 'calibrate']);
        expect(seen.every((x) => !x.nodeModules), JSON.stringify(seen)).toBe(true);
        rmSync(w.dir, { recursive: true, force: true });
        // Control: without container isolation the same world links it (the assertion above is not vacuous).
        w = localWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\nnode_modules/\n');
        gitIn(w.root, 'add', '.gitignore');
        gitIn(w.root, 'commit', '-q', '-m', 'ignore node_modules');
        mkdirSync(join(w.root, 'node_modules', 'vitest'), { recursive: true });
        const plain = [];
        const p = sandbox((req) => { plain.push(existsSync(join(req.cwd, 'node_modules'))); return { ran: true, status: 0, output: '', timedOut: false }; });
        await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: p.run, gateSandboxUserConfig: {} }));
        expect(plain[0]).toBe(true);
    }, MULTI_RUN_MS);
    it('N3: a fresh engine whose discard of the prepare checkout fails never links your node_modules into it', async () => {
        w = localWorld();
        writeFileSync(join(w.root, '.gitignore'), '.omg/\nnode_modules/\n');
        gitIn(w.root, 'add', '.gitignore');
        gitIn(w.root, 'commit', '-q', '-m', 'ignore node_modules');
        mkdirSync(join(w.root, 'node_modules', 'vitest'), { recursive: true });
        // Run 1: the prepare check fails on the head (passes on the base), so a ci-fix lane is due; no script for it here.
        let prepares = 0;
        const s = sandbox((req) => ({ ran: true, status: req.purpose === 'prepare' && prepares++ === 0 ? 1 : 0, output: '', timedOut: false }));
        const first = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(first.message).toMatch(/ci-fix-failed: .*no script for lane/);
        const checkout = checkoutPath(w.root, LOCAL_ISSUE);
        expect(existsSync(checkout)).toBe(true);
        // Run 2, a fresh engine: the ci-fix lane commits, it is reviewed, prepare discards the old checkout and the removal fails.
        removal.fail = true;
        const again = await runFactoryEngine(opts(lanesFor(w, [commitFile('src/fix.js', 'export const fix = 1;\n'), review('approve')]), { gateSandbox: sandbox().run, gateSandboxUserConfig: userContainer }));
        expect(again.message, readFactoryState(w.root, LOCAL_ISSUE).history.map((h) => `${h.to}: ${h.note}`).join('\n')).toMatch(/could not discard the engine's prepare checkout/);
        expect(existsSync(join(checkout, 'node_modules'))).toBe(false);
    }, MULTI_RUN_MS);
    it('L3: gates "ack" with isolation "container" runs in the container, never plainly after an ack', async () => {
        w = localWorld();
        const s = sandbox();
        const ack = { factory: { run: { sandbox: { isolation: 'container', gates: 'ack' } } } };
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: ack }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'gate']);
        expect(s.reqs.every((r) => r.container !== undefined)).toBe(true);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('L2: a base calibration is keyed on the image id the container reported, not on the tag', async () => {
        w = localWorld();
        let id = `sha256:${'a'.repeat(64)}`;
        const s = sandbox((req) => (req.purpose === 'prepare' ? { ran: true, status: 0, output: '', timedOut: false, imageId: id } : { ran: true, status: 1, output: 'FAIL', timedOut: false, imageId: id }));
        const first = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(first.gate?.name, first.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
        expect(Object.keys(readFactoryState(w.root, LOCAL_ISSUE).gateCalibration ?? {})).toHaveLength(1);
        id = `sha256:${'b'.repeat(64)}`;
        await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: s.run, gateSandboxUserConfig: userContainer }));
        expect(Object.keys(readFactoryState(w.root, LOCAL_ISSUE).gateCalibration ?? {})).toHaveLength(2);
    }, MULTI_RUN_MS);
    it('a malformed user value stops the step before anything runs', async () => {
        w = localWorld();
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: { factory: { run: { sandbox: { isolation: 'container', container: { image: '--privileged' } } } } } }));
        expect(out.message).toMatch(/factory\.run\.sandbox\.container\.image must be an image reference/);
        expect(s.reqs).toEqual([]);
    }, MULTI_RUN_MS);
});
//# sourceMappingURL=engine.gates-container.test.js.map