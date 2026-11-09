import { describe, expect, it } from 'vitest';

import { assertFactoryCommand, factoryGuardExec, FactorySafetyError } from '../../../factory/run/exec.js';
import type { Exec } from '../../../ship/exec.js';
import {
  adoptPreconditions, CODING_AGENT_STATUS_QUERY, codingAgentAssignArgs, codingAgentCloseArgs, codingAgentStatusArgs,
  isCodingAgentAssignArgs, isCodingAgentCloseArgs, isCodingAgentStatusArgs, parseCodingAgentStatus, type CodingAgentStatus,
} from '../coding-agent.js';

const REPO = { host: 'github.com', owner: 'o', name: 'r' };
const REPO_ARG = 'github.com/o/r';
const HEAD = 'a'.repeat(40);

describe('coding agent argv', () => {
  it('builds the three exact shapes', () => {
    expect(codingAgentAssignArgs(REPO, 7, 'dev')).toEqual([
      'api', '--hostname', 'github.com', '--method', 'POST', 'repos/o/r/issues/7/assignees',
      '-f', 'assignees[]=copilot-swe-agent[bot]', '-f', 'agent_assignment[base_branch]=dev',
    ]);
    expect(codingAgentStatusArgs(REPO, 7)).toEqual([
      'api', 'graphql', '--hostname', 'github.com', '-f', `query=${CODING_AGENT_STATUS_QUERY}`, '-f', 'owner=o', '-f', 'name=r', '-F', 'number=7',
    ]);
    expect(codingAgentCloseArgs(REPO, 12)).toEqual(['pr', 'close', '12', '--repo', 'github.com/o/r']);
  });

  it('keeps the query on one line', () => {
    expect(CODING_AGENT_STATUS_QUERY).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['an owner with a slash', () => codingAgentStatusArgs({ ...REPO, owner: 'o/x' }, 7)],
    ['an option-shaped name', () => codingAgentAssignArgs({ ...REPO, name: '-r' }, 7, 'dev')],
    ['a bad host', () => codingAgentCloseArgs({ ...REPO, host: 'github.com/x' }, 7)],
    ['issue 0', () => codingAgentAssignArgs(REPO, 0, 'dev')],
    ['a fractional issue', () => codingAgentStatusArgs(REPO, 1.5)],
    ['a base with ..', () => codingAgentAssignArgs(REPO, 7, 'a..b')],
    ['a base with =', () => codingAgentAssignArgs(REPO, 7, 'a=b')],
    ['an option-shaped base', () => codingAgentAssignArgs(REPO, 7, '-dev')],
  ])('throws on %s', (_name, build) => {
    expect(build).toThrow(/coding agent/);
  });
});

