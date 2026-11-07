export type TeamLeaderNextAction =
  | 'answer-blocker'
  | 'reassign-capped'
  | 'shutdown'
  | 'reuse-current-team'
  | 'launch-new-team'
  | 'keep-checking-status';

export interface TeamLeaderGuidanceInput {
  tasks: {
    pending: number;
    blocked: number;
    inProgress: number;
    completed: number;
    failed: number;
    /** Terminal: the owning SDK worker hit its credit cap (`team.sdk.maxCreditsPerWorker`). */
    capped?: number;
  };
  workers: {
    total: number;
    alive: number;
    idle: number;
    nonReporting: number;
  };
  /** Worker messages to the leader that nobody answered yet (blockers, questions). */
  leaderInbox?: {
    unread: number;
  };
}

export interface TeamLeaderGuidance {
  nextAction: TeamLeaderNextAction;
  reason: string;
  message: string;
}

function activeTaskCount(input: TeamLeaderGuidanceInput): number {
  return input.tasks.pending + input.tasks.blocked + input.tasks.inProgress;
}

export function deriveTeamLeaderGuidance(input: TeamLeaderGuidanceInput): TeamLeaderGuidance {
  const activeTasks = activeTaskCount(input);
  const totalWorkers = Math.max(0, input.workers.total);
  const aliveWorkers = Math.max(0, input.workers.alive);
  const idleWorkers = Math.max(0, input.workers.idle);
  const nonReportingWorkers = Math.max(0, input.workers.nonReporting);
  const cappedTasks = Math.max(0, input.tasks.capped ?? 0);
  const unreadLeaderMessages = Math.max(0, input.leaderInbox?.unread ?? 0);

  // A worker waiting on the leader is not stuck: replacing it would throw
  // away a correct wait, so an unanswered message outranks relaunch advice.
  if (unreadLeaderMessages > 0 && activeTasks > 0) {
    return {
      nextAction: 'answer-blocker',
      reason: `leader_inbox_unread:unread=${unreadLeaderMessages},active=${activeTasks}`,
      message:
        'A worker is waiting for the leader. Read leader_inbox, then reply with `omg team api send-message --input \'{"team_name":"<team>","from_worker":"leader-fixed","to_worker":"<worker>","body":"<answer>"}\' --json`.',
    };
  }

  if (cappedTasks > 0) {
    return {
      nextAction: 'reassign-capped',
      reason: `tasks_capped:capped=${cappedTasks},active=${activeTasks}`,
      message:
        'A worker hit its sdk credit cap and its task is `capped`; its uncommitted work stays where the task error says. Reassign the work (a new task or team), or raise team.sdk.maxCreditsPerWorker and relaunch. Shutdown is allowed once nothing is active.',
    };
  }

  if (activeTasks === 0) {
    return {
      nextAction: 'shutdown',
      reason: `all_tasks_terminal:completed=${input.tasks.completed},failed=${input.tasks.failed},workers=${totalWorkers}`,
      message:
        'All tasks are in a terminal state. Review any failures, then shut down or clean up the current team.',
    };
  }

  if (aliveWorkers === 0) {
    return {
      nextAction: 'launch-new-team',
      reason: `no_alive_workers:active=${activeTasks},total_workers=${totalWorkers}`,
      message:
        'Active tasks remain, but no workers appear alive. Launch a new team or replace the dead workers.',
    };
  }

  if (idleWorkers >= aliveWorkers) {
    return {
      nextAction: 'reuse-current-team',
      reason: `all_alive_workers_idle:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers}`,
      message:
        'Workers are idle while active tasks remain. Reuse the current team and reassign, unblock, or restart the pending work.',
    };
  }

  if (nonReportingWorkers >= aliveWorkers) {
    return {
      nextAction: 'launch-new-team',
      reason: `all_alive_workers_non_reporting:active=${activeTasks},alive=${aliveWorkers},non_reporting=${nonReportingWorkers}`,
      message:
        'Workers are still marked alive, but none are reporting progress. Launch a replacement team or restart the stuck workers.',
    };
  }

  return {
    nextAction: 'keep-checking-status',
    reason: `workers_still_active:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers},non_reporting=${nonReportingWorkers}`,
    message:
      'Workers still appear active. Keep checking team status before intervening.',
  };
}
