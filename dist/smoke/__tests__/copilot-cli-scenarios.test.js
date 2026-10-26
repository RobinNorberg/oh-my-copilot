import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CLI_SCENARIO_PERMISSIONS, prepareStubPlugin, runCliScenario, seedUltragoal, ultragoalStatePath, } from '../copilot-cli-scenarios.js';
import { ALL_SCENARIOS, CLI_SCENARIOS, COMPACT_PROMPT, continuationReason, continuationToken, evaluateScenario, OPT_IN_SCENARIOS, PENDING_SCENARIOS, promptContextLine, scenarioCheckIds, SCENARIOS, ULTRAGOAL_ACTIVATION_PROMPT, ULTRAGOAL_CONFIRM_TTL_MS, } from '../copilot-sdk-scenarios.js';
import { parseJsonl } from '../copilot-session-eval.js';
import { removeTempDir } from '../../__tests__/helpers/platform.js';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** Nonces of the live run (Copilot CLI 1.0.91, 2026-10-23) the fixtures were trimmed from. */
const LIVE_NONCE = { continuation: '95224717acf0', 'prompt-context': '3b05ed424a9d' };
const dirs = [];
afterEach(async () => {
    for (const dir of dirs)
        await removeTempDir(dir);
    dirs.length = 0;
});
function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}
function fixtureEvents(name) {
    return parseJsonl(readFileSync(join(FIXTURES, `tier2-${name}-events.jsonl`), 'utf8')).events;
}
function cliRun(name, events, cli = {}) {
    return {
        name,
        events,
        idle: true,
        timedOut: false,
        timeoutMs: 120_000,
        logText: '',
        model: 'cli default',
        maxCredits: 30,
        cli: { sessionId: 's-1', nonce: LIVE_NONCE[name] ?? 'nonce', steps: [], stub: [], ...cli },
    };
}
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
describe('CLI scenario registry', () => {
    it('lists the CLI scenarios as opt-in only, with stable check ids', () => {
        for (const name of CLI_SCENARIOS) {
            expect(OPT_IN_SCENARIOS).toContain(name);
            expect(ALL_SCENARIOS).not.toContain(name);
        }
        expect(scenarioCheckIds('continuation').slice(0, 4)).toEqual([
            'scn.continuation.blocked', 'scn.continuation.reason_injected', 'scn.continuation.stop_hook_active', 'scn.continuation.echo',
        ]);
        expect(scenarioCheckIds('events').slice(-3)).toEqual(['scn.events.exit', 'scn.events.adapter_errors', 'scn.events.cost']);
        expect(Object.keys(PENDING_SCENARIOS)).toEqual(['ultragoal']);
    });
    it('never lets a CLI scenario write files, and keeps view-only permissions for events and ultragoal', () => {
        for (const name of CLI_SCENARIOS)
            expect(CLI_SCENARIO_PERMISSIONS[name].join(' ')).toContain('--deny-tool write');
        expect(CLI_SCENARIO_PERMISSIONS.events).not.toContain('--allow-all-tools');
        expect(CLI_SCENARIO_PERMISSIONS.ultragoal).not.toContain('--allow-all-tools');
    });
});
describe('evaluateScenario on the live CLI fixtures', () => {
    it('continuation: block, injected reason, stop_hook_active on the next stop, echoed token, 2 premium requests', () => {
        const { checks, cost } = evaluateScenario(cliRun('continuation', fixtureEvents('continuation')));
        expect(checks.filter((c) => !c.ok)).toEqual([]);
        expect(cost.premiumRequests).toBe(2);
    });
    it('continuation: fails when the next stop lacks stop_hook_active or the reason never arrives', () => {
        const events = fixtureEvents('continuation');
        const reason = continuationReason(LIVE_NONCE.continuation);
        const tampered = events
            .filter((e) => !(e.type === 'user.message' && String(e.data?.content).includes(reason)))
            .map((e) => (e.type === 'hook.start' && e.data?.hookType === 'agentStop'
            ? { ...e, data: { ...e.data, input: { ...e.data.input, stop_hook_active: false } } } : e));
        const c = byId(evaluateScenario(cliRun('continuation', tampered)).checks);
        expect(c['scn.continuation.blocked'].ok).toBe(true);
        expect(c['scn.continuation.reason_injected'].ok).toBe(false);
        expect(c['scn.continuation.stop_hook_active'].ok).toBe(false);
    });
    it('prompt-context: accepted by the runtime and echoed by the model, 1 premium request', () => {
        const { checks, cost } = evaluateScenario(cliRun('prompt-context', fixtureEvents('prompt-context')));
        expect(checks.filter((c) => !c.ok)).toEqual([]);
        expect(cost.premiumRequests).toBe(1);
    });
    it('prompt-context: a nonce the model never saw fails reached_model', () => {
        const c = byId(evaluateScenario(cliRun('prompt-context', fixtureEvents('prompt-context'), { nonce: 'feedfacecafe' })).checks);
        expect(c['scn.prompt-context.accepted'].ok).toBe(false);
        expect(c['scn.prompt-context.reached_model'].ok).toBe(false);
        expect(c['scn.prompt-context.reached_model'].detail).toContain('userPromptTransformed');
    });
    it('events: postToolUseFailure, permissionRequest and preCompact ran; the /compact resume costs no premium request', () => {
        const { checks, cost } = evaluateScenario(cliRun('events', fixtureEvents('events')));
        expect(checks.filter((c) => !c.ok)).toEqual([]);
        expect(cost.premiumRequests).toBe(1);
    });
    it('events: no compaction event fails pre_compact', () => {
        const events = fixtureEvents('events').filter((e) => e.type !== 'session.compaction_start' && e.data?.hookType !== 'preCompact');
        const c = byId(evaluateScenario(cliRun('events', events)).checks);
        expect(c['scn.events.pre_compact'].ok).toBe(false);
        expect(c['scn.events.post_tool_use_failure'].ok).toBe(true);
    });
    it('ultragoal (pending g-cont): the 1.0.91 fixture is denied by the gate, and the failure carries the pending note', () => {
        const run = cliRun('ultragoal', fixtureEvents('ultragoal'), { seed: { ok: true, detail: 'seeded' } });
        const c = byId(evaluateScenario(run).checks);
        expect(c['scn.ultragoal.seeded'].ok).toBe(true);
        expect(c['scn.ultragoal.tools_allowed'].ok).toBe(false);
        expect(c['scn.ultragoal.tools_allowed'].detail.startsWith(`[${PENDING_SCENARIOS.ultragoal}]`)).toBe(true);
        expect(c['scn.ultragoal.seeded'].detail).toBe('seeded');
    });
    it('ultragoal: passes once no tool call is denied', () => {
        const events = fixtureEvents('ultragoal').filter((e) => !(e.type === 'tool.execution_complete' && e.data?.success === false));
        const c = byId(evaluateScenario(cliRun('ultragoal', events, { seed: { ok: true, detail: 'seeded' } })).checks);
        expect(c['scn.ultragoal.tools_allowed'].ok).toBe(true);
    });
    it('reports every own check as failed when no CLI evidence was collected', () => {
        const run = { ...cliRun('continuation', []), cli: undefined, error: 'boom' };
        const own = evaluateScenario(run).checks.slice(0, 4);
        expect(own.every((c) => !c.ok && c.detail.includes('boom'))).toBe(true);
    });
});
describe('prepareStubPlugin', () => {
    const runStub = (stub, payload) => {
        const hooks = JSON.parse(readFileSync(join(stub.dir, 'hooks.json'), 'utf8'));
        const [event] = Object.keys(hooks.hooks);
        const entry = hooks.hooks[event][0];
        const res = spawnSync(entry.exec, entry.args, { input: JSON.stringify(payload), encoding: 'utf8' });
        return { event, out: JSON.parse(res.stdout) };
    };
    it('stop: registers PascalCase Stop and blocks only the first stop with the reason', () => {
        const home = tempDir('omg-cli-stub-');
        const stub = prepareStubPlugin(home, 'continuation', continuationReason('abc'));
        const first = runStub(stub, { stop_hook_active: false });
        const second = runStub(stub, { stop_hook_active: true });
        expect(first.event).toBe('Stop');
        expect(first.out).toEqual({ decision: 'block', reason: continuationReason('abc') });
        expect(second.out).toEqual({});
        const log = readFileSync(stub.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(log.map((r) => r.payload.stop_hook_active)).toEqual([false, true]);
    });
    it('prompt: registers PascalCase UserPromptSubmit and returns a top-level additionalContext', () => {
        const home = tempDir('omg-cli-stub-');
        const stub = prepareStubPlugin(home, 'prompt-context', promptContextLine('abc'));
        const run = runStub(stub, { prompt: 'x' });
        expect(run.event).toBe('UserPromptSubmit');
        expect(run.out).toEqual({ additionalContext: promptContextLine('abc') });
    });
    it('writes no stub for events and ultragoal', () => {
        const home = tempDir('omg-cli-stub-');
        expect(prepareStubPlugin(home, 'events', 'x')).toBeNull();
        expect(prepareStubPlugin(home, 'ultragoal', 'x')).toBeNull();
    });
});
describe('seedUltragoal', () => {
    /** A plugin root whose UserPromptSubmit entry writes the state keyword-detector would. */
    function fakeRoot(writeState) {
        const root = tempDir('omg-cli-root-');
        mkdirSync(join(root, 'copilot'));
        const script = join(root, 'activate.cjs');
        writeFileSync(script, [
            "const fs = require('fs'); const path = require('path');",
            "const p = JSON.parse(fs.readFileSync(0, 'utf8'));",
            `if (${writeState}) {`,
            "  const dir = path.join(p.cwd, '.omg', 'state', 'sessions', p.session_id);",
            '  fs.mkdirSync(dir, { recursive: true });',
            "  fs.writeFileSync(path.join(dir, 'ultragoal-state.json'), JSON.stringify({ active: true, original_prompt: p.prompt, awaiting_confirmation: true, max_reinforcements: 50 }));",
            '}',
        ].join('\n'));
        writeFileSync(join(root, 'copilot', 'hooks.json'), JSON.stringify({ version: 1, hooks: { UserPromptSubmit: [{ type: 'command', exec: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/activate.cjs'], timeoutSec: 10 }] } }));
        return root;
    }
    it('activates through the UserPromptSubmit group, then backdates past the TTL and caps reinforcements', () => {
        const projectDir = tempDir('omg-cli-proj-');
        spawnSync('git', ['init', '-q'], { cwd: projectDir }); // the smoke project is a git repo, so state resolves under it
        const now = Date.parse('2026-10-23T12:00:00.000Z');
        const seed = seedUltragoal({ root: fakeRoot(true), projectDir, env: process.env, spawnSync }, 'sid-1', now);
        expect(seed.ok).toBe(true);
        const state = JSON.parse(readFileSync(ultragoalStatePath(projectDir, 'sid-1'), 'utf8'));
        expect(state.original_prompt).toBe(ULTRAGOAL_ACTIVATION_PROMPT);
        expect(state.max_reinforcements).toBe(1);
        expect(now - Date.parse(String(state.awaiting_confirmation_set_at))).toBeGreaterThan(ULTRAGOAL_CONFIRM_TTL_MS);
    });
    it('fails when the activation hook writes no state', () => {
        const projectDir = tempDir('omg-cli-proj-');
        const seed = seedUltragoal({ root: fakeRoot(false), projectDir, env: process.env, spawnSync }, 'sid-1', Date.now());
        expect(seed.ok).toBe(false);
        expect(seed.detail).toContain('no ultragoal state');
    });
});
describe('runCliScenario', () => {
    /** Stands in for copilot: records argv and stdin, appends the session's events.jsonl. */
    function fakeCopilot(home, sessionId, calls, lines) {
        return ((_command, args) => {
            const child = Object.assign(new EventEmitter(), {
                stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, exitCode: null, signalCode: null,
            });
            let input = '';
            child.stdin.on('data', (c) => { input += c.toString(); });
            child.stdin.on('finish', () => {
                calls.push({ args, input });
                const dir = join(home, 'session-state', sessionId);
                mkdirSync(dir, { recursive: true });
                const prior = existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8') : '';
                writeFileSync(join(dir, 'events.jsonl'), prior + lines.join('\n') + '\n');
                child.exitCode = 0;
                setImmediate(() => child.emit('close', 0, null));
            });
            return child;
        });
    }
    function sandbox() {
        const parent = tempDir('omg-cli-run-');
        const home = join(parent, 'home');
        const projectDir = join(parent, 'project');
        mkdirSync(home);
        mkdirSync(projectDir);
        return { home, projectDir };
    }
    const input = (name, home, projectDir, spawn) => ({
        name, bin: 'copilot', root: '/plugin', env: {}, projectDir, home, timeoutMs: 5_000, maxCredits: 30, budget: 12.5,
        eventsPath: join(home, `events-${name}.jsonl`), spawnSync, spawn, randomUUID: () => 'sid-1',
    });
    it('continuation: loads the stub as a second plugin dir and pipes the prompt on stdin', async () => {
        const { home, projectDir } = sandbox();
        const calls = [];
        const shutdown = JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: 2, totalNanoAiu: 3e8 } });
        const run = await runCliScenario(input('continuation', home, projectDir, fakeCopilot(home, 'sid-1', calls, [shutdown])));
        expect(calls).toHaveLength(1);
        const args = calls[0].args.join(' ');
        expect(args).toContain('--plugin-dir /plugin --plugin-dir');
        expect(args).toContain(join(home, 'continuation-stub'));
        expect(args).toContain('--session-id sid-1');
        expect(args).toContain('--max-ai-credits 30');
        expect(args).toContain("--deny-tool t(host_smoke)");
        expect(calls[0].input).toBe(`${SCENARIOS.continuation.prompt}\n`);
        expect(run.idle).toBe(true);
        expect(run.error).toBeUndefined();
        expect(run.cli?.steps.map((s) => s.label)).toEqual(['prompt']);
        expect(readFileSync(join(home, 'continuation-stub', 'config.json'), 'utf8')).toContain(continuationToken(run.cli.nonce));
        expect(readFileSync(join(home, 'events-continuation.jsonl'), 'utf8')).toContain('session.shutdown');
    });
    it('events: resumes the same session id with /compact and loads no stub', async () => {
        const { home, projectDir } = sandbox();
        const calls = [];
        const run = await runCliScenario(input('events', home, projectDir, fakeCopilot(home, 'sid-1', calls, ['{"type":"session.start","data":{}}'])));
        expect(calls.map((c) => c.input)).toEqual([`${SCENARIOS.events.prompt}\n`, `${COMPACT_PROMPT}\n`]);
        expect(calls.every((c) => c.args.filter((a) => a === '--plugin-dir').length === 1 && c.args.includes('sid-1'))).toBe(true);
        expect(run.cli?.steps.map((s) => s.label)).toEqual(['prompt', 'compact']);
        expect(run.events).toHaveLength(2);
    });
    it('events: the compact step is capped to what the first step left of the budget', async () => {
        const { home, projectDir } = sandbox();
        const calls = [];
        const shutdown = JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: 1, totalNanoAiu: 40e9 } });
        await runCliScenario({ ...input('events', home, projectDir, fakeCopilot(home, 'sid-1', calls, [shutdown])), maxCredits: 100, budget: 100 });
        const cap = (i) => calls[i].args[calls[i].args.indexOf('--max-ai-credits') + 1];
        expect([cap(0), cap(1)]).toEqual(['100', '60']);
    });
    it('reports an error when the session persisted no events', async () => {
        const { home, projectDir } = sandbox();
        const silent = ((_c, _a) => {
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1, exitCode: null, signalCode: null });
            child.stdin.on('finish', () => { child.exitCode = 0; setImmediate(() => child.emit('close', 0, null)); });
            return child;
        });
        const run = await runCliScenario(input('prompt-context', home, projectDir, silent));
        expect(run.idle).toBe(false);
        expect(run.error).toContain('no events.jsonl');
    });
    it('ultragoal: a failed seed stops before any copilot process', async () => {
        const { home, projectDir } = sandbox();
        const calls = [];
        const run = await runCliScenario({ ...input('ultragoal', home, projectDir, fakeCopilot(home, 'sid-1', calls, [])), root: tempDir('omg-cli-noroot-') });
        expect(calls).toHaveLength(0);
        expect(run.error).toContain('ultragoal seed');
        expect(existsSync(join(projectDir, 'README.md'))).toBe(true);
    });
});
//# sourceMappingURL=copilot-cli-scenarios.test.js.map