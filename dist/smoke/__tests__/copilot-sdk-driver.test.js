import { EventEmitter } from 'events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonl } from '../copilot-session-eval.js';
import { globalModuleRoots, importFromDir, resolveShimTarget, runSdkTier, runtimeCreditCap, satisfiesSdkRange, } from '../copilot-sdk-driver.js';
import { CREDIT_CAP_SKIP_DETAIL, SCENARIOS, scenarioCheckIds, scenarioExcludedTools, SDK_MISSING_DETAIL } from '../copilot-sdk-scenarios.js';
import { LIVE_RUN_REFUSED_DETAIL, liveRunRefusal, runCopilotSmoke } from '../copilot-smoke.js';
import { smokeExitCode } from '../../cli/commands/smoke.js';
const FIXTURES = join(__dirname, 'fixtures');
const fixtureEvents = (name) => parseJsonl(readFileSync(join(FIXTURES, `tier2-${name}-events.jsonl`), 'utf-8')).events;
const LOG = readFileSync(join(FIXTURES, 'tier2-hooks-debug-excerpt.log'), 'utf-8');
const CLEAN_LOG = LOG.split('\n').filter((l) => !l.includes('[run.cjs]')).join('\n');
let root;
let parent;
function write(path, content) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
}
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sdk-root-'));
    write(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot', version: '9.9.9' }));
    write(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-copilot', version: '9.9.9' }));
    write(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { t: { command: 'node' } } }));
    for (const s of ['alpha', 'plan'])
        write(join(root, 'skills', s, 'SKILL.md'), '# s');
    write(join(root, 'agents', 'architect.md'), '# a');
    write(join(root, 'copilot', 'agents', 'architect.md'), '# a');
    write(join(root, 'dist', 'mcp', 'standalone-server.js'), '// fake');
    parent = mkdtempSync(join(tmpdir(), 'sdk-parent-'));
    mkdirSync(join(parent, 'home'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
});
/** Re-stamp a fixture log's ISO timestamps to `iso` (the driver windows lines by time). */
const restamp = (text, iso = new Date().toISOString()) => text.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/gm, iso);
function scenarioOf(prompt) {
    const hit = Object.keys(SCENARIOS).find((s) => SCENARIOS[s].prompt === prompt);
    if (!hit)
        throw new Error(`unexpected prompt ${prompt}`);
    return hit;
}
/** A fake @github/copilot-sdk: static RPCs answer from the fake plugin root; prompts replay fixture JSONL. */
function fakeSdk(opts = {}) {
    const rec = { ops: [], sessions: [], permissions: [] };
    let n = 0;
    const sentAt = {};
    class FakeClient {
        cliProcess = opts.pid ? { pid: opts.pid } : null;
        constructor(options) {
            rec.clientOptions = options;
            rec.connection = options.connection;
        }
        async start() {
            rec.ops.push('start');
            if (opts.startError)
                throw new Error(opts.startError);
        }
        async stop() {
            rec.ops.push('stop');
            if (opts.stopError)
                throw new Error(opts.stopError);
            this.cliProcess = null;
            return [];
        }
        async forceStop() { rec.ops.push('forceStop'); this.cliProcess = null; }
        async getStatus() { return { version: '1.0.91', protocolVersion: 3 }; }
        async listModels() { return (opts.models ?? ['auto']).map((id) => ({ id })); }
        async deleteSession(id) { rec.ops.push(`delete:${id}`); }
        async createSession(config) {
            const id = `s${++n}`;
            rec.ops.push(`create:${id}`);
            rec.sessions.push(config);
            const home = rec.clientOptions.baseDirectory;
            let current;
            const emit = (e) => config.onEvent?.(e);
            return {
                sessionId: id,
                async send({ prompt }) {
                    rec.ops.push(`send:${id}`);
                    if (opts.sendError)
                        throw new Error(opts.sendError);
                    current = scenarioOf(prompt);
                    const scenario = current;
                    for (const kind of ['read', 'shell', 'write']) {
                        const decision = await config.onPermissionRequest({ kind, fullCommandText: 'git push --force origin main' }, { sessionId: id });
                        rec.permissions.push({ scenario, kind, decision: decision.kind });
                    }
                    sentAt[scenario] = new Date().toISOString();
                    if (opts.hang?.includes(scenario))
                        return 'm1';
                    setImmediate(() => {
                        appendFileSync(join(home, 'logs', 'process-1.log'), `${restamp(opts.log ?? CLEAN_LOG)}\n`);
                        const late = opts.lateLine;
                        if (late?.during === scenario)
                            appendFileSync(join(home, 'logs', 'process-1.log'), `${restamp(late.text, sentAt[late.from])}\n`);
                        for (const e of opts.events?.[scenario] ?? fixtureEvents(scenario))
                            emit(e);
                    });
                    return 'm1';
                },
                async abort() {
                    rec.ops.push(`abort:${id}`);
                    setImmediate(() => {
                        emit({ type: 'abort', data: { reason: 'user_initiated' } });
                        emit({ type: 'session.idle', data: { aborted: true } });
                    });
                },
                async disconnect() { rec.ops.push(`disconnect:${id}`); },
                rpc: {
                    plugins: { list: async () => ({ plugins: [{ name: 'oh-my-copilot', version: '9.9.9', enabled: true }] }) },
                    skills: {
                        list: async () => ({
                            skills: ['alpha', 'plan'].map((s) => ({ name: s, source: 'plugin', pluginName: 'oh-my-copilot', path: join(root, 'skills', s, 'SKILL.md') })),
                        }),
                    },
                    agent: { list: async () => ({ agents: [{ name: 'oh-my-copilot:architect' }] }) },
                    mcp: {
                        list: async () => ({ servers: [{ name: 't', status: 'connected' }] }),
                        listTools: async () => ({ tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
                    },
                    tools: {
                        initializeAndValidate: async () => { rec.ops.push(`tools.init:${id}`); return {}; },
                        getCurrentMetadata: async () => ({
                            tools: rec.ops.includes(`tools.init:${id}`)
                                ? (opts.toolNames ?? ['view', 't-state_read', 't-notepad_read']).map((name) => ({ name, mcpServerName: name.startsWith('t-') ? 't' : undefined, description: '' }))
                                : [], // CLI 1.0.91 reports an empty list until the tool set is initialized
                        }),
                    },
                },
            };
        }
    }
    const module = {
        CopilotClient: FakeClient,
        RuntimeConnection: { forStdio: (o) => o },
    };
    // The runtime creates its log dir at start.
    mkdirSync(join(parent, 'home', 'logs'), { recursive: true });
    return { loaded: { module, version: '1.0.16', from: 'fake' }, rec };
}
function gitSpawnSync(calls, refs = '') {
    return ((command, args, options) => {
        calls.push({ args, cwd: options?.cwd });
        const ok = (stdout) => ({ status: 0, stdout, stderr: '', pid: 1, output: [], signal: null });
        if (command !== 'git')
            return { ...ok(''), status: 1 };
        return ok(args.includes('for-each-ref') ? refs : '');
    });
}
function input(loaded, over = {}, gitCalls = []) {
    return {
        root,
        bin: process.platform === 'win32' ? 'C:\\fake\\copilot.exe' : '/fake/copilot',
        binVersion: '1.0.91',
        packageVersion: '9.9.9',
        home: join(parent, 'home'),
        projectDir: join(parent, 'project'),
        remoteDir: join(parent, 'remote.git'),
        env: { COPILOT_HOME: join(parent, 'home'), OMC_GIT_GUARDRAILS: '1' },
        scenarios: ['smoke', 'guardrail'],
        timeoutMs: 5_000,
        maxCredits: 30,
        keepHome: false,
        loadSdk: async () => loaded,
        loadExpectedToolCount: async () => 3,
        spawnSync: gitSpawnSync(gitCalls),
        skillDirs: ['alpha', 'plan'],
        agentFiles: ['architect.md'],
        mcpServer: 't',
        runChain: async () => { throw new Error('chain runner not stubbed'); },
        runTeam: async () => { throw new Error('team runner not stubbed'); },
        ...over,
    };
}
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
describe('runSdkTier (fake SDK)', () => {
    it('missing module: every sdk.* and scn.* check carries the install hint and the tier is skipped', async () => {
        const result = await runSdkTier(input(null));
        expect(result.skipped).toBe(SDK_MISSING_DETAIL);
        expect(result.checks.map((c) => c.id)).toEqual([
            'sdk.available', 'sdk.runtime', 'sdk.plugins', 'sdk.skills', 'sdk.agents', 'sdk.mcp', 'sdk.tools_excluded',
            ...scenarioCheckIds('smoke'), ...scenarioCheckIds('guardrail'),
        ]);
        expect(result.checks.every((c) => !c.ok && c.detail === SDK_MISSING_DETAIL)).toBe(true);
        expect(SDK_MISSING_DETAIL).toBe('@github/copilot-sdk not installed — npm i -g @github/copilot-sdk --omit=optional --ignore-scripts');
    });
    it('a throwing loader counts as missing', async () => {
        const result = await runSdkTier(input(null, { loadSdk: async () => { throw new Error('ERR_MODULE_NOT_FOUND'); } }));
        expect(result.skipped).toBe(SDK_MISSING_DETAIL);
    });
    it('static checks only (scenarios: []): zero prompts sent', async () => {
        const { loaded, rec } = fakeSdk();
        const result = await runSdkTier(input(loaded, { scenarios: [] }));
        expect(result.checks.map((c) => c.id)).toEqual(['sdk.available', 'sdk.runtime', 'sdk.plugins', 'sdk.skills', 'sdk.agents', 'sdk.mcp', 'sdk.tools_excluded']);
        expect(result.checks.filter((c) => !c.ok)).toEqual([]);
        expect(byId(result.checks)['sdk.tools_excluded'].detail).toBe('t-host_smoke absent; 2 other t-* tools offered (3 total)');
        expect(rec.ops).toContain('tools.init:s1'); // the tool set was initialized for the listing
        expect(rec.ops.some((o) => o.startsWith('send:'))).toBe(false);
        expect(result.sdk).toEqual({ version: '1.0.16', runtimeVersion: '1.0.91', protocolVersion: 3, model: 'auto' });
        expect(result.cost).toEqual({ premiumRequests: 0, credits: 0 });
    });
    it('drives the installed exe with debug logs via args, one client, isolated sessions', async () => {
        const { loaded, rec } = fakeSdk();
        const gitCalls = [];
        const result = await runSdkTier(input(loaded, {}, gitCalls));
        expect(result.checks.filter((c) => !c.ok)).toEqual([]);
        expect(rec.connection).toMatchObject({ path: input(null).bin, args: ['--log-level', 'debug', '--max-ai-credits', '30'] });
        expect(rec.connection.env).toMatchObject({ OMC_GIT_GUARDRAILS: '1' });
        expect(rec.clientOptions).toMatchObject({ baseDirectory: join(parent, 'home'), workingDirectory: join(parent, 'project') });
        expect(rec.clientOptions).not.toHaveProperty('logLevel');
        // static + 2 scenario sessions, all with the plugin and without the GitHub MCP server
        expect(rec.sessions).toHaveLength(3);
        for (const s of rec.sessions) {
            expect(s).toMatchObject({ pluginDirectories: [root], workingDirectory: join(parent, 'project'), disabledMcpServers: ['github-mcp-server'] });
            expect(s.excludedTools).toContain('t-host_smoke');
            expect(s).not.toHaveProperty('model'); // only auto listed
        }
        expect(rec.sessions[1].excludedTools).toEqual(scenarioExcludedTools('smoke', 't'));
        expect(rec.sessions[2].excludedTools).toEqual(scenarioExcludedTools('guardrail', 't'));
        // permission policy: smoke grants nothing; guardrail only the push
        expect(rec.permissions.filter((p) => p.decision !== 'reject')).toEqual([{ scenario: 'guardrail', kind: 'shell', decision: 'approve-once' }]);
        // sandbox repo on main with a bare origin; the guardrail checks its refs
        expect(gitCalls.map((c) => c.args.join(' '))).toEqual(expect.arrayContaining([
            '-c init.defaultBranch=main init -q', 'checkout -q -B main', `init -q --bare ${join(parent, 'remote.git')}`,
            `remote add origin ${join(parent, 'remote.git')}`, `--git-dir ${join(parent, 'remote.git')} for-each-ref`,
        ]));
        // event capture per scenario
        expect(Object.keys(result.events)).toEqual(['smoke', 'guardrail']);
        expect(parseJsonl(readFileSync(result.events.guardrail, 'utf-8')).events.length).toBe(fixtureEvents('guardrail').length);
        expect(result.cost.premiumRequests).toBe(2);
        expect(result.cost.credits).toBeGreaterThan(0);
    });
    it.each(['skill', 'delegate'])('%s scenario passes on its captured stream', async (name) => {
        const { loaded } = fakeSdk();
        const result = await runSdkTier(input(loaded, { scenarios: [name] }));
        expect(result.checks.filter((c) => !c.ok)).toEqual([]);
        expect(result.checks.map((c) => c.id).slice(7)).toEqual(scenarioCheckIds(name));
    });
    it('key failures: no deny event, wrong skill path, no subagent event', async () => {
        const guard = fixtureEvents('guardrail').filter((e) => e.type !== 'tool.execution_complete');
        const skill = fixtureEvents('skill').map((e) => (e.type === 'skill.invoked' ? { ...e, data: { ...e.data, path: '/x/skills/other/SKILL.md' } } : e));
        const delegate = fixtureEvents('delegate').filter((e) => !String(e.type).startsWith('subagent.'));
        const { loaded } = fakeSdk({ events: { guardrail: guard, skill, delegate } });
        const c = byId((await runSdkTier(input(loaded, { scenarios: ['guardrail', 'skill', 'delegate'] }))).checks);
        expect(c['scn.guardrail.denied'].ok).toBe(false);
        expect(c['scn.skill.invoked'].ok).toBe(false);
        expect(c['scn.delegate.selected'].ok).toBe(false);
        expect(c['scn.delegate.completed'].ok).toBe(false);
    });
    it('runs chain through the chain runner, never an SDK scenario session, and totals both links', async () => {
        const { loaded, rec } = fakeSdk();
        const evidence = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'tier2-chain-evidence.json'), 'utf-8'));
        const calls = [];
        const result = await runSdkTier(input(loaded, {
            scenarios: ['chain'],
            runChain: async (args) => {
                calls.push(args);
                return { name: 'chain', events: [], idle: true, timedOut: false, timeoutMs: args.timeoutMs, model: 'm', maxCredits: args.maxCredits, budget: args.budget, capped: false, wedged: false, chain: evidence };
            },
        }));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ projectDir: expect.any(String), home: expect.any(String), eventsPath: expect.stringMatching(/events-chain\.jsonl$/) });
        expect(rec.sessions).toHaveLength(1); // the static-check session only
        const c = byId(result.checks);
        for (const id of ['link1', 'spawned', 'inherited', 'closed', 'premium'])
            expect(c[`scn.chain.${id}`].ok).toBe(true);
        expect(result.cost.premiumRequests).toBe(2);
    });
    it('runs team through the team runner after the SDK scenarios and before chain, and totals its workers', async () => {
        const { loaded, rec } = fakeSdk();
        const order = [];
        const teamCalls = [];
        const result = await runSdkTier(input(loaded, {
            scenarios: ['chain', 'team', 'smoke'],
            runChain: async (args) => {
                order.push('chain');
                return { name: 'chain', events: [], idle: false, timedOut: false, timeoutMs: args.timeoutMs, model: 'm', maxCredits: args.maxCredits, budget: args.budget, capped: false, wedged: false, error: 'stub' };
            },
            runTeam: async (args) => {
                order.push('team');
                teamCalls.push(args);
                return {
                    name: 'team', events: [], idle: true, timedOut: false, timeoutMs: args.timeoutMs, model: 'm', maxCredits: args.maxCredits, budget: args.budget, capped: false, wedged: false,
                    team: {
                        teamName: 't', start: { code: 0, ok: true, ms: 1, launchMs: 1, stderr: '' }, status: null, tasks: [], commits: [], shutdown: null,
                        orphans: [], reservationsLeft: [], stateLeft: false, durationMs: 1, budgetMs: 1, cost: { premiumRequests: 2, credits: 1.5, source: 'fake' },
                    },
                };
            },
        }));
        expect(order).toEqual(['team', 'chain']);
        expect(rec.sessions).toHaveLength(2); // static checks + smoke; team and chain bring their own sessions
        expect(teamCalls[0]).toMatchObject({ projectDir: expect.any(String), home: expect.any(String), bin: expect.any(String), eventsPath: expect.stringMatching(/events-team\.jsonl$/) });
        expect(byId(result.checks)['scn.team.premium']).toMatchObject({ ok: true, detail: '2 premium request(s) over fake (max 2)' });
        expect(result.cost.premiumRequests).toBeGreaterThanOrEqual(2);
    });
    it('a pushed ref on the bare remote fails no_push', async () => {
        const { loaded } = fakeSdk();
        const c = byId((await runSdkTier(input(loaded, { scenarios: ['guardrail'], spawnSync: gitSpawnSync([], 'abc commit\trefs/heads/main\n') }))).checks);
        expect(c['scn.guardrail.no_push'].ok).toBe(false);
    });
    it('adapter errors come from the log lines written during the scenario (fail-open timeout not masked)', async () => {
        const { loaded } = fakeSdk({ log: LOG });
        const c = byId((await runSdkTier(input(loaded, { scenarios: ['smoke'] }))).checks)['scn.smoke.adapter_errors'];
        expect(c).toMatchObject({ ok: false, detail: '1 hook stderr line(s) from wiki-session-end.mjs' });
    });
    it('aborts on timeout and still cleans up', async () => {
        const { loaded, rec } = fakeSdk({ hang: ['smoke'] });
        const result = await runSdkTier(input(loaded, { scenarios: ['smoke'], timeoutMs: 50 }));
        expect(byId(result.checks)['scn.smoke.exit']).toMatchObject({ ok: false, detail: 'no session.idle within 50 ms (aborted)' });
        expect(rec.ops).toEqual(['start', 'create:s1', 'tools.init:s1', 'disconnect:s1', 'delete:s1', 'create:s2', 'send:s2', 'abort:s2', 'disconnect:s2', 'delete:s2', 'stop']);
    });
    it('cleanup runs in finally when a session throws: disconnect, deleteSession, then stop', async () => {
        const { loaded, rec } = fakeSdk({ sendError: 'transport closed' });
        const result = await runSdkTier(input(loaded, { scenarios: ['smoke'] }));
        expect(byId(result.checks)['scn.smoke.exit']).toMatchObject({ ok: false, detail: 'session failed: transport closed' });
        expect(rec.ops.slice(-4)).toEqual(['send:s2', 'disconnect:s2', 'delete:s2', 'stop']);
    });
    it('keepHome keeps the on-disk session state (no deleteSession)', async () => {
        const { loaded, rec } = fakeSdk();
        await runSdkTier(input(loaded, { scenarios: ['smoke'], keepHome: true }));
        expect(rec.ops.some((o) => o.startsWith('delete:'))).toBe(false);
        expect(rec.ops.at(-1)).toBe('stop');
    });
    it('a runtime that does not start fails the rest with the reason and still stops the client', async () => {
        const { loaded, rec } = fakeSdk({ startError: 'spawn EACCES' });
        const result = await runSdkTier(input(loaded, { scenarios: ['smoke'] }));
        const c = byId(result.checks);
        expect(c['sdk.available'].ok).toBe(true);
        expect(c['sdk.runtime'].detail).toMatch(/runtime did not start .*spawn EACCES/);
        expect(c['scn.smoke.reply'].ok).toBe(false);
        expect(rec.ops).toEqual(['start', 'stop']);
    });
    it('uses a listed cheap model explicitly and records it', async () => {
        const { loaded, rec } = fakeSdk({ models: ['auto', 'claude-opus-5-5', 'gpt-5-mini'] });
        const result = await runSdkTier(input(loaded, { scenarios: ['smoke'] }));
        expect(rec.sessions[1].model).toBe('gpt-5-mini');
        expect(result.sdk?.model).toBe('gpt-5-mini');
        expect(byId(result.checks)['scn.smoke.cost'].detail).toMatch(/model gpt-5-mini/);
    });
});
describe('runSdkTier credit cap, log windows, tree kill', () => {
    it('maxCredits is a cap: the scenario passing it is aborted and the rest are skipped', async () => {
        const { loaded, rec } = fakeSdk();
        const result = await runSdkTier(input(loaded, { scenarios: ['smoke', 'guardrail'], maxCredits: 1e-6 }));
        const c = byId(result.checks);
        expect(c['scn.smoke.exit']).toMatchObject({ ok: false, detail: expect.stringMatching(/^aborted: credit cap reached/) });
        expect(c['scn.smoke.cost'].ok).toBe(false);
        expect(rec.ops).toContain('abort:s2');
        for (const id of scenarioCheckIds('guardrail'))
            expect(c[id]).toMatchObject({ ok: false, detail: CREDIT_CAP_SKIP_DETAIL });
        expect(rec.ops.filter((o) => o.startsWith('send:'))).toEqual(['send:s2']); // guardrail never prompted
        expect(rec.connection.args).toEqual(['--log-level', 'debug', '--max-ai-credits', '30']); // CLI minimum
    });
    it('passes the cap to the runtime when above the CLI minimum', async () => {
        const { loaded, rec } = fakeSdk();
        await runSdkTier(input(loaded, { scenarios: [], maxCredits: 45.5 }));
        expect(rec.connection.args).toEqual(['--log-level', 'debug', '--max-ai-credits', '46']);
        expect(runtimeCreditCap(10)).toBe(30);
    });
    it('a late SessionEnd timeout line of scenario 1 is attributed to scenario 1, not scenario 2', async () => {
        const late = LOG.split('\n').find((l) => l.includes('[run.cjs]'));
        const { loaded } = fakeSdk({ lateLine: { from: 'smoke', during: 'guardrail', text: late } });
        const c = byId((await runSdkTier(input(loaded, { scenarios: ['smoke', 'guardrail'] }))).checks);
        expect(c['scn.smoke.adapter_errors']).toMatchObject({ ok: false, detail: '1 hook stderr line(s) from wiki-session-end.mjs' });
        expect(c['scn.guardrail.adapter_errors'].ok).toBe(true);
    });
    it('kills the runtime tree when the pid outlives stop()', async () => {
        const { loaded, rec } = fakeSdk({ pid: 4242 });
        const killed = [];
        await runSdkTier(input(loaded, { scenarios: [], isAlive: () => killed.length === 0, killTree: (pid) => { killed.push(pid); rec.ops.push(`kill:${pid}`); } }));
        expect(killed).toEqual([4242]);
        expect(rec.ops.slice(-2)).toEqual(['stop', 'kill:4242']);
    });
    it('a failing stop(): tree kill while the runtime lives, then forceStop', async () => {
        const { loaded, rec } = fakeSdk({ pid: 4242, stopError: 'hung' });
        let alive = true;
        await runSdkTier(input(loaded, { scenarios: [], isAlive: () => alive, killTree: (pid) => { alive = false; rec.ops.push(`kill:${pid}`); } }));
        expect(rec.ops.slice(-3)).toEqual(['stop', 'kill:4242', 'forceStop']);
    });
    it('no tree kill when the runtime exited with stop()', async () => {
        const { loaded } = fakeSdk({ pid: 4242 });
        const killed = [];
        await runSdkTier(input(loaded, { scenarios: ['smoke'], isAlive: () => false, killTree: (pid) => { killed.push(pid); } }));
        expect(killed).toEqual([]);
    });
    it('sdk.tools_excluded fails when host_smoke is still offered', async () => {
        const { loaded } = fakeSdk({ toolNames: ['t-state_read', 't-host_smoke'] });
        const c = byId((await runSdkTier(input(loaded, { scenarios: [] }))).checks);
        expect(c['sdk.tools_excluded']).toMatchObject({ ok: false, detail: 't-host_smoke still offered to the model' });
    });
    it('derives the excluded tool from the MCP server name', async () => {
        const { loaded, rec } = fakeSdk({ toolNames: ['omg-state_read'] });
        await runSdkTier(input(loaded, { scenarios: ['smoke'], mcpServer: 'omg' }));
        for (const s of rec.sessions)
            expect(s.excludedTools[0]).toBe('omg-host_smoke');
    });
    it('a Windows .cmd shim is driven through its resolved .js target, or fails with a clear detail', async () => {
        const shimDir = join(parent, 'npm');
        const target = join(shimDir, 'node_modules', '@github', 'copilot', 'npm-loader.js');
        write(target, '// loader');
        const shim = join(shimDir, 'copilot.cmd');
        write(shim, '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n');
        const { loaded, rec } = fakeSdk();
        await runSdkTier(input(loaded, { scenarios: [], bin: shim, platform: 'win32' }));
        expect(rec.connection.path).toBe(target);
        const bad = join(shimDir, 'other.cmd');
        write(bad, '@ECHO off\r\nnode something-else %*\r\n');
        const fresh = fakeSdk();
        const result = await runSdkTier(input(fresh.loaded, { scenarios: ['smoke'], bin: bad, platform: 'win32' }));
        expect(byId(result.checks)['sdk.runtime'].detail).toMatch(/is a shell shim whose \.js\/\.exe target could not be resolved; pass --copilot-bin/);
        expect(fresh.rec.ops).toEqual([]);
    });
});
describe('SDK loading', () => {
    it('globalModuleRoots: only %APPDATA%/npm on win32; no env prefix, no node dir', () => {
        expect(globalModuleRoots({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', npm_config_prefix: 'C:\\evil' }, 'win32').map((p) => p.replace(/\\/g, '/')))
            .toEqual(['C:/Users/u/AppData/Roaming/npm/node_modules']);
        expect(globalModuleRoots({ npm_config_prefix: '/opt/npm', NPM_CONFIG_PREFIX: '/opt/npm' }, 'linux')).toEqual([]);
    });
    it('satisfiesSdkRange is ^1.0.16', () => {
        for (const v of ['1.0.16', '1.0.17', '1.1.0', '1.20.3'])
            expect(satisfiesSdkRange(v), v).toBe(true);
        for (const v of ['1.0.15', '0.9.9', '2.0.0', '1.0.17-beta.1', '', undefined, 'latest'])
            expect(satisfiesSdkRange(v), String(v)).toBe(false);
    });
    function fakePackage(over, entryFile = 'dist/index.js') {
        const dir = join(parent, 'gm', '@github', 'copilot-sdk');
        write(join(dir, 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', version: '1.0.16', exports: { '.': { import: { default: './dist/index.js' }, require: { default: './dist/cjs/index.js' } } }, ...over }));
        write(join(dir, entryFile), 'export class CopilotClient {}\nexport const RuntimeConnection = { forStdio: (o) => o };\n');
        write(join(dir, 'dist', 'cjs', 'index.js'), 'exports.CopilotClient = class {}; exports.RuntimeConnection = { forStdio: (o) => o };\n');
        write(join(dir, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
        return dir;
    }
    it('importFromDir loads a matching package', async () => {
        const loaded = await importFromDir(fakePackage({}));
        expect(loaded?.version).toBe('1.0.16');
        expect(typeof loaded?.module.CopilotClient).toBe('function');
    });
    it('importFromDir refuses another name, an out-of-range version, or an entry outside the package', async () => {
        expect(await importFromDir(fakePackage({ name: '@evil/copilot-sdk' }))).toBeNull();
        expect(await importFromDir(fakePackage({ version: '0.9.0' }))).toBeNull();
        expect(await importFromDir(fakePackage({ version: '2.0.0' }))).toBeNull();
        expect(await importFromDir(fakePackage({ exports: { '.': { import: '../../../outside.js', require: './dist/cjs/index.js' } } }))).toBeNull();
        expect(await importFromDir(fakePackage({ exports: undefined, main: '../outside.js' }))).toBeNull();
    });
    it('resolveShimTarget reads cmd and ps1 shims, null when the target is missing', () => {
        const files = {
            'C:/npm/copilot.cmd': '"%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
            'C:/npm/copilot.ps1': '& "$basedir/node_modules/@github/copilot/npm-loader.js" $args',
            'C:/npm/plain.cmd': 'node foo %*',
        };
        const read = (p) => { const v = files[p.replace(/\\/g, '/')]; if (v === undefined)
            throw new Error('ENOENT'); return v; };
        const exists = (p) => /npm-loader\.js$/.test(p);
        expect(resolveShimTarget('C:/npm/copilot.cmd', read, exists)?.replace(/\\/g, '/')).toMatch(/\/npm\/node_modules\/@github\/copilot\/npm-loader\.js$/);
        expect(resolveShimTarget('C:/npm/copilot.ps1', read, exists)?.replace(/\\/g, '/')).toMatch(/\/npm\/node_modules\/@github\/copilot\/npm-loader\.js$/);
        expect(resolveShimTarget('C:/npm/plain.cmd', read, exists)).toBeNull();
        expect(resolveShimTarget('C:/npm/missing.cmd', read, exists)).toBeNull();
        expect(resolveShimTarget('C:/npm/copilot.cmd', read, () => false)).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// Through runCopilotSmoke (tier 0 faked like copilot-smoke.test.ts)
// ---------------------------------------------------------------------------
function tier0SpawnSync() {
    return ((command, args) => {
        const ok = (stdout) => ({ status: 0, stdout, stderr: '', pid: 1, output: [], signal: null });
        if (args.includes('--version'))
            return ok('GitHub Copilot CLI 1.0.91.\n');
        if (args.includes('plugin'))
            return ok(JSON.stringify([{ name: 'oh-my-copilot', version: '9.9.9', source: 'external' }]));
        if (args.includes('skill'))
            return ok(JSON.stringify(['alpha', 'plan'].map((s) => ({ name: s, source: 'plugin', path: join(root, 'skills', s) }))));
        if (command === 'git' && args.includes('for-each-ref'))
            return ok('');
        return ok('');
    });
}
function mcpSpawn() {
    return (() => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        let buf = '';
        child.stdin.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const msg = JSON.parse(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (msg.id === 1)
                    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
                if (msg.id === 2)
                    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{}, {}, {}] } })}\n`);
            }
        });
        return child;
    });
}
function smokeDeps(loadSdk) {
    const userConfigDir = join(root, 'user-copilot');
    write(join(userConfigDir, 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'me' }], lastLoggedInUser: { login: 'me' } }));
    return {
        spawnSync: tier0SpawnSync(),
        spawn: mcpSpawn(),
        resolveExecutable: () => join(root, 'copilot.exe'),
        existsSync: () => true,
        loadExpectedToolCount: async () => 3,
        userConfigDir,
        loadSdk,
    };
}
describe('runCopilotSmoke tier 2', () => {
    it('SDK missing: tier 0 runs, the report is skipped, exit code 2', async () => {
        const report = await runCopilotSmoke({ pluginRoot: root, tier: 2, env: {}, deps: smokeDeps(async () => null) });
        expect(report.tier).toBe(2);
        expect(report.skipped).toBe(SDK_MISSING_DETAIL);
        expect(report.checks.filter((c) => !c.ok).every((c) => c.detail === SDK_MISSING_DETAIL)).toBe(true);
        expect(report.checks.find((c) => c.id === 'mcp.list_tools')?.ok).toBe(true);
        expect(smokeExitCode(report)).toBe(2);
        expect(report.sdk).toBeUndefined();
    });
    it('default scenarios smoke+guardrail with report.sdk, report.cost and per-scenario events (removed without keepHome)', async () => {
        const fake = fakeSdkFor();
        const report = await runCopilotSmoke({ pluginRoot: root, tier: 2, env: { OMC_STATE_DIR: '/elsewhere' }, deps: smokeDeps(async () => fake.loaded) });
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        expect(report.checks.filter((c) => c.id.startsWith('scn.')).map((c) => c.id)).toEqual([...scenarioCheckIds('smoke'), ...scenarioCheckIds('guardrail')]);
        expect(report.sdk).toMatchObject({ version: '1.0.16', runtimeVersion: '1.0.91', protocolVersion: 3 });
        expect(report.cost.premiumRequests).toBe(2);
        expect(report.artifacts).toEqual({});
        const env = fake.rec.connection.env;
        expect(env).toMatchObject({ OMC_HOOK_FAIL_CLOSED: '1', OMC_GIT_GUARDRAILS: '1', COPILOT_ALLOW_ALL: 'false' });
        expect(env.OMC_STATE_DIR).toBeUndefined();
        expect(existsSync(env.COPILOT_HOME)).toBe(false);
        const config = fake.configAtStart;
        expect(config).toMatchObject({ loggedInUsers: [{ login: 'me' }] });
        expect(config.trustedFolders[0]).toMatch(/omg-smoke-sdk-.*project$/);
    });
    it('CI shape: no stored login, the token env reaches the runtime and config.json carries no identity', async () => {
        const fake = fakeSdkFor();
        const deps = { ...smokeDeps(async () => fake.loaded), userConfigDir: join(root, 'no-login') };
        const env = { COPILOT_GITHUB_TOKEN: 'ci-token', GH_TOKEN: 'gh', GITHUB_TOKEN: 'gha' };
        const report = await runCopilotSmoke({ pluginRoot: root, tier: 2, scenarios: [], env, deps });
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        expect(fake.rec.connection.env).toMatchObject(env);
        expect(fake.configAtStart).not.toHaveProperty('loggedInUsers');
        expect(fake.configAtStart).not.toHaveProperty('lastLoggedInUser');
    });
    it('keepHome keeps the event captures', async () => {
        const fake = fakeSdkFor();
        const report = await runCopilotSmoke({ pluginRoot: root, tier: 2, scenarios: ['smoke'], env: {}, keepHome: true, deps: smokeDeps(async () => fake.loaded) });
        expect(existsSync(report.artifacts.events.smoke)).toBe(true);
        rmSync(join(report.artifacts.copilotHome, '..'), { recursive: true, force: true });
        if (report.artifacts.listHome)
            rmSync(report.artifacts.listHome, { recursive: true, force: true });
    });
    it('no-billing guard: tier 2 scenarios without an injected loadSdk are refused under vitest, zero spawns', async () => {
        let spawns = 0;
        const count = (() => { spawns++; throw new Error('must not spawn'); });
        for (const scenarios of [undefined, ['smoke']]) {
            const report = await runCopilotSmoke({ pluginRoot: root, tier: 2, ...(scenarios ? { scenarios } : {}), env: {}, deps: { spawnSync: count, spawn: count } });
            expect(report).toMatchObject({ ok: false, skipped: LIVE_RUN_REFUSED_DETAIL, checks: [{ id: 'cli.guard', ok: false, detail: LIVE_RUN_REFUSED_DETAIL }] });
            expect(smokeExitCode(report)).not.toBe(0);
        }
        expect(spawns).toBe(0);
        expect(LIVE_RUN_REFUSED_DETAIL).toBe('live run refused under vitest — set OMC_LIVE_SMOKE=1 (tier 1) / =2 (tier 2 scenarios)');
    });
    it('no-billing guard: tier 1 without an injected spawn is refused', async () => {
        const report = await runCopilotSmoke({ pluginRoot: root, tier: 1, env: {}, deps: { spawnSync: tier0SpawnSync() } });
        expect(report.checks).toEqual([{ id: 'cli.guard', ok: false, detail: LIVE_RUN_REFUSED_DETAIL }]);
    });
    it('no-billing guard: scenarios: [] (static only) still runs', async () => {
        const report = await runCopilotSmoke({ pluginRoot: root, tier: 2, scenarios: [], env: {}, deps: smokeDeps(async () => null) });
        expect(report.checks.some((c) => c.id === 'cli.guard')).toBe(false);
        expect(report.checks.some((c) => c.id === 'plugin.manifest')).toBe(true);
        expect(liveRunRefusal(2, [], {}, { VITEST: 'true' })).toBeNull();
    });
    it('no-billing guard: env and seam rules', () => {
        const test = { VITEST: 'true' };
        expect(liveRunRefusal(2, undefined, {}, { ...test, OMC_LIVE_SMOKE: '2' })).toBeNull();
        expect(liveRunRefusal(2, undefined, {}, { ...test, OMC_LIVE_SMOKE: '1' })).toBe(LIVE_RUN_REFUSED_DETAIL);
        expect(liveRunRefusal(1, undefined, {}, { ...test, OMC_LIVE_SMOKE: '1' })).toBeNull();
        expect(liveRunRefusal(1, undefined, {}, { NODE_ENV: 'test' })).toBe(LIVE_RUN_REFUSED_DETAIL);
        expect(liveRunRefusal(1, undefined, { loadSdk: async () => null }, test)).toBe(LIVE_RUN_REFUSED_DETAIL);
        expect(liveRunRefusal(2, undefined, { spawn: (() => null) }, test)).toBe(LIVE_RUN_REFUSED_DETAIL);
        expect(liveRunRefusal(2, undefined, { loadSdk: async () => null }, test)).toBeNull();
        expect(liveRunRefusal(0, undefined, {}, test)).toBeNull();
        expect(liveRunRefusal(2, undefined, {}, {})).toBeNull(); // not under a test runner
    });
    it('rejects unknown scenario names', async () => {
        await expect(runCopilotSmoke({ pluginRoot: root, tier: 2, scenarios: ['nope'], env: {}, deps: smokeDeps(async () => null) }))
            .rejects.toThrow(/unknown smoke scenario\(s\): nope/);
    });
});
/** fakeSdk bound to whatever home runCopilotSmoke creates (logs dir made at start, config captured). */
function fakeSdkFor() {
    const inner = fakeSdk();
    const out = { loaded: inner.loaded, rec: inner.rec };
    const Base = inner.loaded.module.CopilotClient;
    class HomeClient extends Base {
        home;
        constructor(o) { super(o); this.home = o.baseDirectory; }
        async start() {
            mkdirSync(join(this.home, 'logs'), { recursive: true });
            out.configAtStart = JSON.parse(readFileSync(join(this.home, 'config.json'), 'utf-8'));
            return super.start();
        }
    }
    out.loaded = { ...inner.loaded, module: { ...inner.loaded.module, CopilotClient: HomeClient } };
    return out;
}
//# sourceMappingURL=copilot-sdk-driver.test.js.map