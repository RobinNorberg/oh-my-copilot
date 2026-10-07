import { describe, it, expect, beforeEach, vi } from 'vitest';

const runtimeV2Mocks = vi.hoisted(() => ({
  isRuntimeV2Enabled: vi.fn(),
  monitorTeamV2: vi.fn(),
  findActiveTeamsV2: vi.fn(),
}));

const monitorMocks = vi.hoisted(() => ({
  readTeamConfig: vi.fn(),
}));

const eventsMocks = vi.hoisted(() => ({
  readTeamEventsByType: vi.fn(),
}));

vi.mock('../../../team/runtime-v2.js', () => runtimeV2Mocks);
vi.mock('../../../team/monitor.js', () => monitorMocks);
vi.mock('../../../team/events.js', () => eventsMocks);

const { teamCommand } = await import('../team.js');

/** Capture console.log output during a callback, stripped of ANSI escapes. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

const baseSnapshot = {
  teamName: 'demo-team',
  phase: 'running',
  workers: [
    {
      name: 'worker-1',
      alive: true,
      providerLiveness: 'alive' as const,
      status: { state: 'working', current_task_id: '1' },
      sdk: {
        state: 'ready',
        turns: 3,
        queued: 0,
        last_event_type: 'turn_complete',
        last_event_at: '2026-10-06T00:00:00.000Z',
        last_error: null,
        credits: 1.25,
        premium_requests: 2,
        premium_requests_final: false,
        model: 'claude-sonnet-5',
        host_pid: 4242,
        runtime_pid: 4343,
        session_id: 'sess-1',
        attempt_id: 'attempt-1',
        updated_at: '2026-10-06T00:00:01.000Z',
      },
    },
  ],
  nonReportingWorkers: [],
  tasks: { total: 2, pending: 1, blocked: 0, in_progress: 0, completed: 1, failed: 0 },
};

const baseConfig = {
  instance_id: 'inst-123',
  tmux_session: 'sdk:demo-team',
  workspace_mode: 'single',
  worktree_mode: 'disabled',
  team_state_root: '/repo/.omg/state/team/demo-team',
  workers: [
    {
      name: 'worker-1',
      working_dir: '/repo',
      worktree_repo_root: null,
      worktree_path: null,
      worktree_branch: null,
      worktree_detached: false,
      worktree_created: false,
    },
  ],
};

describe('omg team status --json', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeV2Mocks.isRuntimeV2Enabled.mockReturnValue(true);
    eventsMocks.readTeamEventsByType.mockResolvedValue([]);
    process.exitCode = 0;
  });

  it('parses as JSON with no ANSI codes and includes sdk worker fields', async () => {
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue(baseSnapshot);
    monitorMocks.readTeamConfig.mockResolvedValue(baseConfig);

    const logs = await captureLog(() => teamCommand(['status', 'demo-team', '--json']));

    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(ANSI_PATTERN);
    const status = JSON.parse(logs[0]);

    expect(status.ok).toBe(true);
    expect(status.team).toBe('demo-team');
    expect(status.instance_id).toBe('inst-123');
    expect(status.phase).toBe('running');
    expect(status.transport).toBe('sdk');
    expect(status.tasks).toMatchObject({ total: 2, pending: 1, completed: 1 });
    expect(status.workers.sdk).toEqual([
      expect.objectContaining({
        name: 'worker-1',
        provider: 'alive',
        state: 'ready',
        turns: 3,
        premium_requests: 2,
        premium_requests_final: false,
        credits: 1.25,
        model: 'claude-sonnet-5',
        host_pid: 4242,
        runtime_pid: 4343,
        session_id: 'sess-1',
        attempt_id: 'attempt-1',
        updated_at: '2026-10-06T00:00:01.000Z',
        last_event_at: '2026-10-06T00:00:00.000Z',
        task_state: 'working',
        current_task_id: '1',
      }),
    ]);
  });

  it('reports the pane transport for a multiplexer team', async () => {
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue({ ...baseSnapshot, workers: [] });
    monitorMocks.readTeamConfig.mockResolvedValue({ ...baseConfig, tmux_session: 'omc-team-demo' });

    const status = JSON.parse((await captureLog(() => teamCommand(['status', 'demo-team', '--json'])))[0]);
    expect(status.transport).toBe('pane');
    expect(status.workers.sdk).toEqual([]);
  });

  it('prints the host pid and session id on the human sdk_worker line', async () => {
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue(baseSnapshot);
    monitorMocks.readTeamConfig.mockResolvedValue(baseConfig);

    const logs = await captureLog(() => teamCommand(['status', 'demo-team']));
    expect(logs.find((line) => line.startsWith('sdk_worker='))).toMatch(/host_pid=4242 session=sess-1 state=ready/);
  });

  it('accepts --json before the team name', async () => {
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue(baseSnapshot);
    monitorMocks.readTeamConfig.mockResolvedValue(baseConfig);

    const logs = await captureLog(() => teamCommand(['status', '--json', 'demo-team']));

    const status = JSON.parse(logs[0]);
    expect(status.team).toBe('demo-team');
  });

  it('never treats --json as the team name', async () => {
    runtimeV2Mocks.findActiveTeamsV2.mockResolvedValue([]);

    await expect(teamCommand(['status', '--json'])).rejects.toThrow('Usage: omg team status');
    expect(runtimeV2Mocks.monitorTeamV2).not.toHaveBeenCalledWith('--json', expect.anything());
  });

  it('resolves the team name automatically when exactly one team is active', async () => {
    runtimeV2Mocks.findActiveTeamsV2.mockResolvedValue(['only-team']);
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue({ ...baseSnapshot, teamName: 'only-team' });
    monitorMocks.readTeamConfig.mockResolvedValue(baseConfig);

    const logs = await captureLog(() => teamCommand(['status', '--json']));

    const status = JSON.parse(logs[0]);
    expect(status.team).toBe('only-team');
    expect(runtimeV2Mocks.monitorTeamV2).toHaveBeenCalledWith('only-team', expect.anything());
  });

  it('reports a clean JSON error when no team state is found', async () => {
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue(null);

    const logs = await captureLog(() => teamCommand(['status', 'ghost-team', '--json']));

    expect(logs[0]).not.toMatch(ANSI_PATTERN);
    const status = JSON.parse(logs[0]);
    expect(status.ok).toBe(false);
    expect(status.team).toBe('ghost-team');
  });

  it('keeps human-readable output as plain text (not JSON) without --json', async () => {
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue(baseSnapshot);
    monitorMocks.readTeamConfig.mockResolvedValue(baseConfig);

    const logs = await captureLog(() => teamCommand(['status', 'demo-team']));

    expect(logs[0]).toContain('team=demo-team');
    expect(() => JSON.parse(logs[0])).toThrow();
  });
});
