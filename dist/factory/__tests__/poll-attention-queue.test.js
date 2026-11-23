/**
 * `omg factory poll`'s attention step under a lane that writes `.omg/`: rows
 * whose state is not trusted are only counted (one line when the count
 * changes, one count notice per hour), so they can never delay or suppress a
 * trusted item's line or notice. Trusted notices past the per-tick cap or the
 * rate limit wait in a bounded queue and go out later, oldest first; a send
 * that never settles is aborted and abandoned at the tick's timeout.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../forge/index.js';
import { EngineLedger } from '../run/ledger.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, updateFactoryState } from '../run/state.js';
import { MAX_UNRECORDED_STATES } from '../attention/collect.js';
import { ATTENTION_COUNT_NOTICE_WINDOW_MS, ATTENTION_COUNT_RISE_MS, ATTENTION_NOTICE_ITEMS, ATTENTION_PENDING_MAX, ATTENTION_PRINT_ITEMS, ATTENTION_QUEUE_MAX, runFactoryPoll } from '../poll.js';
const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const STEP_MS = 5 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const REPO = 'https://github.com/o/r';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
let dir;
let root;
let ledgerDir;
let out;
let notices;
let now;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-poll-attention-queue-'));
    root = join(dir, 'repo');
    execFileSync('git', ['init', '-q', root]);
    if (!factoryStateDir(root).startsWith(root))
        throw new Error('state dir is outside the test root');
    ledgerDir = join(dir, 'ledger');
    out = [];
    notices = [];
    now = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
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
            return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list')
        return ok('[]');
    throw new Error(`unscripted ${cmd} ${a}`);
};
const parked = (issue, atMs) => setGate(moveTo({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, iso(atMs - 60_000)), forgeKind: 'github' }, 'implement', 'x', iso(atMs - 30_000)), 'ci-failed', 'x', iso(atMs));
/** A park written as the engine writes it (sealed and recorded in the engine ledger): trusted. */
function park(issue, atMs = now) {
    const s = parked(issue, atMs);
    const l = EngineLedger.open(ledgerDir, root, runKeyOf(s));
    updateFactoryState(root, issue, () => s, { onWrite: (p, c) => l.record(p, c) });
}
/** A sealed state the engine ledger never recorded (what a lane can write): untrusted. */
function forged(issue, atMs = now) {
    const s = parked(issue, atMs);
    mkdirSync(factoryStateDir(root), { recursive: true });
    writeFileSync(factoryStatePath(root, issue), JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}
/** Runs `ticks` ticks; `lane(n)` runs before tick n+1 (n from 0). Ticks are STEP_MS apart. */
async function poll(ticks, lane, over = {}) {
    let stop;
    let n = 0;
    const deps = {
        exec, base: () => 'dev', trustedUser: () => ({ factory: { poll: { remindAfterHours: 24 } } }), projectConfig: () => undefined, createForge,
        now: () => now, ledgerDir,
        healScan: () => { throw new Error('no heal'); },
        owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
        onStop: (h) => { stop = h; return () => { }; },
        sleep: async () => {
            lane(n);
            n += 1;
            now += STEP_MS;
            if (n >= ticks)
                stop?.('SIGTERM');
        },
        notifyAttention: async (x) => { notices.push({ tick: n, n: x }); },
        out: (l) => out.push(l), err: () => { },
        ...over,
    };
    expect(await runFactoryPoll({ heal: false, intake: false, prs: false, json: true, interval: '5m' }, deps)).toBe(0);
    return out.map((l) => JSON.parse(l));
}
const keyOf = (x) => ('key' in x ? x.key : 'count' in x ? `count ${x.count}` : `more ${x.more}`);
describe('omg factory poll: untrusted rows never crowd out a trusted item', () => {
    it('a flood of 20 new forged keys per tick: the real park is printed and notified at its own tick', async () => {
        const t = await poll(8, (n) => {
            for (let k = 0; k < 20; k++)
                forged(1000 + n * 20 + k);
            if (n === 2)
                park(8);
        });
        expect(t[3].attention?.new.map((i) => i.key)).toEqual(['#8']);
        expect(notices.filter((x) => keyOf(x.n) === '#8').map((x) => x.tick)).toEqual([3]);
        // No item notice for any forged row; the rising count gets one count notice per 10 min (ticks 1, 3, 5, 7).
        expect(notices.map((x) => [x.tick, keyOf(x.n)])).toEqual([[1, 'count 20'], [3, '#8'], [3, 'count 60'], [5, 'count 100'], [7, 'count 140']]);
        for (const x of t.slice(1))
            expect(x.attention?.new.every((i) => i.key === '#8')).toBe(true);
    });
    it('six untrusted new items just before a real park leave its notice untouched', async () => {
        const t = await poll(4, (n) => {
            if (n === 0)
                for (let k = 0; k < 3; k++)
                    forged(500 + k);
            if (n === 1)
                for (let k = 3; k < 6; k++)
                    forged(500 + k);
            if (n === 2)
                park(9);
        });
        // The count rose at tick 2 (5 min after the first count notice): its notice waits for the 10 min mark (tick 3).
        expect(notices.map((x) => [x.tick, keyOf(x.n)])).toEqual([[1, 'count 3'], [3, '#9'], [3, 'count 6']]);
        expect(t[2].attention).toEqual({ new: [], unverified: 6 });
        expect(t[3].attention?.new.map((i) => i.key)).toEqual(['#9']);
    });
    it('the untrusted count notice goes out at most once per window while the count does not rise, with its own budget', async () => {
        // 26 ticks 5 min apart (125 min), one new forged key each tick in place of the previous one: the count stays 1.
        await poll(26, (n) => { if (n > 0)
            rmSync(factoryStatePath(root, 2000 + n - 1)); forged(2000 + n); });
        const counts = notices.filter((x) => 'count' in x.n);
        expect(ATTENTION_COUNT_NOTICE_WINDOW_MS).toBe(60 * 60_000);
        expect(counts.map((x) => x.tick)).toEqual([1, 13, 25]);
        expect(notices).toEqual(counts);
    });
    it('a count that rises above the last notified one gets one more notice, at most once per 10 min (scenario 10)', async () => {
        // A junk row first (count 1, notified); 15 min later a second untrusted row (a new problem): notified at once,
        // not an hour later. Then a third and a fourth 5 min apart: the fourth waits for the 10 min mark.
        await poll(8, (n) => {
            if (n === 0)
                forged(2100);
            if (n === 3)
                forged(2101);
            if (n === 4)
                forged(2102);
            if (n === 5)
                forged(2103);
        });
        expect(ATTENTION_COUNT_RISE_MS).toBe(10 * 60_000);
        expect(notices.map((x) => [x.tick, keyOf(x.n)])).toEqual([[1, 'count 1'], [4, 'count 2'], [6, 'count 4']]);
    });
    // Kept small for the suite's time (each tick reads every state file); the review script's evict mode runs thousands.
    it('hundreds of rotating forged keys per tick change nothing for a trusted item', async () => {
        const PER = 100;
        const t = await poll(6, (n) => {
            for (let k = 0; k < PER; k++)
                writeFileSync(factoryStatePath(root, 100_000 + ((n * PER + k) % (5 * PER))), '{}');
            if (n > 0)
                for (let k = 0; k < PER; k++)
                    rmSync(factoryStatePath(root, 100_000 + (((n - 1) * PER + k) % (5 * PER))), { force: true });
            if (n === 3)
                park(10);
        });
        expect(t[4].attention?.new.map((i) => i.key)).toEqual(['#10']);
        expect(notices.filter((x) => 'key' in x.n).map((x) => [x.tick, keyOf(x.n)])).toEqual([[4, '#10']]);
    }, 300_000);
});
describe('omg factory poll: state files left unread', () => {
    it('the `state-files` row is one untrusted item: counted, never an item line or notice', async () => {
        const t = await poll(3, (n) => {
            if (n === 0)
                for (let k = 0; k < MAX_UNRECORDED_STATES + 5; k++)
                    writeFileSync(factoryStatePath(root, 7000 + k), '{}');
            if (n === 1)
                park(11);
        });
        expect(t[1].attention).toEqual({ new: [], unverified: MAX_UNRECORDED_STATES + 1 });
        expect(t[2].attention?.new.map((i) => i.key)).toEqual(['#11']);
        expect(notices.map((x) => [x.tick, keyOf(x.n)])).toEqual([[1, `count ${MAX_UNRECORDED_STATES + 1}`], [2, '#11']]);
    }, 120_000);
});
describe('omg factory poll: trusted notices queue', () => {
    it('past the per-tick cap and the rate limit: queued and delivered later, oldest first, nothing dropped', async () => {
        const t = await poll(6, (n) => {
            if (n === 0)
                for (let k = 0; k < 5; k++)
                    park(20 + k);
            if (n === 1)
                for (let k = 0; k < 4; k++)
                    park(30 + k);
        });
        const keys = notices.map((x) => [x.tick, keyOf(x.n)]);
        expect(keys).toEqual([
            [1, '#20'], [1, '#21'], [1, '#22'],
            [2, '#23'], [2, '#24'], [2, '#30'],
            [3, '#31'], [3, '#32'], [3, '#33'],
        ]);
        expect(t[1].attention?.queued).toBe(2);
        expect(t[2].attention?.queued).toBe(3);
        expect(t[3].attention?.queued).toBeUndefined();
        for (const x of t)
            expect(x.attention?.dropped).toBeUndefined();
    });
    it('a queued item that no longer needs you is not sent', async () => {
        await poll(4, (n) => {
            if (n === 0)
                for (let k = 0; k < 5; k++)
                    park(40 + k);
            if (n === 1)
                rmSync(factoryStatePath(root, 44), { force: true });
        });
        // #44's state went away (the ledger still records it: an Inspect row, a different identity) before its turn.
        expect(notices.map((x) => keyOf(x.n)).filter((k) => k.startsWith('#'))).toEqual(['#40', '#41', '#42', '#43']);
    });
    it('queue overflow: one count notice for the overflow, first, and only the overflow counts as dropped', async () => {
        const N = ATTENTION_QUEUE_MAX + 5;
        const t = await poll(2, (n) => { if (n === 0)
            for (let k = 0; k < N; k++)
                park(3000 + k); });
        expect(t[1].attention?.dropped).toBe(5);
        expect(t[1].attention?.queued).toBe(ATTENTION_QUEUE_MAX - (ATTENTION_NOTICE_ITEMS - 1));
        expect(notices.map((x) => keyOf(x.n))).toEqual(['more 5', '#3000', '#3001']);
    }, 120_000);
});
describe('omg factory poll: a notifier that never settles', () => {
    it('each tick aborts its sends at the timeout, and later ticks still send', async () => {
        const started = [];
        const signals = [];
        let n = 0;
        const t = await poll(6, (k) => { n = k + 1; park(60 + k); }, {
            notifyAttention: (x, signal) => { started.push([n, keyOf(x)]); if (signal)
                signals.push(signal); return new Promise(() => { }); },
            notifyTimeoutMs: 30,
        });
        expect(started).toEqual([[1, '#60'], [2, '#61'], [3, '#62'], [4, '#63'], [5, '#64']]);
        expect(signals).toHaveLength(5);
        expect(signals.every((s) => s.aborted)).toBe(true);
        expect(t.slice(1).every((x) => x.warnings.some((w) => /did not finish within/.test(w)))).toBe(true);
    });
});
describe('omg factory poll: a hung notifier', () => {
    it('abandoned sends that never settle count against the in-flight cap: no more calls pile up (scenario 9)', async () => {
        let calls = 0;
        const t = await poll(12, (k) => park(70 + k), {
            notifyAttention: () => { calls += 1; return new Promise(() => { }); },
            notifyTimeoutMs: 20,
        });
        expect(calls).toBe(ATTENTION_PENDING_MAX);
        expect(t.at(-1).warnings.some((w) => /still in flight; no more are sent/.test(w))).toBe(true);
        // Nothing is lost: the parks past the cap wait in the queue.
        expect(t.at(-1).attention?.queued).toBe(11 - ATTENTION_PENDING_MAX);
    });
});
/** A seal-breaking rewrite of a real park's state for a tick (what a lane can do); returns the restore. */
function flip(issue) {
    const path = factoryStatePath(root, issue);
    const bytes = readFileSync(path);
    const s = JSON.parse(bytes.toString('utf8'));
    writeFileSync(path, JSON.stringify({ ...s, integrity: 'f'.repeat(64) }));
    return () => writeFileSync(path, bytes);
}
const sentTicks = (key) => notices.filter((x) => keyOf(x.n) === key).map((x) => x.tick);
describe('omg factory poll: a lane cannot drop a real park\'s queued notice', () => {
    for (const hours of [1, 24]) {
        it(`flip and restore while queued (${hours} h quiet window): the notice waits and goes once the row is trusted again (scenarios 7, 7q)`, async () => {
            let restore = [];
            await poll(20, (n) => {
                if (n === 0)
                    for (let k = 0; k < 5; k++)
                        park(30 + k);
                if (n === 1)
                    restore = [flip(33), flip(34)];
                if (n === 2)
                    for (const r of restore)
                        r();
            }, { trustedUser: () => ({ factory: { poll: { remindAfterHours: hours } } }) });
            expect(['#30', '#31', '#32'].map(sentTicks)).toEqual([[1], [1], [1]]);
            // Untrusted at tick 2: not sent then (nor dropped); trusted again at tick 3: sent once.
            expect(sentTicks('#33')).toEqual([3]);
            expect(sentTicks('#34')).toEqual([3]);
        });
    }
    it('a flip during the rate-limit wait: every park is notified exactly once', async () => {
        let restore = [];
        await poll(10, (n) => {
            if (n === 0)
                for (let k = 0; k < 9; k++)
                    park(40 + k);
            if (n === 1)
                restore = [flip(46), flip(47), flip(48)];
            if (n === 3)
                for (const r of restore)
                    r();
        });
        for (let k = 0; k < 6; k++)
            expect(sentTicks(`#${40 + k}`)).toHaveLength(1);
        // 6 per 10 min: the last three would go at tick 3; they are trusted again only at tick 4.
        expect(['#46', '#47', '#48'].map(sentTicks)).toEqual([[4], [4], [4]]);
    });
    it('repeated flips: the queued notice goes out once, on a tick its row is trusted', async () => {
        let restore = () => { };
        await poll(12, (n) => {
            if (n === 0)
                for (let k = 0; k < 4; k++)
                    park(50 + k);
            // #53 is untrusted on every even tick from tick 2 on, trusted on the odd ones.
            if (n >= 1 && n % 2 === 1)
                restore = flip(53);
            if (n >= 2 && n % 2 === 0)
                restore();
        });
        expect(sentTicks('#53')).toEqual([3]);
    });
    it('a queued notice of a run that is gone is dropped; one whose trusted row changed is replaced by the new row\'s', async () => {
        await poll(4, (n) => {
            if (n === 0)
                for (let k = 0; k < 5; k++)
                    park(80 + k);
            // The engine removed #83 (the ledger records it) and parked #84 again at a new time: a new identity.
            if (n === 1) {
                rmSync(factoryStatePath(root, 83));
                EngineLedger.open(ledgerDir, root, 83).record(factoryStatePath(root, 83), null);
                park(84, now + 1_000);
            }
        });
        expect(sentTicks('#83')).toEqual([]);
        expect(sentTicks('#84')).toEqual([2]);
    });
    it('15 trusted parks in one tick: every one gets its own line (10, then 5) and its own notice', async () => {
        const t = await poll(8, (n) => { if (n === 0)
            for (let k = 0; k < 15; k++)
                park(100 + k); });
        expect(t[1].attention?.new).toHaveLength(ATTENTION_PRINT_ITEMS);
        expect(t[1].attention?.more).toBe(15 - ATTENTION_PRINT_ITEMS);
        expect(t[2].attention?.new).toHaveLength(15 - ATTENTION_PRINT_ITEMS);
        expect(t[2].attention?.more).toBeUndefined();
        const lined = t.flatMap((x) => x.attention?.new.map((i) => i.key) ?? []);
        expect(lined.sort()).toEqual(Array.from({ length: 15 }, (_, k) => `#${100 + k}`).sort());
        for (let k = 0; k < 15; k++)
            expect(sentTicks(`#${100 + k}`)).toHaveLength(1);
    });
    it('an item counted in "and K more" and hidden by a lane for a tick still gets its line', async () => {
        let restore = () => { };
        const t = await poll(5, (n) => {
            if (n === 0)
                for (let k = 0; k < 12; k++)
                    park(200 + k);
            if (n === 1)
                restore = flip(211);
            if (n === 2)
                restore();
        });
        const lined = t.flatMap((x, tick) => (x.attention?.new ?? []).map((i) => [tick, i.key]));
        expect(lined.filter(([, k]) => k === '#211')).toEqual([[3, '#211']]);
        expect(lined.filter(([, k]) => k === '#210')).toEqual([[2, '#210']]);
    });
    it('queue overflow entries of runs that are gone are dropped before the count notice', async () => {
        // The first ATTENTION_PENDING_MAX sends hang until tick 5: no room, so the overflow waits. Then its runs are gone.
        const release = [];
        let n = 0;
        const t = await poll(7, (k) => {
            n = k + 1;
            if (k === 0)
                for (let j = 0; j < ATTENTION_PENDING_MAX; j++)
                    park(2900 + j);
            if (k === 3)
                for (let j = 0; j < ATTENTION_QUEUE_MAX + 5; j++)
                    park(3000 + j);
            if (k === 4) {
                for (let j = ATTENTION_QUEUE_MAX; j < ATTENTION_QUEUE_MAX + 5; j++) {
                    const p = factoryStatePath(root, 3000 + j);
                    rmSync(p);
                    EngineLedger.open(ledgerDir, root, 3000 + j).record(p, null);
                }
                for (const r of release.splice(0))
                    r();
            }
        }, {
            notifyAttention: (x) => { notices.push({ tick: n, n: x }); return release.length < ATTENTION_PENDING_MAX && n < 5 ? new Promise((r) => { release.push(() => r()); }) : Promise.resolve(); },
            notifyTimeoutMs: 20,
        });
        expect(t[4].attention?.dropped).toBe(5);
        expect(notices.filter((x) => x.tick >= 5).length).toBeGreaterThan(0);
        expect(notices.filter((x) => 'more' in x.n)).toEqual([]);
    }, 120_000);
});
describe('omg factory poll: the bounded notification wait', () => {
    it('keeps node alive until it resolves, also when the hung send holds no handle (no exit 13 mid-tick)', () => {
        const poll = new URL('../poll.ts', import.meta.url).href;
        const probe = `const { settledWithin } = await import(${JSON.stringify(poll)}); console.log('waited', await settledWithin([new Promise(() => {})], 50));`;
        const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 60_000 });
        expect({ status: r.status, out: r.stdout.trim() }).toEqual({ status: 0, out: 'waited false' });
    }, 90_000);
});
//# sourceMappingURL=poll-attention-queue.test.js.map