/**
 * The one GraphQL read of the GitHub forge (factory night 3, goal 2): the
 * human review input on one pull request. The factory guards refuse every
 * `gh api` except this exact argv (reviewFeedbackArgs): the query text is the
 * constant below, the repository is the configured one, the PR a number.
 *
 * Trust (decision D3): a reviewer counts when their login is in
 * `factory.review.trustedReviewers`, or when the same query reports write
 * access or more for them (the repository's first 100 collaborators, and the
 * viewer's own permission). Only a User author can be trusted that way; a Bot
 * counts only when the list names it as `<slug>[bot]`. Anyone else's review,
 * comment or thread reply is dropped and their login listed in `ignored`.
 * Bodies are returned as untrusted data: nothing here reads meaning into them.
 *
 * Fail closed: every list carries pageInfo, and a list with more entries than
 * one read returns throws ReviewFeedbackTruncatedError; a head other than the
 * PR's throws ReviewHeadMovedError; a partial answer is accepted only when
 * every error is about the collaborator list (then `trustIncomplete`).
 */

import { ADO_FACTORY_COMMENT_MARKER } from '../ado/reviews.js';
import { assertReviewHead, ReviewFeedbackError, ReviewFeedbackTruncatedError } from '../review-feedback.js';
import type { ForgeRepo, ForgeReviewFeedback } from '../types.js';

/**
 * The query, one line (no argv newline on any platform). `owner` and `name`
 * go in as raw strings (`-f`, never gh's `@file` form), `number` as an integer (`-F`).
 */
export const REVIEW_FEEDBACK_QUERY = 'query($owner:String!,$name:String!,$number:Int!){viewer{login}'
  + ' repository(owner:$owner,name:$name){viewerPermission collaborators(first:100){pageInfo{hasNextPage} edges{permission node{login}}}'
  + ' pullRequest(number:$number){headRefOid'
  + ' latestReviews(first:50){pageInfo{hasNextPage} nodes{id state submittedAt body author{__typename login} commit{oid}}}'
  + ' latestOpinionatedReviews(first:50){pageInfo{hasNextPage} nodes{state submittedAt body author{__typename login} commit{oid}}}'
  + ' reviewRequests(first:20){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}}}}'
  + ' reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated'
  + ' comments(first:20){pageInfo{hasNextPage} nodes{body path line originalLine createdAt author{__typename login}}}}}}}}';

/** A GitHub login or repository name (conservative: no option shape, no `@`, no `/`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** One thread or review body handed on, at most (the fix prompt fences it). */
export const MAX_FEEDBACK_BODY_CHARS = 8_000;
const TRUNCATED = '\n(truncated)';
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** `gh` argv of the read for `pr` on `repo`. Throws on names the guard would refuse. */
export function reviewFeedbackArgs(repo: Pick<ForgeRepo, 'host' | 'owner' | 'name'>, pr: number): string[] {
  if (!HOST.test(repo.host) || !NAME.test(repo.owner) || !NAME.test(repo.name) || !Number.isSafeInteger(pr) || !NUMBER.test(String(pr))) {
    throw new Error(`review feedback: ${repo.host}/${repo.owner}/${repo.name} #${pr} is not a plain GitHub repository and PR number`);
  }
  return ['api', 'graphql', '--hostname', repo.host, '-f', `query=${REVIEW_FEEDBACK_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${pr}`];
}

/**
 * The guard clause shared by the run and read guards: `args` is exactly
 * reviewFeedbackArgs for the repository `repoArg` (ghRepoArg:
 * `HOST/OWNER/NAME`) and some PR number. Names compare case-insensitively,
 * as GitHub resolves them. Without a repository context it is refused.
 */
