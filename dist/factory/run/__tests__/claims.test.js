import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFactoryClaim, claimRepoKey, factoryClaimHolder, factoryClaimPath, factoryClaimRepo, listFactoryClaims, removeFactoryClaim } from '../claims.js';
import { EXIT_BUSY as ENGINE_EXIT_BUSY } from '../engine.js';
import { acquireFactoryOwner, acquireFactoryRepoOwner, describeOwner, EXIT_BUSY, FactoryBusyError, FactoryStateError, factoryOwnerPath, factoryRepoOwnerPath, factoryStatePath, ownerHolding, refuseWhileEngineRuns, } from '../state.js';
const NOW = '2026-11-09T04:00:00.000Z';
const URL = 'https://github.com/o/r.git';
const live = (pid, host = 'h') => ({ pid, hostname: host, isAlive: () => true });
const dead = (pid, host = 'h') => ({ pid, hostname: host, isAlive: () => false });
let dir;
let ledger;
let cloneA;
let cloneB;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-factory-claims-'));
    ledger = join(dir, 'ledger');
    cloneA = join(dir, 'a');
    cloneB = join(dir, 'b');
    // Each clone is its own git repository: its factory state lives in it (getOmcRoot), never in a shared or home .omg.
    for (const clone of [cloneA, cloneB]) {
        mkdirSync(clone);
        execFileSync('git', ['init', '--quiet', clone], { stdio: 'ignore' });
        expect(factoryStatePath(clone, 1).startsWith(clone)).toBe(true);
    }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
