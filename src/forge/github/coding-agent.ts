/**
 * The GitHub Copilot coding agent ("Copilot cloud agent") as a factory
 * implementer, forge side (factory night 3, goal 6, lane L6a). Three exact
 * gh shapes, each pinned by the factory guard (src/factory/run/exec.ts):
 *
 * - assign (WRITE, starts one agent session, billed by GitHub):
 *   `gh api --hostname <host> --method POST repos/<owner>/<name>/issues/<n>/assignees
 *    -f assignees[]=copilot-swe-agent[bot] -f agent_assignment[base_branch]=<base>`
 *   (REST "Add assignees to an issue" with the documented agent_assignment
 *   object). Passes only with a CodingAgentContext naming this repository,
 *   issue and base. REST ignores an assignee it cannot assign, so
 *   assignCodingAgent confirms the assignment with the status read.
 * - status (READ): `gh api graphql` with CODING_AGENT_STATUS_QUERY: whether the
 *   agent is assignable, its assignment on the issue, the pull requests it
 *   linked to the issue, its review requests (its finish signal) and each
 *   PR's head commit. Passes with the repository-only GithubReadContext.
 * - close (WRITE): `gh pr close <n> --repo <HOST/OWNER/NAME>`, for the agent's
 *   PR once the engine rebranched it (decision D5). Passes only with a
 *   CodingAgentContext whose `pr` is that number.
 *
 * Everything the agent wrote is untrusted: this module reads no title, body,
 * comment or commit message, and validates every name and sha it hands on.
 * Who acted comes from GitHub's event actors and the PR author (`__typename`
 * Bot and the agent login), never from text. GitHub documents no stable bot
 * id, so the identity is not pinned by databaseId or node id.
 */

import type { Exec } from '../../ship/exec.js';
import { ghRun } from './gh.js';

/** The agent's login as GraphQL reports actors and PR authors (`__typename: Bot`). */
export const CODING_AGENT_LOGIN = 'copilot-swe-agent';
/** The agent's login in the REST assignees body. */
export const CODING_AGENT_REST_ASSIGNEE = 'copilot-swe-agent[bot]';
/**
 * How far before `since` the status window starts: GitHub times are whole
 * seconds and its clock is not ours, so an assignment a little "before" the
 * caller's local `since` still counts.
 */
export const CODING_AGENT_SINCE_SKEW_SECONDS = 120;

const PR_FIELDS = 'number state isDraft isCrossRepository baseRefName headRefName headRefOid author{__typename login}'
  + ' baseRepository{nameWithOwner} headRepository{nameWithOwner} commits(last:1){nodes{commit{oid committedDate}}}'
  + ' timelineItems(last:50,since:$since,itemTypes:[REVIEW_REQUESTED_EVENT]){pageInfo{hasPreviousPage} nodes{__typename ... on ReviewRequestedEvent{createdAt actor{__typename login}}}}';

/**
 * The status read, one line (no argv newline on any platform). `owner`,
 * `name` and `since` go in as raw strings (`-f`), `number` as an integer
 * (`-F`). Every list reports whether it was cut (pageInfo): a cut list makes
 * the phase `truncated`, never a guess.
 */
