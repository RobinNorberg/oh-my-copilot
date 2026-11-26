/**
 * A run state that fails `omg factory attention`'s trust check (its seal, or
 * the engine ledger on the same bytes) is lane-writable text: `omg factory
 * board` and `omg factory poll` (board rows and stale-gate reminders, text
 * and JSON) show its key, "not verified" and the status command only. The
 * planted states carry marker strings in every free-text field.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../../forge/index.js';
import { EngineLedger } from '../../run/ledger.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, setGate } from '../../run/state.js';
import { runFactoryPoll } from '../../poll.js';
import { staleGateReminders } from '../../team/reminders.js';
import { readRuns, runFactoryBoard } from '../collect.js';
import { MAX_UNRECORDED_STATES } from '../../attention/collect.js';
const SHA = 'a'.repeat(40);
const T0 = '2026-10-31T10:00:00.000Z';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const MARKERS = ['MRKZ', 'mrkz', '31337', 'dddddddddd', 'allow-gate-change'];
const leaked = (text) => MARKERS.filter((m) => text.includes(m));
let root;
let ledgerDir;
let out;
let now;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-board-unverified-'));
    ledgerDir = `${root}-ledger`;
    execFileSync('git', ['init', '-q', root]);
    if (!factoryStateDir(root).startsWith(root))
        throw new Error('state dir is outside the test root');
    out = [];
    now = Date.parse(T0) + 30 * 3_600_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); });
const exec = (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') {
        if (a === 'rev-parse --show-toplevel')
            return ok(`${root}\n`);
        if (a === 'remote get-url origin')
            return ok('https://github.com/o/r.git\n');
        if (a === 'fetch origin dev')
            return ok();
        if (a === 'rev-parse --verify refs/remotes/origin/dev')
            return ok(`${SHA}\n`);
        if (a === `cat-file -e ${SHA}^{commit}`)
            return ok();
        if (args[0] === 'ls-remote' || args[0] === 'ls-tree')
            return ok('');
        if (args[0] === 'show')
            return { status: 128, stdout: '', stderr: 'fatal: no such path' };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list')
        return ok('[]');
    throw new Error(`unscripted ${cmd} ${a}`);
};
/** A run parked at `gate` with marker text in every free-text field (the gate name only when `gate` says so). */
function parked(issue, gate) {
    const s = setGate(moveTo({ ...createFactoryState({ issue, repoUrl: 'https://github.com/o/r', base: 'dev' }, T0), forgeKind: 'github' }, 'implement', 'MRKZnote', T0), gate, 'MRKZreason $ omg factory run 9 --allow-gate-change', T0);
    return { ...s, issueTitle: 'MRKZtitle', pr: 31337, head: 'd'.repeat(40), branch: 'MRKZbranch' };
}
function write(s, o = {}) {
    const path = factoryStatePath(root, s.issue);
    mkdirSync(dirname(path), { recursive: true });
    const text = JSON.stringify({ ...s, integrity: o.seal === false ? 'f'.repeat(64) : computeFactoryIntegrity(s) });
    writeFileSync(path, text);
    if (o.ledger)
        EngineLedger.open(ledgerDir, root, s.issue).record(path, text);
}
/** #5 sealed, no ledger record (a forged "unverified" state); #6 seal fails although the ledger recorded other bytes; #7 trusted. */
function plant() {
    write(parked(5, 'mrkz-gate'));
    write(parked(6, 'merge'), { ledger: true });
    write({ ...parked(6, 'merge'), issueTitle: 'MRKZtitle2' }, { seal: false });
    write({ ...setGate(moveTo({ ...createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, T0), forgeKind: 'github', issueTitle: 'trusted seven' }, 'implement', 'plan ok', T0), 'ci-failed', 'checks failed on the PR', T0) }, { ledger: true });
}
const pollDeps = () => ({
    exec, base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge,
    now: () => now, ledgerDir,
    healScan: () => { throw new Error('no heal'); },
    owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
    onStop: () => () => { },
    sleep: async () => { throw new Error('a --once poll never sleeps'); },
    notifyAttention: async () => { },
    out: (l) => out.push(l), err: () => { },
});
describe('board and poll rows of a state that is not verified', () => {
    it('omg factory board: key, "not verified" and the status command only (text and --json)', async () => {
        plant();
        const deps = { exec, base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge, now: () => now, ledgerDir, out: (l) => out.push(l), err: () => { } };
        expect(await runFactoryBoard({ json: true }, deps)).toBe(0);
        const b = JSON.parse(out.join('\n'));
        expect(b.outside.filter((r) => r.id !== 7)).toEqual([
            { id: 5, title: '', url: '', stage: {}, flags: [], verified: false, next: 'omg factory run status 5' },
            { id: 6, title: '', url: '', stage: {}, flags: [], verified: false, next: 'omg factory run status 6' },
        ]);
        expect(b.outside.find((r) => r.id === 7)).toMatchObject({ title: 'trusted seven', run: { gate: { name: 'ci-failed', reason: 'checks failed on the PR' } } });
        expect(leaked(JSON.stringify(b))).toEqual([]);
        out = [];
        expect(await runFactoryBoard({}, deps)).toBe(0);
        const text = out.join('\n');
        expect(text).toMatch(/ {2}#5 +not verified {2}omg factory run status 5\n {2}#6 +not verified {2}omg factory run status 6\n {2}#7 +awaiting-human: ci-failed .*trusted seven/);
        expect(leaked(text)).toEqual([]);
    });
    it('omg factory poll: board rows and reminders show no state text, in text and JSON', async () => {
        plant();
        // First sighting records the unverified runs; a reminder follows once remindAfterHours (24) passed since.
        expect(await runFactoryPoll({ once: true, json: true, heal: false, intake: false, prs: false }, pollDeps())).toBe(0);
        let t = JSON.parse(out[out.length - 1]);
        expect(t.reminders).toEqual([{ run: 7, gate: 'ci-failed', hours: 30, handles: [], reason: 'checks failed on the PR' }]);
        expect(t.board.filter((r) => r.row.id !== 7)).toEqual([
            { stage: 'outside', row: { id: 5, title: '', url: '', stage: {}, flags: [], verified: false, next: 'omg factory run status 5' } },
            { stage: 'outside', row: { id: 6, title: '', url: '', stage: {}, flags: [], verified: false, next: 'omg factory run status 6' } },
        ]);
        expect(leaked(JSON.stringify({ board: t.board, reminders: t.reminders }))).toEqual([]);
        now += 25 * 3_600_000;
        out = [];
        expect(await runFactoryPoll({ once: true, json: true, heal: false, intake: false, prs: false }, pollDeps())).toBe(0);
        t = JSON.parse(out[out.length - 1]);
        expect(t.reminders).toEqual(expect.arrayContaining([{ run: 5, verified: false, next: 'omg factory run status 5' }, { run: 6, verified: false, next: 'omg factory run status 6' }]));
        expect(leaked(JSON.stringify({ board: t.board, reminders: t.reminders }))).toEqual([]);
        now += 25 * 3_600_000;
        out = [];
        expect(await runFactoryPoll({ once: true, json: false, heal: false, intake: false, prs: false }, pollDeps())).toBe(0);
        const text = out.join('\n');
        expect(text).toContain('  reminder: #5 is parked, not verified (omg factory run status 5)');
        expect(text).toContain('  reminder: #6 is parked, not verified (omg factory run status 6)');
        // The trusted run's command comes from the gate table (reminderCommand), not from its reason.
        expect(text).toMatch(/ {2}reminder: #7 has waited \d+ h at ci-failed: checks failed on the PR \(omg factory run 7\)/);
        expect(text).toMatch(/ {2}OUTSIDE {2}#5 +not verified {2}omg factory run status 5/);
        expect(leaked(text.split('\n').filter((l) => !l.includes('attention:')).join('\n'))).toEqual([]);
    });
    it('omg factory poll --prs: no forge read and no PR line from an untrusted state; never idle while one exists', async () => {
        plant();
        const calls = [];
        const deps = { ...pollDeps(), exec: ((cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return exec(cmd, args); }) };
        expect(await runFactoryPoll({ once: true, json: true, heal: false, intake: false, prs: true }, deps)).toBe(0);
        const t = JSON.parse(out[out.length - 1]);
        expect(t.prs).toEqual([]);
        expect(calls.filter((c) => c.includes('31337'))).toEqual([]);
        expect(t.idle).toBe(false);
        expect(leaked(JSON.stringify({ prs: t.prs, errors: t.errors }))).toEqual([]);
    });
    it('staleGateReminders: an untrusted run is reminded once per window from its first sighting, never with its fields', () => {
        const s = parked(5, 'mrkz-gate');
        const runs = new Map([[5, s]]);
        const untrusted = new Set([5]);
        const at = Date.parse(T0);
        expect(staleGateReminders({ root, ledgerDir, runs, untrusted, nowMs: at, afterHours: 24 })).toEqual([]);
        expect(staleGateReminders({ root, ledgerDir, runs, untrusted, nowMs: at + 23 * 3_600_000, afterHours: 24 })).toEqual([]);
        expect(staleGateReminders({ root, ledgerDir, runs, untrusted, nowMs: at + 24 * 3_600_000, afterHours: 24 })).toEqual([{ run: 5, verified: false, next: 'omg factory run status 5' }]);
        expect(staleGateReminders({ root, ledgerDir, runs, untrusted, nowMs: at + 25 * 3_600_000, afterHours: 24 })).toEqual([]);
    });
});
describe('board: a forged finished state', () => {
    it('a real run whose state a lane replaced with a sealed terminal phase keeps its "not verified" outside row; no forge read for it or any unverified state', async () => {
        plant();
        // #8: the engine's park (recorded), then a lane's sealed "cancelled" state in its place.
        const real = parked(8, 'merge');
        write(real, { ledger: true });
        write(moveTo({ ...real, gate: undefined }, 'cancelled', 'MRKZ', T0));
        const calls = [];
        const deps = { exec: ((cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return exec(cmd, args); }), base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge, now: () => now, ledgerDir, out: (l) => out.push(l), err: () => { } };
        expect(await runFactoryBoard({ json: true }, deps)).toBe(0);
        const b = JSON.parse(out.join('\n'));
        expect(b.outside.find((r) => r.id === 8)).toEqual({ id: 8, title: '', url: '', stage: {}, flags: [], verified: false, next: 'omg factory run status 8' });
        // recordHumanMerges checks the seal and the engine ledger before any PR read: the planted PR numbers are never read.
        expect(calls.filter((c) => c.startsWith('gh pr view') || c.startsWith('gh api'))).toEqual([]);
        expect(leaked(JSON.stringify(b))).toEqual([]);
    });
});
describe('readRuns with a ledger: the attention collector\'s capped key selection', () => {
    it('every ledger-recorded run, then at most MAX_UNRECORDED_STATES other files; the rest counted in `omitted`', () => {
        mkdirSync(factoryStateDir(root), { recursive: true });
        for (let k = 0; k < MAX_UNRECORDED_STATES + 50; k++)
            writeFileSync(factoryStatePath(root, 1000 + k), '{}');
        // Recorded, and sorted after every forged file.
        write(parked(99_999, 'merge'), { ledger: true });
        const r = readRuns(root, [], ledgerDir);
        expect(r.runs.has(99_999)).toBe(true);
        expect(r.untrusted.has(99_999)).toBe(false);
        expect(r.runs.size + r.broken.size).toBe(MAX_UNRECORDED_STATES + 1);
        expect(r.omitted).toBe(50);
    });
});
//# sourceMappingURL=board-unverified.test.js.map