/**
 * The GitHub Copilot coding agent ("Copilot cloud agent") as a factory
 * implementer, forge side (factory night 3, goal 6, lane L6a). Three exact
 * gh shapes, each pinned by the factory guard to the run's repository
 * (GithubReadContext, src/factory/run/exec.ts):
 *
 * - assign (WRITE, starts one agent session, billed by GitHub):
 *   `gh api --hostname <host> --method POST repos/<owner>/<name>/issues/<n>/assignees
 *    -f assignees[]=copilot-swe-agent[bot] -f agent_assignment[base_branch]=<base>`
 *   (REST "Add assignees to an issue" with the documented agent_assignment
 *   object). REST ignores an assignee it cannot assign, so the caller confirms
 *   the assignment with the status read before it counts a session.
 * - status (READ): `gh api graphql` with CODING_AGENT_STATUS_QUERY: whether the
 *   agent is assignable, its assignment on the issue, the pull requests it
 *   linked to the issue, and whether it requested a review (its finish signal).
 * - close (WRITE): `gh pr close <n> --repo <HOST/OWNER/NAME>`, for the agent's
 *   PR once the engine rebranched it (decision D5).
 *
 * Everything the agent wrote is untrusted: this module reads no title, body,
 * comment or commit message, and validates every name and sha it hands on.
 * Who acted comes from GitHub's event actors and the PR author (`__typename`
 * Bot and the agent login), never from text.
 */

/** The agent's login as GraphQL reports actors and PR authors (`__typename: Bot`). */
export const CODING_AGENT_LOGIN = 'copilot-swe-agent';
/** The agent's login in the REST assignees body. */
export const CODING_AGENT_REST_ASSIGNEE = 'copilot-swe-agent[bot]';

const PR_FIELDS = 'number state isDraft isCrossRepository baseRefName headRefName headRefOid author{__typename login}'
  + ' baseRepository{nameWithOwner} headRepository{nameWithOwner}'
  + ' timelineItems(last:50,itemTypes:[REVIEW_REQUESTED_EVENT]){nodes{__typename ... on ReviewRequestedEvent{createdAt actor{__typename login}}}}';

/**
 * The status read, one line (no argv newline on any platform). `owner` and
 * `name` go in as raw strings (`-f`), `number` as an integer (`-F`).
 */
export const CODING_AGENT_STATUS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner'
  + ' suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:20){nodes{__typename login}}'
  + ' issue(number:$number){state timelineItems(last:100,itemTypes:[ASSIGNED_EVENT,UNASSIGNED_EVENT,CONNECTED_EVENT,CROSS_REFERENCED_EVENT]){nodes{__typename'
  + ' ... on AssignedEvent{createdAt assignee{__typename ... on Bot{login}}}'
  + ' ... on UnassignedEvent{createdAt assignee{__typename ... on Bot{login}}}'
  + ' ... on ConnectedEvent{createdAt actor{__typename login} subject{__typename ...P}}'
  + ' ... on CrossReferencedEvent{createdAt actor{__typename login} source{__typename ...P}}}}}}}'
  + ` fragment P on PullRequest{${PR_FIELDS}}`;

/** A GitHub login or repository name (conservative: no option shape, no `@`, no `/`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** A plain branch name (the factory guard's BRANCH, minus `..`, a trailing `/` and `.lock`). */
const BRANCH = /^[\w.][\w./-]{0,199}$/;
const isBranch = (s: string): boolean => BRANCH.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The parts of a forge repository the shapes name. */
export interface CodingAgentRepo {
  host: string;
  owner: string;
  name: string;
}

function checkRepo(repo: CodingAgentRepo, what: string): void {
  if (!HOST.test(repo.host) || !NAME.test(repo.owner) || !NAME.test(repo.name)) {
    throw new Error(`coding agent ${what}: ${repo.host}/${repo.owner}/${repo.name} is not a plain GitHub repository`);
  }
}

function checkNumber(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || !NUMBER.test(String(n))) throw new Error(`coding agent ${what}: #${n} is not an issue or PR number`);
}

/** `gh` argv that assigns `issue` to the agent, branching from `base`. Throws on values the guard would refuse. */
export function codingAgentAssignArgs(repo: CodingAgentRepo, issue: number, base: string): string[] {
  checkRepo(repo, 'assign');
  checkNumber(issue, 'assign');
  if (!isBranch(base)) throw new Error(`coding agent assign: ${JSON.stringify(base)} is not a plain branch name`);
  return ['api', '--hostname', repo.host, '--method', 'POST', `repos/${repo.owner}/${repo.name}/issues/${issue}/assignees`,
    '-f', `assignees[]=${CODING_AGENT_REST_ASSIGNEE}`, '-f', `agent_assignment[base_branch]=${base}`];
}

