import { describe, expect, it } from 'vitest';

import { assertFactoryCommand, factoryGuardExec, FactorySafetyError } from '../../../factory/run/exec.js';
import type { Exec } from '../../../ship/exec.js';
import {
  adoptPreconditions, assignCodingAgent, CODING_AGENT_SINCE_SKEW_SECONDS, CODING_AGENT_STATUS_QUERY, codingAgentAssignArgs, codingAgentCloseArgs,
  codingAgentStatusArgs, codingAgentWindowStart, isCodingAgentAssignArgs, isCodingAgentCloseArgs, isCodingAgentStatusArgs, parseCodingAgentStatus,
  type CodingAgentContext, type CodingAgentPr, type CodingAgentSince, type CodingAgentStatus,
} from '../coding-agent.js';

const REPO = { host: 'github.com', owner: 'o', name: 'r' };
const REPO_ARG = 'github.com/o/r';
const HEAD = 'a'.repeat(40);
const SINCE = '2026-11-09T06:05:22.300Z';
const LOCAL: CodingAgentSince = { at: SINCE, source: 'local' };
const github = (at: string): CodingAgentSince => ({ at, source: 'github' });
const AGENT_CTX: CodingAgentContext = { repo: REPO_ARG, issue: 7, base: 'dev', pr: 12 };