/** The run state of `key` in `root` with `phase` (only `phase` is read by the claim check), or a raw string. */
function runState(root, key, phase) {
    const path = factoryStatePath(root, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof phase === 'string' ? JSON.stringify({ phase }) : phase.raw);
}
const busyOf = (fn) => {
    try {
        fn();
    }
    catch (error) {
        expect(error).toBeInstanceOf(FactoryBusyError);
        return error;
    }
    throw new Error('expected a FactoryBusyError');
};
describe('cross-clone run claims', () => {
    it('busy is exit 6, the same constant from state.ts and engine.ts', () => {
        expect(EXIT_BUSY).toBe(6);
        expect(ENGINE_EXIT_BUSY).toBe(EXIT_BUSY);
    });
    it('every spelling of one GitHub repository shares the claim directory, github.com aliases included; other repositories do not', () => {
        const key = claimRepoKey(URL, cloneA);
        for (const url of ['https://github.com/O/R', 'git@github.com:o/r.git', 'ssh://git@ssh.github.com:443/o/r.git', 'https://www.github.com/o/r'])
            expect(claimRepoKey(url, cloneB), url).toBe(key);
        expect(claimRepoKey('https://github.com/o/other', cloneA)).not.toBe(key);
        expect(claimRepoKey('https://ghe.example.com/o/r', cloneA)).not.toBe(key);
        expect(factoryClaimPath(ledger, URL, cloneA, 7)).toBe(factoryClaimPath(ledger, URL, cloneB, 7));
        expect(factoryClaimPath(ledger, URL, cloneA, 7)).not.toBe(factoryClaimPath(ledger, URL, cloneA, 8));
    });
    it('a local origin path is one key however it is spelled: relative to the checkout, "..", file://, a link; case folds only on win32 and darwin', () => {
        const repo = join(dir, 'src-repo');
        mkdirSync(repo);
        const key = claimRepoKey(repo, cloneA, 'linux');
        expect(claimRepoKey('../src-repo', cloneA, 'linux')).toBe(key);
        expect(claimRepoKey(join(dir, 'a', '..', 'src-repo'), cloneB, 'linux')).toBe(key);
        expect(claimRepoKey(`file://${repo}`, cloneB, 'linux')).toBe(key);
        expect(claimRepoKey(`${repo}.git`, cloneB, 'linux')).not.toBe(claimRepoKey(join(dir, 'other'), cloneB, 'linux'));
        const link = join(dir, 'link');
        symlinkSync(repo, link, 'junction');
        expect(claimRepoKey(link, cloneB, 'linux')).toBe(key);
        // Case: two directories on a case-sensitive filesystem, one on a case-folding one.
        expect(claimRepoKey('/X/Repo', cloneA, 'linux')).not.toBe(claimRepoKey('/x/repo', cloneA, 'linux'));
        expect(claimRepoKey('/X/Repo', cloneA, 'darwin')).toBe(claimRepoKey('/x/repo', cloneA, 'darwin'));
    });
    it('the claim repository is the origin URL, read-only; no origin, a failing or throwing exec: none', () => {
        const calls = [];
        const exec = (out) => (cmd, args) => { calls.push([cmd, ...args]); return { ...out, stderr: '' }; };
        expect(factoryClaimRepo(exec({ status: 0, stdout: `${URL}\n` }), cloneA)).toBe(URL);
        expect(calls).toEqual([['git', 'remote', 'get-url', 'origin']]);
        expect(factoryClaimRepo(exec({ status: 2, stdout: '' }), cloneA)).toBeNull();
        expect(factoryClaimRepo(() => { throw new Error('unscripted'); }, cloneA)).toBeNull();
    });
    it('a live claim from another clone refuses with a FactoryBusyError naming that clone and the claim file; release frees it', () => {
        const a = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
        const caught = busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)));
        expect(caught).toBeInstanceOf(FactoryStateError);
        expect(caught.message).toBe(`factory run #7 is claimed by a live engine (7, pid 1 on h since ${NOW} in ${cloneA}); one engine runs an item at a time across clones (claim file ${factoryClaimPath(ledger, URL, cloneA, 7)})`);
        // Another item and another repository are independent.
        acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, live(2)).release();
        acquireFactoryClaim(ledger, 'https://github.com/o/other', cloneB, 7, NOW, live(2)).release();
        // Only the owner's release removes the claim.
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'live', claim: { pid: 1, run: '7', root: cloneA } });
        a.release();
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toBeNull();
        acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)).release();
    });
    it('a parked claim (the run stopped before a terminal phase) holds while that checkout\'s run is not terminal; its own checkout takes it back', () => {
        runState(cloneA, 7, 'plan');
        acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1)).park('2026-11-09T05:00:00.000Z');
        expect(JSON.parse(readFileSync(factoryClaimPath(ledger, URL, cloneA, 7), 'utf8'))).toEqual({ hostname: 'h', startedAt: NOW, run: '7', root: cloneA, parkedAt: '2026-11-09T05:00:00.000Z' });
        const caught = busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)));
        expect(caught.message).toMatch(/^factory run #7 is claimed by a run parked at plan \(7, no live process on h since .* in .*\).*; if no engine will resume it, omg factory run release 7 removes the claim$/);
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'parked' });
        // The claiming checkout resumes its own run.
        const back = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(3));
        expect(back.tookOver).toMatchObject({ root: cloneA, parkedAt: '2026-11-09T05:00:00.000Z' });
        back.park(NOW);
        // Terminal there: free.
        runState(cloneA, 7, 'merged');
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toBeNull();
        acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)).release();
    });
    it('a crashed engine\'s claim (dead pid) holds the same way; without run state there it is free', () => {
        acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
        expect(acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, dead(2)).tookOver).toMatchObject({ pid: 1, root: cloneA });
        acquireFactoryClaim(ledger, URL, cloneA, 8, NOW, live(1));
        runState(cloneA, 8, 'implement');
        expect(busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, dead(2))).message).toMatch(/claimed by a run parked at implement \(8, pid 1 on h/);
        // Another host's claim always holds: its pid cannot be checked here.
        expect(() => acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, dead(3, 'other-host'))).toThrow(FactoryBusyError);
    });
    it('a claim whose checkout, run state or own file cannot be read is held and reported, never taken over', () => {
        const write = (key, v) => {
            const path = factoryClaimPath(ledger, URL, cloneA, key);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v));
            return path;
        };
        const parked = (root) => ({ hostname: 'h', startedAt: NOW, run: '7', root, parkedAt: NOW });
        write(7, parked(join(dir, 'gone')));
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/its checkout .*gone is missing/) });
        write(7, parked('relative/path'));
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/names no usable checkout/) });
        runState(cloneA, 7, { raw: '{oops' });
        write(7, parked(cloneA));
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/run state in .* is unreadable/) });
        const path = write(9, '{not json');
        expect(busyOf(() => acquireFactoryClaim(ledger, URL, cloneB, 9, NOW, live(2))).message).toContain(`the claim file ${path} is unreadable`);
        expect(readFileSync(path, 'utf8')).toBe('{not json');
        expect(listFactoryClaims(ledger, URL, cloneB, live(2)).map((c) => [c.key, c.state])).toEqual([[7, 'unreadable'], [9, 'unreadable']]);
    });
    it('removeFactoryClaim: a live holder is busy; a parked claim goes; onlyRoot keeps another checkout\'s claim', () => {
        const a = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
        expect(() => removeFactoryClaim(ledger, URL, cloneB, 7, { deps: live(2) })).toThrow(FactoryBusyError);
        runState(cloneA, 7, 'review');
        a.park(NOW);
        expect(removeFactoryClaim(ledger, URL, cloneB, 7, { onlyRoot: true, deps: live(2) })).toBeNull();
        expect(existsSync(factoryClaimPath(ledger, URL, cloneA, 7))).toBe(true);
        expect(removeFactoryClaim(ledger, URL, cloneA, 7, { onlyRoot: true, deps: live(2) })).toBe(factoryClaimPath(ledger, URL, cloneA, 7));
        acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1)).park(NOW);
        expect(removeFactoryClaim(ledger, URL, cloneB, 7, { deps: live(2) })).toBe(factoryClaimPath(ledger, URL, cloneB, 7));
        expect(removeFactoryClaim(ledger, URL, cloneB, 7, { deps: live(2) })).toBeNull();
    });
    it('the checkout and item owner files refuse with a FactoryBusyError too; the repo owner names separate clones', () => {
        acquireFactoryRepoOwner(cloneA, 7, NOW, live(1));
        expect(() => acquireFactoryRepoOwner(cloneA, 8, NOW, live(2))).toThrow(FactoryBusyError);
        expect(() => acquireFactoryRepoOwner(cloneA, 8, NOW, live(2))).toThrow(/one engine runs per checkout at a time, so start 8 after it ends \(parallel runs need separate clones\)/);
        expect(() => refuseWhileEngineRuns(cloneA, live(2))).toThrow(/another omg factory engine runs in this repository \(7, pid 1 on h/);
        expect(() => refuseWhileEngineRuns(cloneA, dead(2))).not.toThrow();
        acquireFactoryOwner(cloneA, 7, NOW, live(1));
        expect(() => acquireFactoryOwner(cloneA, 7, NOW, live(2))).toThrow(FactoryBusyError);
    });
    it('relabel rewrites the held engine lock\'s run (run --next after its pick); release removes only its own file', () => {
        const held = acquireFactoryRepoOwner(cloneA, 'next', NOW, live(1));
        expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 1, run: 'next' });
        held.relabel('12');
        expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 1, run: '12' });
        acquireFactoryRepoOwner(cloneA, 9, NOW, dead(2));
        held.relabel('13');
        held.release();
        expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 2, run: '9' });
    });
});
describe('owner files: one rule for unreadable files, start identity, plain text', () => {
    const path = () => join(dir, 'x.owner');
    const write = (v) => { mkdirSync(dirname(path()), { recursive: true }); writeFileSync(path(), typeof v === 'string' ? v : JSON.stringify(v)); };
    it('ownerHolding: null without a file, for a dead pid on this host and for the caller itself', () => {
        expect(ownerHolding(path(), live(2))).toBeNull();
        write({ pid: 1, hostname: 'h', startedAt: NOW });
        expect(ownerHolding(path(), dead(2))).toBeNull();
        expect(ownerHolding(path(), live(1))).toBeNull();
    });
    it('ownerHolding: the owner for a live pid here or any pid on another host; unreadable for a malformed file', () => {
        write({ pid: 1, hostname: 'h', startedAt: NOW });
        expect(ownerHolding(path(), live(2))).toMatchObject({ pid: 1 });
        expect(ownerHolding(path(), dead(2, 'other'))).toMatchObject({ pid: 1 });
        write('{not json');
        expect(ownerHolding(path(), live(2))).toBe('unreadable');
        write({ pid: 'x', hostname: 'h' });
        expect(ownerHolding(path(), live(2))).toBe('unreadable');
    });
    it('an unreadable engine lock or item owner file is held: never taken over, never "not busy"', () => {
        const lock = factoryRepoOwnerPath(cloneA);
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, '{truncated');
        expect(busyOf(() => acquireFactoryRepoOwner(cloneA, 7, NOW, dead(2))).message).toBe(`the owner file ${lock} is unreadable, so it counts as held; check that no engine uses it, then remove it (omg factory run release)`);
        expect(readFileSync(lock, 'utf8')).toBe('{truncated');
        expect(() => refuseWhileEngineRuns(cloneA, dead(2))).toThrow(/is unreadable, so it counts as held/);
    });
    it('a live pid whose start identity changed (a reused pid) does not hold; an unknown identity still holds', () => {
        const withIdentity = (pid, ids) => ({ ...live(pid), identityOf: (p) => ids[p] ?? null });
        const first = acquireFactoryRepoOwner(cloneA, 7, NOW, withIdentity(1, { 1: 'ticks:100' }));
        expect(JSON.parse(readFileSync(factoryRepoOwnerPath(cloneA), 'utf8'))).toMatchObject({ pid: 1, identity: 'ticks:100' });
        expect(ownerHolding(factoryRepoOwnerPath(cloneA), withIdentity(2, { 1: 'ticks:100' }))).toMatchObject({ pid: 1 });
        expect(ownerHolding(factoryRepoOwnerPath(cloneA), withIdentity(2, {}))).toMatchObject({ pid: 1 });
        expect(ownerHolding(factoryRepoOwnerPath(cloneA), withIdentity(2, { 1: 'ticks:999' }))).toBeNull();
        expect(acquireFactoryRepoOwner(cloneA, 8, NOW, withIdentity(2, { 1: 'ticks:999' })).tookOver).toMatchObject({ pid: 1 });
        first.release();
        // The same rule for claims.
        acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, withIdentity(1, { 1: 'ticks:100' }));
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, withIdentity(2, { 1: 'ticks:100' }))).toMatchObject({ state: 'live' });
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, withIdentity(2, { 1: 'ticks:5' }))).toBeNull();
    });
    it('owner text is printed as plain text: no escape sequence or control character from the file', () => {
        expect(describeOwner({ pid: 1, hostname: 'h\u001b[2Jx', startedAt: 'now\nFAKE: ok', run: '7\u0007', root: `/r${String.fromCharCode(0x202e)}` })).toBe('7 , pid 1 on hx since now FAKE: ok in /r ');
        mkdirSync(dirname(factoryOwnerPath(cloneA, 1)), { recursive: true });
        writeFileSync(factoryOwnerPath(cloneA, 1), JSON.stringify({ pid: 1, hostname: 'h', startedAt: '\u001b]0;pwned\u0007' }));
        expect(busyOf(() => acquireFactoryOwner(cloneA, 1, NOW, live(2))).message).not.toMatch(/\u001b|\u0007/);
    });
});
//# sourceMappingURL=claims.test.js.map