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
import { readUltragoalStateForHud, renderUltragoal } from '../../hud/elements/ultragoal.js';
import { renderCopilotMode } from '../../hud/elements/copilot-mode.js';
import { render } from '../../hud/render.js';
import {
  COPILOT_HOST_DEFAULTS,
  DEFAULT_HUD_CONFIG,
  PRESET_CONFIGS,
  type HudConfig,
  type HudRenderContext,
} from '../../hud/types.js';

const strip = (value: string | null): string | null => (value === null ? null : value.replace(/\x1b\[[0-9;]*m/g, ''));
const NOW = Date.parse('2026-10-27T10:00:00.000Z');

let project: string;

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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeTeam(
  name: string,
  workers: Array<{ name: string; state: string }>,
  tasks: Array<{ id: string; status: string; owner?: string }>,
  updatedAt = '2026-10-27T09:50:00.000Z',
): void {
  const root = join(getOmcRoot(project), 'state', 'team', name);
  writeJson(join(root, 'config.json'), {
    name,
    task: `${name} task`,
    created_at: updatedAt,
    workers: workers.map((worker) => ({ name: worker.name, role: 'executor' })),
  });
  for (const worker of workers) {
    writeJson(join(root, 'workers', worker.name, 'status.json'), { state: worker.state, updated_at: updatedAt });
  }
  for (const task of tasks) writeJson(join(root, 'tasks', `${task.id}.json`), task);
}

function goal(id: string, status: string): Record<string, unknown> {
  return { id, title: id, objective: id, status, attempt: 1, createdAt: 'x', updatedAt: 'x' };
}

function writePlan(path: string, goals: Array<Record<string, unknown>>, mtimeMs = NOW - 60_000): void {
  writeJson(path, { version: 1, createdAt: 'x', updatedAt: 'x', briefPath: 'b', goalsPath: 'g', ledgerPath: 'l', goals });
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe('team element', () => {
  it('summarises running/total workers and completed/total tasks', () => {
    writeTeam(
      'hud-fix',
      [
        { name: 'worker-1', state: 'working' },
        { name: 'worker-2', state: 'working' },
        { name: 'worker-3', state: 'working' },
        { name: 'worker-4', state: 'idle' },
      ],
      [
        ...['1', '2', '3', '4', '5'].map((id) => ({ id, status: 'completed' })),
        { id: '6', status: 'in_progress', owner: 'worker-1' },
        { id: '7', status: 'pending' },
        { id: '8', status: 'pending' },
        { id: '9', status: 'pending' },
      ],
    );
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

  it('returns null without ultragoal state', () => {
    expect(readUltragoalStateForHud(project, NOW)).toBeNull();
    expect(renderUltragoal(null)).toBeNull();
  });
});

describe('copilotMode element', () => {
  it('shows plan, autopilot and yolo, and hides interactive', () => {
    expect(strip(renderCopilotMode('plan', false))).toBe('plan');
    expect(strip(renderCopilotMode('autopilot', undefined))).toBe('autopilot');
    expect(strip(renderCopilotMode('interactive', true))).toBe('yolo');
    expect(strip(renderCopilotMode('autopilot', true))).toBe('autopilot yolo');
    expect(renderCopilotMode('interactive', false)).toBeNull();
    expect(renderCopilotMode(null, undefined)).toBeNull();
  });
});

describe('default visibility per host', () => {
  const baseContext: HudRenderContext = {
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
  const onlyNew = (elements: Partial<HudConfig['elements']>): HudConfig => ({
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
    expect(out).toBe('plan yolo | team:hud-fix 1/2w 0/3t | goal:1/4');
  });
});
