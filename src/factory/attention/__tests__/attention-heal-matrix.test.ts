/**
 * The heal-signature matrix: ci-heal run state x heal record x host heal seal
 * (8 x 12 x 4 = 384 cases). A lane can write the run state and the heal
 * record, never the host seal or the engine ledger. For every case: no hidden
 * heal row while the seal says open (or predates the open flag), no billed
 * command unless the run state is absent and unrecorded or trusted, and at
 * most one row per key. A heal run whose sealed record says it is closed gets
 * no billed command at all (attention withholds the resume the engine would
 * still take for an existing run state).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healStateDir, healStatePath, readHealState, writeHealState, type HealSignatureState } from '../../heal/state.js';
import { healLedgerDir, verifyHealSeal, writeHealSeal } from '../../heal/run.js';
import { EngineLedger } from '../../run/ledger.js';
import { createFactoryState, factoryStatePath, moveTo, readFactoryState, runKeyOf, setGate, TERMINAL_FACTORY_PHASES, updateFactoryState, verifyFactoryIntegrity, type FactoryRunState } from '../../run/state.js';
import { collectAttention } from '../collect.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const SIG = '0123abcd';
const KEY = `heal-${SIG}` as const;
const OWNER = { pid: 1, hostname: 'h', isAlive: (p: number) => p === process.pid };

const RUNS = ['absent', 'trusted-nonterminal', 'trusted-parked', 'merged', 'cancelled', 'failed', 'untrusted', 'deleted-in-ledger'] as const;
const RECS = ['intact', 'deleted', 'garbage', 'directory', 'edited-closed', 'edited-open', 'next-report', 'next-heal-diagnosis', 'stripped', 'lane-running', 'other-sig8', 'heal-dir-deleted'] as const;
const SEALS = ['open', 'closed', 'old-no-flag', 'absent'] as const;
type Run = typeof RUNS[number];
type Rec = typeof RECS[number];
type Seal = typeof SEALS[number];

function healState(open: boolean): HealSignatureState {
  const s = {
    version: 1, sig8: SIG, signature: 'sig', class: 'test-regression', classification: { sig8: SIG, class: 'test-regression', laneEligible: true }, source: 'push',
    firstSeen: { runId: 1, at: at(30) }, lastSeen: { runId: 1, at: at(30) }, count: 1, seenRuns: [1], next: open ? 'heal-approve' : 'report', rerunIntents: [], updatedAt: at(20),
    healRun: { id: KEY, open: true, startedAt: at(21) } as Record<string, unknown>,
    lanes: [{ id: `${KEY}-debug-1`, kind: 'debug', status: 'done', pid: 999, startedAt: at(21) }],
    diagnosis: { outcome: 'valid', laneId: `${KEY}-debug-1` },
  };
  if (!open) s.healRun = { ...s.healRun, open: false, closedAt: at(19) };
  return s as unknown as HealSignatureState;
}

let dir: string;
let root: string;
let n = 0;
let cases = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-attention-heal-matrix-'));
  root = join(dir, 'repo');
  execFileSync('git', ['init', '-q', root]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One case on the shared checkout: its state tree is reset, the ledger directory is new. */
