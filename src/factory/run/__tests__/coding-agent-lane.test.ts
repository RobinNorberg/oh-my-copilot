/**
 * The coding agent lane's shared pieces (night 3 goal 6, lane L6b): the
 * factory guard's coding agent shapes with and without the step context,
 * the config keys, the sealed record's shape check, the session count and
 * the pre-assign read of open agent PRs. Fixtures only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codingAgentAssignArgs, codingAgentCloseArgs, codingAgentStatusArgs, type CodingAgentContext } from '../../../forge/github/coding-agent.js';
import type { Exec } from '../../../ship/exec.js';
import {
  codingAgentFetchArgs, codingAgentLinkCommentArgs, codingAgentRecordProblem, codingAgentRefusal, codingAgentRepoOf, codingAgentSessionsOn,
  codingAgentTreeArgs, CODING_AGENT_FETCH_HEAD_ARGS, linkEntries, openAgentPrs, recordCodingAgentSession, resolveCodingAgentConfig,
} from '../coding-agent-lane.js';
import { factoryGuardExec, FactorySafetyError } from '../exec.js';
import { createFactoryState, parseFactoryState } from '../state.js';
import { AGENT, FakeAgentGithub, HUMAN } from './fake-coding-agent.js';
import { gitIn } from './fake-lanes.js';

const REPO = { host: 'github.com', owner: 'o', name: 'r' };
const REPO_ARG = 'github.com/o/r';
const HEAD = 'c'.repeat(40);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-coding-agent-lane-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A guarded exec over a recorder; the agent provider returns `ctx()`. */
function guarded(ctx: () => CodingAgentContext | undefined, read: () => { repo: string } | undefined = () => ({ repo: REPO_ARG })) {
  const ran: Array<{ cmd: string; args: string[]; body?: string }> = [];
  const inner: Exec = (cmd, args) => {
    ran.push({ cmd, args: [...args], ...(args[5] === '--body-file' ? { body: readFileSync(args[6], 'utf8') } : {}) });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec: factoryGuardExec(inner, () => ['dev'], undefined, undefined, undefined, read, ctx), ran };
}

describe('factory guard: coding agent writes need the step context', () => {
  const ctx: CodingAgentContext = { repo: REPO_ARG, issue: 7, base: 'dev' };
  const assign = codingAgentAssignArgs(REPO, 7, 'dev');
  const close = codingAgentCloseArgs(REPO, 77);

  it('without the step context the assign, the close and the link comment are refused; the status read passes', () => {
    const body = join(dir, 'body.md');
    writeFileSync(body, 'link\n');
    const { exec, ran } = guarded(() => undefined);
    expect(() => exec('gh', assign)).toThrow(FactorySafetyError);
    expect(() => exec('gh', close)).toThrow(FactorySafetyError);
    expect(() => exec('gh', codingAgentLinkCommentArgs(REPO, 77, body))).toThrow(FactorySafetyError);
    exec('gh', codingAgentStatusArgs(REPO, 7, { at: '2026-11-09T10:00:00Z', source: 'github' }));
    expect(ran).toHaveLength(1);
  });

  it('the assign context admits the assign of its issue on its base only, never a close or a comment', () => {
    const { exec, ran } = guarded(() => ctx);
    exec('gh', assign);
    expect(() => exec('gh', codingAgentAssignArgs(REPO, 8, 'dev'))).toThrow(FactorySafetyError);
    expect(() => exec('gh', codingAgentAssignArgs(REPO, 7, 'main'))).toThrow(FactorySafetyError);
    expect(() => exec('gh', close)).toThrow(FactorySafetyError);
    expect(ran.map((r) => r.args)).toEqual([assign]);
  });

  it('the close context admits the close and the link comment of exactly its PR; the comment runs with the guard\'s copy of the body', () => {
    const body = join(dir, 'body.md');
    writeFileSync(body, 'adopted as #42\n');
    const { exec, ran } = guarded(() => ({ ...ctx, pr: 77 }));
    exec('gh', close);
    exec('gh', codingAgentLinkCommentArgs(REPO, 77, body));
    expect(() => exec('gh', codingAgentCloseArgs(REPO, 78))).toThrow(FactorySafetyError);
    expect(() => exec('gh', codingAgentLinkCommentArgs(REPO, 78, body))).toThrow(FactorySafetyError);
    expect(() => exec('gh', codingAgentLinkCommentArgs({ ...REPO, owner: 'x' }, 77, body))).toThrow(FactorySafetyError);
    expect(() => exec('gh', ['pr', 'comment', '77', '--repo', REPO_ARG, '--body-file', body, '--edit-last'])).toThrow(FactorySafetyError);
    expect(ran).toHaveLength(2);
    expect(ran[1].args.slice(0, 6)).toEqual(['pr', 'comment', '77', '--repo', REPO_ARG, '--body-file']);
    expect(ran[1].args[6]).not.toBe(body);
    expect(ran[1].body).toBe('adopted as #42\n');
  });

  it('the repository-only read context admits no coding agent write', () => {
    const { exec } = guarded(() => undefined, () => ({ repo: REPO_ARG }));
    expect(() => exec('gh', assign)).toThrow(FactorySafetyError);
    expect(() => exec('gh', close)).toThrow(FactorySafetyError);
  });
});

