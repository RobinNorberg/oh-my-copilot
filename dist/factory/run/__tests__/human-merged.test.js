import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from '../../../ship/exec.js';
import { createShipState, readShipState, transition, updateShipState } from '../../../ship/state.js';
import { forgePrStateReader, humanMergeCandidate, humanMergeLines, markMergedByHuman, recordHumanMerge, recordHumanMerges } from '../human-merged.js';
import { currentBytes, EngineLedger } from '../ledger.js';
import { acquireFactoryOwner, createFactoryState, factoryStatePath, readFactoryState, updateFactoryState } from '../state.js';
import { tamperHoldPath } from '../tamper-quarantine.js';
import { gitIn } from './fake-lanes.js';
const ISSUE = 505;
const PR = 515;
const HEAD = 'a'.repeat(40);
const NOW = '2026-11-12T20:00:00.000Z';
const OWNER = { pid: 4242, hostname: 'test-host', isAlive: () => false };
let dir;
let root;
let ledgerDir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-human-merged-'));
    root = join(dir, 'repo');
    ledgerDir = join(dir, 'ledger');
    mkdirSync(join(root, '.git'), { recursive: true });
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
const ledger = () => EngineLedger.open(ledgerDir, root, ISSUE);
/** A run state written as the engine would (recorded in its ledger). */
function engineState(mutate) {
    const l = ledger();
    updateFactoryState(root, ISSUE, () => mutate({ ...createFactoryState({ issue: ISSUE, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW), pr: PR, head: HEAD }), { onWrite: (p, c) => l.record(p, c) });
}
const cancelled = (s) => ({ ...s, phase: 'cancelled' });
const fixFailed = (s) => ({ ...s, phase: 'fix', gate: { name: 'fix-failed', reason: 'the lane left no changes', at: NOW } });
const reader = (state) => {
    const f = Object.assign(() => { f.calls += 1; return state; }, { calls: 0 });
    f.calls = 0;
    return f;
};
const opts = (readPrState) => ({ readPrState, ledgerDir, now: () => NOW, owner: OWNER });
describe('humanMergeCandidate', () => {
    const base = { pr: PR };
    it.each([
        ['cancelled with a PR', { ...base, phase: 'cancelled' }, true],
        ['failed with a PR', { ...base, phase: 'failed' }, true],
        ['parked with a PR', { ...base, phase: 'fix', gate: { name: 'fix-failed', reason: 'x', at: NOW } }, true],
        ['parked at a tamper park', { ...base, phase: 'fix', gate: { name: 'state-tampered', reason: 'x', at: NOW } }, false],
        ['running (no gate)', { ...base, phase: 'fix' }, false],
        ['already merged', { ...base, phase: 'merged' }, false],
        ['cancelled without a PR', { pr: undefined, phase: 'cancelled' }, false],
    ])('%s', (_name, s, want) => {
        expect(humanMergeCandidate(s)).toBe(want);
    });
    it('markMergedByHuman clears the gate and the cancel request and notes the previous state', () => {
        const s = markMergedByHuman({ ...fixFailed(createFactoryState({ issue: ISSUE, repoUrl: '', base: 'dev' }, NOW)), pr: PR, cancelRequested: true }, NOW);
        expect(s.phase).toBe('merged');
        expect(s.gate).toBeUndefined();
        expect(s.cancelRequested).toBeUndefined();
        expect(s.history.at(-1)).toEqual({ at: NOW, from: 'fix', to: 'merged', note: `PR #${PR} merged by a human after awaiting-human: fix-failed` });
    });
});
describe('recordHumanMerge (status, board, dashboard)', () => {
    it('cancelled + merged PR: recorded merged in the state and the engine ledger', () => {
        engineState(cancelled);
        const r = recordHumanMerge(root, ISSUE, opts(reader('MERGED')));
        expect(r.kind).toBe('merged');
        const s = readFactoryState(root, ISSUE);
        expect(s.phase).toBe('merged');
        expect(s.history.at(-1)?.note).toBe(`PR #${PR} merged by a human after cancelled`);
        const path = factoryStatePath(root, ISSUE);
        expect(ledger().matches(path, currentBytes(path))).toBe(true);
        expect(ledger().mismatches()).toEqual([]);
        expect(humanMergeLines([r])).toEqual([`run #${ISSUE}: PR #${PR} was merged by a human after cancelled; recorded the run as merged`]);
    });
    it('parked at fix-failed + merged PR: merged, gate cleared; ship follows when it is the engine\'s own', () => {
        engineState(fixFailed);
        const l = ledger();
        const ready = ['prepare', 'gates', 'ready'];
        updateShipState(root, PR, () => ready.reduce((s, to) => transition(s, to, 'x', NOW), createShipState({ pr: PR, base: 'dev', implementer: 'factory-505', maxFixRounds: 3 }, NOW)), { onWrite: (p, c) => l.record(p, c) });
        const r = recordHumanMerge(root, ISSUE, opts(reader('MERGED')));
        expect(r.kind).toBe('merged');
        const s = readFactoryState(root, ISSUE);
        expect(s.phase).toBe('merged');
        expect(s.gate).toBeUndefined();
        expect(readShipState(root, PR).phase).toBe('merged');
        expect(ledger().mismatches()).toEqual([]);
    });
    it('a failed PR read changes nothing and says so', () => {
        engineState(cancelled);
        const r = recordHumanMerge(root, ISSUE, opts(() => { throw new Error('HTTP 502'); }));
        expect(r).toMatchObject({ kind: 'unchanged', readFailed: true });
        expect(readFactoryState(root, ISSUE).phase).toBe('cancelled');
        expect(humanMergeLines([r])).toEqual([`run #${ISSUE}: not checked for a human merge: PR #${PR} could not be read: HTTP 502`]);
    });
    it('a closed PR changes nothing and says so', () => {
        engineState(fixFailed);
        const r = recordHumanMerge(root, ISSUE, opts(reader('CLOSED')));
        expect(r.kind).toBe('closed');
        expect(readFactoryState(root, ISSUE).gate?.name).toBe('fix-failed');
        expect(humanMergeLines([r])[0]).toMatch(/was closed without merging; the run stays as it is/);
    });
    it('an open PR changes nothing and prints nothing', () => {
        engineState(cancelled);
        const r = recordHumanMerge(root, ISSUE, opts(reader('OPEN')));
        expect(r.kind).toBe('unchanged');
        expect(humanMergeLines([r])).toEqual([]);
    });
    it('a state that is not the engine\'s last write is not read on the forge or written', () => {
        engineState(cancelled);
        updateFactoryState(root, ISSUE, (s) => ({ ...s, updatedAt: '2026-11-12T21:00:00.000Z' }));
        const read = reader('MERGED');
        const r = recordHumanMerge(root, ISSUE, opts(read));
        expect(r).toMatchObject({ kind: 'unchanged', reason: expect.stringMatching(/not the engine's last write/) });
        expect(read.calls).toBe(0);
        expect(readFactoryState(root, ISSUE).phase).toBe('cancelled');
    });
    it('a live engine on the run: nothing is written', () => {
        engineState(cancelled);
        const live = { pid: 4343, hostname: 'test-host', isAlive: () => true };
        const held = acquireFactoryOwner(root, ISSUE, NOW, live);
        try {
            const r = recordHumanMerge(root, ISSUE, { ...opts(reader('MERGED')), owner: { ...OWNER, isAlive: () => true } });
            expect(r).toMatchObject({ kind: 'unchanged', reason: expect.stringMatching(/an engine is running the run/) });
            expect(readFactoryState(root, ISSUE).phase).toBe('cancelled');
        }
        finally {
            held.release();
        }
    });
    it('recordHumanMerges reads only candidates', () => {
        engineState((s) => ({ ...s, phase: 'fix' }));
        const read = reader('MERGED');
        expect(recordHumanMerges(root, [[ISSUE, readFactoryState(root, ISSUE)]], opts(read))).toEqual([]);
        expect(read.calls).toBe(0);
    });
});
describe('recordHumanMerge: skipped runs', () => {
    it('a run parked at a tamper park is not read on the forge or written', () => {
        engineState((s) => ({ ...s, phase: 'fix', gate: { name: 'lane-tampered', reason: 'x', at: NOW } }));
        const read = reader('MERGED');
        expect(recordHumanMerge(root, ISSUE, opts(read))).toMatchObject({ kind: 'unchanged', reason: 'not a stopped run with a PR' });
        expect(read.calls).toBe(0);
        expect(readFactoryState(root, ISSUE).gate?.name).toBe('lane-tampered');
    });
    it('a tamper hold on the checkout: unchanged, no forge read', () => {
        engineState(cancelled);
        mkdirSync(dirname(tamperHoldPath(ledgerDir, root)), { recursive: true });
        writeFileSync(tamperHoldPath(ledgerDir, root), JSON.stringify({ run: ISSUE, at: NOW, gate: 'lane-tampered' }));
        const read = reader('MERGED');
        expect(recordHumanMerge(root, ISSUE, opts(read))).toMatchObject({ kind: 'unchanged', reason: expect.stringMatching(/tamper hold/) });
        expect(read.calls).toBe(0);
        expect(readFactoryState(root, ISSUE).phase).toBe('cancelled');
    });
    it('the ledger is re-read after the owner file: an entry the engine added during the forge read is kept', () => {
        engineState(cancelled);
        const other = join(root, '.omg', 'other.json');
        const read = () => {
            // Another engine write lands in the ledger while the forge is read.
            ledger().record(other, '{"x":1}');
            return 'MERGED';
        };
        expect(recordHumanMerge(root, ISSUE, opts(read)).kind).toBe('merged');
        expect(ledger().tracks(other)).toBe(true);
        const path = factoryStatePath(root, ISSUE);
        expect(ledger().matches(path, currentBytes(path))).toBe(true);
    });
});
describe('forgePrStateReader', () => {
    const REPO = 'https://github.com/o/r';
    const run = (over) => ({ ...createFactoryState({ issue: ISSUE, repoUrl: REPO, base: 'dev' }, NOW), pr: PR, head: HEAD, ...over });
    const forge = (kind, state, view = {}) => ({
        kind,
        reviews: {
            prHead: () => ({ headRefOid: HEAD, state }),
            viewPr: () => ({ number: PR, state, isDraft: false, baseRefName: view.base ?? 'dev', baseRefOid: 'b'.repeat(40), headRefName: 'factory/505', headRefOid: view.head ?? HEAD, url: '' }),
        },
    });
    const noGit = () => { throw new Error('no git expected'); };
    it('GitHub and Azure DevOps: the adapter\'s PR state', () => {
        expect(forgePrStateReader(forge('github', 'MERGED'), noGit, root, REPO)(run({}))).toBe('MERGED');
        expect(forgePrStateReader(forge('azure-devops', 'CLOSED'), noGit, root, REPO)(run({ forgeKind: 'azure-devops' }))).toBe('CLOSED');
        expect(() => forgePrStateReader(forge('github', 'WEIRD'), noGit, root, REPO)(run({}))).toThrow(/unknown state/);
    });
    it('GitHub: a PR merged into another base than the run\'s is a read error', () => {
        expect(() => forgePrStateReader(forge('github', 'MERGED', { base: 'main' }), noGit, root, REPO)(run({}))).toThrow(/merged into main, not the run's base dev/);
        expect(forgePrStateReader(forge('github', 'OPEN', { base: 'main' }), noGit, root, REPO)(run({}))).toBe('OPEN');
    });
    it('a forge config that names another repository than the run\'s: a read error, and recordHumanMerge changes nothing', () => {
        const readPrState = forgePrStateReader(forge('github', 'MERGED'), noGit, root, 'https://github.com/o/other');
        expect(() => readPrState(run({}))).toThrow(/started in https:\/\/github.com\/o\/r, but the forge now resolves to https:\/\/github.com\/o\/other/);
        engineState(cancelled);
        expect(recordHumanMerge(root, ISSUE, opts(readPrState))).toMatchObject({ kind: 'unchanged', readFailed: true });
        expect(readFactoryState(root, ISSUE).phase).toBe('cancelled');
    });
    describe('the local forge', () => {
        const MIRROR = join(tmpdir(), 'mirror.git');
        const local = run({ remote: 'omg-local', forgeKind: 'local', repoUrl: MIRROR });
        /** git answers: no replace refs or grafts, merge-base exits `status`. */
        const git = (status, calls = []) => (cmd, args) => {
            calls.push([cmd, ...args]);
            if (args[0] === 'rev-parse')
                return { status: 0, stdout: '.git\n', stderr: '' };
            if (args[0] === 'for-each-ref')
                return { status: 0, stdout: '', stderr: '' };
            return { status, stdout: '', stderr: '' };
        };
        it('merged only when your base contains the pushed head and the store still names that head', () => {
            const calls = [];
            expect(forgePrStateReader(forge('local', 'OPEN'), git(0, calls), root, MIRROR)(local)).toBe('MERGED');
            expect(calls.find((c) => c[1] === 'merge-base')).toEqual(['git', 'merge-base', '--is-ancestor', HEAD, 'refs/heads/dev']);
            expect(forgePrStateReader(forge('local', 'MERGED'), git(0), root, MIRROR)(local)).toBe('MERGED');
            expect(forgePrStateReader(forge('local', 'MERGED'), git(1), root, MIRROR)(local)).toBe('OPEN');
            expect(forgePrStateReader(forge('local', 'CLOSED'), git(1), root, MIRROR)(local)).toBe('CLOSED');
            expect(() => forgePrStateReader(forge('local', 'OPEN'), git(128), root, MIRROR)(local)).toThrow(/merge-base/);
        });
        it('a store record that names another head or base: a read error, never merged', () => {
            expect(() => forgePrStateReader(forge('local', 'MERGED', { head: 'c'.repeat(40) }), git(0), root, MIRROR)(local)).toThrow(/local PR store names cccccccccccc into dev/);
            expect(() => forgePrStateReader(forge('local', 'OPEN', { base: 'main' }), git(0), root, MIRROR)(local)).toThrow(/into main/);
        });
        it('another mirror than the run\'s: a read error', () => {
            expect(() => forgePrStateReader(forge('local', 'MERGED'), git(0), root, join(tmpdir(), 'other.git'))(local)).toThrow(/finish or cancel the run/);
        });
        it('grafts in a real repository: a read error before merge-base (a fake base history never counts)', () => {
            gitIn(root, 'init', '-q', '-b', 'dev');
            gitIn(root, 'config', 'user.email', 't@example.com');
            gitIn(root, 'config', 'user.name', 't');
            gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'one');
            const head = gitIn(root, 'rev-parse', 'HEAD').trim();
            const r = run({ remote: 'omg-local', forgeKind: 'local', repoUrl: MIRROR, head });
            const view = forge('local', 'MERGED', { head });
            expect(forgePrStateReader(view, defaultExec, root, MIRROR)(r)).toBe('MERGED');
            writeFileSync(join(root, '.git', 'info', 'grafts'), `${head}\n`);
            expect(() => forgePrStateReader(view, defaultExec, root, MIRROR)(r)).toThrow(/replace refs or grafts/);
        });
    });
    it('a run and a forge that disagree on the local forge: a read error', () => {
        expect(() => forgePrStateReader(forge('local', 'MERGED'), noGit, root, REPO)(run({}))).toThrow(/forge resolves to local/);
    });
});
//# sourceMappingURL=human-merged.test.js.map