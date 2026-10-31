/**
 * `omg factory poll` on GitHub (a scripted gh + git): tick order, the intake
 * diff and its seen file, the PR resume hint, the board diff, the heal
 * capability gate, the owner lock, the rate-limit backoff, the stop signal,
 * the idle seam, and the read guard: a tick never spawns and never writes to
 * the tracker or forge.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryPollCommand } from '../../cli/commands/factory-poll.js';
import { createForge } from '../../forge/index.js';
import { FactorySafetyError } from '../run/exec.js';
import { HealRunRefused } from '../heal/run.js';
import { computeFactoryIntegrity, createFactoryState, factoryRepoOwnerPath, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate } from '../run/state.js';
import { acquirePoller, defaultPollHealScan, nextInterval, parseInterval, PollBusyError, pollAuditPath, pollStatePath, POLL_JSON_SCHEMA_VERSION, POLL_MAX_INTERVAL_MS, defaultPollAutoStart, defaultPollBudget, runFactoryPoll, } from '../poll.js';
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
});
describe('omg factory poll: factory.intake.autoStart', () => {
    const ON = { factory: { intake: { autoStart: true } } };
    /** A fake engine: records each start, optionally leaves a run behind. */
    function engine(r = {}) {
        const starts = [];
        const autoStart = async (o) => {
            starts.push(o.root);
            r.after?.();
            return { exitCode: r.exitCode ?? 0, next: r.next === undefined ? 1 : r.next, message: 'parked at awaiting-human: merge' };
        };
        return { starts, autoStart };
    }
    const on = (e, over = {}) => ({ trustedUser: () => ON, projectConfig: () => LABEL, autoStart: e.autoStart, budget: () => null, ...over });
    it('is off by default: an idle tick starts nothing', async () => {
        const e = engine();
        expect(await poll(scripted().exec, { once: true, json: true }, on(e, { trustedUser: () => undefined }))).toBe(0);
        expect(ticks()[0]).toMatchObject({ idle: true, autoStart: { started: false, reason: 'factory.intake.autoStart is off' } });
        expect(e.starts).toEqual([]);
    });
    it('a working-tree key is ignored with a warning', async () => {
        const e = engine();
        const project = { factory: { intake: { ...LABEL.factory.intake, autoStart: true } } };
        expect(await poll(scripted().exec, { once: true, json: true }, on(e, { trustedUser: () => undefined, projectConfig: () => project }))).toBe(0);
        expect(ticks()[0].autoStart).toEqual({ started: false, reason: 'factory.intake.autoStart is off' });
        expect(err.join('\n')).toContain('ignoring factory.intake.autoStart from the working-tree project config');
        expect(e.starts).toEqual([]);
    });
    it('on an idle tick it starts one run --next and reports the item and the exit code (JSON and text)', async () => {
        const e = engine({ exitCode: 3, next: 1 });
        const budget = [];
        expect(await poll(scripted().exec, { once: true, json: true }, on(e, { budget: (r) => { budget.push(r); return null; } }))).toBe(0);
        expect(ticks()[0]).toMatchObject({ idle: true, autoStart: { started: true, next: 1, exitCode: 3, message: 'parked at awaiting-human: merge' } });
        expect([e.starts, budget]).toEqual([[root], [root]]);
        const audit = readFileSync(pollAuditPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(audit.filter((a) => a.kind.startsWith('auto-start')).map((a) => [a.kind, a.next, a.exitCode])).toEqual([['auto-start', undefined, undefined], ['auto-start-done', 1, 3]]);
        out.length = 0;
        expect(await poll(scripted().exec, { once: true }, on(engine({ next: null })))).toBe(0);
        expect(out.join('\n')).toContain('auto-start: omg factory run --next found nothing runnable, exit 0');
        out.length = 0;
        expect(await poll(scripted().exec, { once: true }, on(e))).toBe(0);
        expect(out.join('\n')).toContain('auto-start: omg factory run --next took #1, exit 3: parked at awaiting-human: merge');
    });
    it('starts only on an idle tick with a successful, unthrottled intake read', async () => {
        const e = engine();
        save(moveTo(issueRun(5), 'implement', 'plan ok', T0));
        await poll(scripted().exec, { once: true, json: true, prs: false }, on(e));
        expect(ticks().at(-1)).toMatchObject({ idle: false, autoStart: { started: false, reason: 'a run is in flight' } });
        rmSync(factoryStatePath(root, 5));
        await poll(scripted().exec, { once: true, json: true, intake: false }, on(e));
        expect(ticks().at(-1).autoStart).toEqual({ started: false, reason: 'no intake read this tick (--no-intake)' });
        await poll(scripted().exec, { once: true, json: true }, on(e, { projectConfig: () => undefined }));
        expect(ticks().at(-1).autoStart).toEqual({ started: false, reason: 'no intake read this tick (no intake source (factory.intake.source))' });
        // A parked run keeps the tick idle; its PR read is throttled.
        seedParked();
        const limited = scripted({ onCall: (cmd, args) => (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' ? { status: 1, stdout: '', stderr: 'HTTP 429: Too Many Requests' } : undefined) });
        await poll(limited.exec, { once: true, json: true }, on(e));
        expect(ticks().at(-1)).toMatchObject({ idle: true, intake: { ran: true }, rateLimited: true, autoStart: { started: false, reason: 'the tick was rate-limited' } });
        expect(e.starts).toEqual([]);
    });
    it('not started while the run lock is held or without budget headroom', async () => {
        const e = engine();
        const owner = () => writeFileSync(factoryRepoOwnerPath(root), JSON.stringify({ pid: 99, hostname: hostname(), startedAt: T0, run: '4' }));
        const busy = { pid: 2, hostname: hostname(), isAlive: (pid) => pid === 99 };
        mkdirSync(factoryStateDir(root), { recursive: true });
        owner();
        expect(await poll(scripted().exec, { once: true, json: true }, on(e, { owner: busy }))).toBe(0);
        expect(ticks().at(-1).autoStart).toEqual({ started: false, reason: 'the run lock is held: an engine runs in this repository' });
        rmSync(factoryRepoOwnerPath(root));
        // idle is advisory: an engine that claims the lock during the board step (after the idle check; the items are
        // seen, so the board reads first) makes poll's own claim refuse at start time; the tick is skipped, not failed.
        let views = 0;
        const late = scripted({ onCall: (cmd, args) => { if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && ++views === 1)
                owner(); return undefined; } });
        expect(await poll(late.exec, { once: true, json: true, prs: false }, on(e, { owner: busy }))).toBe(0);
        expect(ticks().at(-1)).toMatchObject({ idle: true, errors: [], autoStart: { started: false, reason: expect.stringMatching(/^the run lock is held: another omg factory engine runs in this repository \(4, pid 99/) } });
        expect(JSON.parse(readFileSync(factoryRepoOwnerPath(root), 'utf8'))).toMatchObject({ pid: 99, run: '4' });
        rmSync(factoryRepoOwnerPath(root));
        // A successful claim is released before the start, so the run's own claim (the binding one) can take it.
        let held = 'unread';
        const check = async () => { held = existsSync(factoryRepoOwnerPath(root)); return { exitCode: 0, next: null, message: 'nothing runnable' }; };
        expect(await poll(scripted().exec, { once: true, json: true }, on({ autoStart: check }))).toBe(0);
        expect([ticks().at(-1).autoStart.started, held]).toEqual([true, false]);
        expect(await poll(scripted().exec, { once: true, json: true }, on(e, { budget: () => 'the AI credits used (9.00) reached budget.softLimit 5' }))).toBe(0);
        expect(ticks().at(-1).autoStart).toEqual({ started: false, reason: 'the AI credits used (9.00) reached budget.softLimit 5' });
        expect(e.starts).toEqual([]);
    });
    it('a broken run state (failing its integrity check) is never idle and starts nothing', async () => {
        const e = engine();
        const s = moveTo(issueRun(6), 'implement', 'plan ok', T0);
        mkdirSync(factoryStateDir(root), { recursive: true });
        writeFileSync(factoryStatePath(root, 6), JSON.stringify({ ...s, phase: 'merged', integrity: computeFactoryIntegrity(s) }));
        expect(await poll(scripted().exec, { once: true, json: true, prs: false }, on(e))).toBe(0);
        expect(ticks().at(-1)).toMatchObject({ idle: false, autoStart: { started: false, reason: 'a run state is unreadable or fails its integrity check' } });
        writeFileSync(factoryStatePath(root, 6), '{ not json');
        expect(await poll(scripted().exec, { once: true, json: true, prs: false }, on(e))).toBe(0);
        expect(ticks().at(-1)).toMatchObject({ idle: false, autoStart: { started: false, reason: 'a run state is unreadable or fails its integrity check' } });
        expect(e.starts).toEqual([]);
    });
    it('at most one run per tick: the started run in flight keeps the next tick from starting another', async () => {
        const e = engine({ after: () => save(moveTo(issueRun(1), 'implement', 'lane lost', T0)) });
        let stop = () => { };
        let sleeps = 0;
        const code = await poll(scripted().exec, { json: true, prs: false }, on(e, {
            onStop: (h) => { stop = h; return () => { }; },
            sleep: async () => { if (++sleeps === 2)
                stop(); },
        }));
        expect(code).toBe(0);
        expect(e.starts).toHaveLength(1);
        expect(ticks().map((t) => t.autoStart.started)).toEqual([true, false]);
        expect(ticks()[1].autoStart).toEqual({ started: false, reason: 'a run is in flight' });
    });
    it('defaultPollBudget: the factory.run limits must resolve, and the AI credits stay below budget.softLimit', () => {
        mkdirSync(join(root, '.copilot'), { recursive: true });
        writeFileSync(join(root, '.copilot', 'omg.jsonc'), JSON.stringify({ budget: { softLimit: 5 } }));
        mkdirSync(join(root, '.omg', 'state'), { recursive: true });
        const ledger = (credits) => writeFileSync(join(root, '.omg', 'state', 'budget-ledger.json'), JSON.stringify({
            version: 1, since: T0, sessions: { s1: { credits, premiumRequests: 0, source: 'measured', detail: 'x', updatedAt: T0 } }, teams: {}, notified: {},
        }));
        ledger(4.5);
        const budget = defaultPollBudget(() => ({}));
        expect(budget(root)).toBeNull();
        ledger(5);
        expect(budget(root)).toMatch(/AI credits used \(5\.00\) reached budget\.softLimit 5/);
        expect(defaultPollBudget(() => { throw new Error('omg factory run refuses to start: no per-lane AI-credit cap is resolved'); })(root)).toMatch(/no per-lane AI-credit cap/);
    });
    it('defaultPollAutoStart: a child `<entry> factory run --next --json` in the root; the outcome is read from its stdout', async () => {
        const script = join(root, 'fake-omg.cjs');
        writeFileSync(script, 'process.stdout.write(JSON.stringify({ ok: false, next: 7, message: process.argv.slice(2).join(" ") + " @ " + process.cwd() }, null, 2)); process.exit(3);\n');
        const r = await defaultPollAutoStart(script)({ root });
        expect(r).toMatchObject({ exitCode: 3, next: 7 });
        expect(r.message).toMatch(/^factory run --next --json @ /);
        writeFileSync(script, 'process.stdout.write("garbage"); process.exit(1);\n');
        expect(await defaultPollAutoStart(script)({ root })).toEqual({ exitCode: 1, next: null, message: 'no outcome on stdout' });
        expect(await defaultPollAutoStart('')({ root })).toMatchObject({ exitCode: 1, next: null });
    });
});
//# sourceMappingURL=poll.test.js.map