describe('factory guard: the adopt git shapes', () => {
  const git = guarded(() => undefined).exec;

  it('admits exactly the PR head fetch, the FETCH_HEAD read and one commit\'s tree listing', () => {
    git('git', codingAgentFetchArgs(77));
    git('git', [...CODING_AGENT_FETCH_HEAD_ARGS]);
    git('git', codingAgentTreeArgs(HEAD));
  });

  it.each([
    [['fetch', '--no-tags', '--refmap=', 'origin', 'refs/pull/77/head:refs/heads/main']],
    [['fetch', '--no-tags', '--refmap=', 'origin', '+refs/pull/77/head:refs/heads/x']],
    [['fetch', '--no-tags', '--refmap=', 'omg-local', 'refs/pull/77/head']],
    [['fetch', '--refmap=', 'origin', 'refs/pull/77/head']],
    [['fetch', '--no-tags', 'origin', 'refs/pull/77/head']],
    [['fetch', '--no-tags', '--refmap=', 'origin', 'refs/pull/077/head']],
    [['fetch', '--no-tags', '--refmap=', 'origin', 'refs/pull/77/merge']],
    [['ls-tree', '-r', '-z', '--full-tree', 'HEAD']],
    [['rev-parse', '--verify', 'FETCH_HEAD']],
  ])('refuses %j', (args) => {
    expect(() => git('git', args)).toThrow(FactorySafetyError);
  });

  it('the builders refuse what the guard would', () => {
    expect(() => codingAgentFetchArgs(0)).toThrow();
    expect(() => codingAgentTreeArgs('HEAD')).toThrow();
    expect(() => codingAgentLinkCommentArgs(REPO, -1, 'x')).toThrow();
  });
});

describe('coding agent config', () => {
  it('defaults: Copilot implements, 90 min wait, 5 sessions a day', () => {
    expect(resolveCodingAgentConfig(undefined, undefined)).toEqual({ config: { implementer: 'copilot', maxWaitMinutes: 90, maxSessionsPerDay: 5 }, warnings: [] });
  });

  it('only the user config opts in; the project config may opt out and lower the numbers', () => {
    const user = { factory: { run: { implementer: 'coding-agent' }, codingAgent: { maxWaitMinutes: 60, maxSessionsPerDay: 3 } } };
    expect(resolveCodingAgentConfig(user, undefined).config).toEqual({ implementer: 'coding-agent', maxWaitMinutes: 60, maxSessionsPerDay: 3 });
    const lower = resolveCodingAgentConfig(user, { factory: { run: { implementer: 'copilot' }, codingAgent: { maxWaitMinutes: 30, maxSessionsPerDay: 10 } } });
    expect(lower.config).toEqual({ implementer: 'copilot', maxWaitMinutes: 30, maxSessionsPerDay: 3 });
    expect(lower.warnings).toEqual([expect.stringContaining('maxSessionsPerDay 10')]);
    const optIn = resolveCodingAgentConfig(undefined, { factory: { run: { implementer: 'coding-agent' } } });
    expect(optIn.config.implementer).toBe('copilot');
    expect(optIn.warnings).toEqual([expect.stringContaining('only the user config can opt in')]);
  });

  it('refuses ill-typed values', () => {
    expect(() => resolveCodingAgentConfig({ factory: { run: { implementer: 'agent' } } }, undefined)).toThrow(/implementer/);
    expect(() => resolveCodingAgentConfig({ factory: { codingAgent: { maxSessionsPerDay: 1.5 } } }, undefined)).toThrow(/maxSessionsPerDay/);
    expect(() => resolveCodingAgentConfig({ factory: { codingAgent: { maxWaitMinutes: 0 } } }, undefined)).toThrow(/maxWaitMinutes/);
    expect(() => resolveCodingAgentConfig({ factory: { codingAgent: [] } }, undefined)).toThrow(/factory.codingAgent/);
  });

  it('GitHub issue runs only', () => {
    expect(codingAgentRefusal('github', 'issue')).toBeNull();
    expect(codingAgentRefusal('azure-devops', 'issue')).toContain('GitHub only');
    expect(codingAgentRefusal('local', 'issue')).toContain('GitHub only');
    expect(codingAgentRefusal('local', 'ci-heal')).toBeNull();
  });

  it('reads the run repository url', () => {
    expect(codingAgentRepoOf('https://github.com/o/r')).toEqual(REPO);
    expect(codingAgentRepoOf('https://github.com/o/r.git')).toEqual(REPO);
    expect(codingAgentRepoOf('git@github.com:o/r')).toBeUndefined();
  });
});

