/**
 * `omg factory poll` on GitHub (a scripted gh + git): tick order, the intake
 * diff and its seen file, the PR resume hint, the board diff, the heal
 * capability gate, the owner lock, the rate-limit backoff, the stop signal,
 * the idle seam, and the read guard: a tick never spawns and never writes to
 * the tracker or forge.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryPollCommand } from '../../cli/commands/factory-poll.js';
import { createForge } from '../../forge/index.js';
import { FactorySafetyError } from '../run/exec.js';
import { HealRunRefused } from '../heal/run.js';
import { DEFAULT_HEAL_CONFIG } from '../heal/config.js';
import { healStateDir } from '../heal/state.js';
import { computeFactoryIntegrity, createFactoryState, factoryRepoOwnerPath, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate } from '../run/state.js';
import { acquirePoller, defaultPollHealScan, nextInterval, parseInterval, PollBusyError, pollAuditPath, pollStatePath, POLL_JSON_SCHEMA_VERSION, POLL_MAX_INTERVAL_MS, runFactoryPoll, } from '../poll.js';
const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const T0 = '2026-10-31T10:00:00.000Z';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const AC = '## Acceptance criteria\n- `omg x` exits 0\n';
const REPO = 'https://github.com/o/r';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const MIN = 60_000;
let root;
let out;
let err;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-poll-'));
    // A git checkout, so the poll and run state live under it (outside a repository the state root climbs to the home directory).
    execFileSync('git', ['init', '-q', root]);
    if (!pollStatePath(root).startsWith(root) || !factoryStateDir(root).startsWith(root))
        throw new Error('state dir is outside the test root');
    out = [];
    err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
/** gh + git: issues 1 and 2 in the label source; PR 9 (run #4) with `prState`. `onCall` sees each command first. */
function scripted(o = {}) {
    const calls = [];
    const exec = (cmd, args) => {
        const a = args.join(' ');
        calls.push(`${cmd} ${a}`);
        const hooked = o.onCall?.(cmd, args);
        if (hooked)
            return hooked;
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
            if (args[0] === 'ls-remote')
                return ok('');
            if (args[0] === 'show')
                return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
        }
        if (cmd === 'gh') {
            if (args[0] === 'issue' && args[1] === 'list')
                return ok(JSON.stringify((o.listed ?? [1, 2]).map((number) => ({ number }))));
            if (args[0] === 'issue' && args[1] === 'view') {
                const n = Number(args[2]);
                return ok(JSON.stringify({ title: `issue ${n}`, body: n === 1 ? AC : 'no plan', state: 'OPEN', url: `${REPO}/issues/${n}`, author: { login: 'o' }, comments: [], labels: [] }));
            }
            if (args[0] === 'pr' && args[1] === 'list')
                return ok('[]');
            if (args[0] === 'pr' && args[1] === 'view' && args[2] === '9') {
                return ok(JSON.stringify({ number: 9, state: o.prState ?? 'OPEN', isDraft: false, baseRefName: 'dev', baseRefOid: SHA, headRefName: 'factory/issue-4', headRefOid: HEAD, url: `${REPO}/pull/9` }));
            }
        }
        throw new Error(`unscripted ${cmd} ${a}`);
    };
    return { exec, calls };
}
const scan = (calls = []) => (o) => {
    calls.push(`${o.kind} ${o.base}`);
    return { base: o.base, dryRun: false, entries: [{ runId: '77', event: 'push', headBranch: 'dev', sig8: '0123abcd', class: 'test-failure', reason: 'x', recorded: true }], queued: 0 };
};
function deps(exec, over = {}) {
    return {
        exec,
        base: () => 'dev',
        trustedUser: () => undefined,
        projectConfig: () => undefined,
        createForge,
        now: () => NOW,
        healScan: scan(),
        owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
        onStop: () => () => { },
        sleep: async () => { throw new Error('a --once poll never sleeps'); },
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        ...over,
    };
}
const poll = (exec, o = {}, over = {}) => runFactoryPoll(o, deps(exec, over));
const ticks = () => out.map((l) => JSON.parse(l));
const LABEL = { factory: { intake: { source: { type: 'label', label: 'factory' } } } };
function save(s) {
    const path = factoryStatePath(root, runKeyOf(s));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}