export function isReviewFeedbackArgs(args: readonly string[], repoArg: string | undefined): boolean {
  if (repoArg === undefined || args.length !== 12) return false;
  const parts = repoArg.split('/');
  if (parts.length !== 3) return false;
  const [host, owner, name] = parts;
  if (!HOST.test(host) || !NAME.test(owner) || !NAME.test(name)) return false;
  const value = (arg: string, key: string): string => (arg.startsWith(`${key}=`) ? arg.slice(key.length + 1) : '');
  const o = value(args[7], 'owner');
  const n = value(args[9], 'name');
  const pr = value(args[11], 'number');
  return args[0] === 'api' && args[1] === 'graphql' && args[2] === '--hostname' && args[3].toLowerCase() === host.toLowerCase()
    && args[4] === '-f' && args[5] === `query=${REVIEW_FEEDBACK_QUERY}`
    && args[6] === '-f' && NAME.test(o) && o.toLowerCase() === owner.toLowerCase()
    && args[8] === '-f' && NAME.test(n) && n.toLowerCase() === name.toLowerCase()
    && args[10] === '-F' && NUMBER.test(pr);
}

/** Who counts as a human reviewer for one read. */
export interface ReviewTrust {
  /** `factory.review.trustedReviewers` (trusted config layers only), any case. */
  trustedReviewers: readonly string[];
}

/** A gh / GraphQL rate-limit answer (poll backs off on it, as on ADO_RATE_LIMITED). */
export const GITHUB_RATE_LIMITED = /\bRATE_LIMITED\b|API rate limit exceeded|secondary rate limit/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const login = (v: unknown): string | undefined => {
  const l = isObj(v) ? str(v.login) : undefined;
  return l && NAME.test(l) ? l : undefined;
};

/** A body the factory posted (its hidden marker as the last line): never human input. */
export function isFactoryComment(body: string): boolean {
  return body.trimEnd().split('\n').pop()?.trim() === ADO_FACTORY_COMMENT_MARKER;
}

const capped = (body: string): string => (body.length <= MAX_FEEDBACK_BODY_CHARS ? body : `${body.slice(0, MAX_FEEDBACK_BODY_CHARS - TRUNCATED.length)}${TRUNCATED}`);

const DECISION: Readonly<Record<string, ForgeReviewFeedback['decisions'][number]['state']>> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending',
};

const errorText = (e: unknown): string => (isObj(e) ? str(e.message) ?? '' : '').slice(0, 200);
const isRateLimited = (e: unknown): boolean => isObj(e) && (e.type === 'RATE_LIMITED' || GITHUB_RATE_LIMITED.test(str(e.message) ?? ''));

/**
 * The GraphQL `errors` of one answer that carries the pull request. None:
 * fine on exit 0. Otherwise the answer counts (as `true`: the collaborator
 * list is unreadable) only when every error's path starts at
 * repository.collaborators (it needs push access); any other error, a
 * RATE_LIMITED one first, throws.
 */
function collaboratorErrorsOnly(json: Obj, pr: number, exitStatus: number): boolean {
  const errors = json.errors;
  if (errors === undefined || errors === null) {
    if (exitStatus !== 0) throw new ReviewFeedbackError(`review feedback of PR ${pr}: gh exited ${exitStatus} with no GraphQL error`);
    return false;
  }
  if (!Array.isArray(errors) || errors.length === 0) throw new ReviewFeedbackError(`review feedback of PR ${pr}: malformed GraphQL errors`);
  const limited = errors.find(isRateLimited);
  if (limited !== undefined) throw new Error(`review feedback of PR ${pr}: GitHub RATE_LIMITED (${errorText(limited)})`);
  const other = errors.find((e) => !(isObj(e) && Array.isArray(e.path) && e.path[0] === 'repository' && e.path[1] === 'collaborators'));
  if (other !== undefined) throw new ReviewFeedbackError(`review feedback of PR ${pr}: partial answer (${errorText(other)})`);
  return true;
}

