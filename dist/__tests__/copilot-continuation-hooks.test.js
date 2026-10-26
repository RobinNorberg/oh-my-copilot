/**
 * Copilot CLI goal/continuation behaviour of the hook scripts, driven by the
 * real Copilot 1.0.91 payloads in fixtures/copilot-live (recorded by the live
 * probe, paths scrubbed to <CWD>). Copilot runs are marked by OMC_HOOK_EVENT,
 * which copilot/hooks.json sets and Claude Code never does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { provisionStandaloneStateLockBridge } from '../installer/index.js';
import { pathToFileURL } from 'url';
const ROOT = process.cwd();
const FIXTURES = join(ROOT, 'src', '__tests__', 'fixtures', 'copilot-live');
const preToolScript = join(ROOT, 'scripts', 'pre-tool-enforcer.mjs');
const persistentModeScript = join(ROOT, 'scripts', 'persistent-mode.mjs');
const keywordScript = join(ROOT, 'scripts', 'keyword-detector.mjs');
const { resolveCanonicalWorkflowStagePrompt } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'workflow-stage-prompts.mjs')).href);
let templateKeywordScript = '';
// The standalone template runs from an installed hooks dir, laid out as the installer does.
function provisionTemplateKeywordScript() {
    if (templateKeywordScript && existsSync(templateKeywordScript))
        return templateKeywordScript;
    const root = mkdtempSync(join(tmpdir(), 'omg-template-kd-'));
    created.push(root);
    const hooksDir = join(root, 'hooks');
    cpSync(join(ROOT, 'templates', 'hooks'), hooksDir, { recursive: true });
    provisionStandaloneStateLockBridge(ROOT, join(hooksDir, 'lib', 'state-lock.mjs'));
    templateKeywordScript = join(hooksDir, 'keyword-detector.mjs');
    return templateKeywordScript;
}
const keywordScripts = [
    ['scripts', () => keywordScript],
    ['templates', provisionTemplateKeywordScript],
];
const PARENT = 'ad86cfd2-c9aa-49bd-a886-811317997b19';
const CHILD = 'ece89723-4efa-45e2-8786-92dbe14ac85a';
const OBJECTIVE = 'Complete all ultragoal stories in .omg/ultragoal/goals.json: G001-ship ship it';
const created = [];
let home = '';
function fixture(name, cwd) {
    const raw = readFileSync(join(FIXTURES, name), 'utf-8');
    return JSON.parse(raw.replaceAll('<CWD>', cwd.replace(/\\/g, '\\\\')));
}
function hookEnv(event, extra = {}) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        HOME: home,
        USERPROFILE: home,
        COPILOT_HOME: join(home, '.copilot'),
        OMC_STATE_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        ...extra,
    };
    delete env.OMC_HOOK_EVENT;
    delete env.ALLOW_ULTRAGOAL_WITHOUT_GOAL;
    delete env.OMC_COPILOT_STOP_CHAIN_MAX;
    delete env.OMC_TEAM_WORKER;
    for (const [key, value] of Object.entries(extra))
        env[key] = value;
    if (event)
        env.OMC_HOOK_EVENT = event;
    return env;
}
function runHook(script, payload, event, extra = {}) {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ROOT;
    const stdout = execFileSync(process.execPath, [script], {
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        cwd,
        env: hookEnv(event, extra),
    });
    return JSON.parse(stdout.trim() || '{}');
}
function makeProject(prefix) {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    created.push(cwd);
    execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'pipe' });
    return cwd;
}
function sessionDir(cwd, sessionId) {
    const dir = join(cwd, '.omg', 'state', 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
}
function writeModeState(cwd, sessionId, mode, overrides = {}) {
    const now = new Date().toISOString();
    const state = {
        active: true,
        started_at: now,
        last_checked_at: now,
        session_id: sessionId,
        project_path: cwd,
        current_phase: 'executing',
        ...overrides,
    };
    writeFileSync(join(sessionDir(cwd, sessionId), `${mode}-state.json`), `${JSON.stringify(state, null, 2)}\n`);
    return state;
}
function readModeState(cwd, sessionId, mode) {
    const path = join(cwd, '.omg', 'state', 'sessions', sessionId, `${mode}-state.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}
function writeGoalRecord(cwd, overrides = {}) {
    const now = new Date().toISOString();
    const record = {
        version: 1,
        objective: OBJECTIVE,
        status: 'active',
        host: 'copilot',
        createdAt: now,
        updatedAt: now,
        criteria: [
            { id: 'C1', text: 'tests pass' },
            { id: 'C2', text: 'docs updated' },
        ],
        ...overrides,
    };
    mkdirSync(join(cwd, '.omg', 'ultragoal'), { recursive: true });
    writeFileSync(join(cwd, '.omg', 'ultragoal', 'omg-goal.json'), `${JSON.stringify(record, null, 2)}\n`);
}
function chainCount(cwd, sessionId) {
    const path = join(cwd, '.omg', 'state', 'sessions', sessionId, 'copilot-stop-chain.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')).count : 0;
}
function writeParentEvents(parentSessionId) {
    const dir = join(home, '.copilot', 'session-state', parentSessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(FIXTURES, 'subagent-parent-events.jsonl'), 'utf-8'));
}
const isDenied = (output) => output.hookSpecificOutput?.permissionDecision === 'deny';
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omg-copilot-cont-home-'));
    created.push(home);
    mkdirSync(join(home, '.copilot'), { recursive: true });
});
afterEach(() => {
    while (created.length)
        rmSync(created.pop(), { recursive: true, force: true });
});
describe('skill tool name is lowercase on Copilot', () => {
    it('lets the live Copilot `skill` cancel call through an active ultragoal guard', () => {
        const cwd = makeProject('omg-skill-cancel-');
        writeModeState(cwd, 'b3010530-780f-4318-a4a2-c8562ec0e97e', 'ultragoal', { claude_goal_objective: OBJECTIVE });
        const payload = fixture('skill-pretooluse.json', cwd);
        expect(payload.tool_name).toBe('skill');
        expect(isDenied(runHook(preToolScript, payload, 'PreToolUse'))).toBe(false);
    });
    it('confirms an awaiting ultragoal state when Copilot invokes the `skill` tool', () => {
        const cwd = makeProject('omg-skill-confirm-');
        const sessionId = 'b3010530-780f-4318-a4a2-c8562ec0e97e';
        writeModeState(cwd, sessionId, 'ultragoal', { awaiting_confirmation: true, awaiting_confirmation_set_at: new Date().toISOString() });
        const payload = { ...fixture('skill-pretooluse.json', cwd), tool_input: { skill: 'ultragoal' } };
        runHook(preToolScript, payload, 'PreToolUse');
        expect(readModeState(cwd, sessionId, 'ultragoal').awaiting_confirmation).toBeUndefined();
    });
    it('writes skill-active state for a bare plugin skill name on Copilot', () => {
        const cwd = makeProject('omg-skill-active-');
        const sessionId = 'b3010530-780f-4318-a4a2-c8562ec0e97e';
        const payload = { ...fixture('skill-pretooluse.json', cwd), tool_input: { skill: 'plan' } };
        runHook(preToolScript, payload, 'PreToolUse');
        expect(existsSync(join(cwd, '.omg', 'state', 'sessions', sessionId, 'skill-active-state.json'))).toBe(true);
    });
    it('keeps bare skill names unprotected on Claude Code (issue #1581)', () => {
        const cwd = makeProject('omg-skill-claude-');
        const sessionId = 'b3010530-780f-4318-a4a2-c8562ec0e97e';
        const payload = { ...fixture('skill-pretooluse.json', cwd), tool_name: 'Skill', tool_input: { skill: 'plan' } };
        runHook(preToolScript, payload, null);
        expect(existsSync(join(cwd, '.omg', 'state', 'sessions', sessionId, 'skill-active-state.json'))).toBe(false);
    });
});
describe('Copilot-native ultragoal goal record', () => {
    const sessionId = 'session-copilot';
    const bash = (cwd, command = 'npm test') => ({
        hook_event_name: 'PreToolUse', session_id: sessionId, cwd, tool_name: 'Bash', tool_input: { command },
    });
    it('denies tools on Copilot until an OMG goal record exists, then allows them', () => {
        const cwd = makeProject('omg-goal-record-');
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        const before = runHook(preToolScript, bash(cwd), 'PreToolUse');
        expect(isDenied(before)).toBe(true);
        expect(before.hookSpecificOutput.permissionDecisionReason).toContain('omg ultragoal goal-start');
        writeGoalRecord(cwd);
        expect(isDenied(runHook(preToolScript, bash(cwd), 'PreToolUse'))).toBe(false);
    });
    it('denies a goal record whose objective does not match', () => {
        const cwd = makeProject('omg-goal-record-mismatch-');
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        writeGoalRecord(cwd, { objective: 'something else entirely' });
        const output = runHook(preToolScript, bash(cwd), 'PreToolUse');
        expect(isDenied(output)).toBe(true);
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('does not match');
    });
    it('keeps the Claude Code /goal guard unchanged: a goal record does not satisfy it', () => {
        const cwd = makeProject('omg-goal-record-claude-');
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        writeGoalRecord(cwd);
        const output = runHook(preToolScript, bash(cwd), null);
        expect(isDenied(output)).toBe(true);
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('[ULTRAGOAL /GOAL REQUIRED]');
    });
    it('accepts a native autopilot objective in the payload when the CLI exposes one', () => {
        const cwd = makeProject('omg-goal-native-');
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        const output = runHook(preToolScript, { ...bash(cwd), autopilot: { objective: OBJECTIVE, active: true } }, 'PreToolUse');
        expect(isDenied(output)).toBe(false);
    });
    it('lets the goal-start / goal-evidence commands and the skill file read through as bootstrap', () => {
        const cwd = makeProject('omg-goal-bootstrap-');
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        expect(isDenied(runHook(preToolScript, bash(cwd, 'omg ultragoal goal-start --criterion "tests pass"'), 'PreToolUse'))).toBe(false);
        expect(isDenied(runHook(preToolScript, bash(cwd, 'omg ultragoal goal-evidence --criterion C1 --evidence ok'), 'PreToolUse'))).toBe(false);
        const read = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd, tool_name: 'Read', tool_input: { path: join(ROOT, 'skills', 'ultragoal', 'SKILL.md') } };
        expect(isDenied(runHook(preToolScript, read, 'PreToolUse'))).toBe(false);
    });
    it('keeps continuing on Stop until every criterion has evidence', () => {
        const cwd = makeProject('omg-goal-stop-');
        writeModeState(cwd, PARENT, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        writeGoalRecord(cwd, { criteria: [{ id: 'C1', text: 'tests pass', evidence: 'npm test green' }, { id: 'C2', text: 'docs updated' }] });
        const stop = { ...fixture('stop-first.json', cwd), session_id: PARENT };
        const blocked = runHook(persistentModeScript, stop, 'Stop');
        expect(blocked.decision).toBe('block');
        expect(blocked.reason).toMatch(/^\[ULTRAGOAL #1\//);
        expect(blocked.reason).toContain('Missing evidence: C2 docs updated');
        expect(blocked.reason).not.toContain('Claude /goal');
        writeGoalRecord(cwd, { status: 'complete', criteria: [{ id: 'C1', text: 'tests pass', evidence: 'npm test green' }, { id: 'C2', text: 'docs updated', evidence: 'README' }] });
        expect(runHook(persistentModeScript, stop, 'Stop').decision).toBeUndefined();
    });
    const done = [{ id: 'C1', text: 'tests pass', evidence: 'npm test green' }];
    it('keeps continuing when the only complete record is for another objective (a previous run or story)', () => {
        const cwd = makeProject('omg-goal-stop-stale-');
        writeModeState(cwd, PARENT, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        writeGoalRecord(cwd, { objective: 'the previous story', status: 'complete', criteria: done });
        const output = runHook(persistentModeScript, { ...fixture('stop-first.json', cwd), session_id: PARENT }, 'Stop');
        expect(output.decision).toBe('block');
        expect(output.reason).toContain('No OMG goal record yet');
    });
    describe('multi-plan runs (plans/<id>/omg-goal.json)', () => {
        function writePlan(cwd, planId, objective) {
            const dir = join(cwd, '.omg', 'ultragoal', 'plans', planId);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'goals.json'), JSON.stringify({ version: 1, planId, claudeGoalMode: 'per_story', activeGoalId: 'G001', goals: [{ id: 'G001', objective, status: 'in_progress' }] }));
            return dir;
        }
        function writePlanRecord(dir, objective, overrides = {}) {
            const now = new Date().toISOString();
            writeFileSync(join(dir, 'omg-goal.json'), JSON.stringify({ version: 1, objective, status: 'active', host: 'copilot', createdAt: now, updatedAt: now, criteria: [{ id: 'C1', text: 'tests pass' }], ...overrides }));
        }
        it('accepts the record of a plan whose current story it matches, and rejects a stale one', () => {
            const cwd = makeProject('omg-goal-multiplan-');
            writeModeState(cwd, sessionId, 'ultragoal', { original_prompt: 'use ultragoal on both plans' });
            writePlan(cwd, 'p1', 'ship plan one');
            const p2 = writePlan(cwd, 'p2', 'ship plan two');
            expect(isDenied(runHook(preToolScript, bash(cwd), 'PreToolUse'))).toBe(true);
            writePlanRecord(p2, 'ship plan two');
            expect(isDenied(runHook(preToolScript, bash(cwd), 'PreToolUse'))).toBe(false);
            writePlanRecord(p2, 'an earlier story of plan two');
            expect(isDenied(runHook(preToolScript, bash(cwd), 'PreToolUse'))).toBe(true);
        });
        it('reads only the plan the ultragoal state names (plan_id)', () => {
            const cwd = makeProject('omg-goal-planid-');
            writeModeState(cwd, sessionId, 'ultragoal', { plan_id: 'p2' });
            writePlanRecord(writePlan(cwd, 'p1', 'ship plan one'), 'ship plan one');
            const p2 = writePlan(cwd, 'p2', 'ship plan two');
            const output = runHook(preToolScript, bash(cwd), 'PreToolUse');
            expect(isDenied(output)).toBe(true);
            expect(output.hookSpecificOutput.permissionDecisionReason).toContain('no OMG goal record exists yet');
            writePlanRecord(p2, 'ship plan two');
            expect(isDenied(runHook(preToolScript, bash(cwd), 'PreToolUse'))).toBe(false);
        });
        it('ends the Stop chain once the plan record has evidence for every criterion', () => {
            const cwd = makeProject('omg-goal-multiplan-stop-');
            writeModeState(cwd, PARENT, 'ultragoal', { plan_id: 'p2' });
            writePlan(cwd, 'p1', 'ship plan one');
            const p2 = writePlan(cwd, 'p2', 'ship plan two');
            const stop = { ...fixture('stop-first.json', cwd), session_id: PARENT };
            writePlanRecord(p2, 'ship plan two');
            expect(runHook(persistentModeScript, stop, 'Stop').reason).toContain('Missing evidence: C1 tests pass');
            writePlanRecord(p2, 'ship plan two', { status: 'complete', criteria: done });
            expect(runHook(persistentModeScript, stop, 'Stop').decision).toBeUndefined();
        });
        it('selects the plan_id plan record even when another plan has a newer, complete one', () => {
            const cwd = makeProject('omg-goal-planid-newer-');
            writeModeState(cwd, PARENT, 'ultragoal', { plan_id: 'p2' });
            writePlanRecord(writePlan(cwd, 'p2', 'ship plan two'), 'ship plan two', { updatedAt: '2026-01-01T00:00:00.000Z' });
            writePlanRecord(writePlan(cwd, 'p1', 'ship plan one'), 'ship plan one', { status: 'complete', criteria: done });
            const stop = { ...fixture('stop-first.json', cwd), session_id: PARENT };
            expect(runHook(persistentModeScript, stop, 'Stop').reason).toContain('Missing evidence: C1 tests pass');
            writeModeState(cwd, PARENT, 'ultragoal', {});
            // Without plan_id the scan takes the newest matching record (p1, complete).
            expect(runHook(persistentModeScript, stop, 'Stop').decision).toBeUndefined();
        });
    });
});
describe('chained continuation on Copilot', () => {
    it('blocks a chained Copilot Stop (stop_hook_active) while the mode cap allows it', () => {
        const cwd = makeProject('omg-chain-');
        writeModeState(cwd, '61b74574-b97a-4c2c-82f6-4d89613496df', 'ultragoal', { claude_goal_objective: OBJECTIVE, max_reinforcements: 10 });
        const stop = fixture('stop-chained.json', cwd);
        expect(stop.stop_hook_active).toBe(true);
        expect(runHook(persistentModeScript, stop, 'Stop').decision).toBe('block');
    });
    it('still lets a chained Stop end on Claude Code', () => {
        const cwd = makeProject('omg-chain-claude-');
        writeModeState(cwd, '61b74574-b97a-4c2c-82f6-4d89613496df', 'ultragoal', { claude_goal_objective: OBJECTIVE });
        expect(runHook(persistentModeScript, fixture('stop-chained.json', cwd), null).decision).toBeUndefined();
    });
    it('ends the chain at the stop-chain cap (default 3, OMC_COPILOT_STOP_CHAIN_MAX overrides)', () => {
        const cwd = makeProject('omg-chain-cap-');
        const sessionId = '61b74574-b97a-4c2c-82f6-4d89613496df';
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE, max_reinforcements: 50 });
        const stop = fixture('stop-chained.json', cwd);
        // Two continuations delivered; this chained Stop counts the third.
        writeFileSync(join(sessionDir(cwd, sessionId), 'copilot-stop-chain.json'), JSON.stringify({ count: 2 }));
        expect(runHook(persistentModeScript, stop, 'Stop').decision).toBeUndefined();
        expect(runHook(persistentModeScript, stop, 'Stop', { OMC_COPILOT_STOP_CHAIN_MAX: '5' }).decision).toBe('block');
    });
    it('honours the ultragoal reinforcement cap inside a chain', () => {
        const cwd = makeProject('omg-chain-ultragoal-cap-');
        writeModeState(cwd, '61b74574-b97a-4c2c-82f6-4d89613496df', 'ultragoal', { claude_goal_objective: OBJECTIVE, reinforcement_count: 2, max_reinforcements: 2 });
        expect(runHook(persistentModeScript, fixture('stop-chained.json', cwd), 'Stop').decision).toBeUndefined();
    });
    it('does not extend ralph past max_iterations inside a chain', () => {
        const cwd = makeProject('omg-chain-ralph-');
        const sessionId = '61b74574-b97a-4c2c-82f6-4d89613496df';
        writeModeState(cwd, sessionId, 'ralph', { iteration: 5, max_iterations: 5, prompt: 'fix it' });
        expect(runHook(persistentModeScript, fixture('stop-chained.json', cwd), 'Stop').decision).toBeUndefined();
        expect(readModeState(cwd, sessionId, 'ralph').max_iterations).toBe(5);
        // A first (unchained) Stop keeps the existing extend-and-continue behaviour.
        expect(runHook(persistentModeScript, fixture('stop-first.json', cwd), 'Stop').decision).toBe('block');
    });
    it('defers to Copilot native autopilot when the payload says it is on', () => {
        const cwd = makeProject('omg-chain-native-');
        writeModeState(cwd, '61b74574-b97a-4c2c-82f6-4d89613496df', 'ultragoal', { claude_goal_objective: OBJECTIVE });
        expect(runHook(persistentModeScript, { ...fixture('stop-first.json', cwd), mode: 'autopilot' }, 'Stop').decision).toBeUndefined();
    });
    it('caps the chain at 3 continuations from the Stop hook alone (keyword-detector never runs)', () => {
        const cwd = makeProject('omg-chain-count-');
        const sessionId = '61b74574-b97a-4c2c-82f6-4d89613496df';
        writeModeState(cwd, sessionId, 'ultragoal', { claude_goal_objective: OBJECTIVE, max_reinforcements: 50 });
        const first = fixture('stop-first.json', cwd);
        const chained = fixture('stop-chained.json', cwd);
        expect(first.stop_hook_active).not.toBe(true);
        const decisions = [first, chained, chained, chained].map((stop) => runHook(persistentModeScript, stop, 'Stop').decision);
        expect(decisions).toEqual(['block', 'block', 'block', undefined]);
        expect(chainCount(cwd, sessionId)).toBe(3);
        // The next genuine prompt's Stop starts a new chain.
        expect(runHook(persistentModeScript, first, 'Stop').decision).toBe('block');
        expect(chainCount(cwd, sessionId)).toBe(0);
    });
    it('leaves the chain count to the Stop hook: keyword-detector neither counts nor resets', () => {
        const cwd = makeProject('omg-chain-kd-');
        const sessionId = '61b74574-b97a-4c2c-82f6-4d89613496df';
        writeFileSync(join(sessionDir(cwd, sessionId), 'copilot-stop-chain.json'), JSON.stringify({ count: 2 }));
        const prompt = fixture('continuation-userpromptsubmit.json', cwd);
        runHook(keywordScript, { ...prompt, prompt: '[ULTRAGOAL #1/50] Ultragoal mode is active. Continue the durable goal workflow.' }, 'UserPromptSubmit');
        runHook(keywordScript, { ...prompt, prompt: 'thanks, now update the readme' }, 'UserPromptSubmit');
        expect(chainCount(cwd, sessionId)).toBe(2);
    });
});
describe('keyword detector ignores OMC continuation text on Copilot', () => {
    const sessionId = '61b74574-b97a-4c2c-82f6-4d89613496df';
    const reasons = [
        `[ULTRAGOAL #2/50] Ultragoal mode is active. Continue the durable goal workflow. When all ultragoal stories are complete and the final quality gate passes, run /oh-my-copilot:cancel to cleanly exit.\nGoal objective: use ultragoal to write a hello.txt file containing hi`,
        '[RALPH LOOP - ITERATION 3/100] Work is NOT done. Continue working.\nTask: use ralph to fix the autopilot tests',
        '[AUTOPILOT - Phase: execution] Autopilot not complete. Continue working. Run autopilot on the remaining items.',
        '[TOOL ERROR - RETRY REQUIRED]\nThe previous "Bash" operation failed.\n\n[ULTRAGOAL #4/50] Ultragoal mode is active.\nGoal objective: start ultragoal now',
    ];
    it.each(reasons)('does not arm a mode from %s', (reason) => {
        const cwd = makeProject('omg-kd-cont-');
        const output = runHook(keywordScript, { ...fixture('continuation-userpromptsubmit.json', cwd), prompt: reason }, 'UserPromptSubmit');
        expect(output.hookSpecificOutput).toBeUndefined();
        for (const mode of ['ultragoal', 'ralph', 'autopilot'])
            expect(readModeState(cwd, sessionId, mode)).toBeNull();
    });
    it.each(['ralplan', 'execution', 'ralph', 'qa'])('does not run keyword detection on the canonical %s pipeline stage prompt', (stageId) => {
        const cwd = makeProject('omg-kd-stage-');
        const prompt = resolveCanonicalWorkflowStagePrompt(stageId, 'use autopilot and ralph to ship the dashboard');
        expect(prompt).toMatch(/^## PIPELINE STAGE: /);
        const output = runHook(keywordScript, { ...fixture('continuation-userpromptsubmit.json', cwd), prompt }, 'UserPromptSubmit');
        expect(output.hookSpecificOutput).toBeUndefined();
        for (const mode of ['ultragoal', 'ralph', 'autopilot'])
            expect(readModeState(cwd, sessionId, mode)).toBeNull();
    });
    it('does not arm a mode from a Copilot subagent kickoff prompt', () => {
        const cwd = makeProject('omg-kd-kickoff-');
        const payload = fixture('subagent-kickoff-userpromptsubmit.json', cwd);
        const prompt = `${String(payload.prompt).split('\n\n')[0]}\n\nuse autopilot to build the dashboard`;
        runHook(keywordScript, { ...payload, prompt }, 'UserPromptSubmit');
        expect(readModeState(cwd, CHILD, 'autopilot')).toBeNull();
    });
    it.each(keywordScripts)('%s: a pasted ultragoal continuation does not re-arm ultragoal on Claude Code', (_name, scriptPath) => {
        const script = scriptPath();
        const cwd = makeProject('omg-kd-paste-');
        runHook(script, { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: reasons[0] }, null);
        expect(readModeState(cwd, sessionId, 'ultragoal')).toBeNull();
    });
});
describe('a question that only mentions a mode keyword does not arm it', () => {
    const sessionId = 'session-question';
    const QUESTION = 'what goals could we work on to improve the hooks, goal and autopilot ...?';
    it.each(keywordScripts)('%s: the reported question does not arm autopilot', (_name, scriptPath) => {
        const script = scriptPath();
        const cwd = makeProject('omg-kd-question-');
        runHook(script, { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: QUESTION }, null);
        expect(readModeState(cwd, sessionId, 'autopilot')).toBeNull();
    });
    it.each([
        ['autopilot build a todo app', 'autopilot'],
        ['can you run autopilot on this?', 'autopilot'],
        ['use ultragoal to write a hello.txt file containing hi', 'ultragoal'],
    ])('explicit invocation "%s" still arms %s', (prompt, mode) => {
        const cwd = makeProject('omg-kd-explicit-');
        runHook(keywordScript, { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt }, null);
        expect(readModeState(cwd, sessionId, mode)?.active).toBe(true);
    });
});
describe('Copilot subagents resolve the parent session guard', () => {
    it('applies the parent ultragoal guard to a subagent tool call linked by the parent events', () => {
        const cwd = makeProject('omg-subagent-');
        writeModeState(cwd, PARENT, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        writeParentEvents(PARENT);
        const childCall = fixture('subagent-child-pretooluse.json', cwd);
        expect(isDenied(runHook(preToolScript, childCall, 'PreToolUse'))).toBe(true);
        expect(JSON.parse(readFileSync(join(cwd, '.omg', 'state', 'sessions', CHILD, 'copilot-parent-session.json'), 'utf-8')).parent_session_id).toBe(PARENT);
        writeGoalRecord(cwd);
        expect(isDenied(runHook(preToolScript, childCall, 'PreToolUse'))).toBe(false);
    });
    it('uses a parent session field when the payload carries one', () => {
        const cwd = makeProject('omg-subagent-field-');
        writeModeState(cwd, PARENT, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        const childCall = { ...fixture('subagent-child-pretooluse.json', cwd), parent_session_id: PARENT };
        expect(isDenied(runHook(preToolScript, childCall, 'PreToolUse'))).toBe(true);
    });
    it('leaves an unlinked session alone (no reliable linkage, documented gap)', () => {
        const cwd = makeProject('omg-subagent-unlinked-');
        writeModeState(cwd, PARENT, 'ultragoal', { claude_goal_objective: OBJECTIVE });
        expect(isDenied(runHook(preToolScript, fixture('subagent-child-pretooluse.json', cwd), 'PreToolUse'))).toBe(false);
    });
});
//# sourceMappingURL=copilot-continuation-hooks.test.js.map