import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { PassThrough } from 'stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { lastJsonObject, leftoverReservations, parseApiTasks, parseLaunchMs, runTeamScenario, teamCost, teamLeaderEnv, } from '../copilot-team-scenario.js';
import { evaluateScenario, SCENARIOS, TEAM_BUDGET_MS } from '../copilot-sdk-scenarios.js';
const dirs = [];
afterEach(() => {
    for (const dir of dirs)
        rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
});
const TEAM = 'smoke-team';
const HOSTS = { 'worker-1': 90001, 'worker-2': 90002 };
const RUNTIMES = { 'worker-1': 90011, 'worker-2': 90012 };
function sandbox() {
    const parent = mkdtempSync(join(tmpdir(), 'omg-team-scn-'));
    dirs.push(parent);
    const project = join(parent, 'project');
    const home = join(parent, 'home');
    const stateDir = join(project, '.omg', 'state', 'team', TEAM);
    const reservationDir = join(project, '.omg', 'state', 'team-recovery', 'team-instances', 'abc123', TEAM);
    mkdirSync(home, { recursive: true });
    mkdirSync(reservationDir, { recursive: true });
    // The real sandbox is a git repo; the OMC root resolves through its top level.
    execFileSync('git', ['init', '--quiet'], { cwd: project, stdio: 'ignore' });
    for (const worker of ['worker-1', 'worker-2']) {
        const dir = join(stateDir, 'workers', worker);
        mkdirSync(join(dir, 'copilot-home', 'logs'), { recursive: true });
        mkdirSync(join(project, 'wt', worker), { recursive: true });
    }
    return { parent, project, home, stateDir, reservationDir };
}
function session(worker, final) {
    return JSON.stringify({
        schema_version: 1, worker_name: worker, host_pid: HOSTS[worker], runtime_pid: RUNTIMES[worker], state: final ? 'closed' : 'idle',
        usage: { credits: 0.5, premium_requests: 1, shutdown_premium_requests: final ? 1 : null, shutdown_credits: final ? 0.9 : null },
    });
}
/** Stands in for `node bridge/cli.cjs ...`: answers start/status/api/shutdown the way the real CLI does. */
function fakeOmg(box, calls, envs, opts = {}) {
    const alive = new Set([...Object.values(HOSTS), ...Object.values(RUNTIMES)]);
    let shutDown = false;
    const fake = ((_command, args, spawnOpts) => {
        const cliArgs = args.slice(1);
        calls.push(cliArgs);
        envs.push(spawnOpts.env ?? {});
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, exitCode: null, signalCode: null,
        });
        let code = 0;
        let out = '';
        let err = '';
        const [, sub] = cliArgs;
        if (cliArgs[0] === 'team' && sub === '2:copilot') {
            if (opts.startOk === false) {
                code = 1;
                err = 'cli_binary_preflight_failed:copilot';
            }
            else {
                for (const worker of ['worker-1', 'worker-2']) {
                    const dir = join(box.stateDir, 'workers', worker);
                    writeFileSync(join(dir, 'sdk-session.json'), session(worker, false));
                    writeFileSync(join(dir, 'sdk-events.jsonl'), `${JSON.stringify({ at: 'x', type: 'assistant.usage', data: { initiator: 'user', copilotUsage: { totalNanoAiu: 5e8 } } })}\n`);
                    writeFileSync(join(dir, 'copilot-home', 'logs', 'process-1.log'), '2026-10-07T00:00:00.000Z [INFO] runtime\n');
                }
                writeFileSync(join(box.reservationDir, 'reservation.json'), '{}');
                out = `${JSON.stringify({ teamName: TEAM, ok: true, startupFailures: [] })}\n`;
                err = '[omg team] sdk workers launched: 2 in 4321 ms (concurrency 2)\n';
            }
        }
        else if (sub === 'status' && shutDown) {
            const kept = opts.preserved ?? ['worker-1', 'worker-2'];
            out = `${JSON.stringify({ ok: false, team: TEAM, error: `No team state found for ${TEAM}`,
                preserved_worktrees: kept.map((name) => ({ workerName: name, path: join(box.project, 'wt', name), branch: null, commits: 1 })) })}\n`;
        }
        else if (sub === 'status') {
            const settled = opts.settle !== false;
            out = `${JSON.stringify({
                ok: true, team: TEAM, transport: 'sdk', team_state_root: box.stateDir,
                workers: {
                    total: 2,
                    list: ['worker-1', 'worker-2'].map((name) => ({ name, worktree_path: join(box.project, 'wt', name) })),
                    sdk: ['worker-1', 'worker-2'].map((name) => ({ name, provider: 'alive', host_pid: HOSTS[name], runtime_pid: RUNTIMES[name], session_id: `s-${name}` })),
                },
                tasks: { total: 2, pending: settled ? 0 : 1, in_progress: settled ? 0 : 1, completed: settled ? 2 : 0, failed: 0 },
            })}\n`;
        }
        else if (sub === 'api') {
            const settled = opts.settle !== false;
            out = `${JSON.stringify({ ok: true, operation: 'list-tasks', data: { count: 2, tasks: [
                        { id: '1', subject: 'Create the file team-alpha.txt containing exactly the line alpha', status: settled ? 'completed' : 'in_progress', owner: 'worker-2' },
                        { id: '2', subject: 'Create the file team-beta.txt containing exactly the line beta', status: settled ? 'completed' : 'pending', owner: 'worker-1' },
                    ] } })}\n`;
        }
        else if (sub === 'shutdown') {
            for (const worker of ['worker-1', 'worker-2'])
                writeFileSync(join(box.stateDir, 'workers', worker, 'sdk-session.json'), session(worker, true));
            if (opts.cleanShutdown !== false) {
                shutDown = true;
                out = `Team shutdown complete: ${TEAM}\n`;
            }
            else {
                code = 1;
                err = 'Team shutdown preserved: provider_cleanup_unverified:worker-1';
            }
        }
        // Let the runner poll the session file at least once mid-shutdown.
        setTimeout(() => {
            // The hosts wrote their final totals above; the CLI disposes the team state as it exits.
            if (sub === 'shutdown' && opts.cleanShutdown !== false) {
                for (const pid of alive)
                    alive.delete(pid);
                rmSync(box.stateDir, { recursive: true, force: true });
                rmSync(box.reservationDir, { recursive: true, force: true });
            }
            child.stdout.end(out);
            child.stderr.end(err);
            child.exitCode = code;
            setImmediate(() => child.emit('close', code, null));
        }, sub === 'shutdown' ? 300 : 0);
        return child;
    });
    return Object.assign(fake, { alive });
}
/**
 * git: the worker that owns a task committed its file on top of the leader
 * HEAD; `merged` workers' heads are ancestors of the leader HEAD afterwards.
 */