describe('coding agent argv', () => {
  it('builds the three exact shapes', () => {
    expect(codingAgentAssignArgs(REPO, 7, 'dev')).toEqual([
      'api', '--hostname', 'github.com', '--method', 'POST', 'repos/o/r/issues/7/assignees',
      '-f', 'assignees[]=copilot-swe-agent[bot]', '-f', 'agent_assignment[base_branch]=dev',
    ]);
    expect(codingAgentStatusArgs(REPO, 7, LOCAL)).toEqual([
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
    expect(CODING_AGENT_STATUS_QUERY.match(/pageInfo\{hasPreviousPage\}/g)).toHaveLength(3);
    expect(CODING_AGENT_STATUS_QUERY).toContain('commits(last:100){pageInfo{hasPreviousPage} nodes{commit{oid committedDate author{user{login}} signature{isValid wasSignedByGitHub}}}}');
    expect(CODING_AGENT_STATUS_QUERY).toContain('issue(number:$number){number state ');
  });

  it('floors since to the second and subtracts the skew margin', () => {
    expect(CODING_AGENT_SINCE_SKEW_SECONDS).toBe(120);
    expect(codingAgentWindowStart('2026-11-09T06:05:22.999Z')).toBe('2026-11-09T06:03:22Z');
    expect(codingAgentWindowStart('2026-11-09T06:05:22Z')).toBe('2026-11-09T06:03:22Z');
    expect(() => codingAgentWindowStart('yesterday')).toThrow(/ISO time/);
  });

  it('refuses a since that is no calendar time, or of no known source', () => {
    for (const at of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-09T24:00:00Z', '2026-11-31T10:00:00.5Z']) {
      expect(() => codingAgentWindowStart(at)).toThrow(/ISO time/);
      expect(() => parseCodingAgentStatus(response([]), github(at))).toThrow(/ISO time/);
    }
    expect(() => codingAgentStatusArgs(REPO, 7, { at: SINCE, source: 'server' } as unknown as CodingAgentSince)).toThrow(/neither local nor github/);
    // A github since is widened in the query like a local one (the parser cuts it exactly).
    expect(codingAgentStatusArgs(REPO, 7, github('2026-11-09T06:05:22Z'))[13]).toBe('since=2026-11-09T06:03:22Z');
  });

  it.each([
    ['an owner with a slash', () => codingAgentStatusArgs({ ...REPO, owner: 'o/x' }, 7, LOCAL)],
    ['an option-shaped name', () => codingAgentAssignArgs({ ...REPO, name: '-r' }, 7, 'dev')],
    ['a bad host', () => codingAgentCloseArgs({ ...REPO, host: 'github.com/x' }, 7)],
    ['issue 0', () => codingAgentAssignArgs(REPO, 0, 'dev')],
    ['a fractional issue', () => codingAgentStatusArgs(REPO, 1.5, LOCAL)],
    ['a bad since', () => codingAgentStatusArgs(REPO, 7, { at: '2026-11-09', source: 'local' })],
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
  const status = codingAgentStatusArgs(REPO, 7, LOCAL);
  const close = codingAgentCloseArgs(REPO, 12);

  it('passes the status read with the read context only', () => {
    expect(gh(status)).not.toThrow();
    // GitHub resolves names case-insensitively.
    expect(gh(codingAgentStatusArgs({ host: 'GitHub.com', owner: 'O', name: 'R' }, 7, LOCAL))).not.toThrow();
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
    expect(gh(codingAgentStatusArgs(other, 7, LOCAL))).toThrow(FactorySafetyError);
    expect(gh(codingAgentStatusArgs({ ...REPO, host: 'example.com' }, 7, LOCAL))).toThrow(FactorySafetyError);
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
    ['a since on 30 February', status.map((a, i) => (i === 13 ? 'since=2026-02-30T00:00:00Z' : a))],
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
  /** Commits before the head commit (oldest first) and the account each maps to (null: no account). */
  earlier?: Array<{ oid: string; user: string | null; signature?: Sig }>; headUser?: string | null; commitsCut?: boolean;
  /** The head commit's signature (default: valid, web-flow, as every live agent commit). */
  headSignature?: Sig;
}
/** A commit signature as GraphQL returns it; null: unsigned. */
type Sig = { isValid: boolean; wasSignedByGitHub: boolean } | null;
const WEB_FLOW: Sig = { isValid: true, wasSignedByGitHub: true };
const commit = (oid: string, committedDate: string, user: string | null, signature: Sig = WEB_FLOW) =>
  ({ commit: { oid, committedDate, author: { user: user === null ? null : { login: user } }, signature } });
const pr = (o: PrOver = {}) => ({
  __typename: 'PullRequest', number: o.number ?? 12, state: o.state ?? 'OPEN', isDraft: true, isCrossRepository: o.isCrossRepository ?? false,
  baseRefName: o.baseRefName ?? 'dev', headRefName: 'copilot/fix-thing', headRefOid: o.headRefOid ?? HEAD, author: o.author ?? agent,
  baseRepository: { nameWithOwner: 'o/r' }, headRepository: { nameWithOwner: o.headRepo ?? 'o/r' },
  commits: {
    pageInfo: page(o.commitsCut),
    nodes: [
      ...(o.earlier ?? []).map((c) => commit(c.oid, '2026-11-09T06:06:00Z', c.user, c.signature === undefined ? WEB_FLOW : c.signature)),
      ...(o.committedAt === null ? [] : [commit(o.commitOid ?? o.headRefOid ?? HEAD, o.committedAt ?? '2026-11-09T06:07:00Z', o.headUser === undefined ? 'Copilot' : o.headUser,
        o.headSignature === undefined ? WEB_FLOW : o.headSignature)]),
    ],
  },
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
      issue: { number: 7, state: 'OPEN', timelineItems: { pageInfo: page(o.cut), nodes: events } },
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
      phase: 'finished', repo: 'o/r', issue: 7, available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [12], ignored: [],
      pr: {
        number: 12, state: 'OPEN', isDraft: true, byAgent: true, sameRepo: true, baseRef: 'dev', headRef: 'copilot/fix-thing', head: HEAD, commitsHead: HEAD,
        headCommittedAt: '2026-11-09T06:07:00Z', allCommitsByAgent: true, allCommitsSignedByGitHub: true, linkedAt: '2026-11-09T06:05:40Z', finishedAt: '2026-11-09T06:07:34Z', truncated: false,
      },
    });
  });

  it('keeps the agent assignment that GitHub stamped just before the local since (whole seconds, clock skew)', () => {
    // Local since 06:05:22.300Z, GitHub stamped the assignment 06:05:22Z (22.7 s truncated), and a 90 s slower GitHub clock.
    for (const at of ['2026-11-09T06:05:22Z', '2026-11-09T06:03:52Z']) {
      const s = parseCodingAgentStatus(response([assigned(at)]), LOCAL);
      expect(s.phase).toBe('waiting-pr');
      expect(s.assignedAt).toBe(at);
    }
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:03:21Z')]), LOCAL).phase).toBe('not-assigned');
  });

  it('reports the FIRST agent assignment in the window as assignedAt', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:30Z'), assigned('2026-11-09T06:05:22Z')]), LOCAL);
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
    expect(s).toEqual({
      phase: 'waiting-pr', repo: 'o/r', issue: 7, available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [],
      ignored: [{ number: 13, reason: 'not-agent-author' }, { number: 20, reason: 'not-agent-author' }, { number: 21, reason: 'cross-repository' }],
    });
    // A foreign open PR does not make the agent's own PR ambiguous.
    const mixed = parseCodingAgentStatus(response([
      assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:30Z', pr({ number: 20, author: human })), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED })),
    ]));
    expect(mixed.phase).toBe('finished');
    expect(mixed.pr?.number).toBe(12);
    expect(mixed.candidates).toEqual([12]);
    expect(mixed.ignored).toEqual([{ number: 20, reason: 'not-agent-author' }]);
  });

  it('ignores PRs a human linked', () => {
    const s = parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), crossRef('2026-11-09T06:05:40Z', pr({ reviews: FINISHED }), human)]));
    expect(s).toEqual({ phase: 'waiting-pr', repo: 'o/r', issue: 7, available: true, assignedAt: '2026-11-09T06:05:22Z', candidates: [], ignored: [] });
  });

  it('tells not-assigned, unassigned and unavailable apart', () => {
    expect(parseCodingAgentStatus(response([])).phase).toBe('not-assigned');
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z', human)])).phase).toBe('not-assigned');
    const off = parseCodingAgentStatus(response([assigned('2026-11-09T06:00:00Z'), unassigned('2026-11-09T06:01:00Z')]));
    expect(off.phase).toBe('not-assigned');
    expect(off.assignedAt).toBeUndefined();
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:02:00Z'), unassigned('2026-11-09T06:01:00Z')])).phase).toBe('waiting-pr');
    expect(parseCodingAgentStatus(response([], [human]))).toEqual({ phase: 'unavailable', repo: 'o/r', issue: 7, available: false, candidates: [], ignored: [] });
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
    const s = parseCodingAgentStatus(response(events), { at: '2026-11-09T06:05:00Z', source: 'local' });
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
    expect(() => parseCodingAgentStatus(response([]), { at: 'yesterday', source: 'local' })).toThrow(/ISO time/);
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
    expect(calls).toEqual([codingAgentAssignArgs(REPO, 7, 'dev'), codingAgentStatusArgs(REPO, 7, LOCAL)]);
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
  const want = { repo: 'o/r', issue: 7, base: 'dev' };
  const withPr = (over: Partial<CodingAgentPr>): CodingAgentStatus => {
    const s = finished();
    return { ...s, pr: { ...s.pr!, ...over } };
  };

  it('accepts the agent PR on the run base in the same repository', () => {
    expect(adoptPreconditions(finished(), want)).toEqual({ ok: true, pr: 12, head: HEAD });
    expect(adoptPreconditions(finished(), { repo: 'O/R', issue: 7, base: 'dev' }).ok).toBe(true);
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
    expect(adoptPreconditions(finished(), { repo: 'o/other', issue: 7, base: 'dev' }).ok).toBe(false);
  });
});

