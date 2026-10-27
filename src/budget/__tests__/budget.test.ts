import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkThresholds,
  resolveBudgetSettings,
  runBudgetHook,
  type BudgetSettings,
} from '../governor.js';
import {
  emptyLedger,
  ledgerPath,
  ledgerTotals,
  ESTIMATED_CREDITS_PER_PROMPT,
  MAX_SCAN_BYTES,
  mergeRecord,
  readCopilotSessionUsage,
  readLedger,
  readTailTotals,
  recordUsage,
  resetLedger,
  updateLedger,
  type UsageRecord,
} from '../ledger.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync } from '../../lib/file-lock.js';
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

const settings = (over: Partial<BudgetSettings> = {}): BudgetSettings => ({ enabled: true, deprecated: [], ...over });

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

  it('estimates ESTIMATED_CREDITS_PER_PROMPT credits (and one legacy request) per top-level prompt, ignoring subagent prompts', () => {
    const usage = readCopilotSessionUsage(writeEvents(SID, [PROMPT, SUBAGENT_PROMPT, PROMPT, 'not json']));
    expect(usage).toMatchObject({ credits: 2 * ESTIMATED_CREDITS_PER_PROMPT, premiumRequests: 2, source: 'estimated' });
    expect(usage?.detail).toMatch(/^estimate: 2 user prompt\(s\) x 1 AI credit/);
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

  it('reads a corrupt or foreign-version ledger as empty and backs it up before overwriting', () => {
    const path = ledgerPath(project);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{broken');
    expect(readLedger(path).sessions).toEqual({});
    recordUsage(path, 's1', record(1));
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{broken');
    writeFileSync(path, JSON.stringify({ version: 2, since: 'x', sessions: { keep: record(9) } }));
    recordUsage(path, 's2', record(1));
    expect(JSON.parse(readFileSync(`${path}.corrupt`, 'utf8')).version).toBe(2);
    expect(Object.keys(readLedger(path).sessions)).toEqual(['s2']);
  });

  it('ignores null and non-object records instead of throwing', async () => {
    const path = ledgerPath(project);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1, since: '2026-10-01T00:00:00.000Z',
      sessions: { a: null, b: 3, c: record(2) }, teams: { x: null, y: { k: null, w: record(1) } }, notified: null,
    }));
    expect(ledgerTotals(readLedger(path))).toMatchObject({ premiumRequests: 3, sessions: 1, teams: { y: { records: 1 } } });
    // The raw shape too (a caller holding an unsanitized ledger).
    expect(ledgerTotals({ ...emptyLedger(), sessions: { a: null as unknown as UsageRecord } }).sessions).toBe(0);
    recordUsage(path, 'c', record(5));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('never lowers an estimate, and keeps the larger measured total when one drops', () => {
    expect(mergeRecord(record(5, 'estimated'), record(3, 'estimated')).premiumRequests).toBe(5);
    const dropped = mergeRecord(record(7), record(2));
    expect(mergeRecord(record(1, 'estimated', 4), record(1, 'estimated', 2)).credits).toBe(4);
    expect(dropped.premiumRequests).toBe(7);
    expect(dropped.detail).toMatch(/total fell from 0 AI credits \(7 premium requests\) to 0 AI credits \(2 premium requests\) \(resumed session\?\), kept 0 AI credits \(7 premium requests\)/);
    // Credits are the billed unit: a drop in credits alone is kept too.
    const fewerCredits = mergeRecord(record(1, 'measured', 0.9), record(1, 'measured', 0.4));
    expect(fewerCredits).toMatchObject({ credits: 0.9, premiumRequests: 1 });
    expect(fewerCredits.detail).toMatch(/total fell from 0\.9 AI credits/);
    // A growing total replaces the record unchanged.
    expect(mergeRecord(record(1, 'measured', 0.4), record(2, 'measured', 0.9))).toEqual(record(2, 'measured', 0.9));
  });

  it('refuses a ledger path in the real home directory under test', () => {
    vi.stubEnv('OMC_STATE_DIR', join(homedir(), '.omg-budget-test-guard'));
    expect(() => ledgerPath(project)).toThrow(/outside the temp dir under test/);
  });
});

describe('readCopilotSessionUsage incremental and tail mode', () => {
  const big = (prompts: number) => {
    // ~200 bytes a line, so 50k prompts are ~10 MB: past MAX_SCAN_BYTES (8 MB).
    const filler = 'x'.repeat(160);
    return Array.from({ length: prompts }, () => line('user.message', { content: filler }));
  };

  it('counts a file larger than the scan budget across calls; the estimate only grows', () => {
    const path = writeEvents(SID, big(50_000));
    expect(statSync(path).size).toBeGreaterThan(MAX_SCAN_BYTES);
    const first = readCopilotSessionUsage(path)!;
    expect(first.source).toBe('estimated');
    expect(first.premiumRequests).toBeGreaterThan(0);
    expect(first.premiumRequests).toBeLessThan(50_000);
    expect(first.detail).toMatch(/read \d+ bytes so far/);
    const second = readCopilotSessionUsage(path, new Date(), { prev: first.scan })!;
    expect(second.premiumRequests).toBe(50_000);
    expect(second.premiumRequests).toBeGreaterThan(first.premiumRequests);
    // Nothing appended: no re-read.
    expect(readCopilotSessionUsage(path, new Date(), { prev: second.scan })).toBeNull();
    appendFileSync(path, `${PROMPT}\n`);
    expect(readCopilotSessionUsage(path, new Date(), { prev: second.scan })?.premiumRequests).toBe(50_001);
  });

  it('reads the end-of-session totals from the tail when the scan is partial', () => {
    const path = writeEvents(SID, [...Array.from({ length: 200 }, () => PROMPT), SHUTDOWN]);
    const usage = readCopilotSessionUsage(path, new Date(), { maxScanBytes: 1024 })!;
    expect(usage).toMatchObject({ premiumRequests: 3, source: 'measured', detail: 'session.shutdown (events tail)' });
    expect(usage.scan!.offset).toBeLessThanOrEqual(1024);
    expect(readTailTotals(path, statSync(path).size)).toMatchObject({ premium: 3, type: 'session.shutdown' });
  });

  it('counts only prompts from the period start', () => {
    const at = (iso: string) => line('user.message', { content: 'hi' }, { timestamp: iso });
    const path = writeEvents(SID, [at('2026-10-01T00:00:00.000Z'), at('2026-10-03T00:00:00.000Z')]);
    expect(readCopilotSessionUsage(path, new Date(), { since: '2026-10-02T00:00:00.000Z' })?.premiumRequests).toBe(1);
  });
});

describe('resolveBudgetSettings', () => {
  it('defaults to no soft limit in AI credits', () => {
    expect(resolveBudgetSettings(undefined, {})).toEqual({ settings: settings(), issues: [] });
    expect(resolveBudgetSettings({ softLimit: 50, unit: 'credits' }, {})).toEqual({ settings: settings({ softLimit: 50 }), issues: [] });
  });

  it('drops invalid values with an issue instead of throwing', () => {
    const { settings: s, issues } = resolveBudgetSettings({ unit: 'usd', softLimit: -1, extra: 1 }, {});
    expect(s).toEqual(settings());
    expect(issues).toEqual([
      'budget.extra: unknown key',
      'budget.unit: must be "credits" (got "usd"); ignored',
      'budget.softLimit: must be a positive number (got -1); ignored',
    ]);
  });

  it('accepts the retired enforcement keys and the premiumRequests unit as no-ops with one deprecation warning', () => {
    const { settings: s, issues } = resolveBudgetSettings({ mode: 'enforce', unit: 'premiumRequests', softLimit: 20, hardLimit: 10, perTeamLimit: 'x' }, {});
    expect(s).toEqual(settings({ softLimit: 20, deprecated: ['budget.mode', 'budget.hardLimit', 'budget.perTeamLimit', 'budget.unit "premiumRequests"'] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^budget\.mode, budget\.hardLimit, budget\.perTeamLimit, budget\.unit "premiumRequests": deprecated and ignored\. .*docs\/MIGRATION\.md/);
  });

  it('honours the kill switch', () => {
    expect(resolveBudgetSettings({ softLimit: 20 }, { OMC_BUDGET_GOVERNOR: '0' }).settings.enabled).toBe(false);
  });
});

describe('checkThresholds', () => {
  it('notifies the soft limit once, in AI credits', () => {
    const ledger = emptyLedger();
    const s = settings({ softLimit: 2 });
    ledger.sessions.a = record(9, 'measured', 1);
    expect(checkThresholds(ledger, s)).toBeNull();
    ledger.sessions.a = record(9, 'measured', 2);
    expect(checkThresholds(ledger, s)).toMatch(/^\[BUDGET\] Soft limit reached: 2 AI credits of 2/);
    expect(checkThresholds(ledger, s)).toBeNull();
  });

  it('says how many records are estimated', () => {
    const ledger = emptyLedger();
    ledger.sessions.a = record(0, 'estimated', 2);
    ledger.sessions.b = record(0, 'measured', 1);
    expect(checkThresholds(ledger, settings({ softLimit: 3 }))).toMatch(/3 AI credits of 3 used since .* \(1 record\(s\) estimated\)\. Mention/);
  });

  it('re-arms the notice when the limit is raised', () => {
    const ledger = emptyLedger();
    ledger.sessions.a = record(0, 'measured', 5);
    expect(checkThresholds(ledger, settings({ softLimit: 4 }))).toMatch(/Soft limit reached: 5 AI credits of 4/);
    // Raised past the usage: nothing yet, but armed again.
    expect(checkThresholds(ledger, settings({ softLimit: 10 }))).toBeNull();
    ledger.sessions.a = record(0, 'measured', 11);
    expect(checkThresholds(ledger, settings({ softLimit: 10 }))).toMatch(/Soft limit reached: 11 AI credits of 10/);
    // Lowering never re-arms.
    expect(checkThresholds(ledger, settings({ softLimit: 8 }))).toBeNull();
  });
});

describe('runBudgetHook', () => {
  const payload = (extra: Record<string, unknown> = {}) => ({ session_id: SID, cwd: project, ...extra });

  it('records usage silently when no limit is configured', () => {
    writeEvents(SID, [PROMPT]);
    expect(runBudgetHook({ phase: 'turn', payload: payload() })).toBeNull();
    expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 1, source: 'estimated' });
  });

  it('marks a crossed limit at stop and delivers it once on the next prompt', () => {
    writeBudget({ softLimit: 1 });
    writeEvents(SID, [PROMPT]);
    const stop = runBudgetHook({ phase: 'turn', payload: payload() });
    expect(stop?.systemMessage).toMatch(/Soft limit reached/);
    const prompt = runBudgetHook({ phase: 'submit', payload: payload() }) as { hookSpecificOutput: { additionalContext: string } };
    expect(prompt.hookSpecificOutput.additionalContext).toMatch(/Soft limit reached/);
    expect(runBudgetHook({ phase: 'submit', payload: payload() })).toBeNull();
  });

  it('prints the summary at session start and upgrades ended estimates to measured', () => {
    writeBudget({ softLimit: 50 });
    writeEvents(SID, [PROMPT]);
    runBudgetHook({ phase: 'turn', payload: payload() });
    writeEvents(SID, [PROMPT, SHUTDOWN]);
    const out = runBudgetHook({ phase: 'start', payload: payload({ session_id: 'new-session' }) }) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toBe(
      `[BUDGET] Copilot usage since ${readLedger(ledgerPath(project)).since.slice(0, 10)}: 0.617 AI credits (1 session(s), 0 team(s)). Reporting only, soft limit 50 AI credits. Details: omg budget status.`,
    );
    expect(readLedger(ledgerPath(project)).sessions[SID]?.source).toBe('measured');
  });

  it('names retired keys once in the session-start summary and never blocks past a deprecated hard limit', () => {
    writeBudget({ mode: 'enforce', hardLimit: 1 });
    writeEvents(SID, [PROMPT, PROMPT, PROMPT]);
    expect(runBudgetHook({ phase: 'turn', payload: payload() })).toBeNull();
    const out = runBudgetHook({ phase: 'start', payload: payload({ session_id: 'new-session' }) }) as { continue: boolean; hookSpecificOutput: { additionalContext: string } };
    expect(out.continue).toBe(true);
    const context = out.hookSpecificOutput.additionalContext;
    expect(context).toMatch(/no soft limit\. budget\.mode, budget\.hardLimit: deprecated and ignored\./);
    expect(context.match(/deprecated/g)).toHaveLength(1);
    expect(context).toMatch(/docs\/MIGRATION\.md/);
  });

  it('records a pane team worker under its team without output, and skips host-recorded sdk workers', () => {
    writeBudget({ softLimit: 1 });
    writeEvents(SID, [PROMPT]);
    const env = { ...process.env, OMC_TEAM_WORKER: 'alpha/worker-1', OMC_TEAM_LEADER_CWD: project };
    expect(runBudgetHook({ phase: 'turn', payload: payload({ cwd: join(root, 'wt') }), env })).toBeNull();
    expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]?.premiumRequests).toBe(1);
    expect(readLedger(ledgerPath(project)).sessions).toEqual({});
    writeEvents('other', [PROMPT]);
    runBudgetHook({ phase: 'turn', payload: payload({ session_id: 'other' }), env: { ...env, OMC_BUDGET_HOST_LEDGER: '1' } });
    expect(readLedger(ledgerPath(project)).teams.alpha?.other).toBeUndefined();
  });

  it('counts only usage after `omg budget reset` for a session running across it', async () => {
    const at = (ms: number) => line('user.message', { content: 'hi' }, { timestamp: new Date(ms).toISOString() });
    const t0 = Date.now() - 3_600_000;
    const forty = Array.from({ length: 40 }, (_, i) => at(t0 + i * 1000));
    writeEvents(SID, forty);
    runBudgetHook({ phase: 'turn', payload: payload() });
    expect(readLedger(ledgerPath(project)).sessions[SID]?.premiumRequests).toBe(40);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
    } finally {
      log.mockRestore();
    }
    const since = Date.parse(readLedger(ledgerPath(project)).since);
    writeEvents(SID, [...forty, at(since + 1000)]);
    runBudgetHook({ phase: 'turn', payload: payload() });
    expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 1, source: 'estimated' });
    // The session ends: its cumulative total (45) minus the pre-reset estimate (40); the split is estimated.
    writeEvents(SID, [...forty, at(since + 1000), line('session.shutdown', { totalPremiumRequests: 45, totalNanoAiu: 0 })]);
    runBudgetHook({ phase: 'turn', payload: payload() });
    expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 5, source: 'estimated' });
  });

  it('subtracts a measured pre-reset total exactly', () => {
    const path = ledgerPath(project);
    recordUsage(path, 'w:1', record(4, 'measured', 2), 'alpha');
    updateLedger(path, (l) => { resetLedger(l); });
    recordUsage(path, 'w:1', record(6, 'measured', 2.5), 'alpha');
    expect(readLedger(path).teams.alpha?.['w:1']).toMatchObject({ premiumRequests: 2, credits: 0.5, source: 'measured' });
  });

  it('refreshes estimated pane team worker records at session start', () => {
    writeEvents(SID, [PROMPT]);
    const env = { ...process.env, OMC_TEAM_WORKER: 'alpha/worker-1', OMC_TEAM_LEADER_CWD: project };
    runBudgetHook({ phase: 'turn', payload: payload({ cwd: join(root, 'wt') }), env });
    expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]?.source).toBe('estimated');
    writeEvents(SID, [PROMPT, SHUTDOWN]);
    runBudgetHook({ phase: 'start', payload: payload({ session_id: 'leader' }) });
    expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]).toMatchObject({ premiumRequests: 3, source: 'measured' });
  });

  it('bounds the session-start refresh: rotates, skips unchanged files, marks gone ones final', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `s-${String(i).padStart(2, '0')}`);
    const padding = ' '.repeat(200); // a line the scanner ignores, so the file can be rewritten at the same size
    for (const id of ids) {
      writeEvents(id, [PROMPT, padding]);
      runBudgetHook({ phase: 'turn', payload: payload({ session_id: id }) });
    }
    // Whole-second mtime: a sub-ms stamp does not survive utimesSync's float-seconds round trip exactly.
    const first = join(copilotHome, 'session-state', ids[0]!, 'events.jsonl');
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(first, pinned, pinned);
    const sessions = () => readLedger(ledgerPath(project)).sessions;
    const checked = () => Object.entries(sessions()).filter(([, r]) => r.scan?.checkedSize !== undefined).map(([id]) => id);
    // A generous time budget: the count bound is under test here, not the clock (a loaded runner is slow).
    const start = (n: number) => runBudgetHook({ phase: 'start', payload: payload({ session_id: `leader-${n}` }), refreshDeadlineMs: 60_000 });
    start(1);
    expect(checked()).toEqual(ids.slice(0, 20));
    start(2);
    expect(checked()).toEqual(ids); // the rotation reached the last five
    // Same size and mtime as at the last check: not re-read, even though the content now holds totals.
    const { size } = statSync(first);
    const shutdown = line('session.shutdown', { totalPremiumRequests: 9, totalNanoAiu: 0 });
    writeFileSync(first, `${shutdown}\n`.padEnd(size - 1, ' ') + '\n');
    expect(statSync(first).size).toBe(size);
    utimesSync(first, pinned, pinned);
    start(3);
    expect(sessions()[ids[0]!]?.source).toBe('estimated');
    // Changed mtime: re-read, upgraded to measured.
    utimesSync(first, new Date(), new Date(Date.now() + 5000));
    start(4);
    expect(sessions()[ids[0]!]).toMatchObject({ premiumRequests: 9, source: 'measured' });
    // Gone: final, never re-read.
    rmSync(join(copilotHome, 'session-state', ids[1]!), { recursive: true });
    for (let i = 5; i < 8; i++) start(i);
    expect(sessions()[ids[1]!]).toMatchObject({ premiumRequests: 1, scan: { gone: true } });
    expect(sessions()[ids[1]!]?.detail).toMatch(/events file gone, final/);
  });

  it('stops the refresh at its time budget but always moves the rotation on', () => {
    for (const id of ['a-1', 'a-2', 'a-3']) {
      writeEvents(id, [PROMPT]);
      runBudgetHook({ phase: 'turn', payload: payload({ session_id: id }) });
    }
    runBudgetHook({ phase: 'start', payload: payload({ session_id: 'leader' }), refreshDeadlineMs: -1 });
    const ledger = readLedger(ledgerPath(project));
    expect(Object.values(ledger.sessions).filter((r) => r.scan?.checkedSize !== undefined)).toHaveLength(1);
    expect(ledger.refreshCursor).toBe(1);
  });

  it('does nothing under the kill switch', () => {
    writeBudget({ softLimit: 1 });
    writeEvents(SID, [PROMPT]);
    expect(runBudgetHook({ phase: 'turn', payload: payload(), env: { ...process.env, OMC_BUDGET_GOVERNOR: '0' } })).toBeNull();
    expect(readLedger(ledgerPath(project)).sessions).toEqual({});
  });
});