export const CODING_AGENT_STATUS_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$since:DateTime!){repository(owner:$owner,name:$name){nameWithOwner'
  + ' suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){pageInfo{hasNextPage} nodes{__typename login}}'
  + ' issue(number:$number){state timelineItems(last:100,since:$since,itemTypes:[ASSIGNED_EVENT,UNASSIGNED_EVENT,CONNECTED_EVENT,CROSS_REFERENCED_EVENT]){pageInfo{hasPreviousPage} nodes{__typename'
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
const BRANCH = /^\w[\w./-]{0,199}$/;
/**
 * A plain branch name by git check-ref-format's rules, on a word-character
 * set: no component that is empty or starts with `.`, none ending in `.lock`,
 * no `..` or `@{`, no trailing `.`.
 */
const isBranch = (s: string): boolean => BRANCH.test(s) && !s.includes('..') && !s.includes('@{') && !s.endsWith('.')
  && s.split('/').every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The parts of a forge repository the shapes name. */
export interface CodingAgentRepo {
  host: string;
  owner: string;
  name: string;
}

/**
 * The write context of ONE coding agent step, set by the engine only around
 * the assign or the close (never for a whole run). `repo` is gh's
 * `HOST/OWNER/NAME` (ghRepoArg). The assign passes only for `issue` on
 * exactly `base`; the close only for `pr`.
 */
export interface CodingAgentContext {
  repo: string;
  issue: number;
  base: string;
  pr?: number;
}

function checkRepo(repo: CodingAgentRepo, what: string): void {
  if (!HOST.test(repo.host) || !NAME.test(repo.owner) || !NAME.test(repo.name)) {
    throw new Error(`coding agent ${what}: ${repo.host}/${repo.owner}/${repo.name} is not a plain GitHub repository`);
  }
}

function checkNumber(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || !NUMBER.test(String(n))) throw new Error(`coding agent ${what}: #${n} is not an issue or PR number`);
}

const isTime = (s: string): boolean => ISO.test(s) && !Number.isNaN(Date.parse(s));

/**
 * The start of the status window for `since`: floored to the whole second,
 * minus CODING_AGENT_SINCE_SKEW_SECONDS. The query's `since` and the parser
 * use the same value.
 */
export function codingAgentWindowStart(since: string): string {
  if (!isTime(since)) throw new Error(`coding agent status: since ${JSON.stringify(since)} is not an ISO time`);
  const ms = Math.floor(Date.parse(since) / 1000) * 1000 - CODING_AGENT_SINCE_SKEW_SECONDS * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `gh` argv that assigns `issue` to the agent, branching from `base`. Throws on values the guard would refuse. */
export function codingAgentAssignArgs(repo: CodingAgentRepo, issue: number, base: string): string[] {
  checkRepo(repo, 'assign');
  checkNumber(issue, 'assign');
  if (!isBranch(base)) throw new Error(`coding agent assign: ${JSON.stringify(base)} is not a plain branch name`);
  return ['api', '--hostname', repo.host, '--method', 'POST', `repos/${repo.owner}/${repo.name}/issues/${issue}/assignees`,
    '-f', `assignees[]=${CODING_AGENT_REST_ASSIGNEE}`, '-f', `agent_assignment[base_branch]=${base}`];
}

/** `gh` argv of the status read for `issue`, from the window start of `since`. */
export function codingAgentStatusArgs(repo: CodingAgentRepo, issue: number, since: string): string[] {
  checkRepo(repo, 'status');
  checkNumber(issue, 'status');
  return ['api', 'graphql', '--hostname', repo.host, '-f', `query=${CODING_AGENT_STATUS_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`,
    '-F', `number=${issue}`, '-f', `since=${codingAgentWindowStart(since)}`];
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
const sameRepoArg = (a: CodingAgentRepo, b: CodingAgentRepo): boolean =>
  lower(a.host) === lower(b.host) && lower(a.owner) === lower(b.owner) && lower(a.name) === lower(b.name);

/**
 * The guard clause for the assign shape: `args` is exactly
 * codingAgentAssignArgs(ctx.repo, ctx.issue, ctx.base). Without a
 * CodingAgentContext it is refused.
 */
export function isCodingAgentAssignArgs(args: readonly string[], ctx: CodingAgentContext | undefined): boolean {
  const repo = repoOf(ctx?.repo);
  if (!ctx || !repo || args.length !== 10 || !Number.isSafeInteger(ctx.issue) || !NUMBER.test(String(ctx.issue)) || !isBranch(ctx.base)) return false;
  const path = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/assignees$/.exec(args[5]);
  return args[0] === 'api' && args[1] === '--hostname' && lower(args[2]) === lower(repo.host)
    && args[3] === '--method' && args[4] === 'POST'
    && path !== null && NAME.test(path[1]) && lower(path[1]) === lower(repo.owner) && NAME.test(path[2]) && lower(path[2]) === lower(repo.name)
    && path[3] === String(ctx.issue)
    && args[6] === '-f' && args[7] === `assignees[]=${CODING_AGENT_REST_ASSIGNEE}`
    && args[8] === '-f' && args[9] === `agent_assignment[base_branch]=${ctx.base}`;
}

/** The guard clause for the status read: exactly codingAgentStatusArgs for `repoArg`, some issue number and a whole-second window start. */
export function isCodingAgentStatusArgs(args: readonly string[], repoArg: string | undefined): boolean {
  const repo = repoOf(repoArg);
  if (!repo || args.length !== 14) return false;
  const value = (arg: string, key: string): string => (arg.startsWith(`${key}=`) ? arg.slice(key.length + 1) : '');
  const o = value(args[7], 'owner');
  const n = value(args[9], 'name');
  const since = value(args[13], 'since');
  return args[0] === 'api' && args[1] === 'graphql' && args[2] === '--hostname' && lower(args[3]) === lower(repo.host)
    && args[4] === '-f' && args[5] === `query=${CODING_AGENT_STATUS_QUERY}`
    && args[6] === '-f' && NAME.test(o) && lower(o) === lower(repo.owner)
    && args[8] === '-f' && NAME.test(n) && lower(n) === lower(repo.name)
    && args[10] === '-F' && NUMBER.test(value(args[11], 'number'))
    && args[12] === '-f' && ISO_SECONDS.test(since) && !Number.isNaN(Date.parse(since));
}

/** The guard clause for the close: exactly codingAgentCloseArgs(ctx.repo, ctx.pr). Without a context naming the PR it is refused. */
export function isCodingAgentCloseArgs(args: readonly string[], ctx: CodingAgentContext | undefined): boolean {
  const repo = repoOf(ctx?.repo);
  const named = args.length === 5 ? repoOf(args[4]) : undefined;
  return repo !== undefined && named !== undefined && ctx?.pr !== undefined && Number.isSafeInteger(ctx.pr) && NUMBER.test(String(ctx.pr))
    && args[0] === 'pr' && args[1] === 'close' && args[2] === String(ctx.pr) && args[3] === '--repo' && sameRepoArg(named, repo);
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
  /** The head commit's committedDate, when the read's last commit is that head. */
  headCommittedAt?: string;
  /** When the agent linked it to the issue (the newest linking event). */
  linkedAt: string;
  /** The agent's newest review request on the PR in the window (its "work finished" signal). */
  finishedAt?: string;
  /** The PR's review-request list in the window was cut. */
  truncated: boolean;
}

/**
 * The agent's state on one issue:
 * - `unavailable`: the agent is not assignable in the repository (not enabled, or no Copilot plan);
 * - `not-assigned`: assignable, but not assigned in the window;
 * - `waiting-pr`: assigned, no pull request of its own linked yet;
 * - `working`: its PR is open and it has not requested a review since its newest commit;
 * - `finished`: its PR is open and its newest review request is at or after the head commit (adoptPreconditions decides what follows);
 * - `closed`: its PR was closed or merged before the engine adopted it;
 * - `ambiguous`: it linked more than one open PR of its own in the window (no `pr` is set);
 * - `truncated`: a list GitHub returned was cut, so the read proves nothing (fail closed: no `pr`;
 *   do not re-assign, do not adopt; count the session if the assign POST returned 2xx).
 */
export type CodingAgentPhase = 'unavailable' | 'not-assigned' | 'waiting-pr' | 'working' | 'finished' | 'closed' | 'ambiguous' | 'truncated';

export interface CodingAgentStatus {
  phase: CodingAgentPhase;
  /** `OWNER/NAME` of the repository GitHub answered for (its nameWithOwner). */
  repo: string;
  /** The agent is in the repository's assignable actors. */
  available: boolean;
  /**
   * GitHub's own time of the agent's FIRST assignment in the window, while it
   * is not unassigned after its newest one. L6b stores this value as `since`
   * for every later status read of the session (GitHub's clock, not ours).
   */
  assignedAt?: string;
  /** The PR the phase is about (the newest the agent linked); absent for unavailable, not-assigned, waiting-pr, ambiguous and truncated. */
  pr?: CodingAgentPr;
  /** Distinct PRs the agent linked in the window that it authored in this repository. */
  candidates: number[];
  /** PRs an agent event linked that the agent did not author, or that are cross-repository: never adopted or closed. */
  ignored: number[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const nodes = (v: unknown): Obj[] => (isObj(v) && Array.isArray(v.nodes) ? v.nodes.filter(isObj) : []);
/** A connection reports that items before (or after) the returned ones exist; a missing pageInfo counts as cut. */
const cut = (v: unknown, key: 'hasPreviousPage' | 'hasNextPage'): boolean => !(isObj(v) && isObj(v.pageInfo) && v.pageInfo[key] === false);
const time = (v: unknown): string | undefined => {
  const s = str(v);
  return s && isTime(s) ? s : undefined;
};
/** The value is the agent itself: a Bot with the agent login (a User of that name never counts). */
const isAgent = (v: unknown): boolean => isObj(v) && v.__typename === 'Bot' && v.login === CODING_AGENT_LOGIN;
const atOrAfter = (at: string, from: string | undefined): boolean => from === undefined || Date.parse(at) >= Date.parse(from);
const STATES: ReadonlySet<string> = new Set(['OPEN', 'CLOSED', 'MERGED']);

function readPr(v: unknown, repoName: string, linkedAt: string, from: string | undefined): CodingAgentPr | undefined {
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
  const headOid = str(v.headRefOid);
  const head = headOid && HEX40.test(headOid) ? headOid : undefined;
  const last = nodes(v.commits)[0];
  const commit = last && isObj(last.commit) ? last.commit : undefined;
  const headCommittedAt = head && commit && commit.oid === head ? time(commit.committedDate) : undefined;
  let finishedAt: string | undefined;
  for (const e of nodes(v.timelineItems)) {
    const at = time(e.createdAt);
    if (e.__typename !== 'ReviewRequestedEvent' || !at || !isAgent(e.actor) || !atOrAfter(at, from)) continue;
    if (!finishedAt || Date.parse(at) > Date.parse(finishedAt)) finishedAt = at;
  }
  return {
    number, state: state as CodingAgentPr['state'], isDraft: v.isDraft === true, byAgent: isAgent(v.author), sameRepo,
    ...(baseRef && isBranch(baseRef) ? { baseRef } : {}),
    ...(headRef && isBranch(headRef) ? { headRef } : {}),
    ...(head ? { head } : {}),
    ...(headCommittedAt ? { headCommittedAt } : {}),
    linkedAt, ...(finishedAt ? { finishedAt } : {}),
    truncated: cut(v.timelineItems, 'hasPreviousPage'),
  };
}

/** A GitHub error message as one plain line: ANSI escape sequences, other control characters and bidi controls removed. */
function plainMessage(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x1b) {
      // ESC [ params intermediates final: skip the whole CSI sequence.
      if (s[i + 1] === '[') {
        i += 2;
        while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
      }
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x200e || code === 0x200f
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
    out += s[i];
  }
  return out.slice(0, 200);
}

/**
 * The agent's state in one status response (stdout of codingAgentStatusArgs).
 * `since` (ISO time: the engine's local time just before the assign, or
 * better a previous read's `assignedAt`) sets the window
 * (codingAgentWindowStart): older sessions, their linked PRs and review
 * requests drop out. Only events whose actor is the agent link a PR, and only
 * PRs the agent authored in this repository become candidates. Throws when
 * the response has no repository or issue.
 */
export function parseCodingAgentStatus(stdout: string, since?: string): CodingAgentStatus {
  const from = since === undefined ? undefined : codingAgentWindowStart(since);
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
    throw new Error(`coding agent status: no issue in the response${first ? ` (${plainMessage(first)})` : ''}`);
  }

  const available = nodes(repo.suggestedActors).some(isAgent);
  let firstAssignedAt: string | undefined;
  let lastAssignedAt: string | undefined;
  let unassignedAt: string | undefined;
  const linked = new Map<number, CodingAgentPr>();
  const ignored = new Set<number>();
  for (const e of nodes(issue.timelineItems)) {
    const at = time(e.createdAt);
    if (!at || !atOrAfter(at, from)) continue;
    if (e.__typename === 'AssignedEvent' && isAgent(e.assignee)) {
      if (!firstAssignedAt || Date.parse(at) < Date.parse(firstAssignedAt)) firstAssignedAt = at;
      if (!lastAssignedAt || Date.parse(at) >= Date.parse(lastAssignedAt)) lastAssignedAt = at;
    } else if (e.__typename === 'UnassignedEvent' && isAgent(e.assignee)) {
      if (!unassignedAt || Date.parse(at) >= Date.parse(unassignedAt)) unassignedAt = at;
    } else if ((e.__typename === 'ConnectedEvent' || e.__typename === 'CrossReferencedEvent') && isAgent(e.actor)) {
      const pr = readPr(e.__typename === 'ConnectedEvent' ? e.subject : e.source, repoName, at, from);
      if (!pr) continue;
      if (!pr.byAgent || !pr.sameRepo) {
        ignored.add(pr.number);
        continue;
      }
      const seen = linked.get(pr.number);
      if (!seen || Date.parse(at) > Date.parse(seen.linkedAt)) linked.set(pr.number, pr);
    }
  }
  const assigned = lastAssignedAt !== undefined && !(unassignedAt && Date.parse(unassignedAt) > Date.parse(lastAssignedAt));

  const prs = [...linked.values()].sort((a, b) => Date.parse(b.linkedAt) - Date.parse(a.linkedAt) || b.number - a.number);
  const candidates = prs.map((p) => p.number);
  const base = {
    repo: repoName, available, ...(assigned && firstAssignedAt ? { assignedAt: firstAssignedAt } : {}),
    candidates, ignored: [...ignored].filter((n) => !linked.has(n)).sort((a, b) => a - b),
  };
  if (cut(issue.timelineItems, 'hasPreviousPage') || (!available && cut(repo.suggestedActors, 'hasNextPage'))) return { phase: 'truncated', ...base };
  const open = prs.filter((p) => p.state === 'OPEN');
  if (open.length > 1) return { phase: 'ambiguous', ...base };
  const pr = open[0] ?? prs[0];
  if (!pr) return { phase: !available && !assigned ? 'unavailable' : assigned ? 'waiting-pr' : 'not-assigned', ...base };
  if (pr.state !== 'OPEN') return { phase: 'closed', ...base, pr };
  if (pr.truncated) return { phase: 'truncated', ...base };
  // Whole-second times: a review request in the same second as its head commit still counts as after it.
  const finished = pr.finishedAt !== undefined && pr.headCommittedAt !== undefined && Date.parse(pr.finishedAt) >= Date.parse(pr.headCommittedAt);
  return { phase: finished ? 'finished' : 'working', ...base, pr };
}

/** What assignCodingAgent observed. */
export interface CodingAgentAssignResult {
  /** The assign POST returned 2xx (gh exited 0): GitHub may have started a billed session; count it. */
  posted: true;
  /** The follow-up status read shows the agent assigned. False: not yet visible, not assigned, or the read failed or was cut. */
  confirmed: boolean;
  /** The follow-up read; its `assignedAt` (GitHub's time) is the `since` for later reads. Absent when the read failed. */
  status?: CodingAgentStatus;
  /** Why the follow-up read failed, when it did. */
  readError?: string;
}

/**
 * Assigns `issue` to the agent on `base` and reads the status once. `since`
 * is the caller's time just before this call. Throws (GhCommandError) only
 * when the POST itself fails; once the POST returned 2xx the result says
 * `posted: true` whatever the read shows, so "posted but not yet visible"
 * (`confirmed: false`) never reads as "not assigned". One read proves
 * nothing negative: re-read later, never re-assign automatically.
 */
export function assignCodingAgent(exec: Exec, repo: CodingAgentRepo, issue: number, base: string, since: string, cwd: string): CodingAgentAssignResult {
  const statusArgs = codingAgentStatusArgs(repo, issue, since);
  ghRun(exec, codingAgentAssignArgs(repo, issue, base), cwd);
  try {
    const status = parseCodingAgentStatus(ghRun(exec, statusArgs, cwd), since);
    return { posted: true, confirmed: status.phase !== 'truncated' && status.assignedAt !== undefined, status };
  } catch (error) {
    // The tail: a gh failure message starts with the whole argv (the long query) and ends with the reason.
    return { posted: true, confirmed: false, readError: plainMessage((error instanceof Error ? error.message : String(error)).slice(-200)) };
  }
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