const fakeGit = (box, merged = []) => ((_cmd, args, o) => {
    const reply = (stdout, status = 0) => ({ status, stdout, stderr: '', pid: 1, output: [], signal: null });
    const inWorktree = o.cwd?.startsWith(join(box.project, 'wt')) ?? false;
    const worker = o.cwd === join(box.project, 'wt', 'worker-1') ? 'worker-1' : 'worker-2';
    if (args[0] === 'rev-parse')
        return reply(inWorktree ? `head-${worker}\n` : 'leaderhead\n');
    if (args[0] === 'merge-base')
        return reply('', merged.some((w) => args.includes(`head-${w}`)) ? 0 : 1);
    const file = worker === 'worker-2' ? 'team-alpha.txt' : 'team-beta.txt';
    if (args[0] === 'log')
        return reply(`smoke team ${worker === 'worker-2' ? 'alpha' : 'beta'}\n`);
    if (args[0] === 'diff')
        return reply(`${file}\n`);
    return reply('');
});
function baseInput(box, spawn) {
    return {
        root: join(box.parent, 'plugin'),
        bin: join(box.parent, 'bin', 'copilot.cmd'),
        env: { PATH: 'p', CLAUDE_CODE_ENTRYPOINT: 'cli', OMC_TEAM_WORKER: 'x/worker-1' },
        projectDir: box.project,
        home: box.home,
        timeoutMs: 120_000,
        maxCredits: 30,
        budget: 30,
        eventsPath: join(box.home, 'events-team.jsonl'),
        spawnSync: fakeGit(box),
        spawn,
        pollMs: 5,
        isAlive: (pid) => spawn.alive?.has(pid) ?? false,
    };
}
describe('team scenario helpers', () => {
    it('teamLeaderEnv sets the Copilot host signal, copilot on PATH, detached worktrees and a per-host cap', () => {
        const dir = join(tmpdir(), 'npm');
        const env = teamLeaderEnv({ PATH: 'existing', CLAUDE_CODE_ENTRYPOINT: 'cli', OMC_TEAM_WORKER: 't/w' }, join(dir, 'copilot.cmd'), 7);
        expect(env.PATH?.split(delimiter)).toEqual([dir, 'existing']);
        expect(env).toMatchObject({ COPILOT_CLI: '1', OMC_RUNTIME_V2: '1', OMC_TEAM_WORKTREE_MODE: 'detached', OMC_TEAM_SDK_MAX_CREDITS: '3' });
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        expect(env.OMC_TEAM_WORKER).toBeUndefined();
    });
    it('lastJsonObject skips noise and takes the last object line', () => {
        expect(lastJsonObject('note\n{"a":1}\n[1]\n{"b":2}\nnot json')).toEqual({ b: 2 });
        expect(lastJsonObject('')).toBeNull();
    });
    it('parseLaunchMs reads the launch line', () => {
        expect(parseLaunchMs('x\n[omg team] sdk workers launched: 2 in 812 ms (concurrency 2)\n')).toBe(812);
        expect(parseLaunchMs('nothing')).toBeNull();
    });
    it('parseApiTasks reads data.tasks', () => {
        expect(parseApiTasks({ ok: true, data: { tasks: [{ id: '1', subject: 's', status: 'completed', owner: 'worker-1' }, { id: 2, status: 'pending' }] } }))
            .toEqual([{ id: '1', subject: 's', status: 'completed', owner: 'worker-1' }, { id: '2', subject: '', status: 'pending', owner: null }]);
    });
    it('teamCost prefers session totals and falls back to events per worker', () => {
        const usage = new Map([['worker-1', { premium: 1, credits: 0.9, final: true }]]);
        const events = new Map([['worker-2', [{ type: 'assistant.usage', data: { initiator: 'user', copilotUsage: { totalNanoAiu: 1e9 } } }]]]);
        expect(teamCost(usage, events)).toEqual({ premiumRequests: 2, credits: 1.9, source: 'worker-1 session.shutdown, worker-2 1 assistant.usage event(s)' });
    });
    it('leftoverReservations finds only the named team', () => {
        const box = sandbox();
        writeFileSync(join(box.reservationDir, 'reservation.json'), '{}');
        expect(leftoverReservations(box.project, TEAM)).toHaveLength(1);
        expect(leftoverReservations(box.project, 'other')).toEqual([]);
    });
});
describe('runTeamScenario', () => {
    it('starts the team with no --transport, waits for both tasks, shuts down cleanly and passes every check', async () => {
        const box = sandbox();
        const calls = [];
        const envs = [];
        const run = await runTeamScenario(baseInput(box, fakeOmg(box, calls, envs)));
        expect(calls[0]).toEqual(['team', '2:copilot', '--json', SCENARIOS.team.prompt]);
        expect(calls.flat()).not.toContain('--transport');
        expect(calls.at(-2)).toEqual(['team', 'shutdown', TEAM]);
        expect(calls.at(-1)).toEqual(['team', 'status', TEAM, '--json']);
        expect(envs[0]).toMatchObject({ COPILOT_CLI: '1', OMC_TEAM_WORKTREE_MODE: 'detached' });
        expect(run).toMatchObject({ name: 'team', idle: true, timedOut: false, timeoutMs: TEAM_BUDGET_MS });
        expect(run.team?.start.launchMs).toBe(4321);
        expect(run.team?.cost).toMatchObject({ premiumRequests: 2, source: 'worker-1 session.shutdown, worker-2 session.shutdown' });
        expect(readdirSync(join(box.home, 'logs')).sort()).toEqual(['team-worker-1-process-1.log', 'team-worker-2-process-1.log']);
        expect(existsSync(join(box.home, 'events-team.jsonl'))).toBe(true);
        const { checks, cost } = evaluateScenario({ ...run, logText: '' });
        expect(checks.filter((c) => !c.ok)).toEqual([]);
        expect(cost.premiumRequests).toBe(2);
        expect(run.team?.commits.map((c) => [c.worker, c.head, c.survived])).toEqual([
            ['worker-1', 'head-worker-1', 'preserved'], ['worker-2', 'head-worker-2', 'preserved'],
        ]);
    });
    it('scn.team.retained accepts a merged head and fails a worker commit that neither merged nor survived in a preserved worktree', async () => {
        const box = sandbox();
        const run = await runTeamScenario({ ...baseInput(box, fakeOmg(box, [], [], { preserved: [] })), spawnSync: fakeGit(box, ['worker-2']) });
        expect(run.team?.commits.map((c) => c.survived)).toEqual(['lost', 'merged']);
        const retained = evaluateScenario({ ...run, logText: '' }).checks.find((c) => c.id === 'scn.team.retained');
        expect(retained).toMatchObject({ ok: false, detail: expect.stringContaining('worker-1 head-wor lost') });
    });
    it('forces the shutdown when the tasks never settle and fails completed/committed', async () => {
        const box = sandbox();
        const calls = [];
        const run = await runTeamScenario({ ...baseInput(box, fakeOmg(box, calls, [], { settle: false })), now: (() => { let t = 0; return () => (t += 60_000); })() });
        expect(calls.at(-2)).toEqual(['team', 'shutdown', TEAM, '--force']);
        expect(run).toMatchObject({ timedOut: true, idle: false, error: expect.stringContaining('--force') });
        const failed = evaluateScenario({ ...run, logText: '' }).checks.filter((c) => !c.ok).map((c) => c.id);
        expect(failed).toEqual(expect.arrayContaining(['scn.team.completed', 'scn.team.status', 'scn.team.shutdown', 'scn.team.exit']));
    });
    it('reports orphans and preserved state when shutdown does not clean up', async () => {
        const box = sandbox();
        const run = await runTeamScenario({ ...baseInput(box, fakeOmg(box, [], [], { cleanShutdown: false })), now: (() => { let t = 0; return () => (t += 1_000); })() });
        expect(run.team?.orphans.sort()).toEqual([...Object.values(HOSTS), ...Object.values(RUNTIMES)].sort());
        expect(run.team?.reservationsLeft).toHaveLength(1);
        expect(run.team?.stateLeft).toBe(true);
        const shutdownCheck = evaluateScenario({ ...run, logText: '' }).checks.find((c) => c.id === 'scn.team.shutdown');
        expect(shutdownCheck).toMatchObject({ ok: false, detail: expect.stringContaining('orphans 90001') });
    });
    it('a failed start yields an error and never shuts anything down', async () => {
        const box = sandbox();
        const calls = [];
        const run = await runTeamScenario(baseInput(box, fakeOmg(box, calls, [], { startOk: false })));
        expect(calls).toHaveLength(1);
        expect(run).toMatchObject({ idle: false, error: expect.stringContaining('cli_binary_preflight_failed') });
        const started = evaluateScenario({ ...run, logText: '' }).checks.find((c) => c.id === 'scn.team.started');
        expect(started).toMatchObject({ ok: false });
    });
});
//# sourceMappingURL=copilot-team-scenario.test.js.map