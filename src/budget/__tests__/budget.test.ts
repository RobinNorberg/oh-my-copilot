import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkThresholds,
  governTeamFanout,
  resolveBudgetSettings,
  runBudgetHook,
  type BudgetSettings,
} from '../governor.js';
import {
  emptyLedger,
  ledgerPath,
  ledgerTotals,
  mergeRecord,
  readCopilotSessionUsage,
  readLedger,
  recordUsage,
  type UsageRecord,
} from '../ledger.js';
import { budgetCommand } from '../../cli/commands/budget.js';
import { renderPremiumBudget } from '../../hud/elements/premium-budget.js';
import { parseTeamArgs } from '../../cli/commands/team.js';

const SID = '1b4b720d-2e5c-4ba8-bd81-d42629574d3a';
const line = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ type, data, ...extra });
// Shapes copied from a real Copilot CLI 1.0.91 events.jsonl (trimmed).
const PROMPT = line('user.message', { content: 'hi' });
const SUBAGENT_PROMPT = line('user.message', { content: 'sub', source: `agent-${SID}` });
const AUTO_MODEL = line('session.auto_mode_resolved', { chosenModel: 'mai-code-1.1-flash' });
const CHECKPOINT = line('session.usage_checkpoint', { totalNanoAiu: 268660000, totalPremiumRequests: 1 });
const SHUTDOWN = line('session.shutdown', { shutdownType: 'routine', totalPremiumRequests: 3, totalNanoAiu: 617430500, currentModel: 'mai-code-1.1-flash' });

let root: string;
let project: string;
let copilotHome: string;