describe('omg budget and the HUD element', () => {
  it('reports status as JSON, exits 0 even past a deprecated hard limit, and resets', async () => {
    writeBudget({ softLimit: 1, hardLimit: 2 });
    recordUsage(ledgerPath(project), 's1', record(1, 'measured', 2));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await budgetCommand('status', { json: true }, project)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ used: 2, settings: { softLimit: 1, deprecated: ['budget.hardLimit'] }, totals: { sessions: 1 } });
      expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({ ok: true, previous: { credits: 2, premiumRequests: 1 } });
      expect(readLedger(ledgerPath(project)).sessions).toEqual({});
    } finally {
      log.mockRestore();
    }
  });

  it('fails a reset cleanly while another process holds the ledger lock', async () => {
    const path = ledgerPath(project);
    recordUsage(path, 's1', record(2));
    const handle = acquireFileLockSync(lockPathFor(path));
    expect(handle).not.toBeNull();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await budgetCommand('reset', {}, project)).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/^omg budget reset: the ledger is locked by another process .*; try again in a moment\.$/);
      expect(readLedger(path).sessions.s1?.premiumRequests).toBe(2);
    } finally {
      error.mockRestore();
      releaseFileLockSync(handle!);
    }
  });

  it('prints the deprecation once in the text status', async () => {
    writeBudget({ mode: 'enforce', unit: 'premiumRequests' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await budgetCommand('status', {}, project)).toBe(0);
      const out = log.mock.calls.flat().join('\n');
      expect(out.match(/deprecated and ignored/g)).toHaveLength(1);
      expect(out).toMatch(/budget\.mode, budget\.unit "premiumRequests": deprecated and ignored/);
    } finally {
      log.mockRestore();
    }
  });

  it('renders cr:used/softLimit, with ~ when part is estimated, only when a soft limit exists', () => {
    expect(renderPremiumBudget(project)).toBeNull();
    writeBudget({ hardLimit: 5 });
    expect(renderPremiumBudget(project)).toBeNull();
    writeBudget({ softLimit: 2, hardLimit: 5, unit: 'premiumRequests' });
    recordUsage(ledgerPath(project), 's1', record(3, 'estimated', 2.25));
    expect(renderPremiumBudget(project)?.replace(/\x1b\[[0-9;]*m/g, '')).toBe('cr:~2.3/2');
  });
});

