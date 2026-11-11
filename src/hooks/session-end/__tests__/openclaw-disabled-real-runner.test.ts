import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// The REAL action runner runs here: it creates runs/<job>/<action>/... before it
// spawns anything. Only the child process (and the legacy action bodies) are faked,
// so the test is offline and fast but the on-disk layout is the production one.
const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  }),
}));
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
  getProcessStartIdentitySync: vi.fn(() => 'sync-identity'),
  isProcessIdentityLive: vi.fn(async () => 'dead' as const),
  terminateOwnedProcessTree: vi.fn(async () => 'terminated' as const),
}));

vi.mock('child_process', () => childProcess);
vi.mock('../index.js', () => actions);
vi.mock('../../../platform/process-utils.js', () => processIdentity);

import { prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest, sessionEndJobsDirectory } from '../cleanup-manifest.js';
import { processSessionEndWorker } from '../worker.js';

const directories: string[] = [];
function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omc-openclaw-real-runner-'));
  directories.push(directory);
  vi.stubEnv('HOME', directory);
  vi.stubEnv('USERPROFILE', directory);
  return directory;
}
function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return [path, ...(entry.isDirectory() ? walk(path) : [])];
  });
}
function segments(directory: string): string[] {
  return walk(sessionEndJobsDirectory(directory)).map((path) => basename(path));
}
async function runJob(directory: string, sessionId: string, enabled: boolean) {
  expect(prepareCoreManifest(directory, sessionId, { openClawEnabled: enabled })).not.toBeNull();
  expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
  expect(sealWikiManifest(directory, sessionId)).not.toBeNull();
  await processSessionEndWorker({ directory, sessionId });
  return readSessionEndJob(directory, sessionId)!;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('openclaw run folders on disk with the real action runner (#479)', () => {
  it('creates no path segment named openclaw when OpenClaw is disabled, while other actions do get run folders', async () => {
    vi.stubEnv('OMC_OPENCLAW', '');
    const directory = project();
    const job = await runJob(directory, 'r1', false);

    const found = segments(directory);
    // Control: the real runner did create a run folder for another action.
    expect(existsSync(join(sessionEndJobsDirectory(directory), 'runs', job.jobId, 'notification'))).toBe(true);
    expect(found).toContain('notification');
    expect(found).not.toContain('openclaw');
    expect(job.actions).not.toHaveProperty('openclaw');
  });

  it('creates the openclaw run folder when OMC_OPENCLAW=1 (so the absence above is meaningful)', async () => {
    vi.stubEnv('OMC_OPENCLAW', '1');
    const directory = project();
    const job = await runJob(directory, 'r2', true);

    expect(existsSync(join(sessionEndJobsDirectory(directory), 'runs', job.jobId, 'openclaw'))).toBe(true);
    expect(segments(directory)).toContain('openclaw');
  });
});
