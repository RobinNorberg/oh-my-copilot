import { describe, expect, it } from 'vitest';

import { assertFactoryCommand, factoryGuardExec, FactorySafetyError } from '../../../factory/run/exec.js';
import type { Exec } from '../../../ship/exec.js';
import {
  adoptPreconditions, assignCodingAgent, CODING_AGENT_SINCE_SKEW_SECONDS, CODING_AGENT_STATUS_QUERY, codingAgentAssignArgs, codingAgentCloseArgs,
  codingAgentStatusArgs, codingAgentWindowStart, isCodingAgentAssignArgs, isCodingAgentCloseArgs, isCodingAgentStatusArgs, parseCodingAgentStatus,
  type CodingAgentContext, type CodingAgentPr, type CodingAgentStatus,
} from '../coding-agent.js';

const REPO = { host: 'github.com', owner: 'o', name: 'r' };
const REPO_ARG = 'github.com/o/r';
const HEAD = 'a'.repeat(40);
const SINCE = '2026-11-09T06:05:22.300Z';
const AGENT_CTX: CodingAgentContext = { repo: REPO_ARG, issue: 7, base: 'dev', pr: 12 };

describe('coding agent argv', () => {
  it('builds the three exact shapes', () => {
    expect(codingAgentAssignArgs(REPO, 7, 'dev')).toEqual([
      'api', '--hostname', 'github.com', '--method', 'POST', 'repos/o/r/issues/7/assignees',
      '-f', 'assignees[]=copilot-swe-agent[bot]', '-f', 'agent_assignment[base_branch]=dev',
    ]);
    expect(codingAgentStatusArgs(REPO, 7, SINCE)).toEqual([
      'api', 'graphql', '--hostname', 'github.com', '-f', `query=${CODING_AGENT_STATUS_QUERY}`, '-f', 'owner=o', '-f', 'name=r', '-F', 'number=7',
      '-f', 'since=2026-11-09T06:03:22Z',
    ]);
    expect(codingAgentCloseArgs(REPO, 12)).toEqual(['pr', 'close', '12', '--repo', 'github.com/o/r']);
  });

  it('keeps the query on one line, windowed and paged', () => {
    expect(CODING_AGENT_STATUS_QUERY).not.toMatch(/[\r\n]/);
    expect(CODING_AGENT_STATUS_QUERY).toContain('timelineItems(last:100,since:$since,');
    expect(CODING_AGENT_STATUS_QUERY).toContain('timelineItems(last:50,since:$since,');
    expect(CODING_AGENT_STATUS_QUERY).toContain('suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){pageInfo{hasNextPage}');
    expect(CODING_AGENT_STATUS_QUERY.match(/pageInfo\{hasPreviousPage\}/g)).toHaveLength(2);
    expect(CODING_AGENT_STATUS_QUERY).toContain('commits(last:1){nodes{commit{oid committedDate}}}');
  });

  it('floors since to the second and subtracts the skew margin', () => {
    expect(CODING_AGENT_SINCE_SKEW_SECONDS).toBe(120);
    expect(codingAgentWindowStart('2026-11-09T06:05:22.999Z')).toBe('2026-11-09T06:03:22Z');
    expect(codingAgentWindowStart('2026-11-09T06:05:22Z')).toBe('2026-11-09T06:03:22Z');
    expect(() => codingAgentWindowStart('yesterday')).toThrow(/ISO time/);
  });

  it.each([
    ['an owner with a slash', () => codingAgentStatusArgs({ ...REPO, owner: 'o/x' }, 7, SINCE)],
    ['an option-shaped name', () => codingAgentAssignArgs({ ...REPO, name: '-r' }, 7, 'dev')],
    ['a bad host', () => codingAgentCloseArgs({ ...REPO, host: 'github.com/x' }, 7)],
    ['issue 0', () => codingAgentAssignArgs(REPO, 0, 'dev')],
    ['a fractional issue', () => codingAgentStatusArgs(REPO, 1.5, SINCE)],
    ['a bad since', () => codingAgentStatusArgs(REPO, 7, '2026-11-09')],
    ['a base with ..', () => codingAgentAssignArgs(REPO, 7, 'a..b')],
    ['a base with =', () => codingAgentAssignArgs(REPO, 7, 'a=b')],
    ['an option-shaped base', () => codingAgentAssignArgs(REPO, 7, '-dev')],
    ['a base starting with .', () => codingAgentAssignArgs(REPO, 7, '.dev')],
    ['a base with a /. component', () => codingAgentAssignArgs(REPO, 7, 'feat/.x')],
    ['a base with //', () => codingAgentAssignArgs(REPO, 7, 'feat//x')],
    ['a base component ending .lock', () => codingAgentAssignArgs(REPO, 7, 'a.lock/b')],
    ['a base ending .lock', () => codingAgentAssignArgs(REPO, 7, 'dev.lock')],
    ['a base ending .', () => codingAgentAssignArgs(REPO, 7, 'dev.')],
    ['a base with @{', () => codingAgentAssignArgs(REPO, 7, 'dev@{1}')],
  ])('throws on %s', (_name, build) => {
    expect(build).toThrow(/coding agent/);
  });

  it('accepts ordinary branch names', () => {
    for (const b of ['dev', 'main', 'release/v5.21.0', 'feat/x_y-z', 'v1.2']) expect(() => codingAgentAssignArgs(REPO, 7, b)).not.toThrow();
  });
});

