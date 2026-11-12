import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryDashboardCommand } from '../../../cli/commands/factory-dashboard.js';
import { createFactoryState, moveTo, overwriteFactoryState, setGate, type FactoryLaneRecord, type FactoryRunState } from '../../run/state.js';
import { collectDashboard, phaseDurations } from '../collect.js';
import { esc, renderDashboardHtml } from '../render.js';

let root: string;
beforeEach(() => { vi.stubEnv('OMC_STATE_DIR', ''); root = mkdtempSync(join(tmpdir(), 'omg-dash-')); execFileSync('git', ['init', '-q', root]); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); process.exitCode = undefined; });

const lane = (id: string, kind: FactoryLaneRecord['kind'], credits: number, end: string, extra: Partial<FactoryLaneRecord> = {}): FactoryLaneRecord => ({
  id, kind, startSha: 'a', status: 'completed', maxCredits: 5, startedAt: end, endedAt: end, usage: { credits, premiumRequests: 1, source: 'measured' }, ...extra,
});

function run(issue: number, title: string, build: (s: FactoryRunState) => FactoryRunState): FactoryRunState {
  let s = createFactoryState({ issue, repoUrl: 'https://example.invalid/r', base: 'main' }, '2026-11-10T10:00:00.000Z');
  s = { ...s, issueTitle: title };
  s = build(s);
  overwriteFactoryState(root, issue, s);
  return s;
}

