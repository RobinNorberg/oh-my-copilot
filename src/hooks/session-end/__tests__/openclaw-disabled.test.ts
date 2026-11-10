import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actions = vi.hoisted(() => ({
  cleanupSessionOwnedTeams: vi.fn(async () => ({ attempted: [], cleaned: [], failed: [] })),
  cleanupSessionPython: vi.fn(async () => undefined),
  cleanupSessionReplies: vi.fn(async () => undefined),
  runSessionEndCallbacks: vi.fn(async () => undefined),
  runSessionEndNotifications: vi.fn(async () => undefined),
  runSessionEndOpenClaw: vi.fn(async () => undefined),
  runForegroundSessionEndCleanup: vi.fn(async () => undefined),
  exportSessionSummary: vi.fn(() => undefined),
  prepareSessionEndWorkerInput: vi.fn(async () => ({})),
}));
const processIdentity = vi.hoisted(() => ({
  getProcessStartIdentity: vi.fn(async () => 'test-process-start'),
  isProcessIdentityLive: vi.fn(async () => 'dead' as const),
}));
// The runner seam: records which actions would have spawned a runner process.
const actionRunner = vi.hoisted(() => ({
  runSessionEndAction: vi.fn(async (_context: unknown, execute: () => Promise<void>) => {
    await execute();
    return { code: 'completed', completed: true };
  }),
}));

vi.mock('../index.js', () => actions);
vi.mock('../../../platform/process-utils.js', () => processIdentity);
vi.mock('../action-runner.js', () => actionRunner);

import { mutateSessionEndJob, prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest, sessionEndJobsDirectory } from '../cleanup-manifest.js';
import { processSessionEndWorker } from '../worker.js';

const directories: string[] = [];
function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omc-openclaw-disabled-'));
  directories.push(directory);
  vi.stubEnv('HOME', directory);
  vi.stubEnv('USERPROFILE', directory);
  return directory;
}
function runnerActions(): string[] {
  return actionRunner.runSessionEndAction.mock.calls.map(([context]) => (context as { actionName: string }).actionName);
}
function openclawRunDirs(directory: string, jobId: string): string {
  return join(sessionEndJobsDirectory(directory), 'runs', jobId, 'openclaw');
}
function seal(directory: string, sessionId: string): void {
  expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
  expect(sealWikiManifest(directory, sessionId)).not.toBeNull();
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('openclaw session-end action when OpenClaw is disabled (#479)', () => {
  it.each([[undefined], ['0'], ['true']])('does not seed the action nor spawn a runner for OMC_OPENCLAW=%s', async (value) => {
    if (value !== undefined) vi.stubEnv('OMC_OPENCLAW', value); else vi.stubEnv('OMC_OPENCLAW', '');
    const directory = project();
    expect(prepareCoreManifest(directory, 's1', { openClawEnabled: false })).not.toBeNull();
    seal(directory, 's1');
    expect(readSessionEndJob(directory, 's1')!.actions).not.toHaveProperty('openclaw');

    await processSessionEndWorker({ directory, sessionId: 's1' });

    const job = readSessionEndJob(directory, 's1')!;
    expect(job.phase).toBe('complete');
    expect(runnerActions()).not.toContain('openclaw');
    expect(runnerActions()).toContain('notification');
    expect(actions.runSessionEndOpenClaw).not.toHaveBeenCalled();
    expect(existsSync(openclawRunDirs(directory, job.jobId))).toBe(false);
  });

  it('settles a legacy manifest that still carries the action as skipped, without a runner', async () => {
    vi.stubEnv('OMC_OPENCLAW', '');
    const directory = project();
    expect(prepareCoreManifest(directory, 's2', { openClawEnabled: false })).not.toBeNull();
    seal(directory, 's2');
    const legacy = readSessionEndJob(directory, 's2')!;
    // Simulate a manifest written by an older build: the action is present, snapshot not enabled.
    expect(mutateSessionEndJob(directory, 's2', legacy.revision, (job) => {
      job.actions.openclaw = { ...job.actions.notification, payload: { openClawEnabled: false }, idempotencyKey: 'legacy-openclaw' };
    })).not.toBeNull();

    await processSessionEndWorker({ directory, sessionId: 's2' });

    const job = readSessionEndJob(directory, 's2')!;
    expect(job.actions.openclaw).toMatchObject({ status: 'completed', attempts: 0, lastOutcomeCode: 'skipped-openclaw-disabled' });
    expect(job.phase).toBe('complete');
    expect(runnerActions()).not.toContain('openclaw');
    expect(existsSync(openclawRunDirs(directory, job.jobId))).toBe(false);
  });

  it('still seeds and runs the action when OMC_OPENCLAW=1', async () => {
    vi.stubEnv('OMC_OPENCLAW', '1');
    const directory = project();
    expect(prepareCoreManifest(directory, 's3', { openClawEnabled: true })).not.toBeNull();
    seal(directory, 's3');
    expect(readSessionEndJob(directory, 's3')!.actions).toHaveProperty('openclaw');

    await processSessionEndWorker({ directory, sessionId: 's3' });

    expect(runnerActions()).toContain('openclaw');
    expect(actions.runSessionEndOpenClaw).toHaveBeenCalledTimes(1);
    expect(readSessionEndJob(directory, 's3')!.actions.openclaw).toMatchObject({ status: 'completed', attempts: 1 });
  });
});
