/**
 * `omg factory poll`'s attention step: the first tick prints a one-line
 * summary, later ticks print only the items that are new (once), a resolved
 * item is not printed again, a park that gets a stale-gate reminder in the
 * same tick is printed by the reminder only, and the `factory-attention`
 * notification carries engine-composed text only. Poll still never writes
 * to the tracker or the forge.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../forge/index.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import { attentionNoticeText, type AttentionNotice } from '../attention/notify.js';
import { EngineLedger } from '../run/ledger.js';
import { createFactoryState, factoryStateDir, moveTo, runKeyOf, setGate, updateFactoryState, type FactoryRunState } from '../run/state.js';
import { runFactoryPoll, type FactoryPollDeps, type PollTick } from '../poll.js';

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
    notifyAttention: async (x) => { notices.push(x); },
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

  it('a park that is also due for a stale-gate reminder in the same tick is printed by the reminder alone', async () => {
    await poll(2, [() => park(4, 'ci-failed', now - 30 * 3_600_000)]);
    const t = ticks();
    expect(t[1].reminders?.map((r) => r.run)).toEqual([4]);
    expect(t[1].attention).toEqual({ new: [] });
    expect(notices).toEqual([]);
  });

  it('an untrusted state is new under Inspect with the status command only, and no gate name', async () => {
    await poll(2, [() => {
      park(5, 'ci-failed', now);
      // Rewritten outside the engine: the ledger no longer holds these bytes.
      const s = { ...createFactoryState({ issue: 5, repoUrl: REPO, base: 'dev' }, iso(now)), forgeKind: 'github' as const, issueTitle: HOSTILE };
      updateFactoryState(root, 5, () => setGate(s, 'evil-gate', HOSTILE, iso(now)));
    }]);
    expect(ticks()[1].attention).toEqual({ new: [{ key: '#5', group: 'inspect', gate: null, next: ['omg', 'factory', 'run', 'status', '5'] }] });
    expect(notices).toEqual([{ repo: 'repo', key: '#5', group: 'inspect', gate: null, next: 'omg factory run status 5' }]);
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