/**
 * The feedback in one GraphQL response (stdout of reviewFeedbackArgs, the gh
 * exit status beside it) for `pr` at `head`. Throws when the response carries
 * no pull request (an unknown PR, a failed query), a list is missing or
 * truncated, an error is not about the collaborator list, or `head` is not the
 * PR's head. A review body counts as a thread only when the review was
 * submitted on `head` (an older head's summary was answered by a later push);
 * inline threads count while unresolved (an outdated one flagged `outdated`).
 * A CHANGES_REQUESTED stands until the same author approves or it is
 * dismissed: a later COMMENTED review does not clear it.
 */
export function parseReviewFeedback(stdout: string, pr: number, head: string, trust: ReviewTrust, exitStatus = 0): ForgeReviewFeedback {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('review feedback: gh api graphql printed no JSON');
  }
  const data = isObj(json) && isObj(json.data) ? json.data : {};
  const repo = isObj(data.repository) ? data.repository : undefined;
  const pull = repo && isObj(repo.pullRequest) ? repo.pullRequest : undefined;
  if (!isObj(json) || !repo || !pull) {
    const errors: unknown[] = isObj(json) && Array.isArray(json.errors) ? json.errors : [];
    const limited = errors.some(isRateLimited);
    const first = errorText(errors[0]);
    throw new Error(`review feedback: no pull request in the response${limited ? ' (GitHub RATE_LIMITED)' : ''}${first ? ` (${first})` : ''}`);
  }
  const collaboratorsUnreadable = collaboratorErrorsOnly(json, pr, exitStatus);
  assertReviewHead(pr, head, pull.headRefOid);

  /** One connection's nodes: present, complete (pageInfo.hasNextPage false) and all objects, else it throws. */
  const connection = (v: unknown, what: string): Obj[] => {
    const page = isObj(v) && isObj(v.pageInfo) ? v.pageInfo.hasNextPage : undefined;
    if (!isObj(v) || !Array.isArray(v.nodes) || typeof page !== 'boolean' || !v.nodes.every(isObj)) {
      throw new ReviewFeedbackError(`review feedback of PR ${pr}: the answer has no complete ${what} list`);
    }
    if (page) throw new ReviewFeedbackTruncatedError(pr, what);
    return v.nodes as Obj[];
  };
  const reviews = connection(pull.latestReviews, 'latestReviews');
  // Same 50-review cap and remedy as latestReviews.
  const opinionated = connection(pull.latestOpinionatedReviews, 'latestReviews');
  const requests = connection(pull.reviewRequests, 'reviewRequests');
  const threadNodes = connection(pull.reviewThreads, 'reviewThreads');

  const configured = new Set(trust.trustedReviewers.map((l) => l.toLowerCase()));
  const trusted = new Set(configured);
  const c = repo.collaborators;
  const edges = isObj(c) && Array.isArray(c.edges) ? c.edges.filter(isObj) : [];
  const trustIncomplete = collaboratorsUnreadable || !isObj(c) || !Array.isArray(c.edges) || !isObj(c.pageInfo) || c.pageInfo.hasNextPage !== false;
  for (const e of edges) {
    const l = login(e.node);
    if (l && WRITE_PERMISSIONS.has(str(e.permission) ?? '')) trusted.add(l.toLowerCase());
  }
  const viewer = login(data.viewer);
  if (viewer && WRITE_PERMISSIONS.has(str(repo.viewerPermission) ?? '')) trusted.add(viewer.toLowerCase());

  const ignored = new Set<string>();
  /**
   * The trusted name of an author, else undefined (an untrusted one is listed
   * in `ignored`; a null or malformed author is dropped). A User is trusted by
   * the list or write access; a Bot (GraphQL gives its login without `[bot]`)
   * only when the list names `<slug>[bot]`; any other kind never.
   */
  const author = (v: unknown): string | undefined => {
    const l = login(v);
    if (!l || !isObj(v)) return undefined;
    const kind = str(v.__typename);
    const name = kind === 'Bot' ? `${l}[bot]` : l;
    const ok = kind === 'User' ? trusted.has(name.toLowerCase()) : kind === 'Bot' ? configured.has(name.toLowerCase()) : false;
    if (ok) return name;
    ignored.add(name);
    return undefined;
  };

  const decisions: ForgeReviewFeedback['decisions'] = [];
  const threads: ForgeReviewFeedback['threads'] = [];
  for (const r of reviews) {
    const state = DECISION[str(r.state) ?? ''];
    const body = str(r.body) ?? '';
    if (!state || isFactoryComment(body)) continue;
    const who = author(r.author);
    if (!who) continue;
    const at = str(r.submittedAt) ?? '';
    const oid = isObj(r.commit) ? str(r.commit.oid) : undefined;
    const reviewHead = oid && HEX40.test(oid) ? oid : undefined;
    decisions.push({ author: who, state, at, ...(reviewHead ? { head: reviewHead } : {}) });
    const id = str(r.id);
    if (id && body.trim() && reviewHead === head && (state === 'changes-requested' || state === 'commented')) {
      threads.push({ id: `review:${id}`, author: who, body: capped(body), at });
    }
  }
  // A later COMMENTED review by the same author does not clear their CHANGES_REQUESTED (GitHub's reviewDecision keeps it),
  // but latestReviews reports the comment as their latest: the latest opinionated review restores the request.
  for (const r of opinionated) {
    if (r.state !== 'CHANGES_REQUESTED' || isFactoryComment(str(r.body) ?? '')) continue;
    const who = author(r.author);
    if (!who) continue;
    const latest = decisions.find((d) => d.author === who);
    if (latest && latest.state !== 'commented' && latest.state !== 'pending') continue;
    const oid = isObj(r.commit) ? str(r.commit.oid) : undefined;
    decisions.push({ author: who, state: 'changes-requested', at: str(r.submittedAt) ?? '', ...(oid && HEX40.test(oid) ? { head: oid } : {}) });
  }

  for (const t of threadNodes) {
    const id = str(t.id);
    if (!id || typeof t.isResolved !== 'boolean' || typeof t.isOutdated !== 'boolean') {
      throw new ReviewFeedbackError(`review feedback of PR ${pr}: a review thread without its id or state`);
    }
    // Resolved threads are done; an outdated one (a later push changed its lines) stays, flagged, until someone resolves it.
    if (t.isResolved) continue;
    const kept = connection(t.comments, `comments of thread ${id.slice(0, 40)}`).flatMap((cm) => {
      const body = str(cm.body) ?? '';
      if (!body.trim() || isFactoryComment(body)) return [];
      const who = author(cm.author);
      return who ? [{ author: who, body, c: cm }] : [];
    });
    if (kept.length === 0) continue;
    const first = kept[0];
    const path = str(first.c.path);
    const line = [first.c.line, first.c.originalLine].find((v): v is number => Number.isSafeInteger(v) && (v as number) > 0);
    const body = kept.length === 1 ? first.body : kept.map((k) => `@${k.author}:\n${k.body}`).join('\n\n');
    const at = kept.map((k) => str(k.c.createdAt) ?? '').sort().pop() ?? '';
    threads.push({ id, author: first.author, body: capped(body), ...(path ? { file: path } : {}), ...(line ? { line } : {}), at, ...(t.isOutdated ? { outdated: true as const } : {}) });
  }

  const pending = new Set<string>();
  for (const q of requests) {
    const who = isObj(q.requestedReviewer) ? q.requestedReviewer : {};
    const slug = str(who.slug);
    const l = login(who);
    const name = l ? (who.__typename === 'Bot' ? `${l}[bot]` : l) : slug && NAME.test(slug) ? `team:${slug}` : undefined;
    if (name) pending.add(name);
  }

  return {
    decisions,
    threads,
    pendingReviewers: [...pending],
    ignored: [...ignored].filter((l) => !trusted.has(l.toLowerCase())).sort(),
    ...(trustIncomplete ? { trustIncomplete: true } : {}),
  };
}
