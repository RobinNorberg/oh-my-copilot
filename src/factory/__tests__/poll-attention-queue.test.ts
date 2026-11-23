/**
 * `omg factory poll`'s attention step under a lane that writes `.omg/`: rows
 * whose state is not trusted are only counted (one line when the count
 * changes, one count notice per hour), so they can never delay or suppress a
 * trusted item's line or notice. Trusted notices past the per-tick cap or the
 * rate limit wait in a bounded queue and go out later, oldest first; a send
 * that never settles is aborted and abandoned at the tick's timeout.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../forge/index.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import type { AnyAttentionNotice } from '../attention/notify.js';
import { EngineLedger } from '../run/ledger.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, updateFactoryState, type FactoryRunState } from '../run/state.js';
import { ATTENTION_COUNT_NOTICE_WINDOW_MS, ATTENTION_NOTICE_ITEMS, ATTENTION_QUEUE_MAX, runFactoryPoll, type FactoryPollDeps, type PollTick } from '../poll.js';

const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const STEP_MS = 5 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const REPO = 'https://github.com/o/r';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

let dir: string;
let root: string;
let ledgerDir: string;
let out: string[];
let notices: Array<{ tick: number; n: AnyAttentionNotice }>;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-poll-attention-queue-'));
  root = join(dir, 'repo');
  execFileSync('git', ['init', '-q', root]);
  if (!factoryStateDir(root).startsWith(root)) throw new Error('state dir is outside the test root');
  ledgerDir = join(dir, 'ledger');
  out = [];
  notices = [];
  now = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const exec: Exec = (cmd, args) => {
  const a = args.join(' ');
  if (cmd === 'git') {
    if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
    if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
    if (a === 'fetch origin dev') return ok();
    if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
    if (a === `cat-file -e ${SHA}^{commit}`) return ok();
    if (args[0] === 'ls-remote' || args[0] === 'ls-tree') return ok('');
    if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
  }
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]');
  throw new Error(`unscripted ${cmd} ${a}`);
};

const parked = (issue: number, atMs: number): FactoryRunState =>
  setGate(moveTo({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, iso(atMs - 60_000)), forgeKind: 'github' }, 'implement', 'x', iso(atMs - 30_000)), 'ci-failed', 'x', iso(atMs));

/** A park written as the engine writes it (sealed and recorded in the engine ledger): trusted. */
function park(issue: number, atMs = now): void {
  const s = parked(issue, atMs);
  const l = EngineLedger.open(ledgerDir, root, runKeyOf(s));
  updateFactoryState(root, issue, () => s, { onWrite: (p, c) => l.record(p, c) });
}