describe('coding agent guard shapes', () => {
  const gh = (args: string[], repo: string | null = REPO_ARG, agent?: CodingAgentContext) =>
    () => assertFactoryCommand('gh', args, [], undefined, undefined, undefined, undefined, repo === null ? undefined : { repo }, agent);
  const assign = codingAgentAssignArgs(REPO, 7, 'dev');
  const status = codingAgentStatusArgs(REPO, 7, SINCE);
  const close = codingAgentCloseArgs(REPO, 12);

  it('passes the status read with the read context only', () => {
    expect(gh(status)).not.toThrow();
    // GitHub resolves names case-insensitively.
    expect(gh(codingAgentStatusArgs({ host: 'GitHub.com', owner: 'O', name: 'R' }, 7, SINCE))).not.toThrow();
    expect(gh(status, null)).toThrow(FactorySafetyError);
  });

  it('refuses both writes with only the read context', () => {
    expect(gh(assign)).toThrow(FactorySafetyError);
    expect(gh(close)).toThrow(FactorySafetyError);
  });

  it('passes the writes with the step context for its issue, base and PR', () => {
    expect(gh(assign, null, AGENT_CTX)).not.toThrow();
    expect(gh(close, null, AGENT_CTX)).not.toThrow();
    expect(gh(status, null, AGENT_CTX)).not.toThrow();
  });

  it('binds the assign to the context issue and the exact base', () => {
    expect(isCodingAgentAssignArgs(codingAgentAssignArgs(REPO, 8, 'dev'), AGENT_CTX)).toBe(false);
    expect(isCodingAgentAssignArgs(codingAgentAssignArgs(REPO, 7, 'main'), AGENT_CTX)).toBe(false);
    expect(isCodingAgentAssignArgs(codingAgentAssignArgs(REPO, 7, 'Dev'), AGENT_CTX)).toBe(false);
    expect(isCodingAgentAssignArgs(codingAgentAssignArgs(REPO, 70, 'dev'), AGENT_CTX)).toBe(false);
    expect(isCodingAgentAssignArgs(assign.map((a, i) => (i === 5 ? 'repos/o/r/issues/07/assignees' : a)), AGENT_CTX)).toBe(false);
    expect(gh(codingAgentAssignArgs(REPO, 8, 'dev'), REPO_ARG, AGENT_CTX)).toThrow(FactorySafetyError);
    expect(isCodingAgentAssignArgs(assign, { ...AGENT_CTX, base: '.bad' })).toBe(false);
  });

  it('binds the close to the context PR', () => {
    expect(isCodingAgentCloseArgs(codingAgentCloseArgs(REPO, 13), AGENT_CTX)).toBe(false);
    expect(isCodingAgentCloseArgs(close, { repo: REPO_ARG, issue: 7, base: 'dev' })).toBe(false);
    expect(gh(codingAgentCloseArgs(REPO, 13), REPO_ARG, AGENT_CTX)).toThrow(FactorySafetyError);
    expect(isCodingAgentCloseArgs(close, undefined)).toBe(false);
  });

  it('refuses another repository', () => {
    const other = { ...REPO, name: 'other' };
    expect(gh(codingAgentAssignArgs(other, 7, 'dev'), null, AGENT_CTX)).toThrow(FactorySafetyError);
    expect(gh(codingAgentStatusArgs(other, 7, SINCE))).toThrow(FactorySafetyError);
    expect(gh(codingAgentStatusArgs({ ...REPO, host: 'example.com' }, 7, SINCE))).toThrow(FactorySafetyError);
    expect(isCodingAgentCloseArgs(codingAgentCloseArgs(other, 12), AGENT_CTX)).toBe(false);
    expect(isCodingAgentCloseArgs(['pr', 'close', '12', '--repo', 'o/r'], AGENT_CTX)).toBe(false);
  });

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
    ['a typed since (@file)', status.map((a, i) => (i === 12 ? '-F' : a))],
    ['a sub-second since', status.map((a, i) => (i === 13 ? 'since=2026-11-09T06:03:22.5Z' : a))],
    ['a since that is no time', status.map((a, i) => (i === 13 ? 'since=@x' : a))],
    ['a status read without since', status.slice(0, 12)],
    ['a --jq filter', [...status, '--jq', '.']],
    ['a plain gh api path', ['api', 'repos/o/r']],
  ])('refuses %s', (_name, args) => {
    expect(gh(args, REPO_ARG, AGENT_CTX)).toThrow(FactorySafetyError);
    expect(isCodingAgentAssignArgs(args, AGENT_CTX) || isCodingAgentStatusArgs(args, REPO_ARG)).toBe(false);
  });

  it('refuses a close with extra flags', () => {
    expect(isCodingAgentCloseArgs([...close, '--delete-branch'], AGENT_CTX)).toBe(false);
    expect(isCodingAgentCloseArgs(['pr', 'close', 'x', '--repo', REPO_ARG], AGENT_CTX)).toBe(false);
  });

  it('runs through factoryGuardExec: status with the read provider, writes only with the agent provider', () => {
    const seen: string[][] = [];
    const inner: Exec = (_cmd, args) => {
      seen.push(args);
      return { status: 0, stdout: '{}', stderr: '' };
    };
    const none = () => undefined;
    expect(() => factoryGuardExec(inner)('gh', status)).toThrow(FactorySafetyError);
    const readOnly = factoryGuardExec(inner, () => [], none, none, none, () => ({ repo: REPO_ARG }));
    readOnly('gh', status);
    expect(() => readOnly('gh', assign)).toThrow(FactorySafetyError);
    expect(() => readOnly('gh', close)).toThrow(FactorySafetyError);
    const step = factoryGuardExec(inner, () => [], none, none, none, () => ({ repo: REPO_ARG }), () => AGENT_CTX);
    step('gh', assign);
    step('gh', close);
    expect(seen).toEqual([status, assign, close]);
  });
});

