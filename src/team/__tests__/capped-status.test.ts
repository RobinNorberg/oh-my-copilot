/**
 * The terminal `capped` task status (D3): the contract treats it as terminal
 * and reachable only from in_progress, and the mission board shows it as
 * blocked (it waits on a leader decision).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TEAM_TASK_STATUSES,
  canTransitionTeamTaskStatus,
  isTerminalTeamTaskStatus,
} from '../contracts.js';
import { readTeamMissions } from '../../hud/mission-board.js';

describe('capped task status contract', () => {
  it('is a known terminal status reachable only from in_progress', () => {
    expect(TEAM_TASK_STATUSES).toContain('capped');
    expect(isTerminalTeamTaskStatus('capped')).toBe(true);
    expect(canTransitionTeamTaskStatus('in_progress', 'capped')).toBe(true);
    expect(canTransitionTeamTaskStatus('pending', 'capped')).toBe(false);
    expect(canTransitionTeamTaskStatus('capped', 'in_progress')).toBe(false);
    expect(canTransitionTeamTaskStatus('capped', 'completed')).toBe(false);
  });
});

describe('mission board with a capped task', () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('counts the capped task as blocked and marks the team blocked', () => {
    dir = mkdtempSync(join(tmpdir(), 'omc-capped-mission-'));
    // The board resolves the state root from the environment: pin it to dir.
    vi.stubEnv('OMC_STATE_DIR', '');
    vi.stubEnv('OMC_DISABLE_MULTIREPO', '1');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    const teamRoot = join(dir, '.omg', 'state', 'team', 'demo');
    mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: 'demo', task: 'demo', created_at: new Date().toISOString(),
      workers: [{ name: 'worker-1', role: 'executor', assigned_tasks: ['1', '2'] }],
    }));
    writeFileSync(join(teamRoot, 'tasks', '1.json'), JSON.stringify({ id: '1', subject: 'done', status: 'completed', owner: 'worker-1' }));
    writeFileSync(join(teamRoot, 'tasks', '2.json'), JSON.stringify({ id: '2', subject: 'capped', status: 'capped', owner: 'worker-1', error: 'sdk_credit_cap' }));

    const mission = readTeamMissions(dir).find((entry) => entry.name === 'demo');

    expect(mission?.taskCounts).toMatchObject({ total: 2, blocked: 1, completed: 1, failed: 0 });
    expect(mission?.status).toBe('blocked');
  });
});

describe('worker team api and the capped status', () => {
  it('rejects a worker transition to capped: only the monitor caps a task', async () => {
    const { executeTeamApiOperation } = await import('../api-interop.js');
    const result = await executeTeamApiOperation('transition-task-status', {
      team_name: 'demo-team', task_id: '1', from: 'in_progress', to: 'capped', claim_token: 'tok',
    }, tmpdir());
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: 'invalid_input', message: expect.stringContaining('to=capped') } });
  });
});