describe('the session window (re-review HIGH-A)', () => {
  // The reviewer's probe: an earlier session inside the 120 s skew margin of a re-assignment.
  const t = (s: string) => `2026-11-09T10:${s}Z`;
  const oldPr = (state: string) => pr({ number: 5, state, reviews: [{ at: t('00:25'), actor: agent }], committedAt: t('00:10') });
  const reassigned = (state: string, after: unknown[] = []) => response([
    assigned(t('00:00')), connected(t('00:20'), oldPr(state)), unassigned(t('00:30')), assigned(t('01:00')), ...after,
  ]);
  const local: CodingAgentSince = { at: '2026-11-09T10:01:00.500Z', source: 'local' };

  it.each(['OPEN', 'CLOSED'])('never reports the previous session PR (%s) after unassign and re-assign within the skew', (state) => {
    const s = parseCodingAgentStatus(reassigned(state), local);
    expect(s).toEqual({
      phase: 'waiting-pr', repo: 'o/r', issue: 7, available: true, assignedAt: t('01:00'), candidates: [], ignored: [{ number: 5, reason: 'outside-session' }],
    });
    expect(adoptPreconditions(s, { repo: 'o/r', issue: 7, base: 'dev' })).toEqual({ ok: false, reasons: ['the coding agent has not finished (waiting-pr)'] });
  });

  it('counts a PR re-linked in this session, but not its review requests from the previous one', () => {
    const s = parseCodingAgentStatus(reassigned('OPEN', [connected(t('01:20'), oldPr('OPEN'))]), local);
    expect(s.phase).toBe('working');
    expect(s.pr?.number).toBe(5);
    expect(s.pr?.finishedAt).toBeUndefined();
    expect(s.ignored).toEqual([]);
  });

  it('is not-assigned while the agent is unassigned, whatever it linked', () => {
    const s = parseCodingAgentStatus(response([assigned(t('00:00')), connected(t('00:20'), oldPr('OPEN')), unassigned(t('00:30'))]), local);
    expect(s).toMatchObject({ phase: 'not-assigned', candidates: [], ignored: [{ number: 5, reason: 'outside-session' }] });
    expect(s.assignedAt).toBeUndefined();
    expect(s.pr).toBeUndefined();
  });

  it('uses a github since exactly: no skew, nothing before it', () => {
    const before = response([assigned(t('00:59')), connected(t('00:59'), pr({ reviews: FINISHED }))]);
    expect(parseCodingAgentStatus(before, github(t('01:00'))).phase).toBe('not-assigned');
    // The same events with the same time as a local since are inside the margin.
    expect(parseCodingAgentStatus(before, { at: t('01:00'), source: 'local' }).assignedAt).toBe(t('00:59'));
    // An event at the since itself still counts.
    expect(parseCodingAgentStatus(response([assigned(t('01:00'))]), github(t('01:00'))).assignedAt).toBe(t('01:00'));
  });

  it('never steps back across chained sessions when since is a GitHub assignedAt', () => {
    const later = (m: string) => `2026-11-09T10:${m}:00Z`;
    const second = pr({ number: 6, reviews: [{ at: later('05'), actor: agent }], committedAt: later('04') });
    const events = [
      assigned(t('00:00')), connected(t('00:20'), oldPr('OPEN')), unassigned(t('00:30')),
      assigned(t('01:00')), connected(later('02'), second),
    ];
    // First read after the assign (local since): the session starts at 10:01:00.
    const first = parseCodingAgentStatus(response(events), local);
    expect(first.assignedAt).toBe(t('01:00'));
    expect(first.phase).toBe('finished');
    expect(first.pr?.number).toBe(6);
    // Every later read uses that GitHub time: same start, and the earlier session is not even in the window.
    const again = parseCodingAgentStatus(response(events), github(first.assignedAt!));
    expect(again.assignedAt).toBe(t('01:00'));
    expect(again.ignored).toEqual([]);
    expect(again.pr?.number).toBe(6);
    // A third session (unassign, re-assign) moves the start forward, never back.
    const third = parseCodingAgentStatus(response([...events, unassigned(later('06')), assigned(later('07'))]), github(first.assignedAt!));
    expect(third.assignedAt).toBe(later('07'));
    expect(third.phase).toBe('waiting-pr');
    expect(third.ignored).toEqual([{ number: 6, reason: 'outside-session' }]);
  });

  it('keeps the first assignment of a streak when the agent is assigned again without an unassignment', () => {
    expect(parseCodingAgentStatus(response([assigned(t('01:00')), assigned(t('01:30'))]), local).assignedAt).toBe(t('01:00'));
  });

  it('orders same-second assignment events by timeline position', () => {
    expect(parseCodingAgentStatus(response([assigned(t('01:00')), unassigned(t('01:00'))]), local).phase).toBe('not-assigned');
    expect(parseCodingAgentStatus(response([unassigned(t('01:00')), assigned(t('01:00'))]), local).assignedAt).toBe(t('01:00'));
  });
});