describe('coding agent guard shapes', () => {
  const gh = (args: string[], repo: string | null = REPO_ARG) =>
    () => assertFactoryCommand('gh', args, [], undefined, undefined, undefined, undefined, repo === null ? undefined : { repo });

  it('passes each shape for the run repository', () => {
    expect(gh(codingAgentAssignArgs(REPO, 7, 'dev'))).not.toThrow();
    expect(gh(codingAgentStatusArgs(REPO, 7))).not.toThrow();
    expect(gh(codingAgentCloseArgs(REPO, 12))).not.toThrow();
    // GitHub resolves names case-insensitively.
    expect(gh(codingAgentStatusArgs({ host: 'GitHub.com', owner: 'O', name: 'R' }, 7))).not.toThrow();
  });

  it('refuses every shape without a repository context', () => {
    for (const args of [codingAgentAssignArgs(REPO, 7, 'dev'), codingAgentStatusArgs(REPO, 7)]) {
      expect(gh(args, null)).toThrow(FactorySafetyError);
    }
    expect(isCodingAgentCloseArgs(codingAgentCloseArgs(REPO, 12), undefined)).toBe(false);
  });

  it('refuses another repository', () => {
    const other = { ...REPO, name: 'other' };
    expect(gh(codingAgentAssignArgs(other, 7, 'dev'))).toThrow(FactorySafetyError);
    expect(gh(codingAgentStatusArgs(other, 7))).toThrow(FactorySafetyError);
    expect(gh(codingAgentStatusArgs({ ...REPO, host: 'example.com' }, 7))).toThrow(FactorySafetyError);
    expect(isCodingAgentCloseArgs(codingAgentCloseArgs(other, 12), REPO_ARG)).toBe(false);
    expect(isCodingAgentCloseArgs(['pr', 'close', '12', '--repo', 'o/r'], REPO_ARG)).toBe(false);
  });

  const assign = codingAgentAssignArgs(REPO, 7, 'dev');
  const status = codingAgentStatusArgs(REPO, 7);
  it.each([
    ['another endpoint', assign.map((a, i) => (i === 5 ? 'repos/o/r/issues/7/comments' : a))],
    ['a nested path', assign.map((a, i) => (i === 5 ? 'repos/o/r/issues/7/assignees/x' : a))],
    ['another assignee', assign.map((a, i) => (i === 7 ? 'assignees[]=mallory' : a))],
    ['a DELETE', assign.map((a, i) => (i === 4 ? 'DELETE' : a))],
    ['a typed field (@file)', assign.map((a, i) => (i === 8 ? '-F' : a))],
    ['custom instructions instead of the base', assign.map((a, i) => (i === 9 ? 'agent_assignment[custom_instructions]=x' : a))],
    ['a base with a space', assign.map((a, i) => (i === 9 ? 'agent_assignment[base_branch]=a b' : a))],
    ['an extra --input', [...assign, '--input', 'body.json']],
    ['a changed query', status.map((a, i) => (i === 5 ? `query=${CODING_AGENT_STATUS_QUERY} ` : a))],
    ['a mutation', status.map((a, i) => (i === 5 ? 'query=mutation{x}' : a))],
    ['a typed owner (@file)', status.map((a, i) => (i === 6 ? '-F' : a))],
    ['a non-integer number', status.map((a, i) => (i === 11 ? 'number=7x' : a))],
    ['a --jq filter', [...status, '--jq', '.']],
    ['a plain gh api path', ['api', 'repos/o/r']],
  ])('refuses %s', (_name, args) => {
    expect(gh(args)).toThrow(FactorySafetyError);
    expect(isCodingAgentAssignArgs(args, REPO_ARG) || isCodingAgentStatusArgs(args, REPO_ARG)).toBe(false);
  });

  it('refuses a close with extra flags', () => {
    expect(isCodingAgentCloseArgs([...codingAgentCloseArgs(REPO, 12), '--delete-branch'], REPO_ARG)).toBe(false);
    expect(isCodingAgentCloseArgs(['pr', 'close', 'x', '--repo', REPO_ARG], REPO_ARG)).toBe(false);
  });

  it('runs through factoryGuardExec only with the context', () => {
    const seen: string[][] = [];
    const inner: Exec = (_cmd, args) => {
      seen.push(args);
      return { status: 0, stdout: '{}', stderr: '' };
    };
    const args = codingAgentStatusArgs(REPO, 7);
    expect(() => factoryGuardExec(inner)('gh', args)).toThrow(FactorySafetyError);
    factoryGuardExec(inner, () => [], () => undefined, () => undefined, () => undefined, () => ({ repo: REPO_ARG }))('gh', args);
    expect(seen).toEqual([args]);
  });
});

// Responses in the shape GitHub returned for a real issue-assigned agent session (2026-11-09), renamed to o/r.
const agent = { __typename: 'Bot', login: 'copilot-swe-agent' };
const human = { __typename: 'User', login: 'robin' };
interface PrOver {
  number?: number; state?: string; author?: unknown; isCrossRepository?: boolean; headRepo?: string; baseRefName?: string; headRefOid?: string;
  reviews?: Array<{ at: string; actor: unknown }>;
}
const pr = (o: PrOver = {}) => ({
  __typename: 'PullRequest', number: o.number ?? 12, state: o.state ?? 'OPEN', isDraft: true, isCrossRepository: o.isCrossRepository ?? false,
  baseRefName: o.baseRefName ?? 'dev', headRefName: 'copilot/fix-thing', headRefOid: o.headRefOid ?? HEAD, author: o.author ?? agent,
  baseRepository: { nameWithOwner: 'o/r' }, headRepository: { nameWithOwner: o.headRepo ?? 'o/r' },
  timelineItems: { nodes: (o.reviews ?? []).map((r) => ({ __typename: 'ReviewRequestedEvent', createdAt: r.at, actor: r.actor })) },
});
const assigned = (at: string, who: unknown = agent) => ({ __typename: 'AssignedEvent', createdAt: at, assignee: who });
const unassigned = (at: string) => ({ __typename: 'UnassignedEvent', createdAt: at, assignee: agent });
const connected = (at: string, subject: unknown, actor: unknown = agent) => ({ __typename: 'ConnectedEvent', createdAt: at, actor, subject });
const crossRef = (at: string, source: unknown, actor: unknown = agent) => ({ __typename: 'CrossReferencedEvent', createdAt: at, actor, source });
const response = (events: unknown[], actors: unknown[] = [agent, human]) => JSON.stringify({
  data: { repository: { nameWithOwner: 'o/r', suggestedActors: { nodes: actors }, issue: { state: 'OPEN', timelineItems: { nodes: events } } } },
});
const FINISHED = [{ at: '2026-11-09T06:06:34Z', actor: human }, { at: '2026-11-09T06:07:34Z', actor: agent }];

