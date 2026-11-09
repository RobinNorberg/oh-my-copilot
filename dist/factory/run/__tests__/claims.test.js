import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFactoryClaim, claimRepoKey, factoryClaimHolder, factoryClaimPath } from '../claims.js';
import { EXIT_BUSY as ENGINE_EXIT_BUSY } from '../engine.js';
import { acquireFactoryOwner, acquireFactoryRepoOwner, EXIT_BUSY, FactoryBusyError, FactoryStateError, ownerHolding } from '../state.js';
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
    mkdirSync(cloneA);
    mkdirSync(cloneB);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('cross-clone run claims', () => {
    it('busy is exit 6, the same constant from state.ts and engine.ts', () => {
        expect(EXIT_BUSY).toBe(6);
        expect(ENGINE_EXIT_BUSY).toBe(EXIT_BUSY);
    });
    it('every spelling of one forge repository shares the claim directory; other repositories do not', () => {
        const key = claimRepoKey(URL, cloneA);
        expect(claimRepoKey('https://github.com/O/R', cloneB)).toBe(key);
        expect(claimRepoKey('git@github.com:o/r.git', cloneB)).toBe(key);
        expect(claimRepoKey('https://github.com/o/other', cloneA)).not.toBe(key);
        expect(factoryClaimPath(ledger, URL, cloneA, 7)).toBe(factoryClaimPath(ledger, URL, cloneB, 7));
        expect(factoryClaimPath(ledger, URL, cloneA, 7)).not.toBe(factoryClaimPath(ledger, URL, cloneA, 8));
    });
    it('a relative local mirror path is resolved against the checkout, an absolute one is shared', () => {
        expect(claimRepoKey('mirror.git', cloneA)).not.toBe(claimRepoKey('mirror.git', cloneB));
        const abs = join(dir, 'mirror.git');
        expect(claimRepoKey(abs, cloneA)).toBe(claimRepoKey(abs, cloneB));
    });
    it('a live claim from another clone refuses with a FactoryBusyError naming that clone; release frees it', () => {
        const a = acquireFactoryClaim(ledger, URL, cloneA, 7, NOW, live(1));
        let caught;
        try {
            acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2));
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(FactoryBusyError);
        expect(caught).toBeInstanceOf(FactoryStateError);
        expect(caught.message).toBe(`factory run #7 is claimed by an engine in ${cloneA} (pid 1 on h since ${NOW}); one engine runs an item at a time across clones`);
        // Another item and another repository are independent.
        acquireFactoryClaim(ledger, URL, cloneB, 8, NOW, live(2)).release();
        acquireFactoryClaim(ledger, 'https://github.com/o/other', cloneB, 7, NOW, live(2)).release();
        // Only the owner's release removes the claim.
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toMatchObject({ pid: 1, run: '7', root: cloneA });
        a.release();
        expect(factoryClaimHolder(ledger, URL, cloneB, 7, live(2))).toBeNull();
        acquireFactoryClaim(ledger, URL, cloneB, 7, NOW, live(2)).release();
    });
    it('a dead claim on this host is taken over; another host\'s claim always refuses', () => {
        acquireFactoryClaim(ledger, URL, cloneA, 'heal-0123abcd', NOW, live(1));
        const took = acquireFactoryClaim(ledger, URL, cloneB, 'heal-0123abcd', NOW, dead(2));
        expect(took.tookOver).toMatchObject({ pid: 1, root: cloneA });
        expect(JSON.parse(readFileSync(factoryClaimPath(ledger, URL, cloneB, 'heal-0123abcd'), 'utf8'))).toMatchObject({ pid: 2, run: 'heal-0123abcd', root: cloneB });
        expect(() => acquireFactoryClaim(ledger, URL, cloneA, 'heal-0123abcd', NOW, dead(3, 'other-host'))).toThrow(FactoryBusyError);
    });
    it('the checkout and item owner files refuse with a FactoryBusyError too; the repo owner names separate clones', () => {
        acquireFactoryRepoOwner(cloneA, 7, NOW, live(1));
        expect(() => acquireFactoryRepoOwner(cloneA, 8, NOW, live(2))).toThrow(FactoryBusyError);
        expect(() => acquireFactoryRepoOwner(cloneA, 8, NOW, live(2))).toThrow(/one engine runs per checkout at a time, so start 8 after it ends \(parallel runs need separate clones\)/);
        acquireFactoryOwner(cloneA, 7, NOW, live(1));
        expect(() => acquireFactoryOwner(cloneA, 7, NOW, live(2))).toThrow(FactoryBusyError);
    });
});
describe('ownerHolding (read-only)', () => {
    const path = () => join(dir, 'x.owner');
    const write = (v) => { mkdirSync(dirname(path()), { recursive: true }); writeFileSync(path(), typeof v === 'string' ? v : JSON.stringify(v)); };
    it('null without a file, for a dead pid on this host and for the caller itself', () => {
        expect(ownerHolding(path(), live(2))).toBeNull();
        write({ pid: 1, hostname: 'h', startedAt: NOW });
        expect(ownerHolding(path(), dead(2))).toBeNull();
        expect(ownerHolding(path(), live(1))).toBeNull();
    });
    it('the owner for a live pid here or any pid on another host; unreadable for a malformed file', () => {
        write({ pid: 1, hostname: 'h', startedAt: NOW });
        expect(ownerHolding(path(), live(2))).toMatchObject({ pid: 1 });
        expect(ownerHolding(path(), dead(2, 'other'))).toMatchObject({ pid: 1 });
        write('{not json');
        expect(ownerHolding(path(), live(2))).toBe('unreadable');
        write({ pid: 'x', hostname: 'h' });
        expect(ownerHolding(path(), live(2))).toBe('unreadable');
    });
});
//# sourceMappingURL=claims.test.js.map