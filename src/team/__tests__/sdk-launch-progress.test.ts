import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  formatSdkLaunchBreakdown,
  lastSdkLaunchPhase,
  startSdkLaunchProgress,
  type SdkLaunchSession,
} from '../sdk-launch-progress.js';
import { sdkWorkerFiles } from '../sdk-transport.js';

const T0 = Date.parse('2026-11-07T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** A fake clock and interval: `advance(ms)` runs the poll once per elapsed poll period. */
function harness(pollMs = 1000) {
  let clock = T0;
  let fn: (() => void) | null = null;
  let cleared = false;
  const lines: string[] = [];
  let session: SdkLaunchSession | null = null;
  const options = {
    pollMs,
    now: () => clock,
    readSession: () => session,
    setInterval: (f: () => void) => { fn = f; return 'h'; },
    clearInterval: () => { cleared = true; },
  };
  return {
    lines,
    options,
    set(next: SdkLaunchSession | null) { session = next; },
    advance(ms: number) {
      for (let t = 0; t < ms; t += pollMs) { clock += pollMs; fn?.(); }
    },
    get cleared() { return cleared; },
  };
}

describe('sdk launch progress', () => {
  it('writes each phase once, heartbeats every 15 s, and ends with a per-phase breakdown', () => {
    const h = harness();
    const stop = startSdkLaunchProgress('/state', 'worker-1', (l) => h.lines.push(l), h.options);
    h.advance(1000);
    expect(h.lines).toEqual([]);
    h.advance(15_000);
    expect(h.lines).toEqual(['[omg team] worker-1: 15s, waiting for the sdk host']);

    h.set({ state: 'starting', timeline: { host_started_at: at(2), client_started_at: at(10) } });
    h.advance(1000);
    expect(h.lines.at(-1)).toBe('[omg team] worker-1: 17s, runtime started');

    h.set({ state: 'idle', timeline: { host_started_at: at(2), client_started_at: at(10), session_created_at: at(30) } });
    h.advance(1000);
    expect(h.lines.at(-1)).toBe('[omg team] worker-1: 18s, session created');
    h.advance(1000);
    expect(h.lines).toHaveLength(3);

    h.set({ state: 'busy', timeline: {
      host_started_at: at(2), client_started_at: at(10), session_created_at: at(30), first_send_at: at(31), turn_started_at: at(34),
    } });
    h.advance(1000);
    expect(h.lines.at(-1)).toBe('[omg team] worker-1: 20s, first turn started');
    h.advance(15_000);
    expect(h.lines.at(-1)).toBe('[omg team] worker-1: 35s, first turn started, waiting for first model reply');

    h.set({ state: 'busy', timeline: {
      host_started_at: at(2), client_started_at: at(10), session_created_at: at(30), first_send_at: at(31), turn_started_at: at(34), first_message_at: at(51),
    } });
    h.advance(1000);
    expect(h.lines.at(-1)).toBe(
      '[omg team] worker-1: ready in 36s (runtime 8s, session 20s, bootstrap 1s, first turn 3s, first reply 17s)',
    );
    expect(h.cleared).toBe(true);
    const count = h.lines.length;
    h.advance(30_000);
    stop();
    expect(h.lines).toHaveLength(count);
  });

  it('reports a failed host with its error and stops', () => {
    const h = harness();
    startSdkLaunchProgress('/state', 'worker-2', (l) => h.lines.push(l), h.options);
    h.set({ state: 'failed', last_error: 'client.start() timed out', timeline: { host_started_at: at(1) } });
    h.advance(1000);
    expect(h.lines).toEqual(['[omg team] worker-2: host failed after 1s: client.start() timed out']);
    expect(h.cleared).toBe(true);
  });

  it('stop() before ready writes the breakdown so far, once', () => {
    const h = harness();
    const stop = startSdkLaunchProgress('/state', 'worker-1', (l) => h.lines.push(l), h.options);
    h.set({ state: 'idle', timeline: { host_started_at: at(0), client_started_at: at(5), session_created_at: at(9) } });
    h.advance(2000);
    stop();
    stop();
    expect(h.lines).toEqual([
      '[omg team] worker-1: 1s, session created',
      '[omg team] worker-1: launch wait ended after 2s (runtime 5s, session 4s)',
    ]);
    expect(h.cleared).toBe(true);
  });

  it('never throws when the writer throws', () => {
    const h = harness();
    const stop = startSdkLaunchProgress('/state', 'worker-1', () => { throw new Error('EPIPE'); }, h.options);
    h.set({ timeline: { first_message_at: at(3) } });
    expect(() => h.advance(1000)).not.toThrow();
    expect(() => stop()).not.toThrow();
  });

  it('reads the real session file by default and skips a malformed one', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-progress-'));
    try {
      const path = sdkWorkerFiles(root, 'worker-1').session;
      mkdirSync(dirname(path), { recursive: true });
      const lines: string[] = [];
      let clock = T0;
      let fn: (() => void) | null = null;
      startSdkLaunchProgress(root, 'worker-1', (l) => lines.push(l), {
        now: () => clock,
        setInterval: (f) => { fn = f; return 1; },
        clearInterval: () => {},
      });
      writeFileSync(path, '{"timeline":');
      clock += 1000; fn!();
      expect(lines).toEqual([]);
      writeFileSync(path, JSON.stringify({ state: 'busy', timeline: { host_started_at: at(0), first_message_at: at(4) } }));
      clock += 1000; fn!();
      expect(lines).toEqual(['[omg team] worker-1: ready in 2s (first reply 4s)']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('phase helpers tolerate missing and partial timelines', () => {
    expect(lastSdkLaunchPhase(null)).toBe(-1);
    expect(lastSdkLaunchPhase({ timeline: { session_created_at: at(1) } })).toBe(2);
    expect(formatSdkLaunchBreakdown({ timeline: { host_started_at: 'not a date', client_started_at: at(1) } })).toBe('');
    expect(formatSdkLaunchBreakdown(null)).toBe('');
  });
});