/** `gh` argv of the status read for `issue`. */
export function codingAgentStatusArgs(repo: CodingAgentRepo, issue: number): string[] {
  checkRepo(repo, 'status');
  checkNumber(issue, 'status');
  return ['api', 'graphql', '--hostname', repo.host, '-f', `query=${CODING_AGENT_STATUS_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${issue}`];
}

/** `gh` argv that closes the agent's PR `pr` (after the engine rebranched it). */
export function codingAgentCloseArgs(repo: CodingAgentRepo, pr: number): string[] {
  checkRepo(repo, 'close');
  checkNumber(pr, 'close');
  return ['pr', 'close', String(pr), '--repo', `${repo.host}/${repo.owner}/${repo.name}`];
}

/** `HOST/OWNER/NAME` (ghRepoArg) split and checked; undefined when it is not one. */
function repoOf(repoArg: string | undefined): CodingAgentRepo | undefined {
  const parts = repoArg?.split('/');
  if (!parts || parts.length !== 3) return undefined;
  const [host, owner, name] = parts;
  return HOST.test(host) && NAME.test(owner) && NAME.test(name) ? { host, owner, name } : undefined;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * The guard clause for the assign shape: `args` is exactly
 * codingAgentAssignArgs for the repository `repoArg` (ghRepoArg), some issue
 * number and a plain base branch. Without a repository context it is refused.
 */
export function isCodingAgentAssignArgs(args: readonly string[], repoArg: string | undefined): boolean {
  const repo = repoOf(repoArg);
  if (!repo || args.length !== 10) return false;
  const path = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/assignees$/.exec(args[5]);
  const base = args[9].startsWith('agent_assignment[base_branch]=') ? args[9].slice('agent_assignment[base_branch]='.length) : '';
  return args[0] === 'api' && args[1] === '--hostname' && lower(args[2]) === lower(repo.host)
    && args[3] === '--method' && args[4] === 'POST'
    && path !== null && NAME.test(path[1]) && lower(path[1]) === lower(repo.owner) && NAME.test(path[2]) && lower(path[2]) === lower(repo.name) && NUMBER.test(path[3])
    && args[6] === '-f' && args[7] === `assignees[]=${CODING_AGENT_REST_ASSIGNEE}`
    && args[8] === '-f' && isBranch(base);
}

/** The guard clause for the status read: exactly codingAgentStatusArgs for `repoArg` and some issue number. */
export function isCodingAgentStatusArgs(args: readonly string[], repoArg: string | undefined): boolean {
  const repo = repoOf(repoArg);
  if (!repo || args.length !== 12) return false;
  const value = (arg: string, key: string): string => (arg.startsWith(`${key}=`) ? arg.slice(key.length + 1) : '');
  const o = value(args[7], 'owner');
  const n = value(args[9], 'name');
  return args[0] === 'api' && args[1] === 'graphql' && args[2] === '--hostname' && lower(args[3]) === lower(repo.host)
    && args[4] === '-f' && args[5] === `query=${CODING_AGENT_STATUS_QUERY}`
    && args[6] === '-f' && NAME.test(o) && lower(o) === lower(repo.owner)
    && args[8] === '-f' && NAME.test(n) && lower(n) === lower(repo.name)
    && args[10] === '-F' && NUMBER.test(value(args[11], 'number'));
}

/** The guard clause for the close: exactly codingAgentCloseArgs for `repoArg` and some PR number. */
export function isCodingAgentCloseArgs(args: readonly string[], repoArg: string | undefined): boolean {
  const repo = repoOf(repoArg);
  const named = args.length === 5 ? repoOf(args[4]) : undefined;
  return repo !== undefined && named !== undefined && args[0] === 'pr' && args[1] === 'close' && NUMBER.test(args[2]) && args[3] === '--repo'
    && lower(named.host) === lower(repo.host) && lower(named.owner) === lower(repo.owner) && lower(named.name) === lower(repo.name);
}

/** One pull request the agent linked to the issue, as read (validated fields only). */
export interface CodingAgentPr {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  /** The PR's author is the agent (`__typename: Bot`, CODING_AGENT_LOGIN). */
  byAgent: boolean;
  /** Head and base repository are both the read repository, not cross-repository. */
  sameRepo: boolean;
  baseRef?: string;
  headRef?: string;
  /** The head commit, when GitHub reported a 40-hex sha. */
  head?: string;
  /** When the agent linked it to the issue (the newest linking event). */
  linkedAt: string;
  /** The agent's newest review request on the PR (its "work finished" signal), at or after `since`. */
  finishedAt?: string;
}

/**
 * The agent's state on one issue:
 * - `unavailable`: the agent is not assignable in the repository (not enabled, or no Copilot plan);
 * - `not-assigned`: assignable, but not assigned since `since`;
 * - `waiting-pr`: assigned, no pull request linked yet;
 * - `working`: its PR is open and it has not requested a review;
 * - `finished`: its PR is open and it requested a review (adoptPreconditions decides what follows);
 * - `closed`: its PR was closed or merged before the engine adopted it;
 * - `ambiguous`: it linked more than one open PR since `since`.
 */
export type CodingAgentPhase = 'unavailable' | 'not-assigned' | 'waiting-pr' | 'working' | 'finished' | 'closed' | 'ambiguous';

export interface CodingAgentStatus {
  phase: CodingAgentPhase;
  /** `OWNER/NAME` of the repository GitHub answered for (its nameWithOwner). */
  repo: string;
  /** The agent is in the repository's assignable actors. */
  available: boolean;
  /** The newest assignment of the agent at or after `since`, while not unassigned after it. */
  assignedAt?: string;
  /** The PR the phase is about (the newest the agent linked); absent for unavailable, not-assigned and waiting-pr. */
  pr?: CodingAgentPr;
  /** Distinct PRs the agent linked to the issue at or after `since`. */
  candidates: number[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const nodes = (v: unknown): Obj[] => (isObj(v) && Array.isArray(v.nodes) ? v.nodes.filter(isObj) : []);
const time = (v: unknown): string | undefined => {
  const s = str(v);
  return s && ISO.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
};
/** The value is the agent itself: a Bot with the agent login (a User of that name never counts). */
const isAgent = (v: unknown): boolean => isObj(v) && v.__typename === 'Bot' && v.login === CODING_AGENT_LOGIN;
const atOrAfter = (at: string, since: string | undefined): boolean => since === undefined || Date.parse(at) >= Date.parse(since);
const STATES: ReadonlySet<string> = new Set(['OPEN', 'CLOSED', 'MERGED']);

function readPr(v: unknown, repoName: string, linkedAt: string, since: string | undefined): CodingAgentPr | undefined {
  if (!isObj(v) || v.__typename !== 'PullRequest') return undefined;
  const number = typeof v.number === 'number' && Number.isSafeInteger(v.number) && v.number > 0 ? v.number : undefined;
  const state = str(v.state);
  if (number === undefined || !state || !STATES.has(state)) return undefined;
  const nameOf = (r: unknown): string | undefined => (isObj(r) ? str(r.nameWithOwner) : undefined);
  const headRepo = nameOf(v.headRepository);
  const baseRepo = nameOf(v.baseRepository);
  const sameRepo = v.isCrossRepository === false && headRepo !== undefined && baseRepo !== undefined
    && lower(headRepo) === lower(repoName) && lower(baseRepo) === lower(repoName);
  const baseRef = str(v.baseRefName);
  const headRef = str(v.headRefName);
  const head = str(v.headRefOid);
  let finishedAt: string | undefined;
  for (const e of nodes(v.timelineItems)) {
    const at = time(e.createdAt);
    if (e.__typename !== 'ReviewRequestedEvent' || !at || !isAgent(e.actor) || !atOrAfter(at, since)) continue;
    if (!finishedAt || Date.parse(at) > Date.parse(finishedAt)) finishedAt = at;
  }
  return {
    number, state: state as CodingAgentPr['state'], isDraft: v.isDraft === true, byAgent: isAgent(v.author), sameRepo,
    ...(baseRef && isBranch(baseRef) ? { baseRef } : {}),
    ...(headRef && isBranch(headRef) ? { headRef } : {}),
    ...(head && HEX40.test(head) ? { head } : {}),
    linkedAt, ...(finishedAt ? { finishedAt } : {}),
  };
}

/**
 * The agent's state in one status response (stdout of codingAgentStatusArgs).
 * `since` (ISO time, the engine's assign time) drops older sessions: their
 * assignment, linked PRs and review requests. Only events whose actor is the
 * agent link a PR. Throws when the response has no repository or issue.
 */
export function parseCodingAgentStatus(stdout: string, since?: string): CodingAgentStatus {
  if (since !== undefined && !time(since)) throw new Error(`coding agent status: since ${JSON.stringify(since)} is not an ISO time`);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('coding agent status: gh api graphql printed no JSON');
  }
  const data = isObj(json) && isObj(json.data) ? json.data : {};
  const repo = isObj(data.repository) ? data.repository : undefined;
  const issue = repo && isObj(repo.issue) ? repo.issue : undefined;
  const repoName = repo ? str(repo.nameWithOwner) : undefined;
  if (!repo || !issue || !repoName) {
    const first = isObj(json) && Array.isArray(json.errors) && isObj(json.errors[0]) ? str(json.errors[0].message) : undefined;
    throw new Error(`coding agent status: no issue in the response${first ? ` (${first.slice(0, 200)})` : ''}`);
  }

  const available = nodes(repo.suggestedActors).some(isAgent);
  let assignedAt: string | undefined;
  let unassignedAt: string | undefined;
  const linked = new Map<number, CodingAgentPr>();
  for (const e of nodes(issue.timelineItems)) {
    const at = time(e.createdAt);
    if (!at || !atOrAfter(at, since)) continue;
    if (e.__typename === 'AssignedEvent' && isAgent(e.assignee)) {
      if (!assignedAt || Date.parse(at) >= Date.parse(assignedAt)) assignedAt = at;
    } else if (e.__typename === 'UnassignedEvent' && isAgent(e.assignee)) {
      if (!unassignedAt || Date.parse(at) >= Date.parse(unassignedAt)) unassignedAt = at;
    } else if ((e.__typename === 'ConnectedEvent' || e.__typename === 'CrossReferencedEvent') && isAgent(e.actor)) {
      const pr = readPr(e.__typename === 'ConnectedEvent' ? e.subject : e.source, repoName, at, since);
      const seen = pr ? linked.get(pr.number) : undefined;
      if (pr && (!seen || Date.parse(at) > Date.parse(seen.linkedAt))) linked.set(pr.number, pr);
    }
  }
  if (assignedAt && unassignedAt && Date.parse(unassignedAt) > Date.parse(assignedAt)) assignedAt = undefined;

  const prs = [...linked.values()].sort((a, b) => Date.parse(b.linkedAt) - Date.parse(a.linkedAt) || b.number - a.number);
  const candidates = prs.map((p) => p.number);
  const base = { repo: repoName, available, ...(assignedAt ? { assignedAt } : {}), candidates };
  const open = prs.filter((p) => p.state === 'OPEN');
  if (open.length > 1) return { phase: 'ambiguous', ...base, pr: open[0] };
  const pr = open[0] ?? prs[0];
  if (!pr) return { phase: !available && !assignedAt ? 'unavailable' : assignedAt ? 'waiting-pr' : 'not-assigned', ...base };
  if (pr.state !== 'OPEN') return { phase: 'closed', ...base, pr };
  return { phase: pr.finishedAt ? 'finished' : 'working', ...base, pr };
}

/** What adopting the agent's PR must match: the run's repository and base branch. */
export interface AdoptExpectation {
  /** `OWNER/NAME` of the run's repository. */
  repo: string;
  /** The run's base branch (FactoryRunState.base). */
  base: string;
}

export type AdoptCheck =
  | { ok: true; pr: number; head: string }
  | { ok: false; reasons: string[] };

/**
 * The adopt preconditions (night-3 review checklist point 7) for the PR in
 * `status`: the agent finished; the PR is open, authored by the agent bot,
 * not cross-repository, in the run's repository, on the run's base branch,
 * and its head is a 40-hex sha. The caller fetches exactly that sha (and
 * re-checks it after the fetch) under its tamper snapshot.
 */
export function adoptPreconditions(status: CodingAgentStatus, want: AdoptExpectation): AdoptCheck {
  const reasons: string[] = [];
  const pr = status.pr;
  if (status.phase !== 'finished' || !pr) {
    reasons.push(`the coding agent has not finished (${status.phase})`);
    return { ok: false, reasons };
  }
  if (pr.state !== 'OPEN') reasons.push(`PR #${pr.number} is ${lower(pr.state)}`);
  if (!pr.byAgent) reasons.push(`PR #${pr.number} is not authored by the ${CODING_AGENT_LOGIN} bot`);
  if (!pr.sameRepo || lower(status.repo) !== lower(want.repo)) reasons.push(`PR #${pr.number} is cross-repository or not in ${want.repo}`);
  if (pr.baseRef !== want.base) reasons.push(`PR #${pr.number} targets ${pr.baseRef ?? 'an unreadable base'}, not ${want.base}`);
  if (!pr.head) reasons.push(`PR #${pr.number} has no 40-hex head sha`);
  return reasons.length > 0 || !pr.head ? { ok: false, reasons } : { ok: true, pr: pr.number, head: pr.head };
}
