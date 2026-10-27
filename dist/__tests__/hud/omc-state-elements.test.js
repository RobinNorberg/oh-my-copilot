/**
 * Lane C elements: team, ultragoal and copilotMode. Readers run against real
 * `.omg` trees in a temp dir; renderers and their default visibility per host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { readTeamStateForHud, renderTeam } from '../../hud/elements/team.js';
import { readTeamMissions } from '../../hud/mission-board.js';
import { readUltragoalStateForHud, renderUltragoal } from '../../hud/elements/ultragoal.js';
import { renderCopilotMode } from '../../hud/elements/copilot-mode.js';
import { render } from '../../hud/render.js';
import { COPILOT_HOST_DEFAULTS, DEFAULT_HUD_CONFIG, PRESET_CONFIGS, } from '../../hud/types.js';
const strip = (value) => (value === null ? null : value.replace(/\x1b\[[0-9;]*m/g, ''));
const NOW = Date.parse('2026-10-27T10:00:00.000Z');
let project;
beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'hud-lane-c-'));
    // A non-git dir resolves its .omg root to the user's home: keep state here.
    execFileSync('git', ['init', '-q'], { cwd: project });
    if (process.env.OMC_STATE_DIR || resolve(getOmcRoot(project)) === resolve(homedir(), '.omg')) {
        throw new Error(`refusing to write test state outside the temp project: ${getOmcRoot(project)}`);
    }
});
afterEach(() => {
    rmSync(project, { recursive: true, force: true });
});
function writeJson(path, value) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
}
function writeTeam(name, workers, tasks, updatedAt = '2026-10-27T09:50:00.000Z') {
    const root = join(getOmcRoot(project), 'state', 'team', name);
    writeJson(join(root, 'config.json'), {
        name,
        task: `${name} task`,
        created_at: updatedAt,
        workers: workers.map((worker) => ({ name: worker.name, role: 'executor' })),
    });
    for (const worker of workers) {
        writeJson(join(root, 'workers', worker.name, 'status.json'), { state: worker.state, updated_at: updatedAt });
        setMtime(join(root, 'workers', worker.name, 'status.json'), Date.parse(updatedAt));
    }
    for (const task of tasks)
        writeJson(join(root, 'tasks', `${task.id}.json`), task);
    // The reader skips dirs by mtime against NOW, so pin it to the team's own clock.
    setMtime(join(root, 'config.json'), Date.parse(updatedAt));
}
function setMtime(path, mtimeMs) {
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}
function goal(id, status) {
    return { id, title: id, objective: id, status, attempt: 1, createdAt: 'x', updatedAt: 'x' };
}
function writePlan(path, goals, mtimeMs = NOW - 60_000) {
    writeJson(path, { version: 1, createdAt: 'x', updatedAt: 'x', briefPath: 'b', goalsPath: 'g', ledgerPath: 'l', goals });
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}
describe('team element', () => {
    it('summarises running/total workers and completed/total tasks', () => {
        writeTeam('hud-fix', [
            { name: 'worker-1', state: 'working' },
            { name: 'worker-2', state: 'working' },
            { name: 'worker-3', state: 'working' },
            { name: 'worker-4', state: 'idle' },
        ], [
            ...['1', '2', '3', '4', '5'].map((id) => ({ id, status: 'completed' })),
            { id: '6', status: 'in_progress', owner: 'worker-1' },
            { id: '7', status: 'pending' },
            { id: '8', status: 'pending' },
            { id: '9', status: 'pending' },
        ]);
        const state = readTeamStateForHud(project, NOW);
        expect(state).toMatchObject({ name: 'hud-fix', runningWorkers: 3, workerCount: 4, completedTasks: 5, totalTasks: 9, otherTeams: 0 });
        expect(strip(renderTeam(state))).toBe('team:hud-fix 3/4w 5/9t');
    });
    it('hides done and stale teams, prefers running, and counts other live teams', () => {
        writeTeam('finished', [{ name: 'w', state: 'done' }], [{ id: '1', status: 'completed' }]);
        writeTeam('abandoned', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }], '2026-10-27T05:00:00.000Z');
        writeTeam('queued', [{ name: 'w', state: 'idle' }], [{ id: '1', status: 'pending' }]);
        writeTeam('busy', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }]);
        expect(strip(renderTeam(readTeamStateForHud(project, NOW)))).toBe('team:busy 1/1w 0/1t +1');
    });
    it('marks a blocked team and returns null without team state', () => {
        expect(readTeamStateForHud(project, NOW)).toBeNull();
        writeTeam('stuck', [{ name: 'w', state: 'blocked' }], [{ id: '1', status: 'blocked' }]);
        expect(strip(renderTeam(readTeamStateForHud(project, NOW)))).toBe('team:stuck 0/1w 0/1t blocked');
        expect(renderTeam(null)).toBeNull();
    });
    it('never throws on corrupt config, tasks or events, and drops only the broken team', () => {
        const teams = join(getOmcRoot(project), 'state', 'team');
        // Corrupt entries inside an otherwise readable team are ignored.
        writeTeam('healthy', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress', owner: 'w' }]);
        writeJson(join(teams, 'healthy', 'tasks', '2.json'), null);
        writeJson(join(teams, 'healthy', 'tasks', '3.json'), 'not a task');
        writeJson(join(teams, 'healthy', 'tasks', '4.json'), { id: '4', status: 5 });
        writeFileSync(join(teams, 'healthy', 'events.jsonl'), 'null\n');
        setMtime(join(teams, 'healthy', 'events.jsonl'), NOW - 60_000);
        // Configs that are not objects, or hold non-object workers.
        writeJson(join(teams, 'scalar-config', 'config.json'), 5);
        writeJson(join(teams, 'null-workers', 'config.json'), { name: 'null-workers', created_at: '2026-10-27T09:00:00.000Z', workers: [null, 7, 'x'] });
        mkdirSync(join(teams, 'bad-json'), { recursive: true });
        writeFileSync(join(teams, 'bad-json', 'config.json'), '{not json');
        // A mailbox whose messages is not iterable throws inside the collector.
        writeTeam('broken-mailbox', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress', owner: 'w' }]);
        writeJson(join(teams, 'broken-mailbox', 'mailbox', 'w.json'), { messages: {} });
        for (const dir of ['scalar-config', 'null-workers'])
            setMtime(join(teams, dir, 'config.json'), NOW - 60_000);
        setMtime(join(teams, 'bad-json', 'config.json'), NOW - 60_000);
        const state = readTeamStateForHud(project, NOW);
        expect(state).toMatchObject({ name: 'healthy', runningWorkers: 1, workerCount: 1, completedTasks: 0, totalTasks: 2 });
        // null-workers is a live team with no workers or tasks: waiting, so it counts as another team.
        expect(state?.otherTeams).toBe(2);
        expect(readTeamMissions(project).map((mission) => mission.name).sort()).toEqual(['healthy', 'null-workers', 'scalar-config']);
    });
    it('skips team dirs whose config.json and events.jsonl are both older than 2 hours', () => {
        const teams = join(getOmcRoot(project), 'state', 'team');
        // created_at says live, but the files are old: skipped before collecting.
        writeTeam('old-files', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }]);
        setMtime(join(teams, 'old-files', 'config.json'), NOW - 3 * 60 * 60 * 1000);
        setMtime(join(teams, 'old-files', 'workers', 'w', 'status.json'), NOW - 3 * 60 * 60 * 1000);
        // Old config but a fresh events.jsonl: still read.
        writeTeam('fresh-events', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }]);
        setMtime(join(teams, 'fresh-events', 'config.json'), NOW - 3 * 60 * 60 * 1000);
        setMtime(join(teams, 'fresh-events', 'workers', 'w', 'status.json'), NOW - 3 * 60 * 60 * 1000);
        writeFileSync(join(teams, 'fresh-events', 'events.jsonl'), '');
        setMtime(join(teams, 'fresh-events', 'events.jsonl'), NOW - 60_000);
        expect(readTeamMissions(project, undefined, 2 * 60 * 60 * 1000, NOW).map((mission) => mission.name)).toEqual(['fresh-events']);
        expect(strip(renderTeam(readTeamStateForHud(project, NOW)))).toBe('team:fresh-events 1/1w 0/1t');
        // Without the window the board still sees both.
        expect(readTeamMissions(project).map((mission) => mission.name).sort()).toEqual(['fresh-events', 'old-files']);
    });
    it('keeps a long-running team visible when only a worker heartbeat or sdk-events.jsonl is fresh', () => {
        const teams = join(getOmcRoot(project), 'state', 'team');
        const old = NOW - 3 * 60 * 60 * 1000;
        writeTeam('heartbeat', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }]);
        writeJson(join(teams, 'heartbeat', 'workers', 'w', 'heartbeat.json'), { alive: true });
        writeTeam('sdk-log', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }]);
        writeFileSync(join(teams, 'sdk-log', 'sdk-events.jsonl'), '');
        writeTeam('idle-old', [{ name: 'w', state: 'working' }], [{ id: '1', status: 'in_progress' }]);
        for (const dir of ['heartbeat', 'sdk-log', 'idle-old']) {
            setMtime(join(teams, dir, 'config.json'), old);
            setMtime(join(teams, dir, 'workers', 'w', 'status.json'), old);
        }
        setMtime(join(teams, 'heartbeat', 'workers', 'w', 'heartbeat.json'), NOW - 60_000);
        setMtime(join(teams, 'sdk-log', 'sdk-events.jsonl'), NOW - 60_000);
        expect(readTeamMissions(project, undefined, 2 * 60 * 60 * 1000, NOW).map((mission) => mission.name).sort()).toEqual(['heartbeat', 'sdk-log']);
    });
    it('dates a team without created_at or events by its config.json mtime, so it goes stale', () => {
        const configPath = join(getOmcRoot(project), 'state', 'team', 'dead', 'config.json');
        writeJson(configPath, { name: 'dead', workers: [{ name: 'w' }] });
        writeJson(join(getOmcRoot(project), 'state', 'team', 'dead', 'tasks', '1.json'), { id: '1', status: 'pending' });
        const mtimeMs = NOW - 3 * 60 * 60 * 1000;
        setMtime(configPath, mtimeMs);
        const [mission] = readTeamMissions(project);
        expect(mission?.createdAt).toBe(new Date(mtimeMs).toISOString());
        expect(mission?.updatedAt).toBe(new Date(mtimeMs).toISOString());
        expect(readTeamStateForHud(project, NOW)).toBeNull();
    });
});
describe('ultragoal element', () => {
    it('renders complete/total for the open legacy plan', () => {
        writePlan(join(getOmcRoot(project), 'ultragoal', 'goals.json'), [
            goal('G1', 'complete'), goal('G2', 'complete'), goal('G3', 'in_progress'), goal('G4', 'pending'), goal('G5', 'pending'),
        ]);
        const state = readUltragoalStateForHud(project, NOW);
        expect(state).toEqual({ complete: 2, total: 5, failed: 0 });
        expect(strip(renderUltragoal(state))).toBe('goal:2/5');
    });
    it('picks the newest open plan under plans/ and skips done, stale and invalid ones', () => {
        const plans = join(getOmcRoot(project), 'ultragoal', 'plans');
        writePlan(join(plans, 'a-done', 'goals.json'), [goal('G1', 'complete')], NOW - 1_000);
        writePlan(join(plans, 'b-stale', 'goals.json'), [goal('G1', 'pending')], NOW - 25 * 60 * 60 * 1000);
        writePlan(join(plans, 'c-old', 'goals.json'), [goal('G1', 'complete'), goal('G2', 'pending')], NOW - 30 * 60_000);
        writePlan(join(plans, 'd-new', 'goals.json'), [goal('G1', 'failed'), goal('G2', 'pending'), goal('G3', 'pending')], NOW - 5 * 60_000);
        writeJson(join(plans, 'e-broken', 'goals.json'), { version: 2 });
        expect(readUltragoalStateForHud(project, NOW)).toEqual({ complete: 0, total: 3, failed: 1 });
    });
    it('never throws on corrupt goals: null entries, wrong types and non-objects', () => {
        const path = join(getOmcRoot(project), 'ultragoal', 'goals.json');
        writePlan(path, [null, 5, 'goal', [], { id: 'G0', status: 3 }, goal('G1', 'complete'), goal('G2', 'pending')]);
        expect(readUltragoalStateForHud(project, NOW)).toEqual({ complete: 1, total: 2, failed: 0 });
        // Nothing valid left: no plan to show.
        writePlan(path, [null, { status: null }]);
        expect(readUltragoalStateForHud(project, NOW)).toBeNull();
        // The whole file is not a plan object.
        for (const value of [null, 'plan', 7, [], { version: 1, goals: 'x' }]) {
            writeJson(path, value);
            expect(() => readUltragoalStateForHud(project, NOW)).not.toThrow();
            expect(readUltragoalStateForHud(project, NOW)).toBeNull();
        }
    });
    it('returns null without ultragoal state', () => {
        expect(readUltragoalStateForHud(project, NOW)).toBeNull();
        expect(renderUltragoal(null)).toBeNull();
    });
});
describe('copilotMode element', () => {
    it('shows mode:plan, mode:autopilot and mode:yolo, and hides interactive', () => {
        expect(strip(renderCopilotMode('plan', false))).toBe('mode:plan');
        expect(strip(renderCopilotMode('autopilot', undefined))).toBe('mode:autopilot');
        expect(strip(renderCopilotMode('interactive', true))).toBe('mode:yolo');
        expect(strip(renderCopilotMode('autopilot', true))).toBe('mode:autopilot+yolo');
        expect(renderCopilotMode('interactive', false)).toBeNull();
        expect(renderCopilotMode(null, undefined)).toBeNull();
    });
});
describe('default visibility per host', () => {
    const baseContext = {
        contextPercent: 0,
        modelName: null,
        ralph: null,
        ultrawork: null,
        prd: null,
        autopilot: null,
        activeAgents: [],
        todos: [],
        backgroundTasks: [],
        cwd: '/nonexistent/hud-lane-c',
        lastSkill: null,
        rateLimitsResult: null,
        customBuckets: null,
        pendingPermission: null,
        thinkingState: null,
        sessionHealth: null,
        omcVersion: null,
        updateAvailable: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        promptTime: null,
        apiKeySource: null,
        profileName: null,
        sessionSummary: null,
        copilotMode: 'plan',
        copilotAllowAll: true,
        team: { name: 'hud-fix', status: 'running', runningWorkers: 1, workerCount: 2, completedTasks: 0, totalTasks: 3, otherTeams: 0 },
        ultragoal: { complete: 1, total: 4, failed: 0 },
    };
    const onlyNew = (elements) => ({
        ...DEFAULT_HUD_CONFIG,
        elements: { ...DEFAULT_HUD_CONFIG.elements, omcLabel: false, contextBar: false, ...elements },
    });
    it('is off under Claude in the defaults and every preset', () => {
        for (const elements of [DEFAULT_HUD_CONFIG.elements, ...Object.values(PRESET_CONFIGS)]) {
            expect(elements.copilotMode).toBeUndefined();
            expect(elements.team).toBeUndefined();
            expect(elements.ultragoal).toBeUndefined();
        }
    });
    it('renders nothing under Claude by default, and renders when the user opts in', async () => {
        expect(await render({ ...baseContext, host: 'claude' }, onlyNew({}))).toBe('');
        const optedIn = strip(await render({ ...baseContext, host: 'claude' }, onlyNew({ team: true, ultragoal: true })));
        expect(optedIn).toBe('team:hud-fix 1/2w 0/3t | goal:1/4');
    });
    it('is on under Copilot through the host defaults, in layout order', async () => {
        const out = strip(await render({ ...baseContext, host: 'copilot' }, onlyNew(COPILOT_HOST_DEFAULTS)));
        expect(out).toBe('mode:plan+yolo | team:hud-fix 1/2w 0/3t | goal:1/4');
    });
    it('drops only a throwing element and still renders the rest of the line', async () => {
        const throwingTeam = {
            get name() {
                throw new Error('corrupt team state');
            },
        };
        const out = strip(await render({ ...baseContext, host: 'copilot', team: throwingTeam }, onlyNew(COPILOT_HOST_DEFAULTS)));
        expect(out).toBe('mode:plan+yolo | goal:1/4');
    });
});
//# sourceMappingURL=omc-state-elements.test.js.map