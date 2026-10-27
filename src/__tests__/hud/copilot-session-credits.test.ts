import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderPremiumBudget } from '../../hud/elements/premium-budget.js';
import { readCopilotEvents } from '../../hud/copilot-events.js';

const plain = (s: string | null) => s?.replace(/\x1b\[[0-9;]*m/g, '') ?? null;

describe('Copilot session credits (cr:)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hud-credits-'));
    // getConfigDir() reads APPDATA on Windows and XDG_CONFIG_HOME elsewhere: keep the real user budget config out.
    vi.stubEnv('APPDATA', join(cwd, 'config'));
    vi.stubEnv('XDG_CONFIG_HOME', join(cwd, 'config'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  const cr = (nanoAiu: number | null, formatted: string | null = null) =>
    plain(renderPremiumBudget(cwd, { nanoAiu, formatted }));

  it('converts total_nano_aiu and ignores the formatted text when the number is present', () => {
    expect(cr(4_200_000_000, '999 AIU')).toBe('cr:4.2');
  });

  it('falls back to formatted only when the number is missing', () => {
    expect(cr(null, '3.1')).toBe('cr:3.1');
    expect(cr(null, null)).toBeNull();
  });

  it('shows 2 decimals below 0.1 credit and hides only at exactly zero', () => {
    expect(cr(40_000_000)).toBe('cr:0.04');
    expect(cr(99_000_000)).toBe('cr:0.1');
    expect(cr(100_000_000)).toBe('cr:0.1');
    expect(cr(3_000_000)).toBe('cr:<0.01');
    expect(cr(0)).toBeNull();
  });
});

describe('Copilot reasoning effort seeding', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hud-effort-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const read = (lines: object[]) => {
    const file = join(root, 'events.jsonl');
    mkdirSync(root, { recursive: true });
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return readCopilotEvents(file).reasoningEffort;
  };

  it('seeds from session.start', () => {
    expect(read([{ type: 'session.start', data: { reasoningEffort: 'medium' } }])).toBe('medium');
  });

  it('seeds from session.resume and lets model_change override', () => {
    expect(read([{ type: 'session.resume', data: { reasoningEffort: 'low' } }])).toBe('low');
    expect(read([
      { type: 'session.start', data: { reasoningEffort: 'low' } },
      { type: 'session.model_change', data: { reasoningEffort: 'high' } },
    ])).toBe('high');
  });
});