/** A sealed state the engine ledger never recorded (what a lane can write): untrusted. */
function forged(issue: number, atMs = now): void {
  const s = parked(issue, atMs);
  mkdirSync(factoryStateDir(root), { recursive: true });
  writeFileSync(factoryStatePath(root, issue), JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}

/** Runs `ticks` ticks; `lane(n)` runs before tick n+1 (n from 0). Ticks are STEP_MS apart. */
async function poll(ticks: number, lane: (n: number) => void, over: Partial<FactoryPollDeps> = {}): Promise<PollTick[]> {
  let stop: ((s?: NodeJS.Signals) => void) | undefined;
  let n = 0;
  const deps: FactoryPollDeps = {
    exec, base: () => 'dev', trustedUser: () => ({ factory: { poll: { remindAfterHours: 24 } } }), projectConfig: () => undefined, createForge,
    now: () => now, ledgerDir,
    healScan: () => { throw new Error('no heal'); },
    owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
    onStop: (h) => { stop = h; return () => {}; },
    sleep: async () => {
      lane(n);
      n += 1;
      now += STEP_MS;
      if (n >= ticks) stop?.('SIGTERM');
    },
    notifyAttention: async (x) => { notices.push({ tick: n, n: x }); },
    out: (l) => out.push(l), err: () => {},
    ...over,
  };
  expect(await runFactoryPoll({ heal: false, intake: false, prs: false, json: true, interval: '5m' }, deps)).toBe(0);
  return out.map((l) => JSON.parse(l) as PollTick);
}

const keyOf = (x: AnyAttentionNotice): string => ('key' in x ? x.key : 'count' in x ? `count ${x.count}` : `more ${x.more}`);

describe('omg factory poll: untrusted rows never crowd out a trusted item', () => {
  it('a flood of 20 new forged keys per tick: the real park is printed and notified at its own tick', async () => {
    const t = await poll(8, (n) => {
      for (let k = 0; k < 20; k++) forged(1000 + n * 20 + k);
      if (n === 2) park(8);
    });
    expect(t[3].attention?.new.map((i) => i.key)).toEqual(['#8']);
    expect(notices.filter((x) => keyOf(x.n) === '#8').map((x) => x.tick)).toEqual([3]);
    // No item notice for any forged row, and one count notice for all of them in this hour.
    expect(notices.map((x) => keyOf(x.n))).toEqual(['count 20', '#8']);
    for (const x of t.slice(1)) expect(x.attention?.new.every((i) => i.key === '#8')).toBe(true);
  });

  it('six untrusted new items just before a real park leave its notice untouched', async () => {
    const t = await poll(4, (n) => {
      if (n === 0) for (let k = 0; k < 3; k++) forged(500 + k);
      if (n === 1) for (let k = 3; k < 6; k++) forged(500 + k);
      if (n === 2) park(9);
    });
    expect(notices.map((x) => [x.tick, keyOf(x.n)])).toEqual([[1, 'count 3'], [3, '#9']]);
    expect(t[2].attention).toEqual({ new: [], unverified: 6 });
    expect(t[3].attention?.new.map((i) => i.key)).toEqual(['#9']);
  });

  it('the untrusted count notice goes out at most once per window, with its own budget', async () => {
    // 26 ticks 5 min apart (125 min), one new forged key each tick.
    await poll(26, (n) => forged(2000 + n));
    const counts = notices.filter((x) => 'count' in x.n);
    expect(ATTENTION_COUNT_NOTICE_WINDOW_MS).toBe(60 * 60_000);
    expect(counts.map((x) => x.tick)).toEqual([1, 13, 25]);
    expect(notices).toEqual(counts);
  });

  // Kept small for the suite's time (each tick reads every state file); the review script's evict mode runs thousands.
  it('hundreds of rotating forged keys per tick change nothing for a trusted item', async () => {
    const PER = 100;
    const t = await poll(6, (n) => {
      for (let k = 0; k < PER; k++) writeFileSync(factoryStatePath(root, 100_000 + ((n * PER + k) % (5 * PER))), '{}');
      if (n > 0) for (let k = 0; k < PER; k++) rmSync(factoryStatePath(root, 100_000 + (((n - 1) * PER + k) % (5 * PER))), { force: true });
      if (n === 3) park(10);
    });
    expect(t[4].attention?.new.map((i) => i.key)).toEqual(['#10']);
    expect(notices.filter((x) => 'key' in x.n).map((x) => [x.tick, keyOf(x.n)])).toEqual([[4, '#10']]);
  }, 300_000);
});

describe('omg factory poll: trusted notices queue', () => {
  it('past the per-tick cap and the rate limit: queued and delivered later, oldest first, nothing dropped', async () => {
    const t = await poll(6, (n) => {
      if (n === 0) for (let k = 0; k < 5; k++) park(20 + k);
      if (n === 1) for (let k = 0; k < 4; k++) park(30 + k);
    });
    const keys = notices.map((x) => [x.tick, keyOf(x.n)]);
    expect(keys).toEqual([
      [1, '#20'], [1, '#21'], [1, '#22'],
      [2, '#23'], [2, '#24'], [2, '#30'],
      [3, '#31'], [3, '#32'], [3, '#33'],
    ]);
    expect(t[1].attention?.queued).toBe(2);
    expect(t[2].attention?.queued).toBe(3);
    expect(t[3].attention?.queued).toBeUndefined();
    for (const x of t) expect(x.attention?.dropped).toBeUndefined();
  });

  it('a queued item that no longer needs you is not sent', async () => {
    await poll(4, (n) => {
      if (n === 0) for (let k = 0; k < 5; k++) park(40 + k);
      if (n === 1) rmSync(factoryStatePath(root, 44), { force: true });
    });
    // #44's state went away (the ledger still records it: an Inspect row, a different identity) before its turn.
    expect(notices.map((x) => keyOf(x.n)).filter((k) => k.startsWith('#'))).toEqual(['#40', '#41', '#42', '#43']);
  });

  it('queue overflow: one count notice for the overflow, first, and only the overflow counts as dropped', async () => {
    const N = ATTENTION_QUEUE_MAX + 5;
    const t = await poll(2, (n) => { if (n === 0) for (let k = 0; k < N; k++) park(3000 + k); });
    expect(t[1].attention?.dropped).toBe(5);
    expect(t[1].attention?.queued).toBe(ATTENTION_QUEUE_MAX - (ATTENTION_NOTICE_ITEMS - 1));
    expect(notices.map((x) => keyOf(x.n))).toEqual(['more 5', '#3000', '#3001']);
  }, 120_000);
});

describe('omg factory poll: a notifier that never settles', () => {
  it('each tick aborts its sends at the timeout, and later ticks still send (no pending growth)', async () => {
    const started: Array<[number, string]> = [];
    const signals: AbortSignal[] = [];
    let n = 0;
    const t = await poll(6, (k) => { n = k + 1; park(60 + k); }, {
      notifyAttention: (x, signal) => { started.push([n, keyOf(x)]); if (signal) signals.push(signal); return new Promise(() => {}); },
      notifyTimeoutMs: 30,
    });
    expect(started).toEqual([[1, '#60'], [2, '#61'], [3, '#62'], [4, '#63'], [5, '#64']]);
    expect(signals).toHaveLength(5);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(t.slice(1).every((x) => x.warnings.some((w) => /did not finish within/.test(w)))).toBe(true);
  });
});
