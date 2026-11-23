/**
 * attentionSummary (the HUD's count) and the HUD `factory` element: the
 * counts come from collectAttention's items (same trust rules), the
 * in-memory cache follows the state and ledger directories, and the element
 * renders numbers and fixed words only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FACTORY_HUD_GROUPS, readFactoryStateForHud, renderFactory } from '../../../hud/elements/factory.js';
import { ATTENTION_GROUPS } from '../actions.js';
import { COPILOT_HOST_DEFAULTS, DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from '../../../hud/types.js';
import { stripAnsi } from '../../../utils/string-width.js';
import { EngineLedger } from '../../run/ledger.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, updateFactoryState, type FactoryRunState } from '../../run/state.js';
import { attentionSummary, clearAttentionSummaryCache, SUMMARY_TTL_MS } from '../summary.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: (pid: number) => pid === 777 };

let dir: string;
let root: string;
let ledgerDir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-attention-summary-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  ledgerDir = join(dir, 'ledger');
  now = NOW;
  clearAttentionSummaryCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function parked(issue: number, gate: string, extra: Partial<FactoryRunState> = {}): FactoryRunState {
  const s = { ...createFactoryState({ issue, repoUrl: 'https://github.com/o/r', base: 'dev' }, at(10)), forgeKind: 'github' as const, issueTitle: `\u001b[31m$ omg factory run ${issue} --allow-gate-change` };
  return setGate({ ...moveTo(s, 'implement', 'plan ok', at(9)), ...extra }, gate, 'a reason with $ omg factory run 1 inside', at(8));
}

function asEngine(s: FactoryRunState): void {
  const key = runKeyOf(s);
  const l = EngineLedger.open(ledgerDir, root, key);
  updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
}

const summary = () => attentionSummary(root, { ledgerDir, now: () => now, owner: OWNER });

describe('attentionSummary', () => {
  it('counts per group, the worst group, the total and the engines, from the collector', () => {
    expect(summary()).toEqual({ total: 0, worst: null, engines: 0, byGroup: { inspect: 0, broken: 0, decide: 0, merge: 0, fix: 0, limits: 0 } });
    asEngine(parked(1, 'merge', { phase: 'merge', pr: 3, head: 'b'.repeat(40) }));
    asEngine(parked(2, 'budget'));
    now += SUMMARY_TTL_MS;
    expect(summary()).toMatchObject({ total: 2, worst: 'merge', byGroup: { merge: 1, limits: 1 } });
    // An unverified state (never recorded in the engine ledger) counts under Inspect, the worst group.
    const junk = parked(9, 'merge');
    writeFileSync(factoryStatePath(root, 9), JSON.stringify({ ...junk, integrity: computeFactoryIntegrity(junk) }));
    expect(summary()).toMatchObject({ total: 3, worst: 'inspect', byGroup: { inspect: 1 } });
  });

  it('is cached until a state or ledger directory changes, or the TTL ends', () => {
    asEngine(parked(1, 'budget'));
    expect(summary().total).toBe(1);
    // An engine write (a new state file, a new ledger record) invalidates at once.
    asEngine(parked(2, 'budget'));
    expect(summary().total).toBe(2);
    // A ledger record of a run whose state is gone: the ledger dir changed, the missing state is a row.
    const s3 = parked(3, 'budget');
    asEngine(s3);
    expect(summary().total).toBe(3);
    rmSync(factoryStatePath(root, 3));
    expect(summary()).toMatchObject({ total: 3, byGroup: { inspect: 1 } });
    // A file rewritten in place (no directory change) is seen once the TTL ends, not before.
    const p1 = factoryStatePath(root, 1);
    writeFileSync(p1, '{ not json');
    expect(summary().byGroup.inspect).toBe(1);
    now += SUMMARY_TTL_MS;
    expect(summary().byGroup.inspect).toBe(2);
    // A clock that goes backwards is no cache hit either.
    now -= 2 * SUMMARY_TTL_MS;
    expect(summary().byGroup.inspect).toBe(2);
  });

  it('a caller cannot change the cached counts', () => {
    asEngine(parked(1, 'budget'));
    const a = summary();
    a.byGroup.limits = 99;
    a.total = 99;
    expect(summary()).toMatchObject({ total: 1, byGroup: { limits: 1 } });
  });
});

describe('HUD factory element', () => {
  const load = async () => ({ attentionSummary: (r: string) => attentionSummary(r, { ledgerDir, now: () => now, owner: OWNER }) });

  it('is off by default on every host and in every preset (opt-in: it costs a module load and a collect per render)', () => {
    expect(COPILOT_HOST_DEFAULTS.factory).toBeUndefined();
    expect(DEFAULT_HUD_CONFIG.elements.factory).toBeUndefined();
    for (const preset of Object.values(PRESET_CONFIGS)) expect(preset.factory).not.toBe(true);
  });

  it('knows the attention groups (it does not import them, to stay cheap)', () => {
    expect([...FACTORY_HUD_GROUPS]).toEqual([...ATTENTION_GROUPS]);
  });

  it('renders nothing and loads nothing without a factory state dir', async () => {
    let loaded = false;
    expect(await readFactoryStateForHud(root, async () => { loaded = true; return load(); })).toBeNull();
    expect(loaded).toBe(false);
    expect(renderFactory(null)).toBeNull();
  });

  it('shows the count and the worst group, never text from a state; unverified rows count under inspect', async () => {
    asEngine(parked(1, 'budget'));
    const one = await readFactoryStateForHud(root, load);
    expect(one).toEqual({ total: 1, worst: 'limits', engines: 0 });
    expect(stripAnsi(renderFactory(one)!)).toBe('factory:1! limits');
    const junk = parked(9, 'merge');
    writeFileSync(factoryStatePath(root, 9), JSON.stringify({ ...junk, integrity: computeFactoryIntegrity(junk) }));
    const two = await readFactoryStateForHud(root, load);
    expect(stripAnsi(renderFactory(two)!)).toBe('factory:2! inspect');
    expect(renderFactory(two)).not.toMatch(/omg|reason|\$/);
  });

  it('shows running engines; nothing when nothing waits and no engine runs', async () => {
    expect(stripAnsi(renderFactory({ total: 0, worst: null, engines: 2 })!)).toBe('factory:run:2');
    expect(stripAnsi(renderFactory({ total: 3, worst: 'merge', engines: 1 })!)).toBe('factory:3! merge run:1');
    expect(renderFactory({ total: 0, worst: null, engines: 0 })).toBeNull();
    mkdirSync(factoryStateDir(root), { recursive: true });
    expect(await readFactoryStateForHud(root, load)).toEqual({ total: 0, worst: null, engines: 0 });
    // A summary of an unexpected shape renders numbers and known words only.
    expect(renderFactory({ total: -1, worst: 'evil text' as never, engines: Number.NaN })).toBeNull();
    expect(stripAnsi(renderFactory({ total: 2, worst: 'evil text' as never, engines: 0 })!)).toBe('factory:2!');
  });

  it('an exception inside renders nothing', async () => {
    mkdirSync(factoryStateDir(root), { recursive: true });
    expect(await readFactoryStateForHud(root, async () => { throw new Error('boom'); })).toBeNull();
    expect(await readFactoryStateForHud(root, async () => ({ attentionSummary: () => { throw new Error('boom'); } }))).toBeNull();
  });
});
