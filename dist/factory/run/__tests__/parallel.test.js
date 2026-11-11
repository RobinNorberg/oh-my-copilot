/**
 * B2 (parallel private-layout runs in one checkout): slots, the repository
 * import lock and its lock order with the scan lock, the credit reservation,
 * the --parallel supervisor and the atomic --next pick across processes.
 * Real files in temp dirs (each one `git init`-ed so no path falls back to
 * the home dir); no git transport, no Copilot.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { acquireFactoryOwner, acquireFactoryRepoOwner, acquireImportLock, acquireRunSlot, EXIT_BUSY, FactoryBusyError, factoryImportLockPath, factoryRepoOwnerPath, factorySlotPath, heldSlots, ImportLockBusyError, scanWait, SCAN_WAIT_MS, tryScanLock, withRepoImportLock, withRepoImportLockAsync, } from '../state.js';
import { creditReservationPath, parallelLayoutRefusal, releaseDeadCreditReservations, reserveLaneCredits, resolveParallelSettings, runParallelSupervisor } from '../parallel.js';
const HOST = 'test-host';
/** Owner deps of a fake process `pid`; `alive` is the set of pids that run. */
const deps = (pid, alive) => ({ pid, hostname: HOST, isAlive: (p) => alive.has(p) });
const NOW = () => '2026-11-11T00:00:00.000Z';
let dir;
let root;
let t = 0;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-parallel-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    // Everything this suite writes lives under the temp root (getOmcRoot of a git-init'd dir).
    expect(resolve(getOmcRoot(root)).startsWith(resolve(dir))).toBe(true);
    t = 0;
    vi.spyOn(scanWait, 'clock').mockImplementation(() => t);
    vi.spyOn(scanWait, 'sleep').mockImplementation((ms) => { t += ms; });
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
});
describe('slots (factory.run.maxConcurrent)', () => {
    it('a free slot is taken; with all held the start is busy (exit 6) "N runs active (maxConcurrent N)" listing the holders', () => {
        const alive = new Set([101, 102, 103]);
        const a = acquireRunSlot(root, 7, 2, NOW, deps(101, alive));
        const b = acquireRunSlot(root, 8, 2, NOW, deps(102, alive));
        expect([a.slot, b.slot]).toEqual([0, 1]);
        let err;
        try {
            acquireRunSlot(root, 9, 2, NOW, deps(103, alive));
        }
        catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(FactoryBusyError);
        expect(EXIT_BUSY).toBe(6);
        const msg = err.message;
        expect(msg).toMatch(/^2 runs active \(factory\.run\.maxConcurrent 2\): slot 0: 7, pid 101 .*; slot 1: 8, pid 102 /);
        // Released: the next start gets it.
        a.release();
        expect(acquireRunSlot(root, 9, 2, NOW, deps(103, alive)).slot).toBe(0);
    });
    it('a dead holder\'s slot is taken over; a live one never is; an unreadable slot file counts as held', () => {
        const alive = new Set([101, 103]);
        acquireRunSlot(root, 7, 1, NOW, deps(102, new Set([102])));
        // 102 is gone: taken over.
        const s = acquireRunSlot(root, 8, 1, NOW, deps(101, alive));
        expect(s.tookOver?.pid).toBe(102);
        expect(() => acquireRunSlot(root, 9, 1, NOW, deps(103, alive))).toThrow(/1 runs active .*pid 101/);
        s.release();
        writeFileSync(factorySlotPath(root, 0), '{broken');
        expect(() => acquireRunSlot(root, 9, 1, NOW, deps(103, alive))).toThrow(/unreadable, so it counts as held/);
        expect(heldSlots(root, deps(103, alive))).toMatchObject([{ slot: 0, owner: 'unreadable' }]);
    });
    it('a live shared run blocks parallel starts, and a live parallel run blocks a shared start (the engine lock); both name the other', () => {
        const alive = new Set([101, 102]);
        const shared = acquireFactoryRepoOwner(root, 5, NOW(), deps(101, alive));
        expect(() => acquireRunSlot(root, 7, 2, NOW, deps(102, alive))).toThrow(/a shared-layout run holds this checkout's engine lock \(5, pid 101 .*no migration/);
        // The refused start gave its slot back.
        expect(heldSlots(root, deps(102, alive))).toEqual([]);
        shared.release();
        const slot = acquireRunSlot(root, 7, 2, NOW, deps(102, alive));
        expect(() => acquireFactoryRepoOwner(root, 5, NOW(), deps(101, alive))).toThrow(/1 private-layout parallel run\(s\) are active in this checkout \(slot 0: 7, pid 102 /);
        // The refused shared start left no engine lock behind.
        expect(existsSync(factoryRepoOwnerPath(root))).toBe(false);
        slot.release();
        acquireFactoryRepoOwner(root, 5, NOW(), deps(101, alive)).release();
    });
    it('a parallel start waits out a `scan` holder (bounded), then is busy; the scan lock itself is not refused by slots', () => {
        const alive = new Set([101, 102]);
        const scan = tryScanLock(root, NOW(), deps(101, alive));
        expect(scan).not.toBeInstanceOf(FactoryBusyError);
        expect(() => acquireRunSlot(root, 7, 2, NOW, deps(102, alive), 2_000)).toThrow(/heal scan or base sync.*waited 2 s/);
        expect(heldSlots(root, deps(102, alive))).toEqual([]);
        scan.release();
        expect(acquireRunSlot(root, 7, 2, NOW, deps(102, alive)).slot).toBe(0);
    });
});
describe('the repository import lock', () => {
    it('a holder killed mid-section is taken over only after its process is gone; a live one is waited for and never taken over, however long', () => {
        const alive = new Set([101, 102]);
        const holder = acquireImportLock(root, 'import:issue-7', NOW, deps(101, alive));
        void holder;
        // 101 is alive: 102 waits the bound (15 min of fake time here) and is busy, the record untouched.
        let err;
        try {
            acquireImportLock(root, 'import:issue-8', NOW, deps(102, alive), 15 * 60_000);
        }
        catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ImportLockBusyError);
        expect(err.message).toMatch(/import lock .* is held by import:issue-7, pid 101 .*waited 900 s/);
        expect(JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8'))).toMatchObject({ pid: 101, run: 'import:issue-7' });
        // 101 dies mid-section (no release): the next taker gets it at once and names it.
        alive.delete(101);
        const next = acquireImportLock(root, 'import:issue-8', NOW, deps(102, alive));
        expect(next.tookOver).toMatchObject({ pid: 101, run: 'import:issue-7' });
        next.release();
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
    });
    it('is re-entrant within one process (a nested section never takes its own record over) and released at the outermost end', () => {
        const order = [];
        withRepoImportLock(root, 'outer', () => {
            order.push(JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8')).run);
            withRepoImportLock(root, 'inner', () => { order.push(JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8')).run); });
            order.push(existsSync(factoryImportLockPath(root)) ? 'still held' : 'gone');
        });
        expect(order).toEqual(['outer', 'outer', 'still held']);
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
    });
    it('lock order with the scan lock: engine.owner, then import.lock; the scan waits for an import, the import never waits on engine.owner, so no deadlock', () => {
        const alive = new Set([101, 102, 103]);
        // No parallel run: the scan lock is as before (no import lock taken).
        const plain = tryScanLock(root, NOW(), deps(101, alive));
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
        plain.release();
        // A parallel run (slot) is live and imports: a scan takes engine.owner, then waits for import.lock, and is busy after its bound.
        const slot = acquireRunSlot(root, 7, 2, NOW, deps(102, alive));
        const imp = acquireImportLock(root, 'import:issue-7', NOW, deps(102, alive));
        const busy = tryScanLock(root, NOW(), deps(101, alive));
        expect(busy).toBeInstanceOf(ImportLockBusyError);
        // ... and gave engine.owner back (it never holds it while busy).
        expect(existsSync(factoryRepoOwnerPath(root))).toBe(false);
        // While the import holds import.lock, the parallel run never needs engine.owner: a second parallel start is not blocked by it.
        expect(acquireRunSlot(root, 8, 2, NOW, deps(103, alive)).slot).toBe(1);
        imp.release();
        // The import ended: the scan gets both, in order; while it holds them a parallel run's import waits for import.lock.
        const scan = tryScanLock(root, NOW(), deps(101, alive));
        expect(JSON.parse(readFileSync(factoryRepoOwnerPath(root), 'utf8'))).toMatchObject({ run: 'scan' });
        expect(JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8'))).toMatchObject({ run: 'scan', pid: 101 });
        expect(() => acquireImportLock(root, 'import:issue-7', NOW, deps(102, alive), 1_000)).toThrow(ImportLockBusyError);
        scan.release();
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
        expect(existsSync(factoryRepoOwnerPath(root))).toBe(false);
        slot.release();
    });
    it('review-487 M-3: the awaited wait leaves the event loop free (a timer runs while it waits); a stop ends it busy with nothing run; a released holder lets fn run in one turn', async () => {
        const alive = new Set([101, 102]);
        const holder = acquireImportLock(root, 'import:issue-7', NOW, deps(101, alive));
        let stopped = false;
        setTimeout(() => { stopped = true; }, 0);
        let ran = false;
        const err = await withRepoImportLockAsync(root, 'import:issue-8', () => { ran = true; }, { deps: deps(102, alive), now: NOW, stopped: () => stopped, sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 20)); }) }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(ImportLockBusyError);
        expect(err.message).toMatch(/held by import:issue-7, pid 101 .*stopped by a signal while waiting for it \(nothing was done under the lock\)/);
        expect(ran).toBe(false);
        expect(JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8'))).toMatchObject({ pid: 101 });
        // The holder ends between two polls: fn runs under the lock (its own label), released after it.
        let polls = 0;
        const seen = await withRepoImportLockAsync(root, 'import:issue-8', () => JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8')).run, {
            deps: deps(102, alive), now: NOW, sleep: async () => { if (++polls === 2)
                holder.release(); },
        });
        expect(seen).toBe('import:issue-8');
        expect(polls).toBe(2);
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
    });
    it('review-487 L-4: a hold of this process is never taken over by a second acquisition (it refuses); a nested section given the hold runs inside it', () => {
        const alive = new Set([101]);
        const scanLike = acquireImportLock(root, 'scan', NOW, deps(101, alive));
        expect(() => withRepoImportLock(root, 'import:issue-7', () => 'ran unlocked', { deps: deps(101, alive), now: NOW })).toThrow(/this process already holds the repository import lock/);
        expect(JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8'))).toMatchObject({ run: 'scan' });
        expect(withRepoImportLock(root, 'import:issue-7', () => JSON.parse(readFileSync(factoryImportLockPath(root), 'utf8')).run, { held: scanLike })).toBe('scan');
        // Still held by the caller (it releases), then free for the next.
        expect(existsSync(factoryImportLockPath(root))).toBe(true);
        scanLike.release();
        expect(withRepoImportLock(root, 'import:issue-7', () => 'locked', { deps: deps(101, alive), now: NOW })).toBe('locked');
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
    });
    it('review-487 L-6: two processes contend for import.lock for real: only one is inside at a time, both finish, no lock is left', async () => {
        // Each child enters the import section 4 times, writing enter/leave lines around a short hold.
        const script = join(dir, 'contend.ts');
        const log = join(dir, 'contend.log');
        const stateUrl = pathToFileURL(resolve(__dirname, '..', 'state.ts')).href;
        writeFileSync(script, [
            'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
            `import { withRepoImportLock } from ${JSON.stringify(stateUrl)};`,
            'const [root, log, tag] = process.argv.slice(2);',
            // A start barrier (bounded), so both contend at once however slowly each process starts on a loaded runner.
            'writeFileSync(`${log}.ready-${tag}`, "");',
            'const until = Date.now() + 120_000;',
            'while (!(existsSync(`${log}.ready-a`) && existsSync(`${log}.ready-b`)) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
            'for (let i = 0; i < 4; i++) {',
            '  withRepoImportLock(root, `import:${tag}`, () => {',
            '    appendFileSync(log, `enter ${tag}\\n`);',
            '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);',
            '    appendFileSync(log, `leave ${tag}\\n`);',
            '  });',
            '}',
        ].join('\n'));
        const tsx = resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
        await Promise.all(['a', 'b'].map((tag) => new Promise((res, rej) => {
            const p = spawn(process.execPath, [tsx, script, root, log, tag], { stdio: ['ignore', 'pipe', 'pipe'] });
            let err = '';
            p.stderr.on('data', (d) => { err += d.toString(); });
            p.on('close', (code) => (code === 0 ? res() : rej(new Error(`child ${tag} exit ${code}: ${err}`))));
        })));
        const lines = readFileSync(log, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(16);
        // Strictly alternating enter X / leave X: never two sections at once.
        for (let i = 0; i < lines.length; i += 2) {
            expect(lines[i]).toMatch(/^enter [ab]$/);
            expect(lines[i + 1]).toBe(lines[i].replace('enter', 'leave'));
        }
        expect(existsSync(factoryImportLockPath(root))).toBe(false);
    }, 240_000);
});
describe('credit reservation (factory.run.maxInFlightCredits)', () => {
    const ledger = () => join(dir, 'ledger');
    const reserve = (id, cap, limit, d) => reserveLaneCredits({ ledgerDir: ledger(), repo8: 'abcdef01', id, run: id.split('-')[1] ?? id, cap, limit, now: NOW(), deps: d });
    it('refuses the second lane over the limit (wait: a lane in flight can end), frees on settle; a cap over the limit alone refuses without waiting', () => {
        const alive = new Set([101, 102]);
        const a = reserve('issue-7-implement-1', 30, 50, deps(101, alive));
        expect(a.ok).toBe(true);
        const b = reserve('issue-8-implement-1', 30, 50, deps(102, alive));
        expect(b).toMatchObject({ ok: false, wait: true, inFlight: 30 });
        expect(!b.ok && b.reason).toMatch(/30 AI credits are reserved by lanes in flight \(issue-7-implement-1 30\); this lane's cap of 30 would pass factory\.run\.maxInFlightCredits 50/);
        if (a.ok)
            a.settle(12);
        expect(existsSync(creditReservationPath(ledger(), 'abcdef01'))).toBe(false);
        expect(reserve('issue-8-implement-1', 30, 50, deps(102, alive)).ok).toBe(true);
        expect(reserve('issue-9-implement-1', 60, 50, deps(102, alive))).toMatchObject({ ok: false, wait: false });
    });
    it('a dead holder\'s reservation is dropped (a crash never leaks it), a live one is kept; release frees only dead or unreadable ones', () => {
        const alive = new Set([101, 102]);
        expect(reserve('issue-7-implement-1', 30, 50, deps(101, alive)).ok).toBe(true);
        alive.delete(101);
        expect(reserve('issue-8-implement-1', 30, 50, deps(102, alive)).ok).toBe(true);
        const file = JSON.parse(readFileSync(creditReservationPath(ledger(), 'abcdef01'), 'utf8'));
        expect(file.reservations.map((r) => r.id)).toEqual(['issue-8-implement-1']);
        // release: 102 lives, nothing freed.
        expect(releaseDeadCreditReservations(ledger(), 'abcdef01', deps(103, alive))).toMatchObject({ freed: [], kept: [expect.stringMatching(/^issue-8-implement-1 /)] });
        alive.delete(102);
        expect(releaseDeadCreditReservations(ledger(), 'abcdef01', deps(103, alive)).freed[0]).toMatch(/credit reservation of lane issue-8-implement-1/);
        // Unreadable: a reservation refuses (fail closed); release removes it.
        writeFileSync(creditReservationPath(ledger(), 'abcdef01'), 'nope');
        expect(() => reserve('issue-9-implement-1', 10, 50, deps(103, alive))).toThrow(/is unreadable, so the credits in flight are unknown/);
        expect(releaseDeadCreditReservations(ledger(), 'abcdef01', deps(103, alive)).freed[0]).toMatch(/unreadable/);
        expect(reserve('issue-9-implement-1', 10, 50, deps(103, alive)).ok).toBe(true);
    });
});
describe('settings', () => {
    it('maxConcurrent / maxInFlightCredits from the trusted layers: user first, an invalid base value is unset (warned), an invalid user value throws; >1 with the shared layout is refused naming factory.run.layout "private"', () => {
        expect(resolveParallelSettings(undefined, undefined)).toEqual({ maxConcurrent: 1, source: 'default' });
        expect(resolveParallelSettings({ factory: { run: { maxConcurrent: 3 } } }, { factory: { run: { maxConcurrent: 5, maxInFlightCredits: 90 } } })).toEqual({ maxConcurrent: 3, maxInFlightCredits: 90, source: 'user config' });
        const warned = [];
        expect(resolveParallelSettings(undefined, { factory: { run: { maxConcurrent: 0 } } }, (m) => warned.push(m))).toEqual({ maxConcurrent: 1, source: 'default' });
        expect(warned[0]).toMatch(/the base \.copilot\/omg\.jsonc: factory\.run\.maxConcurrent must be an integer/);
        expect(() => resolveParallelSettings({ factory: { run: { maxConcurrent: 'two' } } }, undefined)).toThrow(/user config: factory\.run\.maxConcurrent/);
        expect(parallelLayoutRefusal({ maxConcurrent: 2, source: 'user config' }, 'shared')).toMatch(/factory\.run\.maxConcurrent 2 .* only with factory\.run\.layout: "private"/);
        expect(parallelLayoutRefusal({ maxConcurrent: 2, source: 'user config' }, 'private')).toBeNull();
        expect(parallelLayoutRefusal({ maxConcurrent: 1, source: 'default' }, 'shared')).toBeNull();
    });
});
describe('the --parallel supervisor', () => {
    /** A fake child whose outcome the test resolves. */
    function fakeChildren() {
        const pending = [];
        return { pending, spawn: () => new Promise((res) => { pending.push(res); }) };
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));
    it('spawns N, refills a slot when a child ends with a non-busy code, stops refilling when one found nothing runnable; exit code and one report per child', async () => {
        const c = fakeChildren();
        const reports = [];
        const run = runParallelSupervisor({ n: 2, spawn: c.spawn, onStop: () => () => { }, report: (i, r) => reports.push(`${i}:${r.exitCode}`) });
        await tick();
        expect(c.pending.length).toBe(2);
        c.pending[0]({ exitCode: 0, parsed: true, next: 7, message: 'merge park' });
        await tick();
        expect(c.pending.length).toBe(3); // refilled
        c.pending[2]({ exitCode: 0, parsed: true, next: null, message: 'nothing runnable' });
        await tick();
        expect(c.pending.length).toBe(3); // no refill after "nothing runnable"
        c.pending[1]({ exitCode: 4, parsed: true, next: 8, message: 'parked' });
        const r = await run;
        expect(r.exitCode).toBe(4);
        expect(r.children.map((x) => [x.index, x.exitCode])).toEqual([[0, 0], [1, 4], [2, 0]]);
        expect(reports).toEqual(['0:0', '2:0', '1:4']);
    });
    it('a busy child (no free slot) is not refilled; a run that failed is refilled, one that failed before taking an item is not; a failure makes exit 1; all busy is exit 6', async () => {
        const c = fakeChildren();
        const run = runParallelSupervisor({ n: 2, spawn: c.spawn, onStop: () => () => { } });
        await tick();
        c.pending[0]({ exitCode: EXIT_BUSY, parsed: true, next: null, message: 'busy' });
        await tick();
        expect(c.pending.length).toBe(2);
        c.pending[1]({ exitCode: 1, parsed: true, next: 9, message: 'failed' });
        await tick();
        expect(c.pending.length).toBe(3); // #9 failed: its slot runs the next item
        c.pending[2]({ exitCode: 1, parsed: false, next: null, message: 'no outcome on stdout' });
        await tick();
        expect(c.pending.length).toBe(3); // failed before taking an item: no refill (it would fail again)
        expect((await run).exitCode).toBe(1);
        const d = fakeChildren();
        const all = runParallelSupervisor({ n: 1, spawn: d.spawn, onStop: () => () => { } });
        await tick();
        d.pending[0]({ exitCode: EXIT_BUSY, parsed: true, next: null, message: 'busy' });
        expect((await all).exitCode).toBe(EXIT_BUSY);
    });
    it('a stop signal stops the refills and waits for the running children (exit 130); the CLI forwards the signal to them', async () => {
        const c = fakeChildren();
        let stop = () => { };
        let unsubscribed = false;
        const run = runParallelSupervisor({ n: 2, spawn: c.spawn, onStop: (s) => { stop = s; return () => { unsubscribed = true; }; } });
        await tick();
        stop();
        c.pending[0]({ exitCode: 0, parsed: true, next: 7, message: 'stopped after its poll' });
        await tick();
        expect(c.pending.length).toBe(2); // no refill after the stop
        let done = false;
        void run.then(() => { done = true; });
        await tick();
        expect(done).toBe(false); // still waits for the second child
        c.pending[1]({ exitCode: 130, parsed: false, next: null, message: 'ended by SIGINT' });
        const r = await run;
        expect(r).toMatchObject({ exitCode: 130, interrupted: true });
        expect(unsubscribed).toBe(true);
    });
});
describe('the atomic --next pick across processes', () => {
    it('several processes taking the first free item owner file at once never take the same item', async () => {
        // Each child walks items 1..5 in order and takes the first owner file it can (the pick's take), printing it.
        const script = join(dir, 'pick.ts');
        const stateUrl = pathToFileURL(resolve(__dirname, '..', 'state.ts')).href;
        writeFileSync(script, [
            `import { acquireFactoryOwner, FactoryBusyError } from ${JSON.stringify(stateUrl)};`,
            'const root = process.argv[2];',
            'for (const id of [1, 2, 3, 4, 5]) {',
            '  try { acquireFactoryOwner(root, id, new Date().toISOString()); console.log(String(id)); setTimeout(() => {}, 8000); break; }',
            '  catch (e) { if (!(e instanceof FactoryBusyError)) throw e; }',
            '}',
        ].join('\n'));
        const tsx = resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
        for (let round = 0; round < 3; round++) {
            rmSync(join(getOmcRoot(root), 'state'), { recursive: true, force: true });
            const outs = await Promise.all([0, 1, 2, 3].map(() => new Promise((res, rej) => {
                const p = spawn(process.execPath, [tsx, script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '';
                let err = '';
                p.stdout.on('data', (d) => { out += d.toString(); });
                p.stderr.on('data', (d) => { err += d.toString(); });
                p.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`child exit ${code}: ${err}`))));
            })));
            const taken = outs.filter(Boolean);
            expect(taken.length).toBe(4);
            expect(new Set(taken).size).toBe(4);
        }
        expect(existsSync(dirname(script))).toBe(true);
    }, 240_000);
    it('the same rule in one process: a held item is skipped by the next taker', () => {
        const alive = new Set([101, 102]);
        const a = acquireFactoryOwner(root, 1, NOW(), deps(101, alive));
        expect(() => acquireFactoryOwner(root, 1, NOW(), deps(102, alive))).toThrow(FactoryBusyError);
        a.release();
        expect(SCAN_WAIT_MS).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=parallel.test.js.map