const issueRun = (issue) => ({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, T0), forgeKind: 'github', issueTitle: `issue ${issue}` });
/** #4 parked at the merge gate with PR 9. */
const seedParked = () => save({ ...setGate(moveTo(issueRun(4), 'gates', 'gates', T0), 'merge', 'gates green; a human merges', T0), pr: 9, head: HEAD });
describe('omg factory poll on GitHub', () => {
    it('--once --json: heal, intake, PRs and board in one tick; the seen file and the audit', async () => {
        seedParked();
        const healCalls = [];
        const w = scripted({ prState: 'MERGED' });
        expect(await poll(w.exec, { once: true, json: true }, { projectConfig: () => LABEL, healScan: scan(healCalls) })).toBe(0);
        const [t] = ticks();
        expect(out).toHaveLength(1);
        expect(t).toMatchObject({
            schemaVersion: POLL_JSON_SCHEMA_VERSION, tick: 1, forge: 'github', repo: REPO,
            heal: { ran: true, entries: 1, recorded: 1, queued: 0 },
            intake: { ran: true, items: 2, new: [{ id: 1, bucket: 'runnable', reasons: [] }, { id: 2, bucket: 'needs-plan' }] },
            prs: [{ id: 4, pr: 9, state: 'MERGED', hint: 'omg factory run 4' }],
            idle: true, rateLimited: false, errors: [],
        });
        expect(t.nextIntervalMs).toBeUndefined();
        expect(healCalls).toEqual(['github dev']);
        // Every row on the first tick: the two backlog items and the parked run (not in the source).
        expect(t.board.map((b) => [b.stage, b.row.id])).toEqual([['backlog', 1], ['backlog', 2], ['outside', 4]]);
        // Tick order: the intake query, then the new items' reads, then the PR read.
        const order = w.calls.filter((c) => /^gh (issue list|issue view|pr view)/.test(c)).map((c) => c.split(' ').slice(1, 3).join(' '));
        expect(order.indexOf('issue list')).toBeLessThan(order.indexOf('issue view'));
        expect(order.indexOf('issue view')).toBeLessThan(order.indexOf('pr view'));
        expect(JSON.parse(readFileSync(pollStatePath(root), 'utf8'))).toEqual({ seen: [1, 2], at: '2026-10-31T12:00:00.000Z' });
        const audit = readFileSync(pollAuditPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(audit.map((a) => [a.kind, a.id])).toEqual([['intake-new', 1], ['intake-new', 2], ['pr-done', 4]]);
        expect(audit[2]).toMatchObject({ pr: 9, state: 'MERGED', hint: 'omg factory run 4' });
    });
    it('a second tick reports only items new since the seen file', async () => {
        const w = scripted({ listed: [1, 2] });
        expect(await poll(w.exec, { once: true, json: true }, { projectConfig: () => LABEL })).toBe(0);
        out.length = 0;
        const w2 = scripted({ listed: [1, 2, 3] });
        expect(await poll(w2.exec, { once: true, json: true }, { projectConfig: () => LABEL })).toBe(0);
        expect(ticks()[0].intake).toMatchObject({ ran: true, items: 3, new: [{ id: 3 }] });
        // check reads #3 alone; then the board reads each item (GitHub has no batched peek).
        expect(w2.calls.filter((c) => c.startsWith('gh issue view')).map((c) => c.split(' ')[3])).toEqual(['3', '1', '2', '3']);
        expect(JSON.parse(readFileSync(pollStatePath(root), 'utf8')).seen).toEqual([1, 2, 3]);
    });
    it('an open PR prints no hint; text output names a merged one', async () => {
        seedParked();
        expect(await poll(scripted().exec, { once: true, json: true })).toBe(0);
        expect(ticks()[0].prs).toEqual([{ id: 4, pr: 9, state: 'OPEN' }]);
        out.length = 0;
        expect(await poll(scripted({ prState: 'CLOSED' }).exec, { once: true })).toBe(0);
        expect(out.join('\n')).toContain('PR #9 of #4 is closed by a human: run `omg factory run 4` to record it');
    });
    it('never spawns and never writes: every command is a read, and the guard refuses writes before gh', async () => {
        seedParked();
        let guarded;
        const spy = (exec, cwd, config, options) => {
            guarded = exec;
            return createForge(exec, cwd, config, options);
        };
        const w = scripted({ prState: 'MERGED' });
        expect(await poll(w.exec, { once: true, json: true }, { projectConfig: () => LABEL, createForge: spy })).toBe(0);
        for (const c of w.calls)
            expect(c, c).toMatch(/^(?:git (?:rev-parse|remote get-url|fetch origin dev|cat-file -e|ls-remote|show)|gh (?:issue (?:list|view)|pr (?:list|view)))\b/);
        const before = w.calls.length;
        const writes = [
            ['issue', 'edit', '1', '--add-label', 'factory:building'],
            ['issue', 'comment', '1', '--body-file', join(root, 'b.md')],
            ['pr', 'ready', '9'],
            ['pr', 'merge', '9', '--squash'],
            ['pr', 'comment', '9', '--body-file', join(root, 'b.md')],
            ['run', 'rerun', '77', '--failed'],
        ];
        for (const args of writes)
            expect(() => guarded('gh', args, { cwd: root }), args.join(' ')).toThrow(FactorySafetyError);
        for (const cmd of ['copilot', 'node', 'omg'])
            expect(() => guarded(cmd, ['-p', 'x'], { cwd: root })).toThrow(FactorySafetyError);
        expect(w.calls.length).toBe(before);
    });
    it('a guard refusal inside a tick propagates instead of being reported as a read failure', async () => {
        const refusing = (exec, cwd, config, options) => {
            const forge = createForge(exec, cwd, config, options);
            return { ...forge, tracker: { ...forge.tracker, queryItems: () => { exec('gh', ['issue', 'edit', '1', '--add-label', 'x']); return []; } } };
        };
        await expect(poll(scripted().exec, { once: true, json: true }, { projectConfig: () => LABEL, createForge: refusing })).rejects.toThrow(FactorySafetyError);
    });
    it('the heal tick runs only with the heal capability, and a refused scan only skips it', async () => {
        const noHeal = (exec, cwd, config, options) => {
            const forge = createForge(exec, cwd, config, options);
            return { ...forge, capabilities: { ...forge.capabilities, heal: false } };
        };
        const calls = [];
        expect(await poll(scripted().exec, { once: true, json: true }, { createForge: noHeal, healScan: scan(calls) })).toBe(0);
        expect(calls).toEqual([]);
        expect(ticks()[0].heal).toEqual({ ran: false, reason: expect.stringContaining('no heal capability') });
        out.length = 0;
        expect(await poll(scripted().exec, { once: true, json: true, heal: false }, { healScan: scan(calls) })).toBe(0);
        expect(calls).toEqual([]);
        expect(ticks()[0].heal).toEqual({ ran: false, reason: '--no-heal' });
        out.length = 0;
        const refused = () => { throw new HealRunRefused('not here'); };
        expect(await poll(scripted().exec, { once: true, json: true }, { healScan: refused })).toBe(0);
        expect(ticks()[0]).toMatchObject({ heal: { ran: false, reason: 'not here' }, errors: [] });
    });
    it('the default heal scan refuses on Azure DevOps (until heal runs there)', () => {
        const exec = () => { throw new Error('no command runs'); };
        const heal = defaultPollHealScan(exec, () => { throw new Error('no config read'); }, join(root, 'ledger'));
        expect(() => heal({ root, base: 'dev', kind: 'azure-devops', now: new Date(NOW), warn: () => { } })).toThrow(HealRunRefused);
    });
    it('owner lock: a second poller is refused; a dead owner is taken over and released', async () => {
        const live = acquirePoller(root, T0, { pid: 1, hostname: hostname(), isAlive: () => true });
        await expect(poll(scripted().exec, { once: true, json: true }, { owner: { pid: 2, hostname: hostname(), isAlive: () => true } })).rejects.toThrow(PollBusyError);
        const cli = factoryPollCommand(deps(scripted().exec, { owner: { pid: 2, hostname: hostname(), isAlive: () => true } }));
        await cli.parseAsync(['--once', '--json'], { from: 'user' });
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(out.at(-1))).toEqual({ ok: false, error: expect.stringContaining('omg factory poll already runs in this repository (pid 1') });
        process.exitCode = 0;
        live.release();
        out.length = 0;
        // A recorded owner whose pid is dead on this host is taken over; the run releases it again.
        acquirePoller(root, T0, { pid: 1, hostname: hostname(), isAlive: () => true });
        expect(await poll(scripted().exec, { once: true, json: true }, { owner: { pid: 2, hostname: hostname(), isAlive: () => false } })).toBe(0);
        expect(JSON.parse(readFileSync(pollStatePath(root), 'utf8')).pid).toBeUndefined();
    });
    it('the interval: default 5 min, 2 min floor, 60 min ceiling', async () => {
        expect(parseInterval('5m')).toBe(5 * MIN);
        expect(parseInterval('3')).toBe(3 * MIN);
        expect(parseInterval('120s')).toBe(2 * MIN);
        expect(parseInterval('1h')).toBe(60 * MIN);
        for (const bad of ['1m', '90s', '2h', '0', '-5m', '5 min', ''])
            expect(() => parseInterval(bad), bad).toThrow();
        const cli = factoryPollCommand(deps(scripted().exec));
        await cli.parseAsync(['--interval', '1m', '--once'], { from: 'user' });
        expect(process.exitCode).toBe(2);
        expect(err.join('\n')).toMatch(/below the 2 min floor/);
        process.exitCode = 0;
    });
    it('backoff: a rate-limited tick doubles the wait up to 60 min; a clean tick resets it', async () => {
        expect(nextInterval(5 * MIN, 5 * MIN, true)).toBe(10 * MIN);
        expect(nextInterval(40 * MIN, 5 * MIN, true)).toBe(POLL_MAX_INTERVAL_MS);
        expect(nextInterval(40 * MIN, 5 * MIN, false)).toBe(5 * MIN);
        let n = 0;
        const limited = new Set([1, 2]);
        const w = scripted({
            onCall: (cmd, args) => (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list' && limited.has(++n)
                ? { status: 1, stdout: '', stderr: 'HTTP 429: Too Many Requests' } : undefined),
        });
        const waits = [];
        let stop = () => { };
        const code = await poll(w.exec, { json: true }, {
            projectConfig: () => LABEL,
            onStop: (h) => { stop = h; return () => { }; },
            sleep: async (ms) => { waits.push(ms); if (waits.length === 3)
                stop(); },
        });
        expect(code).toBe(0);
        expect(waits).toEqual([10 * MIN, 20 * MIN, 5 * MIN]);
        expect(ticks().map((t) => [t.rateLimited, t.nextIntervalMs])).toEqual([[true, 10 * MIN], [true, 20 * MIN], [false, 5 * MIN]]);
        expect(ticks()[0].errors[0]).toMatch(/^intake: .*429/);
    });
    it('a stop signal during a tick ends the loop after that tick; the board then prints only changed rows', async () => {
        let stop = () => { };
        let ticked = 0;
        const w = scripted({ onCall: (cmd, args) => { if (cmd === 'gh' && args[1] === 'list' && args[0] === 'issue' && ++ticked === 2)
                stop(); return undefined; } });
        const sleeps = [];
        const code = await poll(w.exec, { json: true }, {
            projectConfig: () => LABEL,
            onStop: (h) => { stop = h; return () => { }; },
            sleep: async (ms) => { sleeps.push(ms); },
        });
        expect(code).toBe(0);
        expect(sleeps).toEqual([5 * MIN]);
        expect(ticks().map((t) => t.tick)).toEqual([1, 2]);
        // The second tick finished (output printed) and nothing on the board changed.
        expect(ticks()[1].board).toEqual([]);
        expect(ticks()[0].board.map((b) => b.row.id)).toEqual([1, 2]);
        expect(err.join('\n')).toMatch(/stopping after the current tick/);
    });
    it('idle: a live engine owner or a run in flight is not idle; a parked run is', async () => {
        seedParked();
        expect(await poll(scripted().exec, { once: true, json: true, prs: false })).toBe(0);
        expect(ticks()[0].idle).toBe(true);
        out.length = 0;
        save(moveTo(issueRun(5), 'implement', 'plan ok', T0));
        expect(await poll(scripted().exec, { once: true, json: true, prs: false })).toBe(0);
        expect(ticks()[0].idle).toBe(false);
        rmSync(factoryStatePath(root, 5));
        out.length = 0;
        writeFileSync(factoryRepoOwnerPath(root), JSON.stringify({ pid: 99, hostname: hostname(), startedAt: T0, run: '4' }));
        expect(await poll(scripted().exec, { once: true, json: true, prs: false }, { owner: { pid: 2, hostname: hostname(), isAlive: (pid) => pid === 99 } })).toBe(0);
        expect(ticks()[0].idle).toBe(false);
        expect(existsSync(factoryRepoOwnerPath(root))).toBe(true);
    });
    it('no intake source: the intake tick is skipped and the board shows runs only', async () => {
        seedParked();
        const w = scripted();
        expect(await poll(w.exec, { once: true, json: true })).toBe(0);
        expect(ticks()[0].intake).toEqual({ ran: false, reason: 'no intake source (factory.intake.source)' });
        expect(ticks()[0].board.map((b) => [b.stage, b.row.id])).toEqual([['outside', 4]]);
        expect(w.calls.some((c) => c.startsWith('gh issue'))).toBe(false);
    });
    it('idle: an unreadable or integrity-failed run state is never idle', async () => {
        seedParked();
        const path = factoryStatePath(root, 5);
        // Parked at a gate (would be idle) but its seal fails: readFactoryState still reads it.
        const parked = setGate(moveTo(issueRun(5), 'gates', 'gates', T0), 'merge', 'gates green; a human merges', T0);
        writeFileSync(path, JSON.stringify({ ...parked, integrity: 'f'.repeat(64) }));
        expect(await poll(scripted().exec, { once: true, json: true, prs: false })).toBe(0);
        expect(ticks()[0].idle).toBe(false);
        out.length = 0;
        save(parked);
        expect(await poll(scripted().exec, { once: true, json: true, prs: false })).toBe(0);
        expect(ticks()[0].idle).toBe(true);
        out.length = 0;
        writeFileSync(path, '{ not json');
        expect(await poll(scripted().exec, { once: true, json: true, prs: false })).toBe(0);
        expect(ticks()[0].idle).toBe(false);
        out.length = 0;
        rmSync(path);
        expect(await poll(scripted().exec, { once: true, json: true, prs: false })).toBe(0);
        expect(ticks()[0].idle).toBe(true);
    });
    it('owner: a pid without a hostname is no owner; a stale heartbeat is taken over; the refusal names the file', async () => {
        const path = pollStatePath(root);
        mkdirSync(dirname(path), { recursive: true });
        const me = { pid: 2, hostname: hostname(), isAlive: () => true };
        writeFileSync(path, JSON.stringify({ pid: 1, startedAt: T0, seen: [7] }));
        acquirePoller(root, T0, me).release();
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ seen: [7] });
        // Another host, last beat 2 h 1 min ago: stale.
        const beatAt = new Date(NOW - 121 * MIN).toISOString();
        writeFileSync(path, JSON.stringify({ pid: 1, hostname: 'elsewhere', startedAt: T0, beatAt, seen: [7] }));
        const now = new Date(NOW).toISOString();
        acquirePoller(root, now, me);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 2, hostname: hostname(), startedAt: now, beatAt: now, seen: [7] });
        // A live owner within the window is refused, with the file to delete.
        writeFileSync(path, JSON.stringify({ pid: 1, hostname: 'elsewhere', startedAt: T0, beatAt: new Date(NOW - 119 * MIN).toISOString(), seen: [] }));
        expect(() => acquirePoller(root, now, me)).toThrow(PollBusyError);
        expect(() => acquirePoller(root, now, me)).toThrow(`If no poller runs, delete ${path}`);
    });
    it('owner: each tick writes the heartbeat under the lock', async () => {
        let clock = NOW;
        let stop = () => { };
        const beats = [];
        const code = await poll(scripted().exec, { json: true }, {
            now: () => clock,
            onStop: (h) => { stop = h; return () => { }; },
            sleep: async () => {
                beats.push(JSON.parse(readFileSync(pollStatePath(root), 'utf8')).beatAt);
                clock += 5 * MIN;
                if (beats.length === 2)
                    stop();
            },
        });
        expect(code).toBe(0);
        expect(beats).toEqual([new Date(NOW).toISOString(), new Date(NOW + 5 * MIN).toISOString()]);
        // Released: no owner and no heartbeat left.
        expect(JSON.parse(readFileSync(pollStatePath(root), 'utf8')).beatAt).toBeUndefined();
    });
    it('a failed intake check or seen-file write is a tick error, never the end of the loop', async () => {
        // On the first tick item 2 cannot be shaped into a result: checkItems throws.
        const throwing = (exec, cwd, config, options) => {
            const forge = createForge(exec, cwd, config, options);
            return {
                ...forge,
                tracker: {
                    ...forge.tracker,
                    viewItem: (id) => {
                        const item = forge.tracker.viewItem(id);
                        return id === 2 && ticks().length === 0 ? Object.defineProperty({ ...item }, 'title', { get: () => { throw new Error('bad title'); } }) : item;
                    },
                },
            };
        };
        let stop = () => { };
        let lockHeld = false;
        const lock = `${pollStatePath(root)}.lock`;
        const code = await poll(scripted({
            // The second tick's seen-file write meets a held lock (a live pid, fresh).
            onCall: (cmd, args) => {
                if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list' && ticks().length === 1) {
                    writeFileSync(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
                    lockHeld = true;
                }
                return undefined;
            },
        }).exec, { json: true }, {
            projectConfig: () => LABEL,
            createForge: throwing,
            onStop: (h) => { stop = h; return () => { }; },
            sleep: async () => {
                if (lockHeld) {
                    rmSync(lock);
                    lockHeld = false;
                }
                if (ticks().length === 3)
                    stop();
            },
        });
        expect(code).toBe(0);
        const [t1, t2] = ticks();
        expect(t1.intake).toEqual({ ran: false, reason: 'the intake check failed' });
        expect(t1.errors).toEqual([expect.stringMatching(/^intake check: bad title/)]);
        expect(t2.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^intake seen: /)]));
        expect(ticks()).toHaveLength(3);
        // Tick 1 marked nothing seen and tick 2 could not write: tick 3 checks both ids again and records them.
        expect(ticks()[2].intake).toMatchObject({ ran: true, new: [{ id: 1 }, { id: 2 }] });
        expect(JSON.parse(readFileSync(pollStatePath(root), 'utf8')).seen).toEqual([1, 2]);
    }, 30_000);
    it('the audit never appends through a symbolic link', async () => {
        const target = join(root, 'elsewhere.jsonl');
        writeFileSync(target, '');
        mkdirSync(dirname(pollAuditPath(root)), { recursive: true });
        let linked = true;
        try {
            symlinkSync(target, pollAuditPath(root), 'file');
        }
        catch {
            linked = false;
        }
        // Without the privilege to make a file link (Windows), a junction is the link.
        if (!linked) {
            mkdirSync(join(root, 'dir-target'));
            symlinkSync(join(root, 'dir-target'), pollAuditPath(root), 'junction');
        }
        seedParked();
        expect(await poll(scripted({ prState: 'MERGED' }).exec, { once: true, json: true }, { projectConfig: () => LABEL })).toBe(0);
        expect(ticks()[0].intake).toMatchObject({ ran: true, items: 2 });
        expect(readFileSync(target, 'utf8')).toBe('');
        expect(lstatSync(pollAuditPath(root)).isSymbolicLink()).toBe(true);
    });
    it('the default heal scan on GitHub: read-only argv, heal state under the repository', () => {
        const calls = [];
        const exec = (cmd, args) => {
            calls.push(`${cmd} ${args.join(' ')}`);
            if (cmd === 'gh' && args[0] === 'run' && args[1] === 'list')
                return ok('[]');
            if (cmd === 'git' && args[0] === 'show')
                return { status: 128, stdout: '', stderr: 'fatal: path does not exist' };
            throw new Error(`unscripted ${cmd} ${args.join(' ')}`);
        };
        const warnings = [];
        const ledger = mkdtempSync(join(tmpdir(), 'omg-poll-ledger-'));
        try {
            const heal = defaultPollHealScan(exec, () => ({ config: { ...DEFAULT_HEAL_CONFIG }, warnings: [] }), ledger);
            expect(heal({ root, base: 'dev', kind: 'github', now: new Date(NOW), warn: (m) => warnings.push(m) })).toMatchObject({ entries: [], queued: 0 });
        }
        finally {
            rmSync(ledger, { recursive: true, force: true });
        }
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls)
            expect(c, c).toMatch(/^(?:gh run list |git show refs\/remotes\/origin\/dev:)/);
        expect(healStateDir(root).startsWith(root)).toBe(true);
        expect(warnings.join('\n')).toMatch(/known-flaky/);
    });
});
//# sourceMappingURL=poll.test.js.map