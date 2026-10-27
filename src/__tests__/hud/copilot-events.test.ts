import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { readCopilotEvents, resolveCopilotEventsPath } from '../../hud/copilot-events.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/copilot-events-synth.jsonl', import.meta.url));
const SESSION_ID = '6f1c0e2a-0000-4000-8000-00000000b002';
/** Shortly after the fixture's last event, so its running agent is not stale. */
const NOW = Date.parse('2026-10-27T10:05:00.000Z');

describe('copilot events reader', () => {
  let root: string;
  let sessionDir: string;
  let eventsPath: string;
  const savedHome = process.env.COPILOT_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hud-copilot-events-'));
    process.env.COPILOT_HOME = join(root, '.copilot');
    sessionDir = join(root, '.copilot', 'session-state', SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    eventsPath = join(sessionDir, 'events.jsonl');
    copyFileSync(FIXTURE, eventsPath);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  describe('resolveCopilotEventsPath', () => {
    it('takes transcript_path as the session-state directory', () => {
      expect(resolveCopilotEventsPath(sessionDir, null)).toBe(eventsPath);
    });

    it('accepts events.jsonl itself or a sibling file', () => {
      expect(resolveCopilotEventsPath(eventsPath, null)).toBe(eventsPath);
      const sibling = join(sessionDir, 'workspace.yaml');
      writeFileSync(sibling, 'id: x\n');
      expect(resolveCopilotEventsPath(sibling, null)).toBe(eventsPath);
    });

    it('falls back to $COPILOT_HOME/session-state/<session_id>', () => {
      expect(resolveCopilotEventsPath(undefined, SESSION_ID)).toBe(eventsPath);
      expect(resolveCopilotEventsPath(join(root, 'missing'), SESSION_ID)).toBe(eventsPath);
    });

    it('returns null for a missing file or an unsafe session id', () => {
      expect(resolveCopilotEventsPath(undefined, 'no-such-session')).toBeNull();
      expect(resolveCopilotEventsPath(undefined, '../../etc')).toBeNull();
      expect(resolveCopilotEventsPath(null, null)).toBeNull();
    });
  });

  describe('readCopilotEvents', () => {
    it('maps the fixture onto the transcript fields', () => {
      const data = readCopilotEvents(eventsPath, { now: NOW });

      expect(data.toolCallCount).toBe(5);
      expect(data.agentCallCount).toBe(2);
      expect(data.skillCallCount).toBe(1);
      expect(data.lastToolName).toBe('task');
      expect(data.lastActivatedSkill?.name).toBe('oh-my-copilot:ralph');
      expect(data.sessionStart?.toISOString()).toBe('2026-10-27T10:00:00.000Z');

      const running = data.agents.filter((a) => a.status === 'running');
      expect(running).toHaveLength(1);
      expect(running[0]).toMatchObject({
        id: 'call_task_exec',
        type: 'executor',
        model: 'gpt-5.4',
        description: 'lane-b: events reader',
      });
      expect(data.agents.find((a) => a.type === 'explore')?.status).toBe('completed');

      // skill and task are meta tools; the failed powershell call keeps its status.
      expect(data.recentTools.map((t) => [t.name, t.target, t.status])).toEqual([
        ['view', 'index.ts', 'success'],
        ['powershell', 'npx vitest run src/_...', 'failure'],
      ]);

      expect(data.pendingPermission).toMatchObject({
        toolName: 'shell',
        targetSummary: 'git push origin feat/hud-copilot-data',
      });
      expect(data.mode).toBe('autopilot');
      expect(data.reasoningEffort).toBe('high');
      expect(data.compacting).toBe(false);
      expect(data.compactionCount).toBe(1);
      expect(data.usage).toEqual({ totalNanoAiu: 420000000, totalPremiumRequests: 1 });
      expect(data.todos).toEqual([]);
    });

    it('skips malformed lines and unknown types without failing', () => {
      appendFileSync(eventsPath, 'not json at all\n{"type":42}\n{"type":"session.compaction_start","data":{}}\n');
      const data = readCopilotEvents(eventsPath, { now: NOW });
      expect(data.toolCallCount).toBe(5);
      expect(data.compacting).toBe(true);
    });

    it('marks a running agent stale after the threshold', () => {
      const later = Date.parse('2026-10-27T11:00:00.000Z');
      const data = readCopilotEvents(eventsPath, { now: later, staleTaskThresholdMinutes: 30 });
      expect(data.agents.every((a) => a.status === 'completed')).toBe(true);
    });

    it('returns an empty result for a missing file or a directory', () => {
      const missing = readCopilotEvents(join(root, 'missing.jsonl'));
      expect(missing.toolCallCount).toBe(0);
      expect(missing.agents).toEqual([]);
      expect(missing.mode).toBeNull();
      expect(readCopilotEvents(sessionDir).usage).toBeNull();
      expect(readCopilotEvents(null).recentTools).toEqual([]);
    });

    it('reads only the tail of a large file and drops the cut first line', () => {
      const filler = `{"type":"assistant.message","data":{"content":"${'x'.repeat(1000)}"}}\n`;
      const big = join(sessionDir, 'big.jsonl');
      // An early tool start that falls outside the 4 MB tail window.
      writeFileSync(big, '{"type":"tool.execution_start","data":{"toolCallId":"early","toolName":"view"}}\n');
      appendFileSync(big, filler.repeat(4200));
      appendFileSync(big, '{"type":"tool.execution_start","data":{"toolCallId":"late","toolName":"grep"}}\n');
      const data = readCopilotEvents(big, { now: NOW });
      expect(data.toolCallCount).toBe(1);
      expect(data.lastToolName).toBe('grep');
    });

    it('returns fresh copies from its cache', () => {
      const first = readCopilotEvents(eventsPath, { now: NOW });
      first.agents.length = 0;
      first.recentTools[0].status = 'running';
      const second = readCopilotEvents(eventsPath, { now: NOW });
      expect(second.agents.length).toBeGreaterThan(0);
      expect(second.recentTools[0].status).toBe('success');
      expect(second.agents[0].startTime).toBeInstanceOf(Date);
    });
  });
});
