/**
 * factory.run.sandbox.gates (audit C1): prepare's checks and the local gate
 * run the PR's own code in the OS sandbox ("enforced"), or unsandboxed only
 * after `--allow-unsandboxed-gates` named the head ("ack", and "enforced"
 * where the sandbox gives no verdict), or unsandboxed with a warning
 * ("unsandboxed", user config only). A check that fails in the sandbox
 * counts only when it passes in the sandbox on the trusted base. The engine
 * on the local forge with fake lanes, a recording fake sandbox and a
 * recording plain runner: no Copilot runtime, no network.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalCheckRecord } from '../../../forge/local/index.js';
import { resolveShipConfig } from '../../../ship/config.js';
import { EXIT_AWAITING_HUMAN, GATE_NO_VERDICT_GATE, GATE_SANDBOX_INCOMPATIBLE_GATE, GATES_UNSANDBOXED_GATE, runFactoryEngine } from '../engine.js';
import { overwriteFactoryState, readFactoryState } from '../state.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
const MULTI_RUN_MS = 300_000;
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const PREPARE_CHECK = ['node', 'check.js'];
/** The gate config with one configured prepare check; `trustedBase` reads the base's committed omg.jsonc. */
const gateConfig = (trustedBase = false) => () => ({
    config: {
        ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [PREPARE_CHECK],
        ...(trustedBase ? { trustedBaseCommit: gitIn(w.root, 'rev-parse', BASE) } : {}),
    },
    known: [],
});
const userGates = (gates) => ({ factory: { run: { sandbox: { gates } } } });
/** A recording sandbox: `answer` per request (default: attested pass). */
function sandbox(answer = () => ({ ran: true, status: 0, output: 'ok', timedOut: false })) {
    const reqs = [];
    const run = async (req) => { reqs.push(req); return answer(req); };
    return { reqs, run };
}
/** The plain-runner runs that were prepare checks (the local gate argv is ['node', '--test']). */
const plainPrepare = () => w.gateRuns.filter((r) => r.argv.some((a) => a === 'check.js'));
const plainGate = () => w.gateRuns.filter((r) => r.argv.includes('--test'));
function opts(lanes, over = {}) {
    return localOpts(w, lanes, { gateConfig: gateConfig(), ...over });
}
describe('gates "enforced" (the default)', () => {
    it('runs the prepare check and the local gate only in the sandbox, attested, and records the gate as sandboxed', async () => {
        w = localWorld();
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'gate']);
        expect(s.reqs[0]).toMatchObject({ argv: PREPARE_CHECK, args: ['check.js'] });
        expect(s.reqs[1]).toMatchObject({ argv: ['node', '--test'] });
        // The checkout is the one read-write path; the common git dir is passed for the read-only grant.
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(s.reqs[1].cwd).toBe(s.reqs[0].cwd);
        expect(s.reqs[1].commonGitDir.replace(/\\/g, '/')).toMatch(/\/repo\/\.git$/);
        // Nothing ran unsandboxed.
        expect(w.gateRuns).toEqual([]);
        expect(readLocalCheckRecord(w.stateDir, w.root, state.head)).toMatchObject({ state: 'SUCCESS', sandbox: 'enforced' });
        expect(state.history.some((h) => h.note === `prepare checks on ${state.head.slice(0, 12)} ran in the OS sandbox`)).toBe(true);
        expect(state.unsandboxedGatesAck).toBeUndefined();
    }, MULTI_RUN_MS);
    it('a sandbox without a verdict parks before any unsandboxed run; --allow-unsandboxed-gates runs that head unsandboxed', async () => {
        w = localWorld();
        const none = sandbox(() => ({ ran: false, reason: 'the host reports no shell sandbox capability' }));
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: none.run }));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe(GATES_UNSANDBOXED_GATE);
        const head = readFactoryState(w.root, LOCAL_ISSUE).head;
        expect(out.gate?.reason).toContain(`the prepare check \`node check.js\` on ${head.slice(0, 12)} would run the PR's own code WITHOUT the OS sandbox (the OS sandbox gave no verdict: the host reports no shell sandbox capability)`);
        expect(out.gate?.reason).toContain('--allow-unsandboxed-gates');
        expect(w.gateRuns).toEqual([]);
        // A rerun without the flag parks again and still runs nothing unsandboxed.
        const again = await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: none.run }));
        expect(again.gate?.name).toBe(GATES_UNSANDBOXED_GATE);
        expect(w.gateRuns).toEqual([]);
        const allowed = await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: none.run, allowUnsandboxedGates: true }));
        expect(allowed.gate?.name, allowed.message).toBe('merge');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.unsandboxedGatesAck).toBe(state.head);
        expect(plainPrepare()).toHaveLength(1);
        expect(plainGate()).toHaveLength(1);
        expect(readLocalCheckRecord(w.stateDir, w.root, state.head)).toMatchObject({ state: 'SUCCESS', sandbox: 'ack' });
    }, MULTI_RUN_MS);
    it('no sandbox runner given: an enforced run parks, it never runs the code unsandboxed', async () => {
        w = localWorld();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: undefined }));
        expect(out.gate?.name, out.message).toBe(GATES_UNSANDBOXED_GATE);
        expect(out.gate?.reason).toContain('no OS sandbox runner was given to the engine');
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('--allow-unsandboxed-gates without that park is ignored with a warning', async () => {
        w = localWorld();
        const warnings = [];
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: sandbox().run, allowUnsandboxedGates: true, warn: (m) => warnings.push(m) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(warnings.join('\n')).toMatch(/--allow-unsandboxed-gates is ignored: the run for .* is not parked at awaiting-human: gates-unsandboxed/);
        expect(readFactoryState(w.root, LOCAL_ISSUE).unsandboxedGatesAck).toBeUndefined();
    }, MULTI_RUN_MS);
});
describe('base calibration', () => {
    it('a gate that fails in the sandbox on the base too parks gate-sandbox-incompatible: no FAILURE record, no ci-fix lane', async () => {
        w = localWorld();
        const s = sandbox((req) => (req.purpose === 'prepare' ? { ran: true, status: 0, output: '', timedOut: false } : { ran: true, status: 1, output: 'EACCES node_modules/.vite', timedOut: false }));
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
        expect(out.gate?.reason).toMatch(/fails in the OS sandbox on the base [0-9a-f]{12} itself/);
        expect(out.gate?.reason).toContain('factory.run.sandbox.writeNetwork "registry"');
        expect(out.gate?.reason).toContain('EACCES node_modules/.vite');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'gate', 'calibrate']);
        // The calibration ran on a plain copy of the base tree, not in the PR's checkout.
        const cal = s.reqs[2];
        expect(cal.cwd).not.toBe(s.reqs[1].cwd);
        expect(cal.argv).toEqual(['node', '--test']);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(readLocalCheckRecord(w.stateDir, w.root, state.head)).toBeUndefined();
        expect(lanes.started.map((l) => l.laneId).filter((id) => id.includes('ci-fix'))).toEqual([]);
        expect(Object.values(state.gateCalibration ?? {})).toEqual([{ ok: false, tail: 'EACCES node_modules/.vite' }]);
    }, MULTI_RUN_MS);
    it('a gate that passes in the sandbox on the base: the failure is the PR\'s, a ci-fix lane starts', async () => {
        w = localWorld();
        let gates = 0;
        const s = sandbox((req) => {
            if (req.purpose !== 'gate')
                return { ran: true, status: 0, output: '', timedOut: false };
            gates += 1;
            return { ran: true, status: gates === 1 ? 1 : 0, output: gates === 1 ? 'not ok 1 - greet' : 'ok', timedOut: false };
        });
        const lanes = lanesFor(w, [greet(), review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
        const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run }));
        expect(lanes.started.map((l) => l.laneId)).toContain(`issue-${LOCAL_ISSUE}-ci-fix-1`);
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.filter((r) => r.purpose === 'calibrate')).toHaveLength(1);
    }, MULTI_RUN_MS);
    it('a prepare check that fails in the sandbox on the base too parks instead of a ci-fix lane', async () => {
        w = localWorld();
        const s = sandbox((req) => (req.purpose === 'gate' ? { ran: true, status: 0, output: '', timedOut: false } : { ran: true, status: 2, output: 'ENOTFOUND registry.npmjs.org', timedOut: false }));
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
        expect(out.gate?.reason).toContain('the prepare check `node check.js` fails in the OS sandbox on the base');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'calibrate']);
        expect(lanes.started.map((l) => l.laneId).filter((id) => id.includes('ci-fix'))).toEqual([]);
    }, MULTI_RUN_MS);
});
describe('gates "ack"', () => {
    it('parks before the first prepare check; the flag accepts that head only, a new head parks again', async () => {
        w = localWorld();
        w.gateStatus = [0, 1];
        const s = sandbox();
        const lanes = lanesFor(w, [greet(), review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
        const ack = { gateSandbox: s.run, gateSandboxUserConfig: userGates('ack') };
        const first = await runFactoryEngine(opts(lanes, ack));
        expect(first.gate?.name, first.message).toBe(GATES_UNSANDBOXED_GATE);
        expect(first.gate?.reason).toContain('factory.run.sandbox.gates is "ack" (user config)');
        const head1 = readFactoryState(w.root, LOCAL_ISSUE).head;
        expect(s.reqs).toEqual([]);
        expect(w.gateRuns).toEqual([]);
        // Accepted for head1: the prepare check passes unsandboxed, the gate FAILS unsandboxed (a real failure): ci-fix makes head2,
        // which parks again before any of its code runs.
        const second = await runFactoryEngine(opts(lanes, { ...ack, allowUnsandboxedGates: true }));
        expect(second.gate?.name, second.message).toBe(GATES_UNSANDBOXED_GATE);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.head).not.toBe(head1);
        expect(second.gate?.reason).toContain(`on ${state.head.slice(0, 12)} would run`);
        expect(state.unsandboxedGatesAck).toBe(head1);
        expect(readLocalCheckRecord(w.stateDir, w.root, head1)).toMatchObject({ state: 'FAILURE', sandbox: 'ack' });
        expect(w.gateRuns.map((r) => r.head)).toEqual([head1, head1]);
        expect(s.reqs).toEqual([]);
    }, MULTI_RUN_MS);
});
const PASS = { ran: true, status: 0, output: 'ok', timedOut: false };
/** What runSandboxed answers when the command ran under the confirmed policy and printed no single exit marker (or hung). */
const WITHHELD = { ran: false, started: true, reason: 'the output did not end with the one exit-code marker line the sandbox shell prints after the command' };
const ciFixLanes = (lanes) => lanes.started.map((l) => l.laneId).filter((id) => id.includes('ci-fix'));
describe('a sandbox that withholds or forges a verdict (review 474 item 10)', () => {
    it('a prepare check that ran but gave no verdict parks gate-no-verdict: no ack offer, the flag does not apply, nothing runs unsandboxed', async () => {
        w = localWorld();
        const s = sandbox((req) => (req.purpose === 'prepare' ? WITHHELD : PASS));
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run }));
        expect(out.exitCode, out.message).toBe(EXIT_AWAITING_HUMAN);
        expect(out.gate?.name).toBe(GATE_NO_VERDICT_GATE);
        const head = readFactoryState(w.root, LOCAL_ISSUE).head;
        expect(out.gate?.reason).toContain(`the prepare check \`node check.js\` on ${head.slice(0, 12)} ran in the OS sandbox but gave no verdict`);
        expect(out.gate?.reason).toContain('--allow-unsandboxed-gates does not apply here');
        expect(out.gate?.reason).not.toMatch(/rerun .*--allow-unsandboxed-gates to run/);
        const warnings = [];
        const again = await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: s.run, allowUnsandboxedGates: true, warn: (m) => warnings.push(m) }));
        expect(again.gate?.name, again.message).toBe(GATE_NO_VERDICT_GATE);
        expect(warnings.join('\n')).toMatch(/--allow-unsandboxed-gates is ignored/);
        expect(w.gateRuns).toEqual([]);
        expect(readFactoryState(w.root, LOCAL_ISSUE).unsandboxedGatesAck).toBeUndefined();
        expect(ciFixLanes(lanes)).toEqual([]);
    }, MULTI_RUN_MS);
    it('a local gate that ran but gave no verdict (a timeout with no answer) parks gate-no-verdict: no record, no FAILURE, no ci-fix lane', async () => {
        w = localWorld();
        const s = sandbox((req) => (req.purpose === 'gate' ? { ran: false, started: true, reason: 'timed out after 1200000 ms and the shell call gave no answer; the command is not counted as run in the sandbox' } : PASS));
        const lanes = lanesFor(w, [greet(), review('approve')]);
        const out = await runFactoryEngine(opts(lanes, { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe(GATE_NO_VERDICT_GATE);
        expect(out.gate?.reason).toContain('the local gate `node --test`');
        const head = readFactoryState(w.root, LOCAL_ISSUE).head;
        expect(readLocalCheckRecord(w.stateDir, w.root, head)).toBeUndefined();
        expect(w.gateRuns).toEqual([]);
        expect(ciFixLanes(lanes)).toEqual([]);
    }, MULTI_RUN_MS);
    it('item 8: a prepare check that rewrites the checkout\'s .git file parks lane-tampered; nothing is published', async () => {
        w = localWorld();
        const s = sandbox((req) => {
            if (req.purpose === 'prepare')
                appendFileSync(join(req.cwd, '.git'), '\n');
            return PASS;
        });
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toContain("changed the prepare checkout's .git file");
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare']);
        expect(readFactoryState(w.root, LOCAL_ISSUE).prepared).toBeUndefined();
    }, MULTI_RUN_MS);
    it('item 8: a local gate that rewrites the checkout\'s .git file parks lane-tampered and its SUCCESS is dropped', async () => {
        w = localWorld();
        const s = sandbox((req) => {
            if (req.purpose === 'gate')
                appendFileSync(join(req.cwd, '.git'), '\n');
            return PASS;
        });
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toContain('the local gate on');
        expect(readLocalCheckRecord(w.stateDir, w.root, readFactoryState(w.root, LOCAL_ISSUE).head)).toBeUndefined();
    }, MULTI_RUN_MS);
    it('item 8: after the first check, engine git in the checkout names its git dir and work tree; before it, it does not', async () => {
        w = localWorld();
        const inCheckout = [];
        let checkout = '';
        const s = sandbox((req) => { checkout = req.cwd; return PASS; });
        const exec = (cmd, args, o) => {
            if (cmd === 'git' && o?.cwd)
                inCheckout.push([o.cwd, ...args]);
            return w.exec(cmd, args, o);
        };
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, exec }));
        expect(out.gate?.name, out.message).toBe('merge');
        const mine = inCheckout.filter((c) => c[0] === checkout).map((c) => c.slice(1));
        const pinned = (a) => a.some((x) => x.startsWith('--git-dir=')) && a.some((x) => x === `--work-tree=${checkout}`);
        expect(mine.some((a) => a.includes('merge-base') && !pinned(a)), JSON.stringify(mine)).toBe(true);
        expect(mine.some((a) => a.includes('rev-parse') && a.includes('HEAD') && pinned(a)), JSON.stringify(mine)).toBe(true);
    }, MULTI_RUN_MS);
    it('a working-tree omg.jsonc in the repository cannot switch the gates off: the base-committed config and the user config decide', async () => {
        w = localWorld();
        mkdirSync(join(w.root, '.copilot'), { recursive: true });
        writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), `${JSON.stringify(userGates('unsandboxed'))}\n`);
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateConfig: gateConfig(true) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['prepare', 'gate']);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('a state from before the sandboxed gates (no gate fields) resumes with the gate in the sandbox, never plain', async () => {
        w = localWorld();
        const parked = sandbox((req) => (req.purpose === 'gate' ? { ran: false, reason: 'the sandbox is not available: MXC is not available on this host' } : PASS));
        const first = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: parked.run }));
        expect(first.gate?.name, first.message).toBe(GATES_UNSANDBOXED_GATE);
        // What the engine before this change left at the same point: the run in its phase, no park, no ack, no calibration.
        const { gate: _g, unsandboxedGatesAck: _a, gateCalibration: _c, ...old } = readFactoryState(w.root, LOCAL_ISSUE);
        overwriteFactoryState(w.root, LOCAL_ISSUE, old);
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, []), { gateSandbox: s.run }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs.map((r) => r.purpose)).toEqual(['gate']);
        expect(w.gateRuns).toEqual([]);
        expect(readFactoryState(w.root, LOCAL_ISSUE).unsandboxedGatesAck).toBeUndefined();
    }, MULTI_RUN_MS);
});
describe('the ack carry (review 474 item 10)', () => {
    it('an acked prepare check that commits in the checkout parks lane-tampered, and the ack is not carried to that commit', async () => {
        w = localWorld();
        const ack = { gateSandbox: sandbox().run, gateSandboxUserConfig: userGates('ack') };
        const lanes = lanesFor(w, [greet(), review('approve')]);
        expect((await runFactoryEngine(opts(lanes, ack))).gate?.name).toBe(GATES_UNSANDBOXED_GATE);
        const head1 = readFactoryState(w.root, LOCAL_ISSUE).head;
        const committing = async (argv, cwd) => {
            if (argv.includes('check.js'))
                gitIn(cwd, 'commit', '-q', '--allow-empty', '-m', 'made by the PR code');
            return w.gate(argv, cwd, 60_000);
        };
        const out = await runFactoryEngine(opts(lanes, { ...ack, allowUnsandboxedGates: true, localGate: committing }));
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toContain('added commit(s) the engine did not make');
        expect(readFactoryState(w.root, LOCAL_ISSUE).unsandboxedGatesAck).toBe(head1);
    }, MULTI_RUN_MS);
    it('carries the ack to the head prepare made from the accepted head with its own base merge only', async () => {
        w = localWorld();
        const ack = { gateSandbox: sandbox().run, gateSandboxUserConfig: userGates('ack') };
        const lanes = lanesFor(w, [greet(), review('approve')]);
        expect((await runFactoryEngine(opts(lanes, ack))).gate?.name).toBe(GATES_UNSANDBOXED_GATE);
        const head1 = readFactoryState(w.root, LOCAL_ISSUE).head;
        // The base moves: prepare merges it in (a housekeeping commit the engine makes and records).
        writeFileSync(join(w.root, 'BASE-NOTE.md'), 'base moved\n');
        gitIn(w.root, 'add', 'BASE-NOTE.md');
        gitIn(w.root, 'commit', '-q', '-m', 'base moves');
        const out = await runFactoryEngine(opts(lanes, { ...ack, allowUnsandboxedGates: true }));
        expect(out.gate?.name, out.message).toBe('merge');
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.head).not.toBe(head1);
        expect(state.unsandboxedGatesAck).toBe(state.head);
        expect(state.history.some((h) => h.note === `--allow-unsandboxed-gates for ${head1.slice(0, 12)} carried to the prepared head ${state.head.slice(0, 12)}`)).toBe(true);
        expect(plainGate().map((r) => r.head)).toEqual([state.head]);
    }, MULTI_RUN_MS);
});
describe('gates "unsandboxed"', () => {
    it('runs the code plainly with a warning and records it, from the user config', async () => {
        w = localWorld();
        const warnings = [];
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateSandboxUserConfig: userGates('unsandboxed'), warn: (m) => warnings.push(m) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(s.reqs).toEqual([]);
        expect(plainPrepare()).toHaveLength(1);
        expect(plainGate()).toHaveLength(1);
        const head = readFactoryState(w.root, LOCAL_ISSUE).head;
        expect(readLocalCheckRecord(w.stateDir, w.root, head)).toMatchObject({ state: 'SUCCESS', sandbox: 'unsandboxed' });
        expect(warnings.filter((m) => m.includes('runs WITHOUT the OS sandbox (factory.run.sandbox.gates "unsandboxed", user config)'))).toHaveLength(2);
    }, MULTI_RUN_MS);
    it('is refused from the repository\'s committed omg.jsonc; "ack" from there is honoured', async () => {
        w = localWorld();
        const commitConfig = (gates) => {
            mkdirSync(join(w.root, '.copilot'), { recursive: true });
            writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), `${JSON.stringify(userGates(gates))}\n`);
            gitIn(w.root, 'add', '.copilot/omg.jsonc');
            gitIn(w.root, 'commit', '-q', '-m', `gates ${gates}`);
        };
        commitConfig('unsandboxed');
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateConfig: gateConfig(true) }));
        expect(out.exitCode, out.message).toBe(1);
        expect(out.message).toMatch(/factory\.run\.sandbox\.gates "unsandboxed" is accepted from the user config only/);
        expect(s.reqs).toEqual([]);
        expect(w.gateRuns).toEqual([]);
    }, MULTI_RUN_MS);
    it('a committed "ack" parks like the user config\'s', async () => {
        w = localWorld();
        mkdirSync(join(w.root, '.copilot'), { recursive: true });
        writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), `${JSON.stringify(userGates('ack'))}\n`);
        gitIn(w.root, 'add', '.copilot/omg.jsonc');
        gitIn(w.root, 'commit', '-q', '-m', 'gates ack');
        const s = sandbox();
        const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gateConfig: gateConfig(true) }));
        expect(out.gate?.name, out.message).toBe(GATES_UNSANDBOXED_GATE);
        expect(out.gate?.reason).toContain('factory.run.sandbox.gates is "ack" (the base .copilot/omg.jsonc)');
        expect(s.reqs).toEqual([]);
    }, MULTI_RUN_MS);
});
//# sourceMappingURL=engine.gates-sandbox.test.js.map