describe('PR commits (MEDIUM-3 residual)', () => {
  const read = (o: PrOver) => parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviews: FINISHED, ...o }))]));
  const want = { repo: 'o/r', issue: 7, base: 'dev' };
  const B = 'b'.repeat(40);

  it('says all commits are the agent account when every one maps to it', () => {
    const s = read({ earlier: [{ oid: B, user: 'Copilot' }] });
    expect(s.phase).toBe('finished');
    expect(s.pr).toMatchObject({ allCommitsByAgent: true, commitsHead: HEAD, head: HEAD });
    expect(adoptPreconditions(s, want)).toEqual({ ok: true, pr: 12, head: HEAD });
  });

  it.each([
    ['a human commit before the head', { earlier: [{ oid: B, user: 'mallory' }] }],
    ['a human head commit', { headUser: 'mallory' }],
    ['a commit mapped to no account', { earlier: [{ oid: B, user: null }] }],
    ['a commit mapped to the bot login spelled differently', { headUser: 'copilot' }],
  ] as Array<[string, PrOver]>)('refuses adoption for %s', (_name, over) => {
    const s = read(over);
    expect(s.phase).toBe('finished');
    expect(s.pr?.allCommitsByAgent).toBe(false);
    expect(adoptPreconditions(s, want)).toEqual({ ok: false, reasons: ['PR #12 has commits not mapped to the Copilot account'] });
  });

  it('fails closed as truncated when the commit list was cut, naming it', () => {
    const s = read({ commitsCut: true });
    expect(s.phase).toBe('truncated');
    expect(s.pr).toBeUndefined();
    expect(s.truncation).toEqual({ list: 'commits', issue: 7, pr: 12 });
  });

  it('makes a head missing from the commit list explicit', () => {
    const s = read({ commitOid: B });
    expect(s.phase).toBe('working');
    expect(s.pr).toMatchObject({ head: HEAD, commitsHead: B });
    expect(s.pr?.headCommittedAt).toBeUndefined();
    // Even if a caller forced the phase, adopt refuses.
    expect(adoptPreconditions({ ...s, phase: 'finished' }, want)).toEqual({ ok: false, reasons: [`PR #12 head ${HEAD} is not the newest commit read (${B})`] });
  });

  it('leaves authorship unknown for an empty or unreadable list, and adopt refuses that', () => {
    expect(read({ committedAt: null }).pr?.allCommitsByAgent).toBeUndefined();
    expect(read({ earlier: [{ oid: 'xyz', user: 'Copilot' }] }).pr?.allCommitsByAgent).toBeUndefined();
    const s = read({});
    const unknown: CodingAgentStatus = { ...s, pr: { ...s.pr!, allCommitsByAgent: undefined } };
    expect(adoptPreconditions(unknown, want)).toEqual({ ok: false, reasons: ['PR #12 commit authorship is unknown (commit list cut or unreadable)'] });
  });
});