describe('parseCodingAgentStatus', () => {
  it('reads a finished session', () => {
    const s = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:28Z', pr({ reviews: FINISHED })), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED })),
    ]));
    expect(s).toEqual({
      phase: 'finished', repo: 'o/r', available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [12],
      pr: {
        number: 12, state: 'OPEN', isDraft: true, byAgent: true, sameRepo: true, baseRef: 'dev', headRef: 'copilot/fix-thing', head: HEAD,
        linkedAt: '2026-11-09T06:05:40Z', finishedAt: '2026-11-09T06:07:34Z',
      },
    });
  });

  it('is working while only a human requested a review', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: [FINISHED[0]] }))]));
    expect(s.phase).toBe('working');
    expect(s.pr?.finishedAt).toBeUndefined();
  });

  it('does not count a User named like the agent', () => {
    const fake = { __typename: 'User', login: 'copilot-swe-agent' };
    const s = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:05:22Z'),
      connected('2026-11-09T06:05:40Z', pr({ author: fake, reviews: [{ at: '2026-11-09T06:07:00Z', actor: fake }] })),
      crossRef('2026-11-09T06:05:41Z', pr({ number: 13 }), fake),
    ]));
    expect(s.phase).toBe('working');
    expect(s.pr?.byAgent).toBe(false);
    expect(s.candidates).toEqual([12]);
  });

  it('ignores PRs a human linked', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:40Z', pr({ reviews: FINISHED }), human)]));
    expect(s).toEqual({ phase: 'waiting-pr', repo: 'o/r', available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [] });
  });

  it('tells not-assigned, unassigned and unavailable apart', () => {
    expect(parseCodingAgentStatus(response([])).phase).toBe('not-assigned');
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z', human)])).phase).toBe('not-assigned');
    const off = parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), unassigned('2026-11-09T06:01:00Z')]));
    expect(off.phase).toBe('not-assigned');
    expect(off.assignedAt).toBeUndefined();
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:02:00Z'), unassigned('2026-11-09T06:01:00Z')])).phase).toBe('waiting-pr');
    expect(parseCodingAgentStatus(response([], [human]))).toEqual({ phase: 'unavailable', repo: 'o/r', available: false, candidates: [] });
  });

  it('drops an older session before since', () => {
    const events = [
      assigned('2026-11-01T00:00:00Z'), connected('2026-11-01T00:01:00Z', pr({ number: 5, state: 'CLOSED', reviews: [{ at: '2026-11-01T00:30:00Z', actor: agent }] })),
      assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: [{ at: '2026-11-01T00:30:00Z', actor: agent }] })),
    ];
    const s = parseCodingAgentStatus(response(events), '2026-11-09T06:05:00Z');
    expect(s.phase).toBe('working');
    expect(s.candidates).toEqual([12]);
    expect(parseCodingAgentStatus(response(events)).candidates).toEqual([12, 5]);
  });

  it('reports a PR closed before adoption, and two open PRs as ambiguous', () => {
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr({ state: 'MERGED' }))])).phase).toBe('closed');
    const two = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr()), connected('2026-11-09T06:02:00Z', pr({ number: 13 })),
    ]));
    expect(two.phase).toBe('ambiguous');
    expect(two.candidates).toEqual([13, 12]);
  });

  it('drops values that are not plain', () => {
    const s = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr({ headRefOid: 'HEAD', baseRefName: '-x' })), connected('not a time', pr({ number: 14 })),
    ]));
    expect(s.pr?.head).toBeUndefined();
    expect(s.pr?.baseRef).toBeUndefined();
    expect(s.candidates).toEqual([12]);
  });

  it('throws on a response without an issue', () => {
    expect(() => parseCodingAgentStatus('not json')).toThrow(/no JSON/);
    expect(() => parseCodingAgentStatus(JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', issue: null } }, errors: [{ message: 'Could not resolve' }] })))
      .toThrow(/no issue in the response \(Could not resolve\)/);
    expect(() => parseCodingAgentStatus(response([]), 'yesterday')).toThrow(/ISO time/);
  });
});

describe('adoptPreconditions', () => {
  const finished = (o: PrOver = {}): CodingAgentStatus =>
    parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr({ reviews: FINISHED, ...o }))]));
  const want = { repo: 'o/r', base: 'dev' };

  it('accepts the agent PR on the run base in the same repository', () => {
    expect(adoptPreconditions(finished(), want)).toEqual({ ok: true, pr: 12, head: HEAD });
    expect(adoptPreconditions(finished(), { repo: 'O/R', base: 'dev' }).ok).toBe(true);
  });

  it.each([
    ['a human author', { author: human }, /not authored by the copilot-swe-agent bot/],
    ['a cross-repository head', { isCrossRepository: true }, /cross-repository/],
    ['a head in a fork', { headRepo: 'mallory/r' }, /cross-repository/],
    ['another base', { baseRefName: 'main' }, /targets main, not dev/],
    ['no 40-hex head', { headRefOid: 'abc' }, /no 40-hex head/],
  ])('refuses %s', (_name, over, reason) => {
    const check = adoptPreconditions(finished(over as PrOver), want);
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.reasons.join('; ')).toMatch(reason);
  });

  it('refuses a session that has not finished, or another repository', () => {
    const working = parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr())]));
    expect(adoptPreconditions(working, want)).toEqual({ ok: false, reasons: ['the coding agent has not finished (working)'] });
    expect(adoptPreconditions(finished(), { repo: 'o/other', base: 'dev' }).ok).toBe(false);
  });
});