function setUp(run: Run, rec: Rec, seal: Seal): string {
  rmSync(join(root, '.omg'), { recursive: true, force: true });
  const ledgerDir = join(dir, `l${++n}`);
  const s = healState(seal !== 'closed');
  writeHealState(root, s);
  writeHealSeal(ledgerDir, root, s);
  const sealFile = join(healLedgerDir(ledgerDir, root), `${SIG}.seal.json`);
  if (seal === 'old-no-flag') {
    const j = JSON.parse(readFileSync(sealFile, 'utf8')) as Record<string, unknown>;
    delete j.open;
    writeFileSync(sealFile, JSON.stringify(j));
  }
  if (seal === 'absent') unlinkSync(sealFile);
  if (run !== 'absent') {
    const st = createFactoryState({ issue: 0, repoUrl: 'https://github.com/o/r', base: 'dev', heal: { sig8: SIG, class: 'test-regression', firstRed: { runId: '1', sha: 'c'.repeat(40) }, failingTests: [], env: [], diagnosis: { class: 'x', rootCause: 'y', evidence: [] } } } as unknown as Parameters<typeof createFactoryState>[0], at(10));
    let fin: FactoryRunState;
    if (run === 'trusted-nonterminal') fin = moveTo(st, 'implement', 'x', at(9));
    else if (run === 'trusted-parked') fin = setGate(moveTo(st, 'implement', 'x', at(9)), 'heal-approve', 'x', at(9));
    else fin = moveTo(st, run === 'cancelled' || run === 'failed' ? run : 'merged', 'done', at(9));
    const key = runKeyOf(fin);
    const l = EngineLedger.open(ledgerDir, root, key);
    updateFactoryState(root, key, () => fin, { onWrite: (p, c) => l.record(p, c) });
    const sp = factoryStatePath(root, key);
    if (run === 'untrusted') writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, 'utf8')), issueTitle: 'X' }));
    if (run === 'deleted-in-ledger') unlinkSync(sp);
  }
  const p = healStatePath(root, SIG);
  const cur = JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
  const put = (v: unknown) => writeFileSync(p, JSON.stringify(v));
  switch (rec) {
    case 'deleted': unlinkSync(p); break;
    case 'garbage': writeFileSync(p, 'garbage'); break;
    case 'directory': unlinkSync(p); mkdirSync(p); break;
    case 'edited-closed': put({ ...cur, healRun: { ...cur.healRun, open: false } }); break;
    case 'edited-open': put({ ...cur, healRun: { ...cur.healRun, open: true } }); break;
    case 'next-report': put({ ...cur, next: 'report' }); break;
    case 'next-heal-diagnosis': put({ ...cur, next: 'heal-diagnosis' }); break;
    case 'stripped': { const { healRun: _h, lanes: _l, diagnosis: _d, ...rest } = cur; put(rest); break; }
    case 'lane-running': put({ ...cur, lanes: [{ ...cur.lanes[0], status: 'running', pid: process.pid }] }); break;
    case 'other-sig8': put({ ...cur, sig8: 'ffffffff', classification: { ...cur.classification, sig8: 'ffffffff' } }); break;
    case 'heal-dir-deleted': rmSync(healStateDir(root), { recursive: true, force: true }); break;
  }
  return ledgerDir;
}

/**
 * The engine's own checks for `heal approve` (runHealEngine, then the engine's start()): a sealed heal record, then
 * either a run state the engine resumes (its ledger holds these bytes, the seal holds, not finished) or none at all
 * with an open heal run and no ledger record of a write that is gone (else state-tampered). `next` is left out: it
 * is not sealed, and runHealEngine refuses on it before any lane.
 */
function engineTakesApprove(ledgerDir: string): boolean {
  const s = readHealState(root, SIG);
  if (!s || verifyHealSeal(ledgerDir, root, s) !== 'ok') return false;
  const path = factoryStatePath(root, KEY);
  const ledger = EngineLedger.open(ledgerDir, root, KEY);
  const existing = readFactoryState(root, KEY);
  if (existing !== null) {
    return ledger.tracks(path) && ledger.matches(path, readFileSync(path)) && verifyFactoryIntegrity(existing) && !TERMINAL_FACTORY_PHASES.includes(existing.phase);
  }
  // No run state: the engine refuses an approve whose heal record does not stand at heal-approve (`next`, checked before any lane).
  return s.healRun?.open === true && s.next === 'heal-approve' && typeof ledger.recorded(path) !== 'string';
}

describe('factory attention: ci-heal run state x heal record x heal seal', () => {
  for (const run of RUNS) {
    it(`run state ${run}: every heal record and seal`, () => {
      for (const rec of RECS) {
        for (const seal of SEALS) {
          const ledgerDir = setUp(run, rec, seal);
          cases += 1;
          const d = collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER });
          const where = `${run}/${rec}/seal=${seal}`;
          const keys = d.items.map((i) => i.key);
          expect(new Set(keys).size, `${where}: one row per key (${keys.join(', ')})`).toBe(keys.length);
          // A trusted run state stands in for the heal signature (its own row, or no row while it runs or is done).
          if ((seal === 'open' || seal === 'old-no-flag') && !run.startsWith('trusted')) {
            expect(keys, `${where}: the heal row`).toContain(KEY);
          }
          const billed = d.items.flatMap((i) => i.next.filter((c) => c.billed).map((c) => c.argv.slice(2).join(' ')));
          if (run !== 'absent' && !run.startsWith('trusted')) expect(billed, `${where}: no billed command`).toEqual([]);
          // The host seal says the heal run is closed: never a billed approve, whatever the run state.
          if (seal === 'closed') expect(billed, `${where}: no billed command on a closed heal run`).toEqual([]);
          for (const c of billed) {
            expect(c, where).toBe(`heal approve ${SIG}`);
            expect(engineTakesApprove(ledgerDir), `${where}: the engine takes ${c}`).toBe(true);
          }
        }
      }
    }, 120_000);
  }

  it('ran every case (8 x 12 x 4)', () => {
    expect(RUNS.length * RECS.length * SEALS.length).toBe(384);
    expect(cases).toBe(384);
  });
});