// Responses in the shape GitHub returned for a real issue-assigned agent session (2026-11-09), renamed to o/r.
const agent = { __typename: 'Bot', login: 'copilot-swe-agent' };
const human = { __typename: 'User', login: 'robin' };
const page = (more = false) => ({ hasPreviousPage: more });
interface PrOver {
  number?: number; state?: string; author?: unknown; isCrossRepository?: boolean; headRepo?: string; baseRefName?: string; headRefOid?: string;
  reviews?: Array<{ at: string; actor: unknown }>; committedAt?: string | null; commitOid?: string; reviewsCut?: boolean;
}
const pr = (o: PrOver = {}) => ({
  __typename: 'PullRequest', number: o.number ?? 12, state: o.state ?? 'OPEN', isDraft: true, isCrossRepository: o.isCrossRepository ?? false,
  baseRefName: o.baseRefName ?? 'dev', headRefName: 'copilot/fix-thing', headRefOid: o.headRefOid ?? HEAD, author: o.author ?? agent,
  baseRepository: { nameWithOwner: 'o/r' }, headRepository: { nameWithOwner: o.headRepo ?? 'o/r' },
  commits: { nodes: o.committedAt === null ? [] : [{ commit: { oid: o.commitOid ?? o.headRefOid ?? HEAD, committedDate: o.committedAt ?? '2026-11-09T06:07:00Z' } }] },
  timelineItems: {
    pageInfo: page(o.reviewsCut),
    nodes: (o.reviews ?? []).map((r) => ({ __typename: 'ReviewRequestedEvent', createdAt: r.at, actor: r.actor })),
  },
});
const assigned = (at: string, who: unknown = agent) => ({ __typename: 'AssignedEvent', createdAt: at, assignee: who });
const unassigned = (at: string) => ({ __typename: 'UnassignedEvent', createdAt: at, assignee: agent });
const connected = (at: string, subject: unknown, actor: unknown = agent) => ({ __typename: 'ConnectedEvent', createdAt: at, actor, subject });
const crossRef = (at: string, source: unknown, actor: unknown = agent) => ({ __typename: 'CrossReferencedEvent', createdAt: at, actor, source });
const response = (events: unknown[], actors: unknown[] = [agent, human], o: { cut?: boolean; actorsCut?: boolean } = {}) => JSON.stringify({
  data: {
    repository: {
      nameWithOwner: 'o/r', suggestedActors: { pageInfo: { hasNextPage: o.actorsCut ?? false }, nodes: actors },
      issue: { state: 'OPEN', timelineItems: { pageInfo: page(o.cut), nodes: events } },
    },
  },
});
const FINISHED = [{ at: '2026-11-09T06:06:34Z', actor: human }, { at: '2026-11-09T06:07:34Z', actor: agent }];

