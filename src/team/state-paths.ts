import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';

/**
 * Typed path builders for all team state files.
 * All paths are relative to cwd.
 *
 * State layout:
 *   .omg/state/team/{teamName}/
 *     config.json
 *     shutdown.json
 *     tasks/
 *       task-{taskId}.json
 *     workers/
 *       {workerName}/
 *         heartbeat.json
 *         inbox.md
 *         outbox.jsonl
 *         .ready          ← sentinel file (worker writes on startup)
 *         AGENTS.md       ← worker overlay
 *         shutdown-ack.json
 *     mailbox/
 *       {workerName}.json
 */
export function normalizeTaskFileStem(taskId: string): string {
  const trimmed = String(taskId).trim().replace(/\.json$/i, '');
  if (/^task-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `task-${trimmed}`;
  return trimmed;
}

export const TeamPaths = {
  root: (teamName: string) =>
    `.omg/state/team/${teamName}`,

  config: (teamName: string) =>
    `.omg/state/team/${teamName}/config.json`,

  shutdown: (teamName: string) =>
    `.omg/state/team/${teamName}/shutdown.json`,

  tasks: (teamName: string) =>
    `.omg/state/team/${teamName}/tasks`,

  taskFile: (teamName: string, taskId: string) =>
    `.omg/state/team/${teamName}/tasks/${normalizeTaskFileStem(taskId)}.json`,

  workers: (teamName: string) =>
    `.omg/state/team/${teamName}/workers`,

  workerDir: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}`,

  heartbeat: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/heartbeat.json`,

  inbox: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/inbox.md`,

  outbox: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/outbox.jsonl`,

  ready: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/.ready`,

  overlay: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/AGENTS.md`,

  shutdownAck: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/shutdown-ack.json`,

  workerLaunchAttemptRoot: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}`,

  workerLaunchCurrent: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/current.json`,

  workerLaunchExpected: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/expected.json`,

  workerLaunchAck: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/ack.json`,

  workerLaunchStarted: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/provider-started.json`,

  workerLaunchTransportOwner: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/transport-owner.json`,

  workerLaunchBootstrapDescriptor: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/bootstrap.json`,

  workerLaunchWrapper: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/launch.cmd`,

  workerLaunchTransportCleanupComplete: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/transport-cleanup-complete.json`,

  workerLaunchDecision: (teamName: string, workerName: string, attemptId: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/decision.json`,

  mailbox: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/mailbox/${workerName}.json`,

  mailboxLockDir: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/mailbox/.lock-${workerName}`,

  dispatchRequests: (teamName: string) =>
    `.omg/state/team/${teamName}/dispatch/requests.json`,

  dispatchLockDir: (teamName: string) =>
    `.omg/state/team/${teamName}/dispatch/.lock`,
  mailboxNotificationLock: (teamName: string, requestId: string) =>
    `.omg/state/team/${teamName}/dispatch/.mailbox-notification-${createHash('sha256').update(requestId).digest('hex')}.lock`,

  workerStatus: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/status.json`,

  workerIdleNotify: (teamName: string) =>
    `.omg/state/team/${teamName}/worker-idle-notify.json`,

  workerPrevNotifyState: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/prev-notify-state.json`,

  events: (teamName: string) =>
    `.omg/state/team/${teamName}/events.jsonl`,

  approval: (teamName: string, taskId: string) =>
    `.omg/state/team/${teamName}/approvals/${taskId}.json`,

  manifest: (teamName: string) =>
    `.omg/state/team/${teamName}/manifest.json`,

  monitorSnapshot: (teamName: string) =>
    `.omg/state/team/${teamName}/monitor-snapshot.json`,

  summarySnapshot: (teamName: string) =>
    `.omg/state/team/${teamName}/summary-snapshot.json`,

  phaseState: (teamName: string) =>
    `.omg/state/team/${teamName}/phase-state.json`,

  scalingLock: (teamName: string) =>
    `.omg/state/team/${teamName}/.scaling-lock`,
  configMutationLock: (teamName: string) =>
    `.omg/state/team/${teamName}/.config-mutation.lock`,

  workerIdentity: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/identity.json`,

  workerAgentsMd: (teamName: string) =>
    `.omg/state/team/${teamName}/worker-agents.md`,

  shutdownRequest: (teamName: string, workerName: string) =>
    `.omg/state/team/${teamName}/workers/${workerName}/shutdown-request.json`,
  checkpoints: (teamName: string, taskId: string, claimTokenHash: string) =>
    `.omg/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}`,
  checkpoint: (teamName: string, taskId: string, claimTokenHash: string, sequence: number) =>
    `.omg/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/${sequence}.json`,
  checkpointLatest: (teamName: string, taskId: string, claimTokenHash: string) =>
    `.omg/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/latest.json`,
  taskRecoverySidecar: (teamName: string, recoveryId: string, taskId: string) => {
    if (recoveryId.length === 0 || recoveryId.length > 128 || recoveryId === '.' || recoveryId === '..'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recoveryId)) {
      throw new Error('invalid_recovery_request_id');
    }
    const taskStem = normalizeTaskFileStem(taskId);
    if (!/^task-\d+$/.test(taskStem)) throw new Error('invalid_task_id');
    return `.omg/state/team/${teamName}/recovery/task-sidecars/${recoveryId}/${taskStem}.json`;
  },
  taskRecoveryReservation: (teamName: string, taskId: string) =>
    `.omg/state/team/${teamName}/recovery/reservations/${normalizeTaskFileStem(taskId)}.json`,
  ownerEpochs: (teamName: string) =>
    `.omg/state/team/${teamName}/recovery/owner-epochs`,
  ownerEpoch: (teamName: string, epoch: number) =>
    `.omg/state/team/${teamName}/recovery/owner-epochs/${epoch}.json`,
  recoveryOwnerBootstrapCandidate: (teamName: string, expectedEpoch: number, nonce: string) => {
    if (nonce.length === 0 || nonce.length > 128 || nonce === '.' || nonce === '..'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nonce)) throw new Error('invalid_recovery_owner_bootstrap_nonce');
    return `.omg/state/team/${teamName}/recovery/owner-bootstrap/${expectedEpoch}/${nonce}.json`;
  },
  recoveryIntents: (teamName: string) =>
    `.omg/state/team/${teamName}/recovery/intents`,
  recoveryIntent: (teamName: string, recoveryId: string) =>
    `.omg/state/team/${teamName}/recovery/intents/${recoveryId}.json`,
  recoveryAttempts: (teamName: string) =>
    `.omg/state/team/${teamName}/recovery/attempts`,
  recoveryAttempt: (teamName: string, recoveryId: string) =>
    `.omg/state/team/${teamName}/recovery/attempts/${recoveryId}.json`,
  recoveryActivation: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omg/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}`,
  recoveryReady: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omg/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/ready.json`,
  recoveryActivate: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omg/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/activate.json`,
  recoveryRun: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omg/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/run.json`,
  recoveryRequestsRoot: () => '.omg/state/team-recovery/by-request',
  recoveryAdmissionLock: (payloadHash: string) =>
    `.omg/state/team-recovery/admission-locks/${payloadHash}.lock`,
  recoveryLifecycleLock: (workspaceHash: string, teamName: string) =>
    `.omg/state/team-recovery/lifecycle-locks/${workspaceHash}/${teamName}.lock`,
  recoveryRequestPending: (requestId: string) =>
    `.omg/state/team-recovery/by-request/${requestId}.pending.json`,
  recoveryRequestResult: (requestId: string) =>
    `.omg/state/team-recovery/by-request/${requestId}.result.json`,
  recoveryResultByTeam: (workspaceHash: string, teamName: string, recoveryId: string) =>
    `.omg/state/team-recovery/by-team/${workspaceHash}/${teamName}/${recoveryId}.json`,
  recoveryFinalIndexLock: (workspaceHash: string, teamName: string, recoveryId: string) =>
    `.omg/state/team-recovery/index-locks/${workspaceHash}/${teamName}/${recoveryId}.lock`,
  scalingRollbackFailure: (teamName: string, recordedAt: number) =>
    `.omg/state/team/${teamName}/scaling-rollback/${recordedAt}.json`,
  recoveryPaneRollbackFailure: (teamName: string, recoveryId: string, paneAttemptId: string, recordedAt: number) =>
    `.omg/state/team/${teamName}/recovery/rollback-failures/${recoveryId}/${paneAttemptId}-${recordedAt}.json`,
  recoveryAuditIndex: () => '.omg/state/team-recovery/audit.jsonl',
} as const;

