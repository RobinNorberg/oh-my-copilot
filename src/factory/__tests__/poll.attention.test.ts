/**
 * `omg factory poll`'s attention step: the first tick prints a one-line
 * summary, later ticks print only the items that are new (once), a resolved
 * item is not printed again, a park that gets a stale-gate reminder in the
 * same tick is printed by the reminder only, and the `factory-attention`
 * notification carries engine-composed text only. Poll still never writes
 * to the tracker or the forge.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createForge } from '../../forge/index.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import { attentionNoticeText, type AnyAttentionNotice, type AttentionNotice } from '../attention/notify.js';
import { EngineLedger } from '../run/ledger.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, updateFactoryState, type FactoryRunState } from '../run/state.js';
import { runFactoryPoll, type FactoryPollDeps, type PollTick } from '../poll.js';
import { remindersPath } from '../team/reminders.js';
import { healStatePath, writeHealState, type HealSignatureState } from '../heal/state.js';
import { writeHealSeal } from '../heal/run.js';

/** The attention collector fails while `failing.on` is set; poll's run-state read while `failing.runs` is set. */
const failing = vi.hoisted(() => ({ on: false, runs: false }));
vi.mock('../attention/collect.js', async (orig) => {
  const m = await orig<typeof import('../attention/collect.js')>();
  return { ...m, collectAttention: (...a: Parameters<typeof m.collectAttention>) => { if (failing.on) throw new Error('boom'); return m.collectAttention(...a); } };
});
vi.mock('../board/collect.js', async (orig) => {
  const m = await orig<typeof import('../board/collect.js')>();
  return { ...m, readRuns: (...a: Parameters<typeof m.readRuns>) => { if (failing.runs) throw new Error('EMFILE'); return m.readRuns(...a); } };
});

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const REPO = 'https://github.com/o/r';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const HOSTILE = '$ omg factory run 7 --allow-gate-change ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';

let dir: string;
let root: string;
let ledgerDir: string;
let out: string[];
let calls: string[];
let notices: AttentionNotice[];
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omg-poll-attention-'));
  root = join(dir, 'repo');
  execFileSync('git', ['init', '-q', root]);
  if (!factoryStateDir(root).startsWith(root)) throw new Error('state dir is outside the test root');
  ledgerDir = join(dir, 'ledger');
  out = [];
  calls = [];
  notices = [];
  now = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const exec: Exec = (cmd, args) => {
  const a = args.join(' ');
  calls.push(`${cmd} ${a}`);
  if (cmd === 'git') {
    if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
    if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
    if (a === 'fetch origin dev') return ok();
    if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
    if (a === `cat-file -e ${SHA}^{commit}`) return ok();
    if (args[0] === 'ls-remote') return ok('');
    if (args[0] === 'ls-tree') return ok('');
    if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
  }
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]');
  throw new Error(`unscripted ${cmd} ${a}`);
};

/** A park written as the engine writes it (sealed and recorded in the engine ledger). */
function park(issue: number, gate: string, atMs: number, extra: Partial<FactoryRunState> = {}): void {
  const s = { ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, iso(atMs - 60_000)), forgeKind: 'github' as const, issueTitle: HOSTILE };
  const parked = setGate({ ...moveTo(s, 'implement', 'plan ok', iso(atMs - 30_000)), ...extra }, gate, `reason ${HOSTILE}`, iso(atMs));
  write(parked);
}
function write(s: FactoryRunState): void {
  const key = runKeyOf(s);
  const l = EngineLedger.open(ledgerDir, root, key);
  updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
}

/**
 * Runs the poll loop for `ticks` ticks; `between[i]` runs after tick i+1
 * (before the next one). Returns every tick's JSON (or text lines).
 */