describe('omg team --budget-override', () => {
  it('still parses the deprecated flag', () => {
    expect(parseTeamArgs(['2:copilot', '--budget-override', 'fix it']).budgetOverride).toBe(true);
    expect('budgetOverride' in parseTeamArgs(['2:copilot', 'fix it'])).toBe(false);
  });
});

describe('scripts/premium-budget.mjs', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'premium-budget.mjs');
  const run = (scriptPath: string, phase: string, input: string) => spawnSync(process.execPath, [scriptPath, phase], {
    input, encoding: 'utf8', timeout: 20_000, env: { ...process.env, OMC_DEBUG_HOOKS: '' },
  });
  const noop = { continue: true, suppressOutput: true };

  it('prints the no-op for bad stdin and unknown phases', () => {
    for (const [phase, input] of [['turn', 'not json'], ['turn', ''], ['session-start', '{}']] as const) {
      const r = run(script, phase, input);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(noop);
    }
  });

  it('prints the no-op when the dist build is missing', () => {
    const copy = join(root, 'plugin', 'scripts');
    mkdirSync(join(copy, 'lib'), { recursive: true });
    copyFileSync(script, join(copy, 'premium-budget.mjs'));
    copyFileSync(join(dirname(script), 'lib', 'stdin.mjs'), join(copy, 'lib', 'stdin.mjs'));
    expect(existsSync(join(root, 'plugin', 'dist'))).toBe(false);
    const r = run(join(copy, 'premium-budget.mjs'), 'turn', JSON.stringify({ session_id: SID, cwd: project }));
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(noop);
  });
});

it('keeps the ledger as readable JSON', () => {
  recordUsage(ledgerPath(project), 's1', record(1));
  expect(JSON.parse(readFileSync(ledgerPath(project), 'utf8')).version).toBe(1);
});