function writeEvents(sessionId: string, lines: string[]): string {
  const dir = join(copilotHome, 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function writeBudget(budget: Record<string, unknown>): void {
  mkdirSync(join(project, '.copilot'), { recursive: true });
  writeFileSync(join(project, '.copilot', 'omg.jsonc'), `// test\n${JSON.stringify({ budget })}\n`);
}

const record = (premiumRequests: number, source: UsageRecord['source'] = 'measured', credits = 0): UsageRecord =>
  ({ premiumRequests, credits, source, detail: 'test', updatedAt: '2026-10-11T00:00:00.000Z' });

const settings = (over: Partial<BudgetSettings> = {}): BudgetSettings => ({ enabled: true, mode: 'warn', unit: 'premiumRequests', ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-budget-'));
  project = join(root, 'project');
  copilotHome = join(root, 'copilot-home');
  mkdirSync(project, { recursive: true });
  vi.stubEnv('OMC_STATE_DIR', join(root, 'state'));
  vi.stubEnv('COPILOT_HOME', copilotHome);
  vi.stubEnv('APPDATA', join(root, 'appdata'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'appdata'));
  vi.stubEnv('OMC_BUDGET_GOVERNOR', '');
  vi.stubEnv('OMC_TEAM_WORKER', '');
  vi.stubEnv('OMC_BUDGET_HOST_LEDGER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('readCopilotSessionUsage', () => {
  it('prefers the last shutdown totals and labels them measured', () => {
    const usage = readCopilotSessionUsage(writeEvents(SID, [PROMPT, AUTO_MODEL, CHECKPOINT, SHUTDOWN]));
    expect(usage).toMatchObject({ premiumRequests: 3, credits: 0.6174305, source: 'measured', detail: 'session.shutdown', model: 'mai-code-1.1-flash' });
  });

  it('uses a usage checkpoint when the session has not shut down', () => {
    expect(readCopilotSessionUsage(writeEvents(SID, [PROMPT, CHECKPOINT]))).toMatchObject({ premiumRequests: 1, credits: 0.26866, source: 'measured', detail: 'session.usage_checkpoint' });
  });

  it('estimates one request per top-level prompt, ignoring subagent prompts', () => {
    const usage = readCopilotSessionUsage(writeEvents(SID, [PROMPT, SUBAGENT_PROMPT, PROMPT, 'not json']));
    expect(usage).toMatchObject({ premiumRequests: 2, credits: 0, source: 'estimated' });
    expect(usage?.detail).toMatch(/^estimate: 2 user prompt\(s\) x1/);
  });

  it('returns null for a missing file or a session without prompts', () => {
    expect(readCopilotSessionUsage(join(root, 'nope.jsonl'))).toBeNull();
    expect(readCopilotSessionUsage(writeEvents(SID, [AUTO_MODEL]))).toBeNull();
  });
});

describe('ledger', () => {
  it('never downgrades a measured record to an estimate', () => {
    expect(mergeRecord(record(4), record(9, 'estimated'))).toEqual(record(4));
    expect(mergeRecord(record(2, 'estimated'), record(5))).toEqual(record(5));
  });

  it('records sessions and teams under the lock and totals them', () => {
    const path = ledgerPath(project);
    recordUsage(path, 's1', record(2, 'measured', 0.5));
    recordUsage(path, 's2', record(1, 'estimated'));
    recordUsage(path, 'worker-1:a', record(3, 'measured', 1), 'alpha');
    recordUsage(path, '../escape', record(100));
    const totals = ledgerTotals(readLedger(path));
    expect(totals).toMatchObject({ premiumRequests: 6, credits: 1.5, sessions: 2, estimatedRecords: 1 });
    expect(totals.teams.alpha).toEqual({ premiumRequests: 3, credits: 1, records: 1 });
  });

  it('reads a corrupt ledger as empty', () => {
    const path = ledgerPath(project);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{broken');
    expect(readLedger(path).sessions).toEqual({});
  });
});

describe('resolveBudgetSettings', () => {
  it('defaults to warn mode in premium requests with no limits', () => {
    expect(resolveBudgetSettings(undefined, {})).toEqual({ settings: settings(), issues: [] });
  });

  it('drops invalid values with an issue instead of throwing', () => {
    const { settings: s, issues } = resolveBudgetSettings({ mode: 'block', unit: 'usd', softLimit: -1, hardLimit: 10, perTeamLimit: '5', extra: 1 }, {});
    expect(s).toEqual(settings({ hardLimit: 10 }));
    expect(issues).toHaveLength(5);
  });

  it('flags a soft limit above the hard limit and honours the kill switch', () => {
    const { settings: s, issues } = resolveBudgetSettings({ softLimit: 20, hardLimit: 10, mode: 'enforce' }, { OMC_BUDGET_GOVERNOR: '0' });
    expect(s.enabled).toBe(false);
    expect(issues).toEqual(['budget.softLimit (20) is above budget.hardLimit (10)']);
  });
});

describe('checkThresholds', () => {
  it('notifies the soft and then the hard limit once each', () => {
    const ledger = emptyLedger();
    const s = settings({ softLimit: 2, hardLimit: 4 });
    ledger.sessions.a = record(1);
    expect(checkThresholds(ledger, s)).toBeNull();
    ledger.sessions.a = record(2);
    expect(checkThresholds(ledger, s)).toMatch(/^\[BUDGET\] Soft limit reached: 2 premium requests of 2/);
    expect(checkThresholds(ledger, s)).toBeNull();
    ledger.sessions.a = record(5);
    expect(checkThresholds(ledger, s)).toMatch(/^\[BUDGET\] Hard limit reached/);
    expect(checkThresholds(ledger, s)).toBeNull();
  });
});

describe('runBudgetHook', () => {
  const payload = (extra: Record<string, unknown> = {}) => ({ session_id: SID, cwd: project, ...extra });

  it('records usage silently when no limit is configured', () => {
    writeEvents(SID, [PROMPT]);
    expect(runBudgetHook({ phase: 'stop', payload: payload() })).toBeNull();
    expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 1, source: 'estimated' });
  });

  it('marks a crossed limit at stop and delivers it once on the next prompt', () => {
    writeBudget({ softLimit: 1, hardLimit: 10 });
    writeEvents(SID, [PROMPT]);
    const stop = runBudgetHook({ phase: 'stop', payload: payload() });
    expect(stop?.systemMessage).toMatch(/Soft limit reached/);
    const prompt = runBudgetHook({ phase: 'prompt', payload: payload() }) as { hookSpecificOutput: { additionalContext: string } };
    expect(prompt.hookSpecificOutput.additionalContext).toMatch(/Soft limit reached/);
    expect(runBudgetHook({ phase: 'prompt', payload: payload() })).toBeNull();
  });

  it('prints the summary at session start and upgrades ended estimates to measured', () => {
    writeBudget({ hardLimit: 50 });
    writeEvents(SID, [PROMPT]);
    runBudgetHook({ phase: 'stop', payload: payload() });
    writeEvents(SID, [PROMPT, SHUTDOWN]);
    const out = runBudgetHook({ phase: 'session-start', payload: payload({ session_id: 'new-session' }) }) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toMatch(/^\[BUDGET\] Copilot usage since .*: 3 premium requests, 0\.617 AI credits \(1 session\(s\), 0 team\(s\)\)\. Limits in premiumRequests: hard 50 \(warn mode\)/);
    expect(readLedger(ledgerPath(project)).sessions[SID]?.source).toBe('measured');
  });

  it('records a pane team worker under its team without output, and skips host-recorded sdk workers', () => {
    writeBudget({ softLimit: 1 });
    writeEvents(SID, [PROMPT]);
    const env = { ...process.env, OMC_TEAM_WORKER: 'alpha/worker-1', OMC_TEAM_LEADER_CWD: project };
    expect(runBudgetHook({ phase: 'stop', payload: payload({ cwd: join(root, 'wt') }), env })).toBeNull();
    expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]?.premiumRequests).toBe(1);
    expect(readLedger(ledgerPath(project)).sessions).toEqual({});
    writeEvents('other', [PROMPT]);
    runBudgetHook({ phase: 'stop', payload: payload({ session_id: 'other' }), env: { ...env, OMC_BUDGET_HOST_LEDGER: '1' } });
    expect(readLedger(ledgerPath(project)).teams.alpha?.other).toBeUndefined();
  });

  it('does nothing under the kill switch', () => {
    writeBudget({ softLimit: 1 });
    writeEvents(SID, [PROMPT]);
    expect(runBudgetHook({ phase: 'stop', payload: payload(), env: { ...process.env, OMC_BUDGET_GOVERNOR: '0' } })).toBeNull();
    expect(readLedger(ledgerPath(project)).sessions).toEqual({});
  });
});