async function poll(ticks: number, between: Array<() => void> = [], json = true, over: Partial<FactoryPollDeps> = {}): Promise<void> {
  let stop: ((s?: NodeJS.Signals) => void) | undefined;
  let n = 0;
  const deps: FactoryPollDeps = {
    exec, base: () => 'dev', trustedUser: () => ({ factory: { poll: { remindAfterHours: 24 } } }), projectConfig: () => undefined, createForge,
    now: () => now, ledgerDir,
    healScan: () => { throw new Error('no heal'); },
    owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
    onStop: (h) => { stop = h; return () => {}; },
    sleep: async () => {
      between[n]?.();
      n += 1;
      now += 5 * 60_000;
      if (n >= ticks) stop?.('SIGTERM');
    },
    notifyAttention: async (x) => { notices.push(x as AttentionNotice); },
    out: (l) => out.push(l), err: () => {},
    ...over,
  };
  expect(await runFactoryPoll({ heal: false, intake: false, prs: false, json, interval: '5m' }, deps)).toBe(0);
}
const ticks = (): PollTick[] => out.map((l) => JSON.parse(l) as PollTick);

describe('omg factory poll: attention items', () => {
  it('first tick: a one-line summary; then each new item once; a resolved item is not printed again', async () => {
    park(1, 'merge', T0 - 3_600_000, { phase: 'merge', pr: 11, head: HEAD });
    await poll(5, [
      () => park(2, 'ci-failed', now),
      () => {},
      () => write({ ...moveTo({ ...createFactoryState({ issue: 2, repoUrl: REPO, base: 'dev' }, iso(now)), forgeKind: 'github' }, 'merged', 'merged', iso(now)) }),
      () => park(2, 'budget', now),
    ]);
    const t = ticks();
    expect(t[0].attention).toEqual({ summary: '1 item needs you: merge 1; no engine running', new: [] });
    expect(t[1].attention).toEqual({ new: [{ key: '#2', group: 'fix', gate: 'ci-failed', next: ['omg', 'factory', 'run', 'status', '2'] }] });
    expect(t[2].attention).toEqual({ new: [] });
    expect(t[3].attention).toEqual({ new: [] });
    expect(t[4].attention).toEqual({ new: [{ key: '#2', group: 'limits', gate: 'budget', next: ['omg', 'factory', 'run', 'status', '2'] }] });
    expect(notices.map((x) => [x.key, x.gate])).toEqual([['#2', 'ci-failed'], ['#2', 'budget']]);
    // Poll still never writes to the tracker or the forge, and the attention step spawns nothing.
    expect(calls.filter((c) => c.startsWith('gh ') && !c.startsWith('gh pr list'))).toEqual([]);
    expect(calls.filter((c) => /^git (push|branch|update-ref|worktree|commit|tag)/.test(c))).toEqual([]);
  });

  it('prints one compact line per new item, with the first next command and no state text', async () => {
    await poll(2, [() => park(3, 'merge', now, { phase: 'merge', pr: 12, head: HEAD })], false);
    const text = out.join('\n');
    expect(text).toContain('attention: nothing needs you; no engine running (omg factory attention)');
    expect(text).toContain(`attention: #3 needs you: merge at merge; next: gh pr merge 12 --admin --merge --match-head-commit ${HEAD}`);
    // The attention lines (the board rows below them are the board's own and print the title and reason, as before).
    const lines = text.split('\n').filter((l) => l.trimStart().startsWith('attention:'));
    expect(lines).toHaveLength(2);
    for (const l of lines) for (const bad of ['allow-gate-change', 'ghp_', 'reason']) expect(l).not.toContain(bad);
  });

  it('a park whose sealed park time is a window old and that gets its reminder: the reminder is its line, it still gets one notice', async () => {
    await poll(4, [() => park(4, 'ci-failed', now - 30 * 3_600_000)]);
    const t = ticks();
    expect(t[1].reminders?.map((r) => r.run)).toEqual([4]);
    expect(t[1].attention).toEqual({ new: [] });
    expect(notices.map((x) => x.key)).toEqual(['#4']);
  });

  it('a forged reminders record never takes a fresh park\'s line or notice', async () => {
    await poll(4, [() => {
      park(71, 'merge', now);
      const gateAt = iso(now);
      writeFileSync(remindersPath(root), JSON.stringify({ '#71': { gateAt, remindedAt: '2000-01-01T00:00:00.000Z' } }));
    }]);
    const t = ticks();
    expect(t[1].reminders).toBeUndefined();
    expect(t.flatMap((x) => x.attention?.new ?? []).map((i) => i.key)).toEqual(['#71']);
    expect(notices.map((x) => x.key)).toEqual(['#71']);
  });

  it('a future remindedAt neither fires a reminder nor hides the park', async () => {
    await poll(3, [() => {
      park(72, 'merge', now - 30 * 3_600_000);
      writeFileSync(remindersPath(root), JSON.stringify({ '#72': { gateAt: iso(now - 30 * 3_600_000), remindedAt: '2999-01-01T00:00:00.000Z' } }));
    }]);
    const t = ticks();
    expect(t.flatMap((x) => x.reminders ?? [])).toEqual([]);
    expect(t[1].attention?.new.map((i) => i.key)).toEqual(['#72']);
    expect(notices.map((x) => x.key)).toEqual(['#72']);
  });

  it('only the first tick is the baseline: a collector that failed first does not swallow a later park', async () => {
    failing.on = true;
    try {
      await poll(5, [() => {}, () => park(61, 'merge', now), () => { failing.on = false; }]);
    } finally {
      failing.on = false;
    }
    const t = ticks();
    expect(t.slice(0, 3).map((x) => x.attention)).toEqual([undefined, undefined, undefined]);
    expect(t[3].attention?.new.map((i) => i.key)).toEqual(['#61']);
    expect(notices.map((x) => x.key)).toEqual(['#61']);
  });

  it('a run-state read that throws fails the tick closed (not idle) and the poll goes on', async () => {
    failing.runs = true;
    try {
      await poll(3, [() => { failing.runs = false; }]);
    } finally {
      failing.runs = false;
    }
    const t = ticks();
    expect(t).toHaveLength(3);
    expect(t[0].errors.some((e) => e.startsWith('run states: EMFILE'))).toBe(true);
    expect(t[0].idle).toBe(false);
    expect(t[1].errors).toEqual([]);
  });

  it('an untrusted row that comes and goes every tick: one count notice per hour, not one per rise', async () => {
    const all: AnyAttentionNotice[] = [];
    // 12 ticks 5 min apart: a new unreadable state, then gone, then another (the count alternates 0 and 1).
    await poll(12, Array.from({ length: 11 }, (_, n) => () => (n % 2 === 0 ? (mkdirSync(factoryStateDir(root), { recursive: true }), writeFileSync(factoryStatePath(root, 3000 + n), 'garbage')) : rmSync(factoryStatePath(root, 3000 + n - 1), { force: true }))), true,
      { notifyAttention: async (x) => { all.push(x); } });
    expect(all).toEqual([{ repo: 'repo', count: 1 }]);
  });

  it('an untrusted state is only counted: one count line and one count notice, no key, gate or command', async () => {
    await poll(2, [() => {
      park(5, 'ci-failed', now);
      // Rewritten outside the engine: the ledger no longer holds these bytes.
      const s = { ...createFactoryState({ issue: 5, repoUrl: REPO, base: 'dev' }, iso(now)), forgeKind: 'github' as const, issueTitle: HOSTILE };
      updateFactoryState(root, 5, () => setGate(s, 'evil-gate', HOSTILE, iso(now)));
    }]);
    expect(ticks()[1].attention).toEqual({ new: [], unverified: 1 });
    expect(notices).toEqual([{ repo: 'repo', count: 1 }]);
  });
});

