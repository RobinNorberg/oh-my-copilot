import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeFactoryIntegrity, createFactoryState, setGate, type FactoryRunKey, type FactoryRunState } from '../../run/state.js';
import { TEAM_ROUTING_PATH } from '../context.js';
import { remindersPath, staleGateReminders } from '../reminders.js';

const T0 = Date.parse('2026-11-09T00:00:00.000Z');
const H = 3_600_000;
let root: string;
let ledgerDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-remind-'));
  ledgerDir = `${root}-ledger`;
  execFileSync('git', ['init', '-q', root]);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); });

const seal = (s: FactoryRunState): FactoryRunState => ({ ...s, integrity: computeFactoryIntegrity(s) });
const parked = (issue: number, at: number, plan = 'edit src/a/b.ts'): [FactoryRunKey, FactoryRunState] => [issue,
  seal(setGate({ ...createFactoryState({ issue, repoUrl: 'u', base: 'dev' }, new Date(at).toISOString()), plan: { source: 'issue-body', text: plan } }, 'merge', 'ready‮', new Date(at).toISOString()))];
const readBase = (p: string) => (p === TEAM_ROUTING_PATH ? '| src/** | - | core | @robin |\n| ** | - | all | @lead |' : undefined);

describe('staleGateReminders', () => {
  it('is off without a window', () => {
    const runs = new Map([parked(1, T0)]);
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 99 * H, afterHours: 0 })).toEqual([]);
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 99 * H, afterHours: undefined })).toEqual([]);
    expect(existsSync(remindersPath(ledgerDir, root))).toBe(false);
  });

  it('waits for the window, reminds once, then again a window later', () => {
    const runs = new Map([parked(1, T0)]);
    const at = (h: number) => staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + h * H, afterHours: 24, readBase });
    expect(at(23)).toEqual([]);
    const first = at(25);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ run: 1, gate: 'merge', hours: 25, handles: ['@robin'] });
    expect(first[0].reason).toContain('<U+202E>');
    expect(at(26)).toEqual([]);
    expect(at(48)).toEqual([]);
    expect(at(49)).toHaveLength(1);
  });

  it('a new gate on the same run restarts the window; a cleared gate is forgotten', () => {
    const runs = new Map([parked(1, T0)]);
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 30 * H, afterHours: 24 })).toHaveLength(1);
    const renewed = new Map([parked(1, T0 + 40 * H)]);
    expect(staleGateReminders({ root, ledgerDir, runs: renewed, nowMs: T0 + 50 * H, afterHours: 24 })).toEqual([]);
    expect(staleGateReminders({ root, ledgerDir, runs: new Map(), nowMs: T0 + 60 * H, afterHours: 24 })).toEqual([]);
    expect(JSON.parse(readFileSync(remindersPath(ledgerDir, root), 'utf8'))).toEqual({});
  });

  it('keeps its record in the host ledger, keyed per repository; a forged in-repo record of older versions is ignored and kept', () => {
    const runs = new Map([parked(1, T0)]);
    const legacy = join(root, '.omg', 'state', 'factory', 'reminders.json');
    mkdirSync(join(legacy, '..'), { recursive: true });
    // Under the old in-repo record this would postpone the reminder for a long time, then repeat it every tick.
    const forged = JSON.stringify({ '#1': { gateAt: new Date(T0).toISOString(), remindedAt: '2999-01-01T00:00:00.000Z' } });
    writeFileSync(legacy, forged);
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 25 * H, afterHours: 24 })).toHaveLength(1);
    expect(remindersPath(ledgerDir, root).startsWith(join(ledgerDir, 'reminders'))).toBe(true);
    expect(existsSync(remindersPath(ledgerDir, root))).toBe(true);
    writeFileSync(legacy, JSON.stringify({ '#1': { gateAt: new Date(T0).toISOString(), remindedAt: '2000-01-01T00:00:00.000Z' } }));
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 26 * H, afterHours: 24 })).toEqual([]);
    expect(readFileSync(legacy, 'utf8')).toContain('2000-01-01');
    // Another repository has its own record.
    const other = `${root}-other`;
    expect(remindersPath(ledgerDir, other)).not.toBe(remindersPath(ledgerDir, root));
  });

  it('the record only postpones: never a reminder of a park younger than the window, a future time counts as now', () => {
    const runs = new Map([parked(1, T0)]);
    const gateAt = new Date(T0).toISOString();
    const put = (remindedAt: string) => { mkdirSync(join(remindersPath(ledgerDir, root), '..'), { recursive: true }); writeFileSync(remindersPath(ledgerDir, root), JSON.stringify({ '#1': { gateAt, remindedAt } })); };
    const at = (h: number) => staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + h * H, afterHours: 24 });
    // An absurdly old remindedAt: no reminder before the sealed park time is a window old, then one.
    put('2000-01-01T00:00:00.000Z');
    expect(at(0)).toEqual([]);
    expect(at(23)).toEqual([]);
    expect(at(25)).toHaveLength(1);
    // A future remindedAt postpones by one window from when it was read (kept clamped), not forever.
    put('2999-01-01T00:00:00.000Z');
    expect(at(30)).toEqual([]);
    expect(JSON.parse(readFileSync(remindersPath(ledgerDir, root), 'utf8'))['#1'].remindedAt).toBe(new Date(T0 + 30 * H).toISOString());
    expect(at(53)).toEqual([]);
    expect(at(54)).toHaveLength(1);
  });

  it('falls back to the catch-all handle when the plan names no path, and works without a base', () => {
    const runs = new Map([parked(2, T0, 'no paths here')]);
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 30 * H, afterHours: 24, readBase })[0].handles).toEqual(['@lead']);
    const runs2 = new Map([parked(3, T0)]);
    expect(staleGateReminders({ root, ledgerDir, runs: runs2, nowMs: T0 + 30 * H, afterHours: 24 })[0].handles).toEqual([]);
  });

  it('skips terminal runs and runs without a gate', () => {
    const [, gated] = parked(4, T0);
    const { gate: _g, ...noGate } = gated;
    const runs = new Map<FactoryRunKey, FactoryRunState>([[4, noGate as FactoryRunState], [5, seal({ ...gated, phase: 'merged' })]]);
    expect(staleGateReminders({ root, ledgerDir, runs, nowMs: T0 + 99 * H, afterHours: 24, readBase })).toEqual([]);
  });

  it('skips a run that fails the integrity seal and says so', () => {
    const [key, state] = parked(7, T0);
    const warns: string[] = [];
    const tampered = { ...state, phase: 'review' } as FactoryRunState;
    const r = staleGateReminders({ root, ledgerDir, runs: new Map([[key, tampered]]), nowMs: T0 + 30 * H, afterHours: 24, warn: (m) => warns.push(m) });
    expect(r).toEqual([]);
    expect(warns).toEqual([expect.stringContaining('unsound')]);
  });

  it('shows a hostile gate name with visible characters', () => {
    const [key, state] = parked(8, T0);
    const forged = seal(setGate(state, 'merge‮\u001b[31m', 'x', new Date(T0).toISOString()));
    const r = staleGateReminders({ root, ledgerDir, runs: new Map([[key, forged]]), nowMs: T0 + 30 * H, afterHours: 24 });
    expect(r[0].gate).toContain('<U+202E>');
    expect(r[0].gate).not.toContain('\u001b');
  });

  it('a throwing base read warns and still reminds without handles', () => {
    const warns: string[] = [];
    const r = staleGateReminders({ root, ledgerDir, runs: new Map([parked(6, T0)]), nowMs: T0 + 30 * H, afterHours: 24, readBase: () => { throw new Error('boom'); }, warn: (m) => warns.push(m) });
    expect(r[0].handles).toEqual([]);
    expect(warns[0]).toContain('boom');
  });
});
