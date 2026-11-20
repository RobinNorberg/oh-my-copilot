/**
 * Lane fast path of pre-tool-enforcer.mjs (docs/HOOKS.md "Lane hook set").
 *
 * Under OMC_LANE_HOOKS=minimal on the Copilot hook host the enforcer runs every
 * guard and skips only the advisory context. Each case below runs the same
 * payload sequence in a fresh project twice, once as a normal Copilot session
 * and once as a lane, and requires the same deny / rewrite decision on every
 * call. Outside a Copilot lane the variable must change nothing at all.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { laneStateRootEnv } from '../copilot-run/job.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { scaleTiming } from './helpers/platform.js';
vi.unmock('child_process');
vi.unmock('node:child_process');
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
const SESSION = 'lane-session-1';
const OBJECTIVE = 'Complete all ultragoal stories in .omg/ultragoal/goals.json: G001-ship ship it';
const created = [];
afterEach(() => {
    while (created.length)
        rmSync(created.pop(), { recursive: true, force: true });
});
function makeProject() {
    const cwd = mkdtempSync(join(tmpdir(), 'omg-lane-pte-'));
    const aux = mkdtempSync(join(tmpdir(), 'omg-lane-pte-aux-'));
    created.push(cwd, aux);
    execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'pipe' });
    return { cwd, aux };
}
function writeJson(filePath, data) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
}
function modeEnv(mode) {
    switch (mode) {
        case 'claude': return {};
        case 'claude-lane-var': return { OMC_LANE_HOOKS: 'minimal' };
        case 'copilot': return { OMC_HOOK_EVENT: 'PreToolUse' };
        case 'lane':
        case 'lane-root': return { OMC_HOOK_EVENT: 'PreToolUse', OMC_LANE_HOOKS: 'minimal' };
        case 'copilot-lane-other': return { OMC_HOOK_EVENT: 'PreToolUse', OMC_LANE_HOOKS: '1' };
    }
}
function hookEnv(aux, mode, extra = {}) {
    const home = join(aux, 'home');
    const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        COPILOT_HOME: join(home, '.copilot'),
        XDG_CONFIG_HOME: join(aux, 'xdg'),
        APPDATA: join(aux, 'xdg'),
        NODE_ENV: 'test',
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: '',
        OMC_STATE_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        OMC_QUIET: '',
        OMC_READ_BUDGET: '',
        OMC_READ_BUDGET_MAX_LINES: '',
        OMC_ROUTING_FORCE_INHERIT: 'false',
        OMC_SUBAGENT_MODEL: '',
        OMC_SHELL_CHECKS: '',
        OMC_AGENT_PREFLIGHT_CONTEXT_THRESHOLD: '',
        OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: '',
        OMC_PRE_TOOL_ADVISORY_NOW_MS: '1000',
        CLAUDE_MODEL: '',
        ANTHROPIC_MODEL: '',
        ANTHROPIC_BASE_URL: '',
        CLAUDE_CODE_USE_BEDROCK: '',
        CLAUDE_CODE_USE_VERTEX: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        CLAUDE_CODE_BEDROCK_SONNET_MODEL: '',
    };
    delete env.OMC_HOOK_EVENT;
    delete env.OMC_LANE_HOOKS;
    delete env.ALLOW_ULTRAGOAL_WITHOUT_GOAL;
    delete env.OMC_LANE_CWD;
    delete env.OMC_LANE_STATE_ROOT;
    Object.assign(env, extra, modeEnv(mode));
    return env;
}
function runRaw(payload, cwd, aux, mode, extra = {}) {
    return execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd,
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        // A hang guard only; nothing here asserts timing.
        timeout: scaleTiming(10_000),
        env: hookEnv(aux, mode, extra),
    });
}
/** The engine's precomputed state root for a lane in `cwd`, as job.ts sets it. */
function laneRootVars(cwd, aux, extra = {}) {
    const vars = laneStateRootEnv(cwd, hookEnv(aux, 'lane', extra), process.cwd());
    expect(Object.keys(vars).sort()).toEqual(['OMC_LANE_CWD', 'OMC_LANE_STATE_ROOT']);
    return vars;
}
/** Runs a case's calls in a fresh project; the raw stdout of each call. */
function runCase(c, mode) {
    const { cwd, aux } = makeProject();
    c.setup?.(cwd, aux);
    // Outside a Copilot lane the engine's variables must be inert: give those modes a decoy root.
    const decoy = { OMC_LANE_CWD: realpathSync.native(cwd), OMC_LANE_STATE_ROOT: join(aux, 'decoy', '.omg') };
    const extra = mode === 'lane-root'
        ? { ...c.env, ...laneRootVars(cwd, aux, c.env) }
        : mode === 'claude-lane-var' || mode === 'copilot-lane-other' ? { ...decoy, ...c.env } : c.env;
    const outputs = c.calls(cwd, aux).map((payload) => runRaw(payload, cwd, aux, mode, extra));
    return { outputs, cwd, aux };
}
/** What a PreToolUse output decides: the deny and its reason, and any rewritten input. Paths are scrubbed. */
function decision(stdout, cwd, aux) {
    const scrub = (text) => text.split(cwd).join('<CWD>').split(aux).join('<AUX>');
    const output = JSON.parse(stdout.trim());
    const hook = (output.hookSpecificOutput ?? {});
    return {
        continue: output.continue,
        decision: output.decision,
        reason: typeof output.reason === 'string' ? scrub(output.reason) : output.reason,
        permissionDecision: hook.permissionDecision,
        permissionDecisionReason: typeof hook.permissionDecisionReason === 'string' ? scrub(hook.permissionDecisionReason) : undefined,
        updatedInput: hook.updatedInput,
    };
}
function additionalContext(stdout) {
    const output = JSON.parse(stdout.trim());
    return output.hookSpecificOutput?.additionalContext;
}
const call = (cwd, tool, input, extra = {}) => ({
    hook_event_name: 'PreToolUse', session_id: SESSION, cwd, tool_name: tool, tool_input: input, ...extra,
});
const ultragoalState = (cwd) => {
    const now = new Date().toISOString();
    writeJson(join(cwd, '.omg', 'state', 'sessions', SESSION, 'ultragoal-state.json'), {
        active: true, started_at: now, last_checked_at: now, session_id: SESSION, project_path: cwd,
        current_phase: 'executing', claude_goal_objective: OBJECTIVE,
    });
};
const bigFile = (cwd) => writeFileSync(join(cwd, 'big.txt'), 'line\n'.repeat(4000));
// Every guard of the enforcer that can deny or rewrite a call, plus plain allowed calls.
const CASES = [
    { name: 'allowed Bash', calls: (cwd) => [call(cwd, 'Bash', { command: 'ls -la' })] },
    { name: 'allowed Read', calls: (cwd) => [call(cwd, 'Read', { file_path: join(cwd, 'README.md') })] },
    { name: 'allowed Edit and Write', calls: (cwd) => [
            call(cwd, 'Edit', { file_path: join(cwd, 'a.txt'), old_string: 'a', new_string: 'b' }),
            call(cwd, 'Write', { file_path: join(cwd, 'b.txt'), content: 'x' }),
        ] },
    { name: 'allowed Grep and Glob', calls: (cwd) => [call(cwd, 'Grep', { pattern: 'foo' }), call(cwd, 'Glob', { pattern: '**/*.ts' })] },
    { name: 'allowed Agent spawn', calls: (cwd) => [call(cwd, 'Agent', { subagent_type: 'oh-my-copilot:explore', prompt: 'look', description: 'find files' })] },
    { name: 'unknown tool with an active mode', setup: (cwd) => writeJson(join(cwd, '.omg', 'state', 'sessions', SESSION, 'ralph-state.json'), { active: true, session_id: SESSION }),
        calls: (cwd) => [call(cwd, 'mcp__t__state_read', {})] },
    { name: 'built-in task-list tool', calls: (cwd) => [call(cwd, 'TaskCreate', { subject: 'x' })] },
    { name: 'Task prompt with fallback language (slop warning)', calls: (cwd) => [
            call(cwd, 'Task', { subagent_type: 'oh-my-copilot:executor', description: 'fix', prompt: 'If it fails, add a fallback that silently returns cached data as a workaround.' }),
        ] },
    { name: 'ultragoal without a goal record: deny', setup: ultragoalState,
        calls: (cwd) => [call(cwd, 'Bash', { command: 'npm test' }), call(cwd, 'Edit', { file_path: join(cwd, 'a.txt'), old_string: 'a', new_string: 'b' })] },
    { name: 'ultragoal bootstrap command stays allowed', setup: ultragoalState,
        calls: (cwd) => [call(cwd, 'Bash', { command: 'omg ultragoal goal-start --criterion "done"' })] },
    { name: 'ALLOW_ULTRAGOAL_WITHOUT_GOAL bypass', setup: ultragoalState, env: { ALLOW_ULTRAGOAL_WITHOUT_GOAL: '1' },
        calls: (cwd) => [call(cwd, 'Bash', { command: 'npm test' })] },
    { name: 'skill name passed as subagent_type: deny',
        calls: (cwd) => [call(cwd, 'Task', { subagent_type: 'oh-my-copilot:ai-slop-cleaner', description: 'd', prompt: 'p' })] },
    { name: 'force-inherit tier alias without routing: deny', env: { OMC_ROUTING_FORCE_INHERIT: 'true' },
        calls: (cwd) => [call(cwd, 'Agent', { subagent_type: 'oh-my-copilot:explore', model: 'sonnet', description: 'd', prompt: 'p' })] },
    { name: 'force-inherit with a [1m] session model: deny', env: { OMC_ROUTING_FORCE_INHERIT: 'true', CLAUDE_MODEL: 'claude-sonnet-4-6[1m]' },
        calls: (cwd) => [call(cwd, 'Agent', { subagent_type: 'oh-my-copilot:explore', description: 'd', prompt: 'p' })] },
    { name: 'agents.<name>.model injection: updatedInput',
        setup: (_cwd, aux) => { mkdirSync(join(aux, 'xdg', 'claude-omc'), { recursive: true }); writeFileSync(join(aux, 'xdg', 'claude-omc', 'config.jsonc'), '{ "agents": { "explore": { "model": "sonnet" } } }'); },
        calls: (cwd) => [call(cwd, 'Task', { subagent_type: 'oh-my-copilot:explore', prompt: 'x', description: 'find files' })] },
    { name: 'force-agent-delegation threshold: deny on the third Read',
        setup: (cwd) => writeJson(join(cwd, '.omg', 'config.json'), { routing: { forceDelegation: { enforce: true, rules: [{ pattern: 'Read', threshold: { count: 3, windowSeconds: 60 }, denyMessage: 'Too many Reads.' }] } } }),
        calls: (cwd) => [0, 1, 2].map((i) => call(cwd, 'Read', { file_path: join(cwd, `f${i}.ts`), offset: 1, limit: 10 })) },
    { name: 'read budget: warn, then deny', setup: bigFile,
        calls: (cwd) => [call(cwd, 'Read', { file_path: join(cwd, 'big.txt') }), call(cwd, 'Read', { file_path: join(cwd, 'big.txt') })] },
    { name: 'agent-heavy preflight with an exhausted transcript: deny',
        setup: (cwd) => writeFileSync(join(cwd, 'transcript.jsonl'), `${JSON.stringify({ usage: { context_window: 1000, input_tokens: 950 }, context_window: 1000, input_tokens: 950 })}\n`),
        calls: (cwd) => [call(cwd, 'Task', { subagent_type: 'oh-my-copilot:explore', prompt: 'p', description: 'd' }, { transcript_path: join(cwd, 'transcript.jsonl') })] },
    { name: 'shell checks: unterminated here-document denied', env: { OMC_SHELL_CHECKS: '1' },
        calls: (cwd) => [call(cwd, 'Bash', { command: 'cat > f.txt <<EOF\nhello\n' })] },
    { name: 'Skill call records skill state', calls: (cwd) => [call(cwd, 'Skill', { skill: 'oh-my-copilot:review' })] },
    { name: 'DISABLE_OMC', env: { DISABLE_OMC: '1' }, calls: (cwd) => [call(cwd, 'Bash', { command: 'ls' })] },
];
describe('pre-tool-enforcer lane fast path (OMC_LANE_HOOKS=minimal)', () => {
    // Lane decisions of every case, collected by the per-case tests for the coverage check below.
    const laneDecisions = [];
    it.each(CASES.map((c) => [c.name, c]))('%s: the lane decides as a normal Copilot session, with no advisory context', (_name, c) => {
        const normal = runCase(c, 'copilot');
        const lane = runCase(c, 'lane');
        const laneRoot = runCase(c, 'lane-root');
        expect(lane.outputs).toHaveLength(normal.outputs.length);
        expect(laneRoot.outputs).toHaveLength(normal.outputs.length);
        lane.outputs.forEach((out, i) => {
            const laneDecision = decision(out, lane.cwd, lane.aux);
            expect(laneDecision).toEqual(decision(normal.outputs[i], normal.cwd, normal.aux));
            expect(decision(laneRoot.outputs[i], laneRoot.cwd, laneRoot.aux)).toEqual(laneDecision);
            laneDecisions.push(laneDecision);
            const context = additionalContext(out);
            if (context === undefined)
                return;
            // The one context a lane keeps is the read budget's own warn step (the call
            // before its deny), word for word as outside a lane.
            expect(c.name, String(context)).toBe('read budget: warn, then deny');
            expect(context).toBe(additionalContext(normal.outputs[i]));
        });
    });
    it('the cases cover real denies and a rewrite', () => {
        expect(laneDecisions.length).toBeGreaterThanOrEqual(CASES.length);
        // The agent-heavy preflight blocks with top-level decision:'block'; the other guards deny in hookSpecificOutput.
        const denies = laneDecisions
            .filter((d) => d.permissionDecision === 'deny' || d.decision === 'block')
            .map((d) => String(d.permissionDecisionReason ?? d.reason));
        for (const marker of ['ULTRAGOAL GOAL RECORD REQUIRED', '[SKILL vs AGENT]', '[MODEL ROUTING]', 'Too many Reads.', 'Preflight context guard', '[SHELL CHECK]']) {
            expect(denies.some((reason) => reason.includes(marker)), marker).toBe(true);
        }
        expect(denies.length).toBeGreaterThanOrEqual(9);
        expect(laneDecisions.some((d) => d.updatedInput?.model === 'sonnet')).toBe(true);
    });
    it('the advisory a lane skips is there outside the lane', () => {
        const bash = CASES[0];
        expect(additionalContext(runCase(bash, 'copilot').outputs[0])).toContain('Use parallel execution');
        expect(runCase(bash, 'lane').outputs[0].trim()).toBe('{"continue":true,"suppressOutput":true}');
    });
    it('a lane writes the skill state and no advisory throttle file', () => {
        const c = CASES.find((x) => x.name === 'Skill call records skill state');
        const normal = runCase(c, 'copilot');
        const lane = runCase(c, 'lane');
        const sessionDir = (cwd) => join(cwd, '.omg', 'state', 'sessions', SESSION);
        expect(existsSync(join(sessionDir(normal.cwd), 'skill-active-state.json'))).toBe(true);
        expect(existsSync(join(sessionDir(lane.cwd), 'skill-active-state.json'))).toBe(true);
        const bash = runCase(CASES[0], 'lane');
        expect(existsSync(join(sessionDir(bash.cwd), 'pre-tool-advisory-throttle.json'))).toBe(false);
    });
    it.each(CASES.map((c) => [c.name, c]))('%s: byte for byte unchanged outside a Copilot lane', (_name, c) => {
        // Claude Code never sets OMC_HOOK_EVENT, so OMC_LANE_HOOKS=minimal there is inert;
        // on Copilot any value other than "minimal" is inert too.
        const scrub = (r) => r.outputs.map((o) => o.split(r.cwd).join('<CWD>').split(JSON.stringify(r.cwd).slice(1, -1)).join('<CWD>').split(r.aux).join('<AUX>').split(JSON.stringify(r.aux).slice(1, -1)).join('<AUX>'));
        expect(scrub(runCase(c, 'claude-lane-var'))).toEqual(scrub(runCase(c, 'claude')));
        expect(scrub(runCase(c, 'copilot-lane-other'))).toEqual(scrub(runCase(c, 'copilot')));
    });
});
describe('lane precomputed state root (OMC_LANE_CWD / OMC_LANE_STATE_ROOT)', () => {
    it('equals what getOmcRoot returns for the work dir, also with the lane profile as HOME', () => {
        vi.stubEnv('OMC_STATE_DIR', '');
        try {
            const { cwd, aux } = makeProject();
            const expected = getOmcRoot(realpathSync.native(cwd));
            expect(laneRootVars(cwd, aux)).toEqual({ OMC_LANE_CWD: realpathSync.native(cwd), OMC_LANE_STATE_ROOT: expected });
            const sub = join(cwd, 'pkg', 'src');
            mkdirSync(sub, { recursive: true });
            expect(laneRootVars(sub, aux).OMC_LANE_STATE_ROOT).toBe(getOmcRoot(realpathSync.native(sub)));
        }
        finally {
            vi.unstubAllEnvs();
        }
    });
    it('is not computed when the lane env sets OMC_STATE_DIR, or the work dir is missing', () => {
        const { cwd, aux } = makeProject();
        expect(laneStateRootEnv(cwd, { ...hookEnv(aux, 'lane'), OMC_STATE_DIR: join(aux, 'central') }, process.cwd())).toEqual({});
        expect(laneStateRootEnv(join(cwd, 'missing'), hookEnv(aux, 'lane'), process.cwd())).toEqual({});
    });
    // The precomputed root points at a decoy whose state holds an active ultragoal, while the
    // project itself has none: a deny proves the hook used the decoy, an allow that it resolved itself.
    function decoySetup() {
        const { cwd, aux } = makeProject();
        const decoyRoot = join(aux, 'decoy', '.omg');
        const now = new Date().toISOString();
        writeJson(join(decoyRoot, 'state', 'sessions', SESSION, 'ultragoal-state.json'), {
            active: true, started_at: now, last_checked_at: now, session_id: SESSION, current_phase: 'executing', claude_goal_objective: OBJECTIVE,
        });
        return { cwd, aux, vars: { OMC_LANE_CWD: realpathSync.native(cwd), OMC_LANE_STATE_ROOT: decoyRoot } };
    }
    const denied = (stdout) => JSON.parse(stdout.trim()).hookSpecificOutput?.permissionDecision === 'deny';
    const bashIn = (dir) => call(dir, 'Bash', { command: 'npm test' });
    it('is used for the lane work dir and a plain subdir of it', () => {
        const { cwd, aux, vars } = decoySetup();
        expect(denied(runRaw(bashIn(cwd), cwd, aux, 'lane', vars))).toBe(true);
        const sub = join(cwd, 'src', 'deep');
        mkdirSync(sub, { recursive: true });
        expect(denied(runRaw(bashIn(sub), sub, aux, 'lane', vars))).toBe(true);
        if (process.platform === 'win32') {
            const upper = { ...vars, OMC_LANE_CWD: vars.OMC_LANE_CWD.toUpperCase() };
            expect(denied(runRaw(bashIn(cwd), cwd, aux, 'lane', upper))).toBe(true);
        }
    });
    it('falls back to the normal lookup outside the work dir, in a nested repo, and with OMC_STATE_DIR', () => {
        const { cwd, aux, vars } = decoySetup();
        // A sibling that shares the prefix: <cwd>-x.
        const sibling = `${cwd}-x`;
        mkdirSync(sibling);
        created.push(sibling);
        execFileSync('git', ['init', '--quiet'], { cwd: sibling, stdio: 'pipe' });
        expect(denied(runRaw(bashIn(sibling), sibling, aux, 'lane', vars))).toBe(false);
        // The parent of the work dir.
        expect(denied(runRaw(bashIn(dirname(cwd)), dirname(cwd), aux, 'lane', vars))).toBe(false);
        // A nested repo or workspace marker below the work dir has its own root.
        const nested = join(cwd, 'vendor', 'lib');
        mkdirSync(nested, { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd: join(cwd, 'vendor'), stdio: 'pipe' });
        expect(denied(runRaw(bashIn(nested), nested, aux, 'lane', vars))).toBe(false);
        const marked = join(cwd, 'ws');
        mkdirSync(marked);
        writeFileSync(join(marked, '.omc-workspace'), '{}');
        expect(denied(runRaw(bashIn(marked), marked, aux, 'lane', vars))).toBe(false);
        // OMC_STATE_DIR set in the hook: centralized resolution, the precomputed root is ignored.
        expect(denied(runRaw(bashIn(cwd), cwd, aux, 'lane', { ...vars, OMC_STATE_DIR: join(aux, 'central') }))).toBe(false);
        // Not a lane: ignored.
        expect(denied(runRaw(bashIn(cwd), cwd, aux, 'copilot', vars))).toBe(false);
        expect(denied(runRaw(bashIn(cwd), cwd, aux, 'claude-lane-var', vars))).toBe(false);
    });
});
//# sourceMappingURL=pre-tool-enforcer-lane.test.js.map