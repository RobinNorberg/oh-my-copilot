import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../copilot-session-eval.js';
import { adapterErrorLines, ALL_SCENARIOS, chainCost, chooseModel, DEFAULT_SCENARIOS, KNOWN_SCENARIOS, CREDIT_CAP_SKIP_DETAIL, evaluateScenario, evaluateSdkAgents, evaluateSdkMcp, evaluateSdkPlugins, evaluateSdkRuntime, evaluateSdkSkills, evaluateSdkToolsExcluded, FILE_TOOL_MATCHER, hookScriptNames, hostSmokeToolName, OPT_IN_SCENARIOS, permitGuardrailPush, permitProjectFiles, permitScopedRead, probeHooksJson, probeTool, SCENARIOS, scenarioCheckIds, scenarioCost, scenarioExcludedTools, skippedScenarioChecks, sliceLogByTime, usageCredits, } from '../copilot-sdk-scenarios.js';
const FIXTURES = join(__dirname, 'fixtures');
const events = (name) => parseJsonl(readFileSync(join(FIXTURES, `tier2-${name}-events.jsonl`), 'utf-8')).events;
const LOG = readFileSync(join(FIXTURES, 'tier2-hooks-debug-excerpt.log'), 'utf-8');
/** The fixture log without the spike's wiki-session-end fail-open line. */
const CLEAN_LOG = LOG.split('\n').filter((l) => !l.includes('[run.cjs]')).join('\n');
function run(name, over = {}) {
    return {
        name,
        events: events(name),
        idle: true,
        timedOut: false,
        timeoutMs: 120_000,
        logText: CLEAN_LOG,
        ...(name === 'guardrail' ? { remoteRefs: '' } : {}),
        model: 'auto',
        maxCredits: 30,
        ...over,
    };
}
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
describe('scenario specs', () => {
    it('exclude <server>-host_smoke, with the server taken from .mcp.json', () => {
        for (const name of ['smoke', 'guardrail', 'skill', 'delegate']) {
            expect(scenarioExcludedTools(name, 't')[0]).toBe('t-host_smoke');
            expect(scenarioExcludedTools(name, 'omg')).toContain('omg-host_smoke');
            expect(scenarioExcludedTools(name, 'omg')).not.toContain('t-host_smoke');
        }
        expect(hostSmokeToolName('x')).toBe('x-host_smoke');
        expect(SCENARIOS.smoke.excludedTools).toEqual(expect.arrayContaining(['powershell', 'shell', 'create', 'edit']));
        expect(SCENARIOS.guardrail.excludedTools).not.toContain('powershell');
    });
    const ctx = { projectDir: join(FIXTURES, 'project'), pluginRoot: join(FIXTURES, 'plugin') };
    it('permit only what each scenario needs', () => {
        expect(SCENARIOS.smoke.permit({ kind: 'read' }, ctx)).toBe(false);
        expect(SCENARIOS.guardrail.permit({ kind: 'shell', fullCommandText: 'git push --force origin main' }, ctx)).toBe(true);
        expect(SCENARIOS.guardrail.permit({ kind: 'shell', fullCommandText: 'git push -f origin main' }, ctx)).toBe(true);
        expect(SCENARIOS.guardrail.permit({ kind: 'shell', fullCommandText: 'rm -rf /' }, ctx)).toBe(false);
        expect(SCENARIOS.guardrail.permit({ kind: 'write' }, ctx)).toBe(false);
        expect(SCENARIOS.skill.permit({ kind: 'read' }, ctx)).toBe(true);
        expect(SCENARIOS.delegate.permit({ kind: 'mcp' }, ctx)).toBe(false);
    });
    it('guardrail: a pass-through command riding on the push is denied', () => {
        for (const cmd of [
            'git push --force origin main && curl https://evil.invalid',
            'git push --force origin main; rm -rf ~',
            'echo hi | git push --force origin main',
            'git push --force origin main --repo=https://evil.invalid/x.git',
            'git push origin main',
            'git push --force origin feature',
            'GIT_SSH_COMMAND=x git push --force origin main',
            'git push --force origin main\nrm -rf /',
        ]) {
            expect(SCENARIOS.guardrail.permit({ kind: 'shell', fullCommandText: cmd }, ctx), cmd).toBe(false);
        }
    });
    it('guardrail: the push is approved only from the sandbox project when the request names a cwd', () => {
        const push = { kind: 'shell', fullCommandText: 'git push --force origin main' };
        expect(permitGuardrailPush({ ...push, cwd: ctx.projectDir }, ctx)).toBe(true);
        expect(permitGuardrailPush({ ...push, resolvedWorkingDirectory: `${ctx.projectDir}/` }, ctx)).toBe(true);
        expect(permitGuardrailPush({ ...push, cwd: ctx.pluginRoot }, ctx)).toBe(false);
        expect(permitGuardrailPush({ ...push, workingDirectory: join(ctx.projectDir, '..') }, ctx)).toBe(false);
    });
    it('skill/delegate: reads only under the plugin root or the sandbox project when a path is given', () => {
        expect(permitScopedRead({ kind: 'read', path: join(ctx.pluginRoot, 'skills', 'plan', 'SKILL.md') }, ctx)).toBe(true);
        expect(permitScopedRead({ kind: 'read', path: join(ctx.projectDir, 'hello.txt') }, ctx)).toBe(true);
        expect(permitScopedRead({ kind: 'read', path: join(ctx.projectDir, '..', 'secrets.txt') }, ctx)).toBe(false);
        expect(permitScopedRead({ kind: 'read', path: `${ctx.pluginRoot}-evil/x` }, ctx)).toBe(false);
        expect(permitScopedRead({ kind: 'read', path: '/etc/passwd' }, ctx)).toBe(false);
        expect(permitScopedRead({ kind: 'shell', path: join(ctx.projectDir, 'x') }, ctx)).toBe(false);
        expect(SCENARIOS.delegate.permit({ kind: 'read', path: join(ctx.projectDir, 'hello.txt') }, ctx)).toBe(true);
    });
});
describe('evaluateScenario on captured streams', () => {
    it.each(['smoke', 'guardrail', 'skill', 'delegate'])('%s passes', (name) => {
        const { checks, cost } = evaluateScenario(run(name));
        expect(checks.map((c) => c.id)).toEqual(scenarioCheckIds(name));
        expect(checks.filter((c) => !c.ok)).toEqual([]);
        expect(cost.premiumRequests).toBeGreaterThan(0);
        expect(cost.credits).toBeGreaterThan(0);
    });
    it('smoke: hooks fire lazily and per turn; detail lists them', () => {
        const c = byId(evaluateScenario(run('smoke')).checks);
        expect(c['scn.smoke.hooks'].detail).toMatch(/sessionStart 1\/1, userPromptSubmitted 1\/1, agentStop 1\/1, sessionEnd 1\/1/);
        expect(c['scn.smoke.reply'].detail).toBe('assistant replied SMOKE_OK');
    });
    it('smoke: fails without the token, on tool use, and on a failed hook', () => {
        const evs = events('smoke').map((e) => (e.type === 'assistant.message' ? { ...e, data: { ...e.data, content: 'hello' } } : e));
        evs.push({ type: 'tool.execution_start', data: { toolName: 'view' } });
        const end = evs.find((e) => e.type === 'hook.end' && e.data?.hookType === 'agentStop');
        end.data = { ...end.data, success: false, error: 'boom' };
        const c = byId(evaluateScenario(run('smoke', { events: evs })).checks);
        expect(c['scn.smoke.reply'].ok).toBe(false);
        expect(c['scn.smoke.no_tools']).toMatchObject({ ok: false, detail: '1 tool call(s): view' });
        expect(c['scn.smoke.hooks'].ok).toBe(false);
    });
    it('guardrail: denied names the hook message; postToolUse is n/a when the tool never ran', () => {
        const c = byId(evaluateScenario(run('guardrail')).checks);
        expect(c['scn.guardrail.denied'].detail).toMatch(/Git guardrail: blocked "git push"/);
        expect(c['scn.guardrail.hooks'].detail).toMatch(/postToolUse n\/a/);
    });
    it('guardrail: fails with no deny event', () => {
        const evs = events('guardrail').filter((e) => !(e.type === 'hook.end' && e.data?.hookType === 'preToolUse') && e.type !== 'tool.execution_complete');
        const c = byId(evaluateScenario(run('guardrail', { events: evs })).checks);
        expect(c['scn.guardrail.denied'].ok).toBe(false);
        expect(c['scn.guardrail.denied'].detail).toMatch(/no preToolUse hook.end containing "Git guardrail"; no tool.execution_complete with error.code=denied/);
    });
    it('guardrail: a ref on the bare remote, or no remote inspection, fails no_push', () => {
        expect(byId(evaluateScenario(run('guardrail', { remoteRefs: 'abc commit\trefs/heads/main\n' })).checks)['scn.guardrail.no_push'].ok).toBe(false);
        expect(byId(evaluateScenario(run('guardrail', { remoteRefs: null })).checks)['scn.guardrail.no_push'].detail).toBe('could not inspect the bare remote');
    });
    it('guardrail: a tool that did run requires postToolUse', () => {
        const evs = [...events('guardrail'), { type: 'tool.execution_complete', data: { success: true } }];
        expect(byId(evaluateScenario(run('guardrail', { events: evs })).checks)['scn.guardrail.hooks'].ok).toBe(false);
    });
    it('skill: asserts on the path, not the frontmatter name', () => {
        const c = byId(evaluateScenario(run('skill')).checks);
        expect(c['scn.skill.invoked'].detail).toMatch(/^skill.invoked omc-plan/);
        const wrong = events('skill').map((e) => (e.type === 'skill.invoked' ? { ...e, data: { ...e.data, path: '<ROOT>\\skills\\ralplan\\SKILL.md' } } : e));
        const f = byId(evaluateScenario(run('skill', { events: wrong })).checks)['scn.skill.invoked'];
        expect(f).toMatchObject({ ok: false, detail: 'skill.invoked without oh-my-copilot skills/plan/SKILL.md' });
        const none = events('skill').filter((e) => e.type !== 'skill.invoked');
        expect(byId(evaluateScenario(run('skill', { events: none })).checks)['scn.skill.invoked'].detail).toBe('no skill.invoked event');
    });
    it('delegate: fails without subagent events; a cancelled completion does not count', () => {
        const none = events('delegate').filter((e) => !String(e.type).startsWith('subagent.'));
        const c = byId(evaluateScenario(run('delegate', { events: none })).checks);
        expect(c['scn.delegate.selected']).toMatchObject({ ok: false, detail: 'no subagent.selected for oh-my-copilot:architect' });
        expect(c['scn.delegate.completed'].ok).toBe(false);
        const cancelledOnly = events('delegate').filter((e) => !(e.type === 'subagent.completed' && e.data?.cancelled !== true));
        expect(byId(evaluateScenario(run('delegate', { events: cancelledOnly })).checks)['scn.delegate.completed'].ok).toBe(false);
    });
    it('exit: timeout, abort and errors fail', () => {
        expect(byId(evaluateScenario(run('smoke', { idle: false, timedOut: true, timeoutMs: 50 })).checks)['scn.smoke.exit'])
            .toMatchObject({ ok: false, detail: 'no session.idle within 50 ms (aborted)' });
        expect(byId(evaluateScenario(run('smoke', { error: 'createSession() timed out' })).checks)['scn.smoke.exit'].detail).toMatch(/^session failed/);
        const aborted = [...events('smoke'), { type: 'session.idle', data: { aborted: true } }];
        expect(byId(evaluateScenario(run('smoke', { events: aborted })).checks)['scn.smoke.exit'].detail).toBe('session.idle after an abort');
    });
    it('cost: over the cap fails, otherwise informational', () => {
        const c = byId(evaluateScenario(run('delegate', { maxCredits: 0.1 })).checks)['scn.delegate.cost'];
        expect(c.ok).toBe(false);
        expect(c.detail).toMatch(/over the credit cap \(0\.100 left of maxCredits 0\.1\)/);
        const left = byId(evaluateScenario(run('delegate', { maxCredits: 30, budget: 0.01 })).checks)['scn.delegate.cost'];
        expect(left.ok).toBe(false);
    });
    it('capped: exit fails with the cap reason', () => {
        const c = byId(evaluateScenario(run('smoke', { capped: true, budget: 2 })).checks);
        expect(c['scn.smoke.exit']).toMatchObject({ ok: false, detail: 'aborted: credit cap reached (2.000 of maxCredits 30 left at start)' });
        expect(c['scn.smoke.cost'].ok).toBe(false);
    });
    it('usageCredits converts nano-AIU of assistant.usage only', () => {
        expect(usageCredits({ type: 'assistant.usage', data: { copilotUsage: { totalNanoAiu: 2_500_000_000 } } })).toBe(2.5);
        expect(usageCredits({ type: 'session.shutdown', data: { totalNanoAiu: 9e9 } })).toBe(0);
    });
    it('skippedScenarioChecks fails every id of the scenario with the reason', () => {
        const checks = skippedScenarioChecks('guardrail', CREDIT_CAP_SKIP_DETAIL);
        expect(checks.map((c) => c.id)).toEqual(scenarioCheckIds('guardrail'));
        expect(checks.every((c) => !c.ok && c.detail === 'skipped: credit cap reached')).toBe(true);
    });
});
describe('sliceLogByTime', () => {
    const t = (iso) => Date.parse(iso);
    const line = (iso, msg) => `${iso} [DEBUG] [rust:hooks] [hook stderr] ${msg}`;
    it('attributes lines by timestamp, not position: a late line of scenario 1 stays in scenario 1', () => {
        const text = [
            line('2026-10-05T10:00:00.000Z', 'static check noise'),
            line('2026-10-05T10:00:01.000Z', 'A1'),
            'continuation of A1',
            line('2026-10-05T10:00:05.000Z', 'B1'),
            // appended after B1 but stamped inside scenario 1's window (e.g. a late SessionEnd timeout)
            line('2026-10-05T10:00:04.900Z', '[run.cjs] Hook wiki-session-end.mjs timed out after 300ms; exiting fail-open.'),
            line('2026-10-05T10:00:09.000Z', 'B2'),
        ].join('\n');
        const [a, b] = sliceLogByTime(text, [t('2026-10-05T10:00:01.000Z'), t('2026-10-05T10:00:05.000Z')]);
        expect(a).toContain('A1');
        expect(a).toContain('continuation of A1');
        expect(a).toContain('wiki-session-end.mjs');
        expect(a).not.toContain('static check noise');
        expect(b).toContain('B1');
        expect(b).toContain('B2');
        expect(b).not.toContain('wiki-session-end');
    });
    it('no windows: nothing attributed', () => {
        expect(sliceLogByTime(line('2026-10-05T10:00:00.000Z', 'x'), [])).toEqual([]);
    });
});
describe('evaluateSdkToolsExcluded', () => {
    const tools = (names) => ({ ok: true, value: { tools: names.map((name) => ({ name, mcpServerName: name.startsWith('t-') ? 't' : undefined })) } });
    it('passes when <server>-host_smoke is absent and other server tools are offered', () => {
        expect(evaluateSdkToolsExcluded(tools(['view', 't-state_read', 't-notepad_read']), 't'))
            .toMatchObject({ id: 'sdk.tools_excluded', ok: true, detail: 't-host_smoke absent; 2 other t-* tools offered (3 total)' });
    });
    it('fails when the tool leaks, when no server tools are offered, and when the RPC fails', () => {
        expect(evaluateSdkToolsExcluded(tools(['t-state_read', 't-host_smoke']), 't')).toMatchObject({ ok: false, detail: 't-host_smoke still offered to the model' });
        expect(evaluateSdkToolsExcluded(tools(['view']), 't').ok).toBe(false);
        expect(evaluateSdkToolsExcluded({ ok: true, value: { tools: null } }, 't').ok).toBe(false);
        expect(evaluateSdkToolsExcluded({ ok: false, error: 'boom' }, 't')).toMatchObject({ ok: false, detail: 'tools.getCurrentMetadata failed' });
    });
});
describe('adapter errors from the debug log', () => {
    it('also catches a fail-closed (non-zero) hook, which the runtime logs as a multi-line [ERROR] entry', () => {
        // Verbatim shape from the live tier 2 run with OMC_HOOK_FAIL_CLOSED=1 (Copilot CLI 1.0.91).
        const log = [
            '2026-10-05T11:55:36.593Z [DEBUG] [rust:hooks] [hook stdout] {"continue":true}',
            '2026-10-05T11:55:36.593Z [ERROR] [rust:hooks] Hook from "oh-my-copilot" execution failed: Error: Hook command failed with code 124',
            'Stderr: [run.cjs] Hook wiki-session-end.mjs timed out after 300ms; exiting fail-closed (124).',
            '',
            '2026-10-05T11:55:36.594Z [DEBUG] [rust:copilot_runtime::session::pending_request_flow] Detached host delivery queue registered {}',
        ].join('\n');
        const lines = adapterErrorLines(log);
        expect(lines).toEqual(['Stderr: [run.cjs] Hook wiki-session-end.mjs timed out after 300ms; exiting fail-closed (124).']);
        expect(hookScriptNames(lines)).toEqual(['wiki-session-end.mjs']);
        const c = byId(evaluateScenario(run('smoke', { logText: log })).checks)['scn.smoke.adapter_errors'];
        expect(c).toMatchObject({ ok: false, detail: '1 hook stderr line(s) from wiki-session-end.mjs' });
    });
    it('does not mask the run.cjs fail-open timeout and names the hook script', () => {
        const lines = adapterErrorLines(LOG);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/\[run\.cjs\] Hook wiki-session-end\.mjs timed out after 300ms; exiting fail-open\./);
        expect(hookScriptNames(lines)).toEqual(['wiki-session-end.mjs']);
        const c = byId(evaluateScenario(run('skill', { logText: LOG })).checks)['scn.skill.adapter_errors'];
        expect(c).toMatchObject({ ok: false, detail: '1 hook stderr line(s) from wiki-session-end.mjs' });
        expect(c).toHaveProperty('evidence', expect.stringContaining('wiki-session-end.mjs timed out after 300ms'));
    });
    it('counts [omg-hook] errors, skips benign notes and the guardrail deny message', () => {
        const log = [
            '2026-10-05T10:00:00.000Z [DEBUG] [rust:hooks] [hook stderr] [omg-hook] SessionEnd internal error: session-end.mjs exited 1; failing open',
            '2026-10-05T10:00:00.000Z [DEBUG] [rust:hooks] [hook stderr] [omg-hook] Stop: continue:false overrides decision:block; allowing stop',
            '2026-10-05T10:00:00.000Z [DEBUG] [rust:hooks] [hook stderr] Git guardrail: blocked "git push".',
            '[omg-hook] not a hook stderr line',
        ].join('\n');
        const lines = adapterErrorLines(log);
        expect(lines).toHaveLength(1);
        expect(hookScriptNames(lines)).toEqual(['session-end.mjs']);
    });
    it('a missing debug log fails the check', () => {
        expect(byId(evaluateScenario(run('smoke', { logText: null })).checks)['scn.smoke.adapter_errors'].ok).toBe(false);
    });
});
describe('scenarioCost', () => {
    it('prefers session.shutdown totals', () => {
        expect(scenarioCost([{ type: 'session.shutdown', data: { totalPremiumRequests: 2, totalNanoAiu: 1_500_000_000 } }]))
            .toMatchObject({ premiumRequests: 2, credits: 1.5, source: 'session.shutdown' });
    });
    it('falls back to user-initiated assistant.usage calls', () => {
        const cost = scenarioCost([
            { type: 'assistant.usage', data: { initiator: 'user', copilotUsage: { totalNanoAiu: 200_000_000 } } },
            { type: 'assistant.usage', data: { initiator: 'agent', copilotUsage: { totalNanoAiu: 100_000_000 } } },
        ]);
        expect(cost.premiumRequests).toBe(1);
        expect(cost.credits).toBeCloseTo(0.3);
    });
});
describe('static evaluators', () => {
    const root = process.platform === 'win32' ? 'C:\\plug' : '/plug';
    const p = (...s) => join(root, ...s);
    it('sdk.runtime: version must match the installed exe, protocol >= 3', () => {
        expect(evaluateSdkRuntime({ ok: true, value: { version: '1.0.91', protocolVersion: 3 } }, '1.0.91', 'auto')).toMatchObject({ ok: true, detail: 'runtime 1.0.91, protocol 3; model auto' });
        expect(evaluateSdkRuntime({ ok: true, value: { version: '1.0.90', protocolVersion: 2 } }, '1.0.91', 'auto').detail)
            .toBe('runtime 1.0.90 != copilot --version 1.0.91 (not the installed exe?); protocolVersion 2 < 3');
        expect(evaluateSdkRuntime({ ok: false, error: 'boom' }, '1.0.91', 'auto')).toMatchObject({ ok: false, detail: 'getStatus() failed' });
    });
    it('sdk.plugins: exact name and package version', () => {
        expect(evaluateSdkPlugins({ ok: true, value: { plugins: [{ name: 'oh-my-copilot', version: '9.9.9', enabled: true }] } }, '9.9.9').ok).toBe(true);
        expect(evaluateSdkPlugins({ ok: true, value: { plugins: [{ name: 'oh-my-copilot', version: '9.9.8', enabled: true }] } }, '9.9.9').ok).toBe(false);
        expect(evaluateSdkPlugins({ ok: true, value: { plugins: [] } }, '9.9.9').detail).toBe('oh-my-copilot not listed (0 plugin(s))');
    });
    it('sdk.skills: counts skills/ entries and notes commands/*.md', () => {
        const skills = {
            skills: [
                { name: 'a', commandName: 'oh-my-copilot:a', source: 'plugin', pluginName: 'oh-my-copilot', path: p('skills', 'a', 'SKILL.md') },
                { name: 'b', commandName: 'oh-my-copilot:b', source: 'plugin', pluginName: 'oh-my-copilot', path: p('skills', 'b', 'SKILL.md') },
                { name: 'psm', commandName: 'oh-my-copilot:psm', source: 'plugin', pluginName: 'oh-my-copilot', path: p('commands', 'psm.md') },
                { name: 'x', source: 'builtin', path: '/builtin/x' },
            ],
        };
        const ok = evaluateSdkSkills({ ok: true, value: skills }, root, ['a', 'b']);
        expect(ok).toMatchObject({ ok: true, detail: '2/2 skills/*/SKILL.md listed as plugin skills; plus 1 non-skills/ plugin entry (commands/*.md: oh-my-copilot:psm)' });
        const missing = evaluateSdkSkills({ ok: true, value: skills }, root, ['a', 'b', 'c']);
        expect(missing).toMatchObject({ ok: false, evidence: 'missing: c' });
    });
    it('sdk.agents: every agents/*.md as oh-my-copilot:<name>', () => {
        const agents = { agents: [{ name: 'oh-my-copilot:architect' }, { name: 'oh-my-copilot:writer' }] };
        expect(evaluateSdkAgents({ ok: true, value: agents }, ['architect.md', 'writer.md']).ok).toBe(true);
        expect(evaluateSdkAgents({ ok: true, value: agents }, ['architect.md', 'critic.md'])).toMatchObject({ ok: false, evidence: 'missing: oh-my-copilot:critic' });
    });
    it('sdk.mcp: connected with the registry tool count', () => {
        const mcp = { ok: true, value: { servers: [{ name: 't', status: 'connected' }] } };
        const tools = { ok: true, value: { tools: [{ name: 'a' }, { name: 'b' }] } };
        expect(evaluateSdkMcp(mcp, tools, 't', 2).ok).toBe(true);
        expect(evaluateSdkMcp(mcp, tools, 't', 3).detail).toMatch(/stale dist/);
        expect(evaluateSdkMcp({ ok: true, value: { servers: [{ name: 't', status: 'pending' }] } }, tools, 't', 2).detail).toBe('server t status pending');
    });
});
describe('chooseModel', () => {
    it('falls back to auto when only auto is listed', () => {
        const choice = chooseModel(['auto', 'auto']);
        expect(choice.model).toBeUndefined();
        expect(choice.label).toBe('auto');
    });
    it('picks a cheap explicit model, and an explicit request wins', () => {
        expect(chooseModel(['auto', 'claude-opus-5-5', 'gpt-5-mini']).model).toBe('gpt-5-mini');
        expect(chooseModel(['auto'], 'claude-sonnet-5')).toMatchObject({ model: 'claude-sonnet-5', note: expect.stringMatching(/not in models.list/) });
    });
});
describe('chain scenario (live capture, Copilot CLI 1.0.91, 2026-10-06)', () => {
    /** Redacted ledgers, decisions, stop marker and both link sessions' key events. */
    const evidence = JSON.parse(readFileSync(join(FIXTURES, 'tier2-chain-evidence.json'), 'utf-8'));
    /** The debug-log line link 1's SessionEnd left: the 300 ms foreground budget, fail-closed under the smoke. */
    const TIMEOUT_LINE = 'Stderr: [run.cjs] Hook session-end.mjs timed out after 300ms; exiting fail-closed (124).';
    const chainRun = (over = {}) => ({
        name: 'chain',
        events: evidence.sessions.flatMap((s) => s.events ?? []),
        idle: true,
        timedOut: false,
        timeoutMs: 240_000,
        logText: '',
        model: 'link default',
        maxCredits: 30,
        chain: evidence,
        ...over,
    });
    it('is opt-in: never in all or the default set', () => {
        expect(ALL_SCENARIOS).not.toContain('chain');
        expect(DEFAULT_SCENARIOS).not.toContain('chain');
        expect(KNOWN_SCENARIOS).toContain('chain');
    });
    it('passes the chain checks on the captured two-link run and sums both links (2 legacy premium requests)', () => {
        const { checks, cost } = evaluateScenario(chainRun());
        const c = byId(checks);
        for (const id of ['link1', 'spawned', 'inherited', 'closed', 'credits', 'exit', 'adapter_errors', 'cost']) {
            expect(c[`scn.chain.${id}`]?.ok, `scn.chain.${id}: ${c[`scn.chain.${id}`]?.detail}`).toBe(true);
        }
        expect(c['scn.chain.link1'].detail).toContain('66c7ed79-96f2-4b3f-a2f4-290874ee376b');
        expect(c['scn.chain.closed'].detail).toContain('loop-capped:link-2');
        expect(cost.premiumRequests).toBe(2);
        expect(chainCost(evidence)).toMatchObject({ premiumRequests: 2, source: '2/2 link session(s) events.jsonl' });
    });
    it('flags the captured SessionEnd foreground timeout as an adapter error', () => {
        const c = byId(evaluateScenario(chainRun({ logText: `2026-10-06T01:10:37.159Z [ERROR] [rust:hooks] Hook from "oh-my-copilot" execution failed\n${TIMEOUT_LINE}` })).checks);
        expect(c['scn.chain.adapter_errors']).toMatchObject({ ok: false, detail: expect.stringContaining('session-end.mjs') });
    });
    it('fails inherited when a link SessionEnd rejected OMC_CHAIN_LINK, and closed when a ledger stayed open', () => {
        const rejected = { ...evidence, decisions: [...evidence.decisions, { decision: 'chain-link-rejected', sessionId: 'x', error: 'no ledger' }] };
        expect(byId(evaluateScenario(chainRun({ chain: rejected })).checks)['scn.chain.inherited'].ok).toBe(false);
        const open = { ...evidence, ledgers: evidence.ledgers.map((l, i) => (i === 1 ? { ...l, closedAt: undefined, hostSessionId: undefined } : l)) };
        const c = byId(evaluateScenario(chainRun({ chain: open })).checks);
        expect(c['scn.chain.closed'].ok).toBe(false);
        expect(c['scn.chain.inherited'].ok).toBe(false);
    });
    it('reports every check id when no evidence was collected', () => {
        const { checks } = evaluateScenario(chainRun({ chain: undefined, idle: false, error: 'chain setup: boom' }));
        expect(checks.map((c) => c.id)).toEqual(scenarioCheckIds('chain'));
        expect(checks.filter((c) => c.ok).map((c) => c.id)).toEqual(['scn.chain.adapter_errors', 'scn.chain.cost']);
    });
});
describe('filetools scenario (Copilot CLI 1.0.91 capture)', () => {
    const probeFixture = (name) => readFileSync(join(FIXTURES, `tier2-${name}-probe.jsonl`), 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    // view, edit, create (mai-code-1.1-flash), in an earlier layout without filetools/new/README.md.
    const NONCE = 'omg-dirctx-334f8708d0bc';
    const PROBE = probeFixture('filetools');
    const evidence = (over = {}) => ({ nonce: NONCE, writeNonce: 'omg-dirctx-unset', probe: PROBE, edited: true, created: true, ...over });
    const ftRun = (over = {}) => run('filetools', { filetools: evidence(), ...over });
    const own = scenarioCheckIds('filetools').slice(0, 8);
    // view, apply_patch (notes.txt + new/created.txt), view (gpt-6-luna), with the apply_patch-aware injector.
    const patchRun = (over = {}) => run('filetools', {
        events: parseJsonl(readFileSync(join(FIXTURES, 'tier2-filetools-patch-events.jsonl'), 'utf-8')).events,
        filetools: { nonce: 'omg-dirctx-11e9834dc45b', writeNonce: 'omg-dirctx-397636e54ea0', probe: probeFixture('filetools-patch'), edited: true, created: true, ...over },
    });
    it('apply_patch capture passes: Edit with the patch text as tool_input, the write-side README injected through it', () => {
        const { checks, cost } = evaluateScenario(patchRun());
        expect(checks.filter((c) => !c.ok)).toEqual([]);
        expect(cost.premiumRequests).toBe(1);
        const c = byId(checks);
        expect(c['scn.filetools.pre'].detail).toBe('PreToolUse probe: view→Read (native view), apply_patch→Edit (native apply_patch), view→Read (native view)');
        expect(c['scn.filetools.matcher'].detail).toBe(`PostToolUse matcher ${FILE_TOOL_MATCHER}: view→Read, apply_patch→Edit, view→Read`);
        expect(c['scn.filetools.payload'].detail).toBe('view: tool_name Read {path}; apply_patch: tool_name Edit "<patch: filetools/notes.txt, new/created.txt>"; view: tool_name Read {path}');
        expect(c['scn.filetools.injected_write'].detail).toBe('filetools/new/README.md nonce in a postToolUse hook.end output; in the apply_patch tool result sent to the model');
    });
    it('edit/create capture: pre and post hooks per file tool, Claude names in the payload, the injection in the view result', () => {
        const { checks, cost } = evaluateScenario(ftRun());
        expect(checks.map((c) => c.id)).toEqual(scenarioCheckIds('filetools'));
        // That layout had no README.md for the written file alone, so no write-side injection.
        expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['scn.filetools.injected_write']);
        expect(cost.premiumRequests).toBe(1);
        const c = byId(checks);
        expect(c['scn.filetools.injected_write'].detail).toBe('filetools/new/README.md nonce missing from a postToolUse hook.end output; in no model-facing tool result');
        expect(c['scn.filetools.tools'].detail).toBe('view, edit, create completed; notes.txt edited, created.txt created');
        expect(c['scn.filetools.pre'].detail).toBe('PreToolUse probe: view→Read (native view), edit→Edit (native edit), create→Write (native create)');
        expect(c['scn.filetools.post'].detail).toBe('PostToolUse probe: view→Read (native view), edit→Edit (native edit), create→Write (native create)');
        expect(c['scn.filetools.matcher'].detail).toBe(`PostToolUse matcher ${FILE_TOOL_MATCHER}: view→Read, edit→Edit, create→Write`);
        // tool_input keeps Copilot's argument names; no Claude file_path/old_string/new_string/content.
        expect(c['scn.filetools.payload'].detail).toBe('view: tool_name Read {path}; edit: tool_name Edit {path,old_str,new_str}; create: tool_name Write {path,file_text}');
        expect(c['scn.filetools.injected'].detail).toBe('filetools/README.md nonce in a postToolUse hook.end output; in the view tool result sent to the model; model echoed it');
    });
    it('the Claude payload carries no tool call id and has tool_result, not tool_response', () => {
        const post = PROBE.find((r) => r.label === 'PostToolUse').payload;
        expect(Object.keys(post).sort()).toEqual(['cwd', 'hook_event_name', 'session_id', 'timestamp', 'tool_input', 'tool_name', 'tool_result']);
        expect(PROBE.every((r) => probeTool(r).name !== '')).toBe(true);
    });
    it('fails matcher when the Read|Write|Edit|MultiEdit entry never ran', () => {
        const c = byId(evaluateScenario(ftRun({ filetools: evidence({ probe: PROBE.filter((r) => r.label !== 'PostToolUse:matcher') }) })).checks);
        expect(c['scn.filetools.matcher']).toMatchObject({ ok: false, detail: expect.stringContaining('view→none') });
        expect(c['scn.filetools.post'].ok).toBe(true);
    });
    it('fails pre when the PreToolUse entries never ran', () => {
        const c = byId(evaluateScenario(ftRun({ filetools: evidence({ probe: PROBE.filter((r) => r.label.toLowerCase() !== 'pretooluse') }) })).checks);
        expect(c['scn.filetools.pre']).toMatchObject({ ok: false, detail: expect.stringContaining('view→none (native none)') });
    });
    it('fails payload when the Claude-format entry sees native tool names', () => {
        const native = new Map(PROBE.filter((r) => r.label === 'postToolUse').map((r) => [JSON.stringify(probeTool(r).input), probeTool(r).name]));
        const unmapped = PROBE.map((r) => (r.label === 'PostToolUse' ? { ...r, payload: { ...r.payload, tool_name: native.get(JSON.stringify(probeTool(r).input)) } } : r));
        const c = byId(evaluateScenario(ftRun({ filetools: evidence({ probe: unmapped }) })).checks);
        expect(c['scn.filetools.payload']).toMatchObject({ ok: false, detail: expect.stringContaining('view: tool_name view {path}') });
    });
    it('fails injected when the nonce reached the hook but no model-facing tool result', () => {
        const stripped = events('filetools').filter((e) => e.type !== 'tool.execution_complete' && e.type !== 'model.tool_execution');
        const c = byId(evaluateScenario(ftRun({ events: stripped })).checks);
        expect(c['scn.filetools.injected']).toMatchObject({ ok: false, detail: expect.stringMatching(/in a postToolUse hook\.end output; in no model-facing tool result/) });
    });
    it("fails injected for another run's nonce; a direct view of README.md does not count", () => {
        expect(byId(evaluateScenario(ftRun({ filetools: evidence({ nonce: 'omg-dirctx-000000000000' }) })).checks)['scn.filetools.injected'].ok).toBe(false);
        const readme = events('filetools').map((e) => (e.type === 'tool.execution_start' && e.data?.toolName === 'view'
            ? { ...e, data: { ...e.data, arguments: { path: 'filetools/README.md' } } } : e));
        expect(byId(evaluateScenario(ftRun({ events: readme })).checks)['scn.filetools.injected'].ok).toBe(false);
    });
    it('fails tools when the edit did not land, and every own check without evidence', () => {
        expect(byId(evaluateScenario(ftRun({ filetools: evidence({ edited: false }) })).checks)['scn.filetools.tools'].ok).toBe(false);
        const { checks } = evaluateScenario(run('filetools', { error: 'createSession() timed out' }));
        expect(checks.filter((c) => own.includes(c.id)).every((c) => !c.ok && c.detail.startsWith('no filetools evidence'))).toBe(true);
    });
    it('is opt-in, without a shell, and permits file access only under the sandbox project', () => {
        expect(OPT_IN_SCENARIOS).toContain('filetools');
        expect(ALL_SCENARIOS).not.toContain('filetools');
        expect(DEFAULT_SCENARIOS).not.toContain('filetools');
        expect(SCENARIOS.filetools.excludedTools).toEqual(['powershell', 'shell']);
        expect(SCENARIOS.filetools.prompt).not.toMatch(/omg-dirctx/);
        const ctx = { projectDir: join(FIXTURES, 'project'), pluginRoot: join(FIXTURES, 'plugin') };
        expect(permitProjectFiles({ kind: 'read', path: join(ctx.projectDir, 'filetools', 'notes.txt') }, ctx)).toBe(true);
        expect(permitProjectFiles({ kind: 'write', fileName: join(ctx.projectDir, 'filetools', 'created.txt') }, ctx)).toBe(true);
        expect(permitProjectFiles({ kind: 'write', fileName: 'filetools/created.txt' }, ctx)).toBe(true);
        expect(permitProjectFiles({ kind: 'write', fileName: join(ctx.projectDir, '..', 'x.txt') }, ctx)).toBe(false);
        expect(permitProjectFiles({ kind: 'write', fileName: join(ctx.projectDir, 'x'), resolvedPath: join(ctx.pluginRoot, 'x') }, ctx)).toBe(false);
        expect(permitProjectFiles({ kind: 'read', path: join(ctx.pluginRoot, 'skills', 'x') }, ctx)).toBe(false);
        expect(permitProjectFiles({ kind: 'read' }, ctx)).toBe(false);
        expect(permitProjectFiles({ kind: 'shell', fullCommandText: 'ls' }, ctx)).toBe(false);
    });
    it('the probe hooks mirror our generated PostToolUse matcher, one command entry per label', () => {
        const ours = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'copilot', 'hooks.json'), 'utf-8'));
        const injector = ours.hooks.PostToolUse.find((h) => h.args.some((a) => a.endsWith('post-tool-directory-context-injector.mjs')));
        expect(injector?.matcher).toBe(FILE_TOOL_MATCHER);
        const probe = probeHooksJson('node', '/p/probe.cjs', '/p/log.jsonl');
        expect(probe.version).toBe(1);
        expect(Object.keys(probe.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'preToolUse', 'postToolUse']);
        expect(probe.hooks.PostToolUse.map((h) => h.matcher)).toEqual([undefined, FILE_TOOL_MATCHER]);
        expect(probe.hooks.PostToolUse[1]).toMatchObject({ type: 'command', exec: 'node', args: ['/p/probe.cjs', 'PostToolUse:matcher', '/p/log.jsonl'] });
    });
});
//# sourceMappingURL=copilot-sdk-scenarios.test.js.map