describe('truncation names the list and the issue', () => {
  it.each([
    ['issue-timeline', response([assigned('2026-11-09T06:05:22Z')], undefined, { cut: true }), { list: 'issue-timeline', issue: 7 }],
    ['assignable-actors', response([], [human], { actorsCut: true }), { list: 'assignable-actors', issue: 7 }],
    ['review-requests', response([assigned('2026-11-09T06:05:22Z'), connected('2026-11-09T06:05:40Z', pr({ reviewsCut: true }))]), { list: 'review-requests', issue: 7, pr: 12 }],
  ])('%s', (_name, out, truncation) => {
    const s = parseCodingAgentStatus(out);
    expect(s.phase).toBe('truncated');
    expect(s.truncation).toEqual(truncation);
  });

  it('has no truncation on other phases, and throws without an issue number', () => {
    expect(parseCodingAgentStatus(response([assigned('2026-11-09T06:05:22Z')])).truncation).toBeUndefined();
    const noNumber = JSON.parse(response([])) as { data: { repository: { issue: Record<string, unknown> } } };
    delete noNumber.data.repository.issue.number;
    expect(() => parseCodingAgentStatus(JSON.stringify(noNumber))).toThrow(/no issue in the response/);
  });
});

describe('final-round review LOWs (PR #462)', () => {
  const t = (s: string) => `2026-11-09T10:${s}Z`;
  const local: CodingAgentSince = { at: '2026-11-09T10:01:00.500Z', source: 'local' };
  const done = (at: string) => pr({ reviews: [{ at, actor: agent }], committedAt: at });
  const want = { repo: 'o/r', issue: 7, base: 'dev' };

  describe('LOW-1: a link counts only after the streak-start event in timeline order', () => {
    it('ignores a link in the same second as unassign and re-assign that precedes the re-assign', () => {
      const s = parseCodingAgentStatus(response([
        assigned(t('00:00')), unassigned(t('01:00')), connected(t('01:00'), done(t('01:00'))), assigned(t('01:00')),
      ]), local);
      expect(s).toEqual({
        phase: 'waiting-pr', repo: 'o/r', issue: 7, available: true, assignedAt: t('01:00'), candidates: [], ignored: [{ number: 12, reason: 'outside-session' }],
      });
    });

    it('counts a link in the same second that follows the streak start', () => {
      const s = parseCodingAgentStatus(response([unassigned(t('01:00')), assigned(t('01:00')), connected(t('01:00'), done(t('01:30')))]), local);
      expect(s.phase).toBe('finished');
      expect(s.candidates).toEqual([12]);
      expect(s.ignored).toEqual([]);
    });

    it('orders by time first: a later link listed before the assignment still follows it', () => {
      const s = parseCodingAgentStatus(response([connected(t('01:05'), done(t('01:30'))), assigned(t('01:00'))]), local);
      expect(s.candidates).toEqual([12]);
    });

    it('compares review requests by time (no shared timeline): one in the session start second counts', () => {
      const s = parseCodingAgentStatus(response([assigned(t('01:00')), connected(t('01:00'), done(t('01:00')))]), local);
      expect(s.phase).toBe('finished');
      expect(s.pr?.finishedAt).toBe(t('01:00'));
    });
  });

  describe('LOW-2: a github since is whole seconds', () => {
    it('throws on a github since with milliseconds, in the parser and the argv', () => {
      const ms = github('2026-11-09T10:01:00.500Z');
      expect(() => parseCodingAgentStatus(response([]), ms)).toThrow(/github since must be a whole-second GitHub time/);
      expect(() => codingAgentStatusArgs(REPO, 7, ms)).toThrow(/github since must be a whole-second GitHub time/);
      expect(() => assignCodingAgent(() => ({ status: 0, stdout: '{}', stderr: '' }), REPO, 7, 'dev', '2026-11-09T10:01:00.500Z', '/w')).not.toThrow();
      expect(parseCodingAgentStatus(response([assigned(t('01:00'))]), github(t('01:00'))).assignedAt).toBe(t('01:00'));
    });
  });

  describe('LOW-3: adoption is bound to the run issue', () => {
    it('refuses a status for another issue', () => {
      const s = parseCodingAgentStatus(response([assigned(t('01:00')), connected(t('01:01'), done(t('01:30')))]), local);
      expect(adoptPreconditions(s, want)).toEqual({ ok: true, pr: 12, head: HEAD });
      expect(adoptPreconditions(s, { ...want, issue: 8 })).toEqual({ ok: false, reasons: ['the status is for issue #7, not #8'] });
      expect(adoptPreconditions({ ...s, phase: 'working' }, { ...want, issue: 8 })).toEqual({
        ok: false, reasons: ['the status is for issue #7, not #8', 'the coding agent has not finished (working)'],
      });
    });
  });

  describe('LOW-4: every commit must be signed by GitHub', () => {
    const B = 'b'.repeat(40);
    const read = (o: PrOver) => parseCodingAgentStatus(response([assigned(t('01:00')), connected(t('01:01'), pr({ reviews: [{ at: t('01:30'), actor: agent }], committedAt: t('01:10'), ...o }))]), local);

    it('reports allCommitsSignedByGitHub true for web-flow signed agent commits and adopts', () => {
      const s = read({ earlier: [{ oid: B, user: 'Copilot' }] });
      expect(s.pr?.allCommitsSignedByGitHub).toBe(true);
      expect(adoptPreconditions(s, want).ok).toBe(true);
    });

    it.each([
      ['an unsigned commit with the agent email (a local push)', { earlier: [{ oid: B, user: 'Copilot', signature: null }] }],
      ['an invalid signature', { headSignature: { isValid: false, wasSignedByGitHub: true } }],
      ['a valid signature not made by GitHub', { headSignature: { isValid: true, wasSignedByGitHub: false } }],
    ] as Array<[string, PrOver]>)('refuses %s even though authorship maps to the agent', (_name, over) => {
      const s = read(over);
      expect(s.phase).toBe('finished');
      expect(s.pr).toMatchObject({ allCommitsByAgent: true, allCommitsSignedByGitHub: false });
      expect(adoptPreconditions(s, want)).toEqual({ ok: false, reasons: ['PR #12 has commits without a valid GitHub (web-flow) signature'] });
    });

    it('leaves signatures unknown for an empty list, and adopt refuses that', () => {
      expect(read({ committedAt: null }).pr?.allCommitsSignedByGitHub).toBeUndefined();
      const s = read({});
      const unknown: CodingAgentStatus = { ...s, pr: { ...s.pr!, allCommitsSignedByGitHub: undefined } };
      expect(adoptPreconditions(unknown, want)).toEqual({ ok: false, reasons: ['PR #12 commit signatures are unknown (commit list cut or unreadable)'] });
    });

    it('reads signatures in the one pinned status query', () => {
      const args = codingAgentStatusArgs(REPO, 7, local);
      expect(args).toHaveLength(14);
      expect(args[5]).toBe(`query=${CODING_AGENT_STATUS_QUERY}`);
      expect(CODING_AGENT_STATUS_QUERY.match(/signature\{isValid wasSignedByGitHub\}/g)).toHaveLength(1);
      expect(isCodingAgentStatusArgs(args, REPO_ARG)).toBe(true);
    });
  });

  describe('the query-level since keeps the 120 s margin for both sources', () => {
    // GitHub's since excludes an event in the same second (live check), so a github since
    // queried without the margin would drop the session's own Assigned event.
    it.each(['local', 'github'] as const)('%s', (source) => {
      const at = t('01:00');
      const queried = codingAgentStatusArgs(REPO, 7, { at, source })[13].slice('since='.length);
      expect(queried).toBe('2026-11-09T09:59:00Z');
      expect(Date.parse(at) - Date.parse(queried)).toBe(CODING_AGENT_SINCE_SKEW_SECONDS * 1000);
      expect(CODING_AGENT_SINCE_SKEW_SECONDS).toBe(120);
    });
  });
});