/**
 * Get absolute path for a team state file.
 */
export function absPath(cwd: string, relativePath: string): string {
  if (isAbsolute(relativePath)) return relativePath;
  if (relativePath === '.omg' || relativePath.startsWith('.omg/')) {
    return join(getOmcRoot(cwd), relativePath.slice('.omg'.length).replace(/^\//, ''));
  }
  return join(cwd, relativePath);
}

/**
 * Get absolute root path for a team's state directory.
 */
export function teamStateRoot(cwd: string, teamName: string): string {
  return absPath(cwd, TeamPaths.root(teamName));
}

/**
 * Canonical task storage path builder.
 *
 * All task files live at:
 *   {cwd}/.omg/state/team/{teamName}/tasks/task-{taskId}.json
 *
 * When taskId is omitted, returns the tasks directory:
 *   {cwd}/.omg/state/team/{teamName}/tasks/
 *
 * Use this as the single source of truth for task file locations.
 * New writes always use this canonical path.
 */
export function getTaskStoragePath(cwd: string, teamName: string, taskId?: string): string {
  const tasksRoot = join(getOmcRoot(cwd), 'state', 'team', teamName, 'tasks');
  if (taskId !== undefined) {
    return join(tasksRoot, normalizeTaskFileStem(taskId) + '.json');
  }
  return tasksRoot;
}

/**
 * Legacy task storage path builder (deprecated).
 *
 * Old location: ~/.copilot/tasks/{teamName}/{taskId}.json
 *
 * Used only by the compatibility shim in task-file-ops.ts to check
 * for data written by older versions during reads. New code must not
 * write to this path.
 *
 * @deprecated Use getTaskStoragePath instead.
 */
export function getLegacyTaskStoragePath(claudeConfigDir: string, teamName: string, taskId?: string): string {
  if (taskId !== undefined) {
    return join(claudeConfigDir, 'tasks', teamName, `${taskId}.json`);
  }
  return join(claudeConfigDir, 'tasks', teamName);
}