/** A state written outside the engine (sealed, never recorded in the engine ledger): an untrusted row. */
function forged(issue: number, atMs: number): void {
  const s = setGate(moveTo(createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, iso(atMs - 60_000)), 'implement', 'x', iso(atMs - 30_000)), 'ci-failed', 'x', iso(atMs));
  mkdirSync(factoryStateDir(root), { recursive: true });
  writeFileSync(factoryStatePath(root, issue), JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}

describe('omg factory poll: a lane cannot flood the attention lines or notifications', () => {
  const textLines = () => out.join('\n').split('\n').filter((l) => l.trimStart().startsWith('attention:'));

  it('an untrusted state rewritten every tick (its times, or flipping unreadable/unverified) is new once', async () => {
    forged(5, now);
    await poll(10, Array.from({ length: 10 }, (_, n) => () => forged(5, now + n)), false);
    expect(notices).toEqual([]);
    expect(textLines().filter((l) => l.includes('#5'))).toEqual([]);
    out = [];
    notices = [];
    rmSync(factoryStateDir(root), { recursive: true, force: true });
    await poll(10, Array.from({ length: 10 }, (_, n) => () => (n % 2 ? forged(5, now) : writeFileSync(factoryStatePath(root, 5), 'garbage'))), false);
    expect(notices.length).toBeLessThanOrEqual(1);
    expect(textLines().filter((l) => l.includes('#5 needs you')).length).toBeLessThanOrEqual(1);
  });

  it('new untrusted rows past any cap: no item line or notice, one count line per change, a rising count notified at most once per 10 min', async () => {
    const all: AnyAttentionNotice[] = [];
    // 6 ticks: the first prints the summary, each of the 5 after it sees 20 new forged states.
    await poll(6, Array.from({ length: 5 }, (_, n) => () => { for (let k = 0; k < 20; k++) forged(1000 + n * 20 + k, now); }), false, { notifyAttention: async (x) => { all.push(x); } });
    // 25 minutes, the count rising every tick: one count notice per ATTENTION_COUNT_RISE_MS (ticks 1, 3, 5).
    expect(all).toEqual([{ repo: 'repo', count: 20 }, { repo: 'repo', count: 60 }, { repo: 'repo', count: 100 }]);
    expect(attentionNoticeText(all[0])).toBe('factory repo: 20 unverified or damaged state file(s) need inspection\ndetails: omg factory attention');
    const lines = textLines();
    expect(lines.filter((l) => l.includes('needs you:') || l.includes('more new item'))).toEqual([]);
    expect(lines.filter((l) => l.includes('unverified or damaged state file(s) need inspection')).map((l) => l.trim().split(' ')[1])).toEqual(['20', '40', '60', '80', '100']);
  });

  it('the per-tick cap and rate limit queue trusted notices; a notification that never settles is abandoned at the timeout', async () => {
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    await poll(3, [() => { for (let k = 0; k < 8; k++) park(20 + k, 'ci-failed', now); }, () => park(40, 'ci-failed', now)], true, {
      notifyAttention: (x, signal) => { started.push('key' in x ? x.key : 'count'); if (signal) signals.push(signal); return new Promise(() => {}); },
      notifyTimeoutMs: 50,
    });
    const t = ticks();
    expect(started).toEqual(['#20', '#21', '#22', '#23', '#24', '#25']);
    expect(t[1].attention?.queued).toBe(5);
    expect(t[1].attention?.dropped).toBeUndefined();
    expect(t[2].attention?.queued).toBe(3);
    expect(t[1].warnings.some((w) => /did not finish within/.test(w))).toBe(true);
    expect(signals).toHaveLength(6);
    expect(signals.every((sg) => sg.aborted)).toBe(true);
  });

  it('trusted new parks still notify once each', async () => {
    await poll(4, [() => park(30, 'ci-failed', now), () => { park(31, 'budget', now); park(32, 'ci-failed', now); }, () => {}]);
    // Within a tick, in attention's order (fix before limits).
    expect(notices.map((x) => x.key)).toEqual(['#30', '#32', '#31']);
  });

  it('the rate limit: a seventh notice inside 10 minutes waits in the queue and goes out later, oldest first', async () => {
    const all: AnyAttentionNotice[] = [];
    await poll(4, [() => { for (let k = 0; k < 4; k++) park(50 + k, 'ci-failed', now); }, () => { for (let k = 0; k < 3; k++) park(60 + k, 'ci-failed', now); }, () => park(70, 'ci-failed', now)], true,
      { notifyAttention: async (x) => { all.push(x); } });
    const t = ticks();
    expect(all.map((x) => ('key' in x ? x.key : 'count'))).toEqual(['#50', '#51', '#52', '#53', '#60', '#61', '#62', '#70']);
    expect(t[1].attention?.queued).toBe(1);
    expect(t[2].attention?.queued).toBe(1);
    expect(t[2].attention?.new.map((i) => i.key)).toEqual(['#60', '#61', '#62']);
    expect(t[3].attention?.queued).toBeUndefined();
    for (const x of t) expect(x.attention?.dropped).toBeUndefined();
  });
});

