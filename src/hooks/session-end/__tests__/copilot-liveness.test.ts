/**
 * Copilot CLI fires SessionEnd after every agentStop (live 1.0.91). The
 * session-end worker must not clear live mode state, clean up teams or notify
 * until the session's events.jsonl records the real end (session.shutdown).
 * Events fixtures are the live probe's stop-stub session, slimmed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

// A re-armed job's producer grace expires at once, so the worker runs its actions in-test.
vi.hoisted(() => { process.env.OMC_SESSION_END_TEST_PRODUCER_GRACE_MS = '0'; });

vi.mock('../../../platform/process-utils.js', () => ({
  getProcessStartIdentity: vi.fn(async () => 'test-process-start'),
  isProcessIdentityLive: vi.fn(async () => 'dead' as const),
}));
vi.mock('../action-runner.js', () => ({
  // The worker's action order and claims are under test, not the actions themselves.
  runSessionEndAction: vi.fn(async () => ({ code: 'completed', completed: true })),
}));

import { isCopilotSessionEndJob, isCopilotSessionLive } from '../copilot-liveness.js';
import { deferSessionEndChain, mutateSessionEndJob, prepareCoreManifest, readSessionEndJob } from '../cleanup-manifest.js';
import { factoryStateDir } from '../chain-enqueuer.js';
import { processSessionEndWorker } from '../worker.js';

const FIXTURES = join(process.cwd(), 'src', '__tests__', 'fixtures', 'copilot-live');
const SESSION = '61b74574-b97a-4c2c-82f6-4d89613496df';
const roots: string[] = [];
let savedCopilotHome: string | undefined;
let copilotHome: string;

function writeEvents(fixture: string): string {
  const dir = join(copilotHome, 'session-state', SESSION);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, readFileSync(join(FIXTURES, fixture), 'utf-8'));
  return path;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omg-copilot-session-end-'));
  roots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeUltragoal(dir: string): string {
  const sessionDir = join(dir, '.omg', 'state', 'sessions', SESSION);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'ultragoal-state.json');
  writeFileSync(path, JSON.stringify({ active: true, session_id: SESSION, project_path: dir, started_at: new Date().toISOString() }));
  return path;
}

function prepareCopilotJob(dir: string, host: Record<string, unknown> = { host: 'copilot' }) {
  const input = { hook_event_name: 'SessionEnd', session_id: SESSION, cwd: dir, reason: 'complete' };
  const job = prepareCoreManifest(dir, SESSION, { cwd: dir, reason: 'complete', input, initialTeamNames: [], ...host });
  expect(job).not.toBeNull();
  // Past the producer grace, so the worker would run foreground cleanup now.
  expect(mutateSessionEndJob(dir, SESSION, job!.revision, (next) => {
    next.producerGraceExpiresAt = new Date(Date.now() - 1).toISOString();
  })).not.toBeNull();
}

beforeEach(() => {
  savedCopilotHome = process.env.COPILOT_HOME;
  copilotHome = mkdtempSync(join(tmpdir(), 'omg-copilot-home-'));
  roots.push(copilotHome);
  process.env.COPILOT_HOME = copilotHome;
});

afterEach(() => {
  if (savedCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = savedCopilotHome;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('isCopilotSessionLive', () => {
  it('is live mid-session and over once session.shutdown is recorded', () => {
    writeEvents('session-events-midsession.jsonl');
    expect(isCopilotSessionLive(SESSION)).toBe(true);
    writeEvents('session-events-shutdown.jsonl');
    expect(isCopilotSessionLive(SESSION)).toBe(false);
  });

  it('is live again after a resume following the shutdown', () => {
    const path = writeEvents('session-events-shutdown.jsonl');
    appendFileSync(path, `${JSON.stringify({ type: 'session.resume', id: 'r1', timestamp: new Date().toISOString() })}\n`);
    expect(isCopilotSessionLive(SESSION)).toBe(true);
  });

  it('treats a missing or long-idle events file as ended (pre-existing behaviour)', () => {
    expect(isCopilotSessionLive(SESSION)).toBe(false);
    const path = writeEvents('session-events-midsession.jsonl');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(path, old, old);
    expect(isCopilotSessionLive(SESSION)).toBe(false);
  });
});

describe('session-end worker on Copilot', () => {
  it('runs no session-end action while the Copilot session goes on, and runs them after shutdown', async () => {
    const dir = project();
    const statePath = writeUltragoal(dir);
    prepareCopilotJob(dir);
    expect(isCopilotSessionEndJob(readSessionEndJob(dir, SESSION))).toBe(true);
    writeEvents('session-events-midsession.jsonl');

    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    const held = readSessionEndJob(dir, SESSION)!;
    expect(Object.values(held.actions).every((action) => action.status === 'pending' || action.status === 'completed')).toBe(true);
    expect(held.actions['foreground-cleanup'].status).toBe('pending');
    expect(held.actions['foreground-cleanup'].attempts).toBe(0);
    expect(existsSync(statePath)).toBe(true);

    writeEvents('session-events-shutdown.jsonl');
    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    expect(readSessionEndJob(dir, SESSION)?.actions['foreground-cleanup'].status).toBe('completed');
  });

  it('re-arms a job held past its deadlines so the real end still runs every action', async () => {
    const dir = project();
    writeUltragoal(dir);
    prepareCopilotJob(dir);
    // The first turn's SessionEnd created the job an hour ago; the session went on since.
    const created = readSessionEndJob(dir, SESSION)!;
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(mutateSessionEndJob(dir, SESSION, created.revision, (next) => {
      next.producerGraceExpiresAt = hourAgo;
      next.bestEffortDeadlineAt = hourAgo;
    })).not.toBeNull();
    writeEvents('session-events-midsession.jsonl');
    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    expect(Date.parse(readSessionEndJob(dir, SESSION)!.bestEffortDeadlineAt)).toBeGreaterThan(Date.now());

    writeEvents('session-events-shutdown.jsonl');
    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    const ended = readSessionEndJob(dir, SESSION)!;
    expect(ended.phase).toBe('complete');
    expect(Object.values(ended.actions).filter((action) => action.status === 'expired')).toEqual([]);
    expect(ended.actions['foreground-cleanup'].status).toBe('completed');
    expect(ended.actions.notification.status).toBe('completed');
  });

  it('runs the actions at the real end without waiting a fresh producer grace', async () => {
    // The 1 ms grace above hides a grace restart at the real end; load the modules again with a short real one.
    // The clock is faked so a slow run cannot cross the grace by itself.
    process.env.OMC_SESSION_END_TEST_PRODUCER_GRACE_MS = '200';
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const manifest = await import('../cleanup-manifest.js');
      const { processSessionEndWorker: worker } = await import('../worker.js');
      const dir = project();
      writeUltragoal(dir);
      const input = { hook_event_name: 'SessionEnd', session_id: SESSION, cwd: dir, reason: 'complete' };
      expect(manifest.prepareCoreManifest(dir, SESSION, { cwd: dir, reason: 'complete', input, initialTeamNames: [], host: 'copilot' })).not.toBeNull();

      // A mid-session SessionEnd holds the job and restarts its grace.
      writeEvents('session-events-midsession.jsonl');
      await worker({ directory: dir, sessionId: SESSION }, 6);
      const held = manifest.readSessionEndJob(dir, SESSION)!;
      expect(held.actions.notification.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(300);

      writeEvents('session-events-shutdown.jsonl');
      const endedAt = Date.now();
      await worker({ directory: dir, sessionId: SESSION }, 6);
      const ended = manifest.readSessionEndJob(dir, SESSION)!;
      expect(ended.producerGraceExpiresAt).toBe(held.producerGraceExpiresAt);
      expect(ended.phase).toBe('complete');
      expect(ended.actions.notification.status).toBe('completed');
      expect(Date.parse(ended.actions.notification.claimedAt!)).toBeLessThan(endedAt + 200);
      expect(Object.values(ended.actions).filter((action) => action.status === 'expired')).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.env.OMC_SESSION_END_TEST_PRODUCER_GRACE_MS = '0';
      vi.resetModules();
    }
  });

  it('decides the factory-chain link at the real end with the last SessionEnd outcome', async () => {
    const dir = project();
    mkdirSync(factoryStateDir(dir), { recursive: true });
    writeFileSync(join(factoryStateDir(dir), `chain-${SESSION}.json`), JSON.stringify({ intentId: 'intent-copilot' }));
    writeFileSync(join(dir, '.omg', 'factory-routes.json'), JSON.stringify({ 'success:*': { stage: 'review', skill: 'code-review' } }));
    prepareCopilotJob(dir);
    const decisions = () => { try { return readFileSync(join(factoryStateDir(dir), 'chain-decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).decision); } catch { return []; } };

    // Turn 1 ended in an error; the session went on and ended cleanly.
    deferSessionEndChain(dir, SESSION, { reason: 'error' });
    writeEvents('session-events-midsession.jsonl');
    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    expect(decisions()).toEqual([]);
    expect(JSON.parse(readFileSync(join(factoryStateDir(dir), `chain-${SESSION}.json`), 'utf8')).closedAt).toBeUndefined();

    deferSessionEndChain(dir, SESSION, { reason: 'complete' });
    writeEvents('session-events-shutdown.jsonl');
    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    const ended = readSessionEndJob(dir, SESSION)!;
    expect(ended.actions['spawn-next'].payload.deferredChain).toBeUndefined();
    expect(ended.actions['spawn-next'].payload.chain).toMatchObject({ outcome: 'success', intentId: 'intent-copilot' });
    expect(ended.actions['spawn-next'].status).toBe('completed');
    expect(decisions()).toEqual(['enqueued']);
  });

  it('runs a Claude Code job without waiting on Copilot events', async () => {
    const dir = project();
    writeUltragoal(dir);
    prepareCopilotJob(dir, {});
    writeEvents('session-events-midsession.jsonl');

    await processSessionEndWorker({ directory: dir, sessionId: SESSION }, 6);
    expect(readSessionEndJob(dir, SESSION)?.actions['foreground-cleanup'].status).toBe('completed');
  });
});
