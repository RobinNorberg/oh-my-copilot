/**
 * `omg team` start and shutdown output (F6, F7, F14): the SDK transport line,
 * a graceful shutdown that names failed/capped tasks, and exit 3 with the
 * preserved worktrees named when a dirty worktree is kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const INSTANCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const runtimeV2Mocks = vi.hoisted(() => ({
  isRuntimeV2Enabled: vi.fn(() => true),
  startTeamV2: vi.fn(),
  monitorTeamV2: vi.fn(),
  findActiveTeamsV2: vi.fn(async () => []),
  shutdownTeamV2: vi.fn(),
  cleanupStaleReservations: vi.fn(async () => undefined),
}));

const monitorMocks = vi.hoisted(() => ({
  readTeamConfig: vi.fn(async () => ({ instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
}));

const teamOpsMocks = vi.hoisted(() => ({
  teamListTasks: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('../../../team/runtime-v2.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../team/runtime-v2.js')>(),
  ...runtimeV2Mocks,
}));

vi.mock('../../../team/monitor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../team/monitor.js')>(),
  readTeamConfig: monitorMocks.readTeamConfig,
}));

vi.mock('../../../team/team-ops.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../team/team-ops.js')>(),
  teamListTasks: teamOpsMocks.teamListTasks,
}));

vi.mock('../../../agents/utils.js', () => ({
  loadAgentPrompt: vi.fn((role: string) => `prompt:${role}`),
}));

describe('omg team lifecycle output', () => {
  const originalCwd = process.cwd();
  let cwd: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omc-team-lifecycle-output-'));
    process.chdir(cwd);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    runtimeV2Mocks.monitorTeamV2.mockResolvedValue({
      teamName: 'demo', phase: 'executing', workers: [], nonReportingWorkers: [], leaderInbox: [],
      tasks: { total: 1, pending: 0, blocked: 0, in_progress: 1, completed: 0, failed: 0, capped: 0, items: [] },
    });
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it.each([
    ['sdk:demo', 'transport: sdk (headless)'],
    ['omc-team-demo', 'tmux session: omc-team-demo'],
  ])('prints the transport for session %s on start', async (sessionName, expected) => {
    runtimeV2Mocks.startTeamV2.mockResolvedValue({
      teamName: 'demo', sessionName, instanceId: INSTANCE_ID, config: { worker_count: 1 }, startupFailures: [],
    });
    const { teamCommand } = await import('../team.js');

    await teamCommand(['1:claude:executor', 'reply with exactly: PONG']);

    expect(logs).toContain(expected);
    expect(logs.some((line) => line.startsWith('tmux session: sdk:'))).toBe(false);
  });

  it('shuts down gracefully with failed and capped tasks and names them', async () => {
    teamOpsMocks.teamListTasks.mockResolvedValue([
      { id: '1', status: 'completed' },
      { id: '2', status: 'failed' },
      { id: '3', status: 'capped' },
    ]);
    runtimeV2Mocks.shutdownTeamV2.mockResolvedValue({ outcome: 'cleaned' });
    const { teamCommand } = await import('../team.js');

    await teamCommand(['shutdown', 'demo']);

    expect(logs).toContain('shutdown with 2 failed or capped task(s): task-2 (failed) task-3 (capped)');
    expect(logs).toContain('Team shutdown complete: demo');
    expect(process.exitCode).toBe(0);
  });

  it('names the kept dirty worktrees and exits 3 when shutdown preserves them', async () => {
    runtimeV2Mocks.shutdownTeamV2.mockResolvedValue({
      outcome: 'preserved',
      reason: 'worktrees_preserved',
      workers: ['worker-1'],
      worktrees: [{ workerName: 'worker-1', path: '/repo/.omg/worktrees/demo/worker-1', reason: 'dirty_worktree' }],
    });
    const { teamCommand } = await import('../team.js');

    await teamCommand(['shutdown', 'demo']);

    expect(errors).toContain('preserved_worktree=/repo/.omg/worktrees/demo/worker-1 worker=worker-1 reason=dirty_worktree');
    expect(errors.some((line) => line.includes('workers: worker-1') && line.includes('omg team shutdown demo'))).toBe(true);
    expect(process.exitCode).toBe(3);
  });

  it('still fails other preserved outcomes', async () => {
    runtimeV2Mocks.shutdownTeamV2.mockResolvedValue({ outcome: 'preserved', reason: 'worker_panes_alive', workers: ['worker-1'] });
    const { teamCommand } = await import('../team.js');

    await teamCommand(['shutdown', 'demo']);

    expect(errors.join(' ')).toContain('Team shutdown preserved: worker_panes_alive:worker-1');
    expect(process.exitCode).toBe(1);
  });
});