describe('parseCodingAgentStatus', () => {
  it('reads a finished session', () => {
    const s = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:28Z', pr({ reviews: FINISHED })), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED })),
    ]));
    expect(s).toEqual({
      phase: 'finished', repo: 'o/r', available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [12], ignored: [],
      pr: {
        number: 12, state: 'OPEN', isDraft: true, byAgent: true, sameRepo: true, baseRef: 'dev', headRef: 'copilot/fix-thing', head: HEAD,
        headCommittedAt: '2026-11-09T06:07:00Z', linkedAt: '2026-11-09T06:05:40Z', finishedAt: '2026-11-09T06:07:34Z', truncated: false,
      },
    });
  });

  it('keeps the agent assignment that GitHub stamped just before the local since (whole seconds, clock skew)', () => {
    // Local since 06:05:22.300Z, GitHub stamped the assignment 06:05:22Z (22.7 s truncated), and a 90 s slower GitHub clock.
    for (const at of ['2026-11-09T06:05:22Z', '2026-11-09T06:03:52Z']) {
      const s = parseCodingAgentStatus(response([assigned(at)]), SINCE);
      expect(s.phase).toBe('waiting-pr');
      expect(s.assignedAt).toBe(at);
    }
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:03:21Z')]), SINCE).phase).toBe('not-assigned');
  });

  it('reports the FIRST agent assignment in the window as assignedAt', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:30Z'), assigned('2026-11-09T06:05:22Z')]), SINCE);
    expect(s.assignedAt).toBe('2026-11-09T06:05:22Z');
  });

  it('is working while only a human requested a review', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: [FINISHED[0]] }))]));
    expect(s.phase).toBe('working');
    expect(s.pr?.finishedAt).toBeUndefined();
  });

  it('is working again when a follow-up session pushed after the review request', () => {
    const followUp = pr({ reviews: FINISHED, committedAt: '2026-11-09T06:20:00Z' });
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', followUp)]));
    expect(s.phase).toBe('working');
    expect(s.pr?.finishedAt).toBe('2026-11-09T06:07:34Z');
    // ... and finished once the agent requests a review again after that commit.
    const again = pr({ reviews: [...FINISHED, { at: '2026-11-09T06:25:00Z', actor: agent }], committedAt: '2026-11-09T06:20:00Z' });
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', again)])).phase).toBe('finished');
  });

  it('counts a review request in the same second as the head commit as after it', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED, committedAt: '2026-11-09T06:07:34Z' }))]));
    expect(s.phase).toBe('finished');
  });

  it('stays working when the head commit time is unknown or belongs to another commit', () => {
    for (const over of [{ committedAt: null }, { commitOid: 'b'.repeat(40) }, { headRefOid: 'abc' }] as PrOver[]) {
      const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED, ...over }))]));
      expect(s.phase).toBe('working');
      expect(s.pr?.headCommittedAt).toBeUndefined();
    }
  });

  it('only counts PRs the agent authored in this repository; the rest are ignored', () => {
    const fake = { __typename: 'User', login: 'copilot-swe-agent' };
    const s = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:05:22Z'),
      crossRef('2026-11-09T06:05:30Z', pr({ number: 20, author: human, reviews: FINISHED })),
      crossRef('2026-11-09T06:05:31Z', pr({ number: 21, headRepo: 'mallory/r', isCrossRepository: true, reviews: FINISHED })),
      connected('2026-11-09T06:05:40Z', pr({ number: 13, author: fake })),
    ]));
    expect(s).toEqual({ phase: 'waiting-pr', repo: 'o/r', available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [], ignored: [13, 20, 21] });
    // A foreign open PR does not make the agent's own PR ambiguous.
    const mixed = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:30Z', pr({ number: 20, author: human })), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED })),
    ]));
    expect(mixed.phase).toBe('finished');
    expect(mixed.pr?.number).toBe(12);
    expect(mixed.candidates).toEqual([12]);
    expect(mixed.ignored).toEqual([20]);
  });

  it('ignores PRs a human linked', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:40Z', pr({ reviews: FINISHED }), human)]));
    expect(s).toEqual({ phase: 'waiting-pr', repo: 'o/r', available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [], ignored: [] });
  });

  it('tells not-assigned, unassigned and unavailable apart', () => {
    expect(parseCodingAgentStatus(response([])).phase).toBe('not-assigned');
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z', human)])).phase).toBe('not-assigned');
    const off = parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), unassigned('2026-11-09T06:01:00Z')]));
    expect(off.phase).toBe('not-assigned');
    expect(off.assignedAt).toBeUndefined();
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:02:00Z'), unassigned('2026-11-09T06:01:00Z')])).phase).toBe('waiting-pr');
    expect(parseCodingAgentStatus(response([], [human]))).toEqual({ phase: 'unavailable', repo: 'o/r', available: false, candidates: [], ignored: [] });
  });

  it('fails closed as truncated when a list was cut', () => {
    // The issue timeline: older items in the window are missing, so the assignment may be hidden.
    const issueCut = parseCodingAgentStatus(response([connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED }))], undefined, { cut: true }));
    expect(issueCut.phase).toBe('truncated');
    expect(issueCut.pr).toBeUndefined();
    // A missing pageInfo counts as cut.
    const noInfo = JSON.parse(response([assigned('2026-11-09T06:05:22Z')])) as { data: { repository: { issue: { timelineItems: Record<string, unknown> } } } };
    delete noInfo.data.repository.issue.timelineItems.pageInfo;
    expect(parseCodingAgentStatus(JSON.stringify(noInfo)).phase).toBe('truncated');
    // The agent's PR review requests.
    const prCut = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED, reviewsCut: true }))]));
    expect(prCut.phase).toBe('truncated');
    expect(prCut.pr).toBeUndefined();
    // The assignable actors, when the agent is not among those returned.
    expect(parseCodingAgentStatus(response([], [human], { actorsCut: true })).phase).toBe('truncated');
    expect(parseCodingAgentStatus(response([], [agent], { actorsCut: true })).phase).toBe('not-assigned');
  });

  it('drops an older session before the window', () => {
    const events = [
      assigned('2026-11-01T00:00:00Z'), connected('2026-11-01T00:01:00Z', pr({ number: 5, state: 'CLOSED', reviews: [{ at: '2026-11-01T00:30:00Z', actor: agent }] })),
      assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: [{ at: '2026-11-01T00:30:00Z', actor: agent }] })),
    ];
    const s = parseCodingAgentStatus(response(events), '2026-11-09T06:05:00Z');
    expect(s.phase).toBe('working');
    expect(s.candidates).toEqual([12]);
    expect(parseCodingAgentStatus(response(events)).candidates).toEqual([12, 5]);
  });

  it('reports a PR closed before adoption, and two open PRs as ambiguous without a pr', () => {
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr({ state: 'MERGED' }))])).phase).toBe('closed');
    const two = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr()), connected('2026-11-09T06:02:00Z', pr({ number: 13 })),
    ]));
    expect(two.phase).toBe('ambiguous');
    expect(two.pr).toBeUndefined();
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

  it('throws on a response without an issue, with a plain error message', () => {
    expect(() => parseCodingAgentStatus('not json')).toThrow(/no JSON/);
    expect(() => parseCodingAgentStatus(JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', issue: null } }, errors: [{ message: 'Could not resolve' }] })))
      .toThrow(/no issue in the response \(Could not resolve\)/);
    const nasty = 'Bad\u001b[31m red\u001b[0m\r\nline‮ evil⁦ x\u0007';
    let message = '';
    try {
      parseCodingAgentStatus(JSON.stringify({ data: { repository: null }, errors: [{ message: nasty }] }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('coding agent status: no issue in the response (Bad redline evil x)');
    expect(() => parseCodingAgentStatus(response([]), 'yesterday')).toThrow(/ISO time/);
  });
});

describe('assignCodingAgent', () => {
  const run = (statusOut: string | null) => {
    const calls: string[][] = [];
    const exec: Exec = (_cmd, args) => {
      calls.push(args);
      if (args[1] === '--hostname') return { status: 0, stdout: '{}', stderr: '' };
      return statusOut === null ? { status: 1, stdout: '', stderr: 'HTTP 502\nmore' } : { status: 0, stdout: statusOut, stderr: '' };
    };
    return { calls, result: () => assignCodingAgent(exec, REPO, 7, 'dev', SINCE, '/w') };
  };

  it('posts, reads once and confirms with GitHub time', () => {
    const { calls, result } = run(response([assigned('2026-11-09T06:05:22Z')]));
    const r = result();
    expect(r).toMatchObject({ posted: true, confirmed: true });
    expect(r.status?.assignedAt).toBe('2026-11-09T06:05:22Z');
    expect(calls).toEqual([codingAgentAssignArgs(REPO, 7, 'dev'), codingAgentStatusArgs(REPO, 7, SINCE)]);
  });

  it('says posted but unconfirmed when the read does not show it yet, is cut, or fails', () => {
    expect(run(response([])).result()).toMatchObject({ posted: true, confirmed: false, status: { phase: 'not-assigned' } });
    expect(run(response([assigned('2026-11-09T06:05:22Z')], undefined, { cut: true })).result()).toMatchObject({ posted: true, confirmed: false });
    const failed = run(null).result();
    expect(failed).toMatchObject({ posted: true, confirmed: false });
    expect(failed.status).toBeUndefined();
    expect(failed.readError).toMatch(/exit 1\): HTTP 502$/);
  });

  it('throws when the POST fails', () => {
    const exec: Exec = () => ({ status: 1, stdout: '', stderr: 'HTTP 422' });
    expect(() => assignCodingAgent(exec, REPO, 7, 'dev', SINCE, '/w')).toThrow(/HTTP 422/);
  });
});

describe('adoptPreconditions', () => {
  const finished = (o: PrOver = {}): CodingAgentStatus =>
    parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr({ reviews: FINISHED, ...o }))]));
  const want = { repo: 'o/r', base: 'dev' };
  const withPr = (over: Partial<CodingAgentPr>): CodingAgentStatus => {
    const s = finished();
    return { ...s, pr: { ...s.pr!, ...over } };
  };

  it('accepts the agent PR on the run base in the same repository', () => {
    expect(adoptPreconditions(finished(), want)).toEqual({ ok: true, pr: 12, head: HEAD });
    expect(adoptPreconditions(finished(), { repo: 'O/R', base: 'dev' }).ok).toBe(true);
  });

  it.each([
    ['a human author', withPr({ byAgent: false }), /not authored by the copilot-swe-agent bot/],
    ['a cross-repository head', withPr({ sameRepo: false }), /cross-repository/],
    ['another base', finished({ baseRefName: 'main' }), /targets main, not dev/],
    ['no 40-hex head', withPr({ head: undefined }), /no 40-hex head/],
  ])('refuses %s', (_name, status, reason) => {
    const check = adoptPreconditions(status, want);
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.reasons.join('; ')).toMatch(reason);
  });

  it('never sees a PR the agent did not author or that lives in a fork', () => {
    expect(adoptPreconditions(finished({ author: human }), want)).toEqual({ ok: false, reasons: ['the coding agent has not finished (waiting-pr)'] });
    expect(adoptPreconditions(finished({ headRepo: 'mallory/r' }), want)).toEqual({ ok: false, reasons: ['the coding agent has not finished (waiting-pr)'] });
  });

  it('refuses a session that has not finished, or another repository', () => {
    const working = parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), connected('2026-11-09T06:01:00Z', pr())]));
    expect(adoptPreconditions(working, want)).toEqual({ ok: false, reasons: ['the coding agent has not finished (working)'] });
    expect(adoptPreconditions(finished(), { repo: 'o/other', base: 'dev' }).ok).toBe(false);
  });
});