describe('governTeamFanout', () => {
  const totals = (premiumRequests: number, credits = 0) => ({ ...ledgerTotals(emptyLedger()), premiumRequests, credits });
  const base = { maxCreditsPerWorker: 10, override: false, clampable: true };
  const four = ['copilot', 'copilot', 'copilot', 'copilot'];

  it('passes when within budget or when no copilot worker is billed', () => {
    expect(governTeamFanout({ ...base, settings: settings({ mode: 'enforce', hardLimit: 10 }), totals: totals(5), agentTypes: four })).toEqual({ workerCount: 4 });
    expect(governTeamFanout({ ...base, settings: settings({ mode: 'enforce', hardLimit: 1 }), totals: totals(5), agentTypes: ['claude', 'codex'] })).toEqual({ workerCount: 2 });
  });

  it('only warns in warn mode or with the override', () => {
    const warn = governTeamFanout({ ...base, settings: settings({ hardLimit: 6 }), totals: totals(4), agentTypes: four });
    expect(warn).toEqual({ workerCount: 4, notice: expect.stringMatching(/projected 4 premium requests .* exceeds the 2 premium requests left of budget.hardLimit 6; starting anyway \(warn mode\)/) });
    const override = governTeamFanout({ ...base, override: true, settings: settings({ mode: 'enforce', hardLimit: 6 }), totals: totals(4), agentTypes: four });
    expect(override.workerCount).toBe(4);
    expect(override.notice).toMatch(/--budget-override/);
  });

  it('clamps in enforce mode, and refuses when nothing fits or workers own subtasks', () => {
    const s = settings({ mode: 'enforce', hardLimit: 6, perTeamLimit: 3 });
    expect(governTeamFanout({ ...base, settings: s, totals: totals(0), agentTypes: four })).toMatchObject({ workerCount: 3, notice: expect.stringMatching(/exceeds budget.perTeamLimit 3; clamped to 3/) });
    expect(governTeamFanout({ ...base, settings: s, totals: totals(6), agentTypes: four }).refusal).toMatch(/team launch refused\. Pass --budget-override/);
    expect(governTeamFanout({ ...base, clampable: false, settings: s, totals: totals(0), agentTypes: four }).refusal).toMatch(/refused/);
  });

  it('projects the per-worker credit cap in credits', () => {
    const decision = governTeamFanout({ ...base, settings: settings({ mode: 'enforce', unit: 'credits', perTeamLimit: 25 }), totals: totals(0, 0), agentTypes: four });
    expect(decision).toMatchObject({ workerCount: 2, notice: expect.stringMatching(/projected 40 AI credits \(4 copilot worker\(s\) x 10 credit cap\)/) });
  });
});

describe('omg budget and the HUD element', () => {
  it('reports status as JSON, exits 1 at the hard limit, and resets', async () => {
    writeBudget({ hardLimit: 2 });
    recordUsage(ledgerPath(project), 's1', record(2));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await budgetCommand('status', { json: true }, project)).toBe(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ used: 2, settings: { hardLimit: 2 }, totals: { sessions: 1 } });
      expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({ ok: true, previous: { premiumRequests: 2 } });
      expect(readLedger(ledgerPath(project)).sessions).toEqual({});
    } finally {
      log.mockRestore();
    }
  });

  it('renders prq:used/limit, with ~ when part is estimated, only when limits exist', () => {
    expect(renderPremiumBudget(project)).toBeNull();
    writeBudget({ softLimit: 2, hardLimit: 5 });
    recordUsage(ledgerPath(project), 's1', record(3, 'estimated'));
    expect(renderPremiumBudget(project)?.replace(/\x1b\[[0-9;]*m/g, '')).toBe('prq:~3/5');
  });
});

describe('omg team --budget-override', () => {
  it('parses the flag only when given', () => {
    expect(parseTeamArgs(['2:copilot', '--budget-override', 'fix it']).budgetOverride).toBe(true);
    expect('budgetOverride' in parseTeamArgs(['2:copilot', 'fix it'])).toBe(false);
  });
});

it('keeps the ledger as readable JSON', () => {
  recordUsage(ledgerPath(project), 's1', record(1));
  expect(JSON.parse(readFileSync(ledgerPath(project), 'utf8')).version).toBe(1);
});