describe('the sealed coding agent record', () => {
  const ok = { laneId: 'issue-7-coding-agent-1', assignAt: '2026-11-09T10:00:00.123Z', assign: 'posted', since: { at: '2026-11-09T10:00:01Z', source: 'github' }, adopted: { pr: 77, head: HEAD }, linked: true, closed: false };

  it('accepts a well-formed record', () => {
    expect(codingAgentRecordProblem(ok)).toBeNull();
    expect(codingAgentRecordProblem({ laneId: ok.laneId, assignAt: ok.assignAt, assign: 'pending' })).toBeNull();
  });

  it.each([
    ['laneId', { ...ok, laneId: 'issue-7-implement-1' }],
    ['assign', { ...ok, assign: 'done' }],
    ['since', { ...ok, since: { at: '2026-11-09T10:00:01.500Z', source: 'github' } }],
    ['since', { ...ok, since: { at: '2026-11-09T10:00:01Z', source: 'local' } }],
    ['adopted', { ...ok, adopted: { pr: 77, head: 'HEAD' } }],
    ['adopted', { ...ok, adopted: { pr: 77, head: HEAD, extra: 1 } }],
    ['unknown field', { ...ok, trusted: true }],
  ])('refuses a bad %s', (_what, record) => {
    expect(codingAgentRecordProblem(record)).not.toBeNull();
  });

  it('the run state loader refuses a malformed record (the field is under the seal and shape-checked)', () => {
    const s = createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, '2026-11-09T10:00:00.000Z');
    expect(parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, codingAgent: ok })).codingAgent).toEqual(ok);
    expect(() => parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, codingAgent: { ...ok, assign: 'yes' } }))).toThrow(/field codingAgent/);
  });
});

describe('coding agent sessions', () => {
  it('counts per UTC day, idempotently per lane, the larger of the budget ledger and the engine mirror', () => {
    const root = join(dir, 'repo');
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(root);
    gitIn(root, 'init', '-q');
    const at = '2026-11-09T10:00:00.000Z';
    expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-09')).toBe(0);
    expect(recordCodingAgentSession({ root, ledgerDir, laneId: 'issue-7-coding-agent-1', run: 'issue-7', repo: REPO_ARG, at })).toEqual([]);
    recordCodingAgentSession({ root, ledgerDir, laneId: 'issue-7-coding-agent-1', run: 'issue-7', repo: REPO_ARG, at });
    recordCodingAgentSession({ root, ledgerDir, laneId: 'issue-8-coding-agent-1', run: 'issue-8', repo: REPO_ARG, at: '2026-11-08T23:59:59.000Z' });
    expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-09')).toBe(1);
    expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-08')).toBe(1);
    // A lane that wipes the repository's state root does not reset the count.
    rmSync(join(root), { recursive: true, force: true });
    expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-09')).toBe(1);
  });
});

describe('the pre-assign read and the tree check', () => {
  it('finds open agent PRs of any session in the repository; a human PR, a closed one or another repository does not count', () => {
    const fake = new FakeAgentGithub(() => '2026-11-09T10:00:00Z');
    fake.prs.push(
      { number: 5, state: 'OPEN', head: HEAD, linkedAt: '2026-01-01T00:00:00Z', commits: [], reviewRequests: [] },
      { number: 6, state: 'CLOSED', head: HEAD, linkedAt: '2026-01-02T00:00:00Z', commits: [], reviewRequests: [] },
      { number: 9, state: 'OPEN', head: HEAD, linkedAt: '2026-01-03T00:00:00Z', commits: [], reviewRequests: [], author: { ...HUMAN } },
    );
    expect(openAgentPrs(fake.status(), 'o/r')).toEqual([5]);
    expect(openAgentPrs(fake.status(), 'x/r')).toEqual([]);
    expect(openAgentPrs('not json', 'o/r')).toEqual([]);
    expect(AGENT.login).toBe('copilot-swe-agent');
  });

  it('reports gitlinks and symlinks the head adds or changes', () => {
    const base = ['100644 blob 1111\tREADME.md', '160000 commit aaaa\tvendor/x'].join('\0');
    const head = ['100644 blob 2222\tREADME.md', '160000 commit bbbb\tvendor/x', '120000 blob cccc\tlink', '160000 commit dddd\tnew'].join('\0');
    expect(linkEntries(base, head)).toEqual({ gitlinks: ['vendor/x', 'new'], symlinks: ['link'] });
    expect(linkEntries(base, base)).toEqual({ gitlinks: [], symlinks: [] });
  });
});