describe('collectDashboard', () => {
  it('sums credits per role and day, counts parks and times phases', () => {
    run(1, 'First', (s) => {
      let x = moveTo(s, 'implement', 'go', '2026-11-10T10:10:00.000Z');
      x = setGate(x, 'secret-scan', 'found one', '2026-11-10T10:20:00.000Z');
      x = moveTo(x, 'review', 'again', '2026-11-10T10:30:00.000Z');
      x = { ...x, updatedAt: '2026-11-10T10:40:00.000Z', lanes: [lane('l1', 'implement', 2, '2026-11-10T10:20:00.000Z'), lane('l2', 'review', 1.5, '2026-11-11T09:00:00.000Z'), lane('l3', 'fix', 1, '2026-11-11T09:30:00.000Z', { role: 'ci-fix' })], elapsedMs: 120_000 };
      return x;
    });
    run(2, 'Second', (s) => ({ ...setGate(s, 'secret-scan', 'again', '2026-11-10T11:00:00.000Z'), lanes: [lane('l1', 'implement', 3, '2026-11-11T12:00:00.000Z')] }));

    const d = collectDashboard(root, { now: () => new Date('2026-11-12T00:00:00.000Z') });
    expect(d.totals).toMatchObject({ runs: 2, lanes: 4, credits: 7.5, premiumRequests: 4 });
    expect(d.byRole).toEqual([
      { role: 'implement', credits: 5, premiumRequests: 2, lanes: 2 },
      { role: 'review', credits: 1.5, premiumRequests: 1, lanes: 1 },
      { role: 'ci-fix', credits: 1, premiumRequests: 1, lanes: 1 },
    ]);
    expect(d.byDay).toEqual([
      { day: '2026-11-10', credits: 2, premiumRequests: 1, lanes: 1 },
      { day: '2026-11-11', credits: 5.5, premiumRequests: 3, lanes: 3 },
    ]);
    expect(d.parkReasons).toEqual([{ name: 'secret-scan', count: 2 }]);
    const one = d.runs.find((r) => r.key === '#1')!;
    expect(one.phaseMs).toEqual({ intake: 600_000, implement: 1_200_000, review: 600_000 });
  });

  it('--since drops older runs and days', () => {
    run(1, 'Old', (s) => ({ ...s, updatedAt: '2026-11-01T00:00:00.000Z', lanes: [lane('l1', 'implement', 2, '2026-11-01T00:00:00.000Z')] }));
    run(2, 'New', (s) => ({ ...s, updatedAt: '2026-11-11T00:00:00.000Z', lanes: [lane('l1', 'implement', 3, '2026-11-11T00:00:00.000Z')] }));
    const d = collectDashboard(root, { since: '2026-11-05' });
    expect(d.runs.map((r) => r.key)).toEqual(['#2']);
    expect(d.byDay.map((x) => x.day)).toEqual(['2026-11-11']);
    expect(() => collectDashboard(root, { since: 'yesterday' })).toThrow(/--since/);
  });

  it('terminal phase has no open-ended duration', () => {
    const s = moveTo(moveTo(createFactoryState({ issue: 3, repoUrl: 'x', base: 'main' }, '2026-11-10T10:00:00.000Z'), 'implement', 'n', '2026-11-10T10:01:00.000Z'), 'failed', 'n', '2026-11-10T10:02:00.000Z');
    expect(phaseDurations({ ...s, updatedAt: '2026-11-10T12:00:00.000Z' })).toEqual({ intake: 60_000, implement: 60_000 });
  });

  it('reads bench results with a schemaVersion and skips the rest', () => {
    mkdirSync(join(root, 'bench-results'));
    writeFileSync(join(root, 'bench-results', 'a.json'), JSON.stringify({ schemaVersion: 1, mode: 'fake', totals: { passRate: 0.9, nested: { x: 1 } }, issues: [{ id: 'i1', outcome: 'pass', expect: 'merged-park' }, { bogus: true }], extra: 'ignored' }));
    writeFileSync(join(root, 'bench-results', 'b.json'), JSON.stringify({ nothing: 1 }));
    writeFileSync(join(root, 'bench-results', 'c.json'), '{broken');
    const d = collectDashboard(root);
    expect(d.bench).toHaveLength(1);
    expect(d.bench[0]).toMatchObject({ file: 'a.json', mode: 'fake', totals: { passRate: 0.9 }, issues: [{ id: 'i1', outcome: 'pass', expect: 'merged-park' }] });
    expect(d.warnings.filter((w) => w.startsWith('bench-results/'))).toHaveLength(2);
  });

  it('an unreadable run state is a warning, not a crash', () => {
    mkdirSync(join(root, '.omg', 'state', 'factory'), { recursive: true });
    writeFileSync(join(root, '.omg', 'state', 'factory', 'run-9.json'), 'nope');
    const d = collectDashboard(root);
    expect(d.runs).toEqual([]);
    expect(d.warnings.join('\n')).toMatch(/#9/);
  });
});

describe('renderDashboardHtml', () => {
  it('escapes untrusted titles, park text and bench rows and carries no script or external URL', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    run(1, evil, (s) => setGate(s, 'x', evil, '2026-11-10T10:05:00.000Z'));
    mkdirSync(join(root, 'bench-results'));
    writeFileSync(join(root, 'bench-results', 'a.json'), JSON.stringify({ schemaVersion: 1, mode: evil, issues: [{ id: evil, outcome: evil }] }));
    const html = renderDashboardHtml(collectDashboard(root));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/(src|href)=["']?https?:/i);
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain("default-src 'none'");
  });

  it('esc covers the five dangerous characters', () => {
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('omg factory dashboard command', () => {
  const deps = (out: string[], err: string[]) => ({ root: () => root, out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date('2026-11-12T00:00:00.000Z') });

  it('prints html, writes --out and emits --json', async () => {
    run(1, 'T', (s) => s);
    const out: string[] = []; const err: string[] = [];
    await factoryDashboardCommand(deps(out, err)).parseAsync([], { from: 'user' });
    expect(out.join('')).toMatch(/^<!doctype html>/);
    const file = join(root, 'dash.html');
    await factoryDashboardCommand(deps(out, err)).parseAsync(['--out', file], { from: 'user' });
    expect(readFileSync(file, 'utf8')).toContain('Factory dashboard');
    const j: string[] = [];
    await factoryDashboardCommand(deps(j, err)).parseAsync(['--json'], { from: 'user' });
    expect(JSON.parse(j.join('')).schemaVersion).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it('a bad --since exits with the usage code', async () => {
    const err: string[] = [];
    await factoryDashboardCommand(deps([], err)).parseAsync(['--since', 'bad'], { from: 'user' });
    expect(process.exitCode).toBe(2);
  });
});
