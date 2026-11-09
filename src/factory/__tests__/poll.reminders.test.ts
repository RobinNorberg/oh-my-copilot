/**
 * Stale-gate reminders inside `omg factory poll` (night-3 goal 5): the step is
 * read-only on git (the routing file arrives as one `git show <base sha>:<path>`),
 * prints the reminder, honours factory.poll.remindAfterHours from the trusted
 * layers, and reminds once per window.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../forge/index.js';
import type { Exec, ExecResult } from '../../ship/exec.js';
import { computeFactoryIntegrity, createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, type FactoryRunState } from '../run/state.js';
import { runFactoryPoll, type FactoryPollDeps, type PollTick } from '../poll.js';
import { remindersPath } from '../team/reminders.js';

const SHA = 'a'.repeat(40);
const T0 = '2026-10-31T10:00:00.000Z';
const REPO = 'https://github.com/o/r';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const ROUTING = '| src/** | - | core | @robin |\n| ** | - | all | @lead |';

let root: string;
let out: string[];
let err: string[];
let now: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-poll-remind-'));
  execFileSync('git', ['init', '-q', root]);
  if (!factoryStateDir(root).startsWith(root)) throw new Error('state dir is outside the test root');
  out = [];
  err = [];
  now = Date.parse(T0) + 30 * 3_600_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function scripted(calls: string[] = []): Exec {
  return (cmd, args) => {
    const a = args.join(' ');
    calls.push(`${cmd} ${a}`);
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok('');
      if (a === `show ${SHA}:.copilot/team/routing.md`) return ok(ROUTING);
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]');
    throw new Error(`unscripted ${cmd} ${a}`);
  };
}

function deps(exec: Exec, over: Partial<FactoryPollDeps> = {}): FactoryPollDeps {
  return {
    exec, base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge,
    now: () => now,
    healScan: () => { throw new Error('no heal'); },
    owner: { pid: 4242, hostname: hostname(), isAlive: () => false },
    onStop: () => () => {},
    sleep: async () => { throw new Error('a --once poll never sleeps'); },
    out: (l) => out.push(l), err: (l) => err.push(l),
    ...over,
  };
}

function save(s: FactoryRunState): void {
  const path = factoryStatePath(root, runKeyOf(s));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) }));
}
const seedParked = (plan = 'edit src/a.ts'): void => save({
  ...setGate(moveTo({ ...createFactoryState({ issue: 4, repoUrl: REPO, base: 'dev' }, T0), forgeKind: 'github', issueTitle: 'issue 4', plan: { source: 'issue-body', text: plan } }, 'gates', 'gates', T0), 'merge', 'gates green; a human merges', T0),
});
const flags = { once: true, json: true, heal: false, intake: false, prs: false } as const;
const tick = (): PollTick => JSON.parse(out[out.length - 1]) as PollTick;

describe('poll stale-gate reminders', () => {
  it('reminds a gate parked past the default 24 h with the routed handle, and never writes git or the forge', async () => {
    seedParked();
    const calls: string[] = [];
    expect(await runFactoryPoll(flags, deps(scripted(calls)))).toBe(0);
    expect(tick().reminders).toEqual([{ run: 4, gate: 'merge', hours: 30, handles: ['@robin'], reason: 'gates green; a human merges' }]);
    expect(calls.filter((c) => /^git (fetch|push|branch|update-ref|worktree)/.test(c) && c !== 'git fetch origin dev')).toEqual([]);
    expect(calls.filter((c) => c.startsWith('gh ') && !c.startsWith('gh pr list'))).toEqual([]);
    expect(existsSync(remindersPath(root))).toBe(true);
  });

  it('reads the routing file only as git show of the base sha', async () => {
    seedParked();
    const calls: string[] = [];
    await runFactoryPoll(flags, deps(scripted(calls)));
    expect(calls.filter((c) => c.includes('routing.md'))).toEqual([`git show ${SHA}:.copilot/team/routing.md`]);
  });

  it('reads the routing file with replace refs off: a planted refs/replace blob does not choose the handles', async () => {
    seedParked();
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    mkdirSync(join(root, '.copilot', 'team'), { recursive: true });
    writeFileSync(join(root, '.copilot', 'team', 'routing.md'), ROUTING);
    git('add', '-f', '.copilot/team/routing.md');
    git('commit', '-q', '-m', 'routing');
    const commit = git('rev-parse', 'HEAD');
    const real = git('rev-parse', `${commit}:.copilot/team/routing.md`);
    const forged = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, encoding: 'utf8', input: '| ** | - | evil | @evil |\n' }).trim();
    git('replace', real, forged);
    const base = scripted();
    const exec: Exec = (cmd, args, opts) => {
      const swapped = args.map((x) => x.split(SHA).join(commit));
      if (cmd === 'git' && (swapped[0] === 'show' || swapped[0] === 'cat-file') && swapped.some((x) => x.includes(commit))) {
        const r = spawnSync('git', swapped, { cwd: root, encoding: 'utf8', env: { ...process.env, ...(opts?.env ?? {}) } });
        return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      }
      return base(cmd, args, opts);
    };
    expect(await runFactoryPoll(flags, deps(exec))).toBe(0);
    expect(tick().reminders?.[0].handles).toEqual(['@robin']);
  }, 60_000);

  it('a failed base read is a poll warning, not "file absent"', async () => {
    seedParked();
    const base = scripted();
    const exec: Exec = (cmd, args, opts) => (cmd === 'git' && args[0] === 'show' && args[1]?.endsWith('routing.md') ? { status: 128, stdout: '', stderr: 'fatal: bad object' } : base(cmd, args, opts));
    expect(await runFactoryPoll(flags, deps(exec))).toBe(0);
    expect(tick().reminders?.[0].handles).toEqual([]);
    expect(tick().warnings.join('\n')).toContain('routing.md unreadable at the base commit');
  });

  it('prints a hostile gate name with visible characters', async () => {
    save({ ...setGate(moveTo({ ...createFactoryState({ issue: 4, repoUrl: REPO, base: 'dev' }, T0), forgeKind: 'github', issueTitle: 'issue 4', plan: { source: 'issue-body', text: 'x' } }, 'gates', 'gates', T0), 'merge\u202e', 'r', T0) });
    expect(await runFactoryPoll({ ...flags, json: false }, deps(scripted()))).toBe(0);
    expect(out.join('\n')).toContain('at merge<U+202E>');
  });

  it('prints the reminder line in text mode and reminds once per window', async () => {
    seedParked();
    expect(await runFactoryPoll({ ...flags, json: false }, deps(scripted()))).toBe(0);
    expect(out.join('\n')).toContain('reminder: #4 has waited 30 h at merge @robin: gates green; a human merges (omg factory run 4)');
    out.length = 0;
    now += 3_600_000;
    await runFactoryPoll(flags, deps(scripted()));
    expect(tick().reminders).toBeUndefined();
    out.length = 0;
    now += 24 * 3_600_000;
    await runFactoryPoll(flags, deps(scripted()));
    expect(tick().reminders).toHaveLength(1);
  });

  it('factory.poll.remindAfterHours 0 turns it off; a bad value is a usage error', async () => {
    seedParked();
    await runFactoryPoll(flags, deps(scripted(), { trustedUser: () => ({ factory: { poll: { remindAfterHours: 0 } } }) }));
    expect(tick().reminders).toBeUndefined();
    expect(existsSync(remindersPath(root))).toBe(false);
    await expect(runFactoryPoll(flags, deps(scripted(), { trustedUser: () => ({ factory: { poll: { remindAfterHours: 'x' } } }) }))).rejects.toThrow(/remindAfterHours/);
  });

  it('ignores the working-tree project config for the window (trusted layers only)', async () => {
    seedParked();
    await runFactoryPoll(flags, deps(scripted(), { projectConfig: () => ({ factory: { poll: { remindAfterHours: 1000 } } }) }));
    expect(tick().reminders).toHaveLength(1);
    expect(readFileSync(remindersPath(root), 'utf8')).toContain('"gateAt"');
  });
});
