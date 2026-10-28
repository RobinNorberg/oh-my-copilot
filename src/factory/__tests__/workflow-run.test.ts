import { createHmac } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processWorkflowRunEvent, routeWorkflowRun, startListener, stopListener, type ListenerConfig, type WorkflowRunEvent } from '../listener.js';
import { enqueueWebhookRun, MAX_QUEUED_RUNS, pruneWebhookQueue, QUEUE_TTL_MS, readWebhookQueue } from '../heal/state.js';

const SECRET = 'test-secret';
const WHITELIST = ['owner/repo'];
const dirs: string[] = [];
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OMC_STATE_DIR;
  const state = mkdtempSync(join(tmpdir(), 'omg-wfrun-state-'));
  dirs.push(state);
  process.env.OMC_STATE_DIR = state;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousStateDir;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

function config(): ListenerConfig {
  const cwd = mkdtempSync(join(tmpdir(), 'omg-wfrun-'));
  dirs.push(cwd);
  return { port: 0, secret: SECRET, whitelist: WHITELIST, cwd };
}

function event(run: Partial<NonNullable<WorkflowRunEvent['workflow_run']>> = {}, extra: Partial<WorkflowRunEvent> = {}): WorkflowRunEvent {
  return {
    action: 'completed',
    repository: { full_name: 'owner/repo' },
    workflow_run: { id: 40584638028, conclusion: 'failure', head_branch: 'dev', event: 'push', path: '.github/workflows/ci.yml', ...run },
    ...extra,
  };
}

describe('routeWorkflowRun', () => {
  it('enqueues only a completed, failed push run of ci.yml on the heal branch', () => {
    expect(routeWorkflowRun(event(), WHITELIST)).toEqual({ kind: 'enqueue', runId: '40584638028' });
    expect(routeWorkflowRun(event({ head_branch: 'main' }), WHITELIST, 'main')).toEqual({ kind: 'enqueue', runId: '40584638028' });
    for (const bad of [
      event({}, { action: 'requested' }),
      event({ conclusion: 'cancelled' }),
      event({ conclusion: 'success' }),
      event({ event: 'pull_request' }),
      event({ head_branch: 'feature/x' }),
      event({ path: '.github/workflows/release.yml' }),
    ]) {
      expect(routeWorkflowRun(bad, WHITELIST).kind).toBe('discarded');
    }
    expect(routeWorkflowRun(event({}, { repository: { full_name: 'someone/else' } }), WHITELIST)).toMatchObject({ kind: 'rejected', status: 403 });
    for (const id of ['40584638028', -1, 1.5, '1; rm -rf /', undefined]) {
      expect(routeWorkflowRun(event({ id }), WHITELIST)).toMatchObject({ kind: 'rejected', status: 422 });
    }
  });
});

describe('processWorkflowRunEvent', () => {
  it('only enqueues: no session spawn, idempotent by run id', () => {
    const cfg = config();
    const spawner = vi.fn();
    const audit = vi.fn();
    expect(processWorkflowRunEvent(event(), cfg, { spawner, audit })).toMatchObject({ status: 202, kind: 'accepted', detail: 'enqueued run 40584638028 for the next heal scan' });
    expect(processWorkflowRunEvent(event(), cfg, { spawner, audit })).toMatchObject({ status: 202, detail: 'run 40584638028 already queued' });
    expect(spawner).not.toHaveBeenCalled();
    expect(readWebhookQueue(cfg.cwd).map((q) => q.runId)).toEqual(['40584638028']);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'routed', stage: 'heal-queue', runId: '40584638028' }));
  });

  it('a busy queue answers 503 and enqueues nothing', () => {
    const cfg = config();
    const r = processWorkflowRunEvent(event(), cfg, { audit: () => {}, enqueueHeal: () => { throw new Error('lock busy'); } });
    expect(r).toMatchObject({ status: 503, kind: 'discarded' });
  });

  it('a signed workflow_run POST enqueues end to end; an unsigned one is refused', async () => {
    const cfg = config();
    const spawner = vi.fn();
    const server = await startListener(cfg, { spawner, audit: () => {} });
    try {
      const port = (server.address() as { port: number }).port;
      const body = JSON.stringify(event());
      const signature = `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
      const unsigned = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00' }, body });
      expect(unsigned.status).toBe(401);
      expect(readWebhookQueue(cfg.cwd)).toEqual([]);
      const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body });
      expect(res.status).toBe(202);
      expect(readWebhookQueue(cfg.cwd).map((q) => q.runId)).toEqual(['40584638028']);
      expect(spawner).not.toHaveBeenCalled();
    } finally {
      stopListener(server, cfg.cwd);
    }
  });
});

describe('heal webhook queue', () => {
  it('is bounded, prunes seen and expired runs, and refuses a non-numeric id', () => {
    const { cwd } = config();
    const now = new Date('2026-10-28T00:00:00Z');
    for (let i = 1; i <= MAX_QUEUED_RUNS + 5; i++) enqueueWebhookRun(cwd, String(i), now);
    const queued = readWebhookQueue(cwd);
    expect(queued).toHaveLength(MAX_QUEUED_RUNS);
    expect(queued[0].runId).toBe('6');
    expect(pruneWebhookQueue(cwd, new Set(['6', '7']), now)).toHaveLength(MAX_QUEUED_RUNS - 2);
    expect(pruneWebhookQueue(cwd, new Set(), new Date(now.getTime() + QUEUE_TTL_MS))).toEqual([]);
    expect(() => enqueueWebhookRun(cwd, '../x', now)).toThrow(/numeric/);
  });
});