describe('omg factory poll: a sealed heal row is the same row while a lane rewrites its unsealed fields', () => {
  it('one line and one notice, whatever updatedAt, class and next say, and its notice is not pushed back in the queue', async () => {
    const SIG = '0123abcd';
    const hs = {
      version: 1, sig8: SIG, signature: 'sig', class: 'regression', classification: { sig8: SIG, class: 'regression', laneEligible: true }, source: 'push',
      firstSeen: { runId: 1, at: iso(T0 - 3e6) }, lastSeen: { runId: 1, at: iso(T0 - 3e6) }, count: 1, seenRuns: [1], next: 'heal-approve', rerunIntents: [], updatedAt: iso(T0 - 2e6),
      healRun: { id: `heal-${SIG}`, open: true, startedAt: iso(T0 - 2.5e6) },
      lanes: [{ id: `heal-${SIG}-debug-1`, kind: 'debug', status: 'completed', pid: 999, startedAt: iso(T0 - 2.4e6) }],
      diagnosis: { outcome: 'valid', laneId: `heal-${SIG}-debug-1` },
    } as unknown as HealSignatureState;
    const all: AnyAttentionNotice[] = [];
    const lane = (k: number) => () => {
      const cur = JSON.parse(readFileSync(healStatePath(root, SIG), 'utf8')) as Record<string, unknown>;
      writeFileSync(healStatePath(root, SIG), JSON.stringify({ ...cur, updatedAt: iso(now - (k % 2) * 1e6), class: `MRKZclass${k}`, next: k % 2 ? 'heal-approve' : 'report' }));
    };
    await poll(12, [
      // Eight parks first, then the heal row: its notice waits in the queue behind the five the rate limit holds.
      () => { for (let k = 0; k < 8; k++) park(20 + k, 'ci-failed', now); },
      () => { writeHealState(root, hs); writeHealSeal(ledgerDir, root, hs); },
      ...Array.from({ length: 9 }, (_, k) => lane(k))], true, { notifyAttention: async (x) => { all.push(x); } });
    const t = ticks();
    expect(t.flatMap((x) => x.attention?.new ?? []).filter((i) => i.key === `heal-${SIG}`)).toHaveLength(1);
    const heal = all.filter((x) => 'key' in x && x.key === `heal-${SIG}`);
    expect(heal).toHaveLength(1);
    // Sent right after the eight parks ahead of it (the 9th notice), not pushed behind later ones.
    expect(all.findIndex((x) => 'key' in x && x.key === `heal-${SIG}`)).toBe(8);
    expect(JSON.stringify(t)).not.toContain('MRKZ');
    expect(JSON.stringify(all)).not.toContain('MRKZ');
  });
});

describe('factory-attention notification payload', () => {
  it('holds engine-composed text only for a hostile state, and the repository path stays local', async () => {
    await poll(2, [() => park(6, 'merge', now, { phase: 'merge', pr: 1, head: HEAD, forgeKind: 'local', remote: 'omg-local' } as Partial<FactoryRunState>)]);
    expect(notices).toHaveLength(1);
    const n = notices[0];
    expect(n).toEqual({ repo: 'repo', key: '#6', group: 'merge', gate: 'merge', next: `git merge --no-ff --no-edit ${HEAD}` });
    const text = attentionNoticeText(n);
    expect(text).toBe(`factory repo: #6 needs you (Merge: merge)\nnext: git merge --no-ff --no-edit ${HEAD}\ndetails: omg factory attention`);
    for (const bad of ['ghp_', 'allow-gate-change', 'reason', dir]) expect(text).not.toContain(bad);
  });
});
