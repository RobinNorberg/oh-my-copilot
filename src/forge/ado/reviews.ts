/**
 * ForgeReviews on Azure Repos (factory forges design §6): pull requests
 * through `git/pullRequests`, comments as new threads. The factory only
 * opens drafts and only flips isDraft to false; the guard refuses any other
 * PR body (a merge in particular).
 */

import { readFileSync } from 'fs';
import type { ForgePr, ForgeReviewFeedback, ForgeReviews, ForgeThread, PrMergeability } from '../types.js';
import { assertReviewHead } from '../review-feedback.js';
import { adoCall, adoJson, isObject, listValue, repoParams, str, type AdoContext } from './invoke.js';

const SHA = /^[0-9a-f]{40}$/;
/** REST `description` limit on a pull request. */
export const ADO_PR_DESCRIPTION_MAX = 4000;
const TRUNCATED = '\n\n(truncated: the full text is in the factory run log)';

/** The pull request fields the adapter reads, from `git/pullRequests/{id}`. */
export interface AdoPrView {
  id: number;
  status: string;
  isDraft: boolean;
  sourceRefName: string;
  targetRefName: string;
  /** PR head the forge last saw (lags a push by seconds). */
  lastMergeSourceCommit?: string;
  lastMergeTargetCommit?: string;
  /** The merge commit PR builds run on (refs/pull/{id}/merge). */
  lastMergeCommit?: string;
  mergeStatus?: string;
  /** Project GUID, for the policy artifact id. */
  projectId?: string;
}

/**
 * The hidden last line of every PR comment the factory posts on Azure Repos
 * (an HTML comment, not rendered): `omg factory poll` leaves those threads out
 * of its human thread count. A person who pastes it only hides their own thread.
 */
export const ADO_FACTORY_COMMENT_MARKER = '<!-- omg-factory: comment -->';

const endsWithMarker = (content: unknown): boolean =>
  typeof content === 'string' && content.trimEnd().split('\n').pop()?.trim() === ADO_FACTORY_COMMENT_MARKER;

const commitOf = (v: unknown): string | undefined => {
  const id = isObject(v) ? str(v.commitId) : undefined;
  return id && SHA.test(id) ? id : undefined;
};

export function readAdoPr(ctx: AdoContext, pr: number): AdoPrView {
  const json = adoJson(adoCall(ctx, 'git.pullRequests.GET', { ...repoParams(ctx), pullRequestId: String(pr) }), `pull request ${pr}`);
  if (!isObject(json) || json.pullRequestId !== pr || typeof json.status !== 'string') throw new Error(`pull request ${pr}: malformed response`);
  const repository = isObject(json.repository) ? json.repository : {};
  const project = isObject(repository.project) ? repository.project : {};
  return {
    id: pr,
    status: json.status,
    isDraft: json.isDraft === true,
    sourceRefName: str(json.sourceRefName) ?? '',
    targetRefName: str(json.targetRefName) ?? '',
    lastMergeSourceCommit: commitOf(json.lastMergeSourceCommit),
    lastMergeTargetCommit: commitOf(json.lastMergeTargetCommit),
    lastMergeCommit: commitOf(json.lastMergeCommit),
    mergeStatus: str(json.mergeStatus),
    projectId: str(project.id),
  };
}

const THREAD_STATUS: ReadonlySet<string> = new Set(['active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending']);
const COMMENT_TYPE: ReadonlySet<string> = new Set(['text', 'system', 'codeChange']);

/** The PR's threads (Pull Request Threads - List), deleted ones left out; a thread without a numeric id fails the read. */
export function parseAdoThreads(json: unknown, pr: number): ForgeThread[] {
  return listValue(json).flatMap((t): ForgeThread[] => {
    if (!isObject(t) || t.isDeleted === true) return [];
    if (!Number.isSafeInteger(t.id)) throw new Error(`pull request ${pr}: a thread without an id`);
    const first = Array.isArray(t.comments) && isObject(t.comments[0]) ? t.comments[0] : {};
    const author = (isObject(first.author) ? str(first.author.uniqueName) : undefined)?.toLowerCase() ?? '';
    const status = str(t.status) ?? '';
    const kind = str(first.commentType) ?? '';
    const file = isObject(t.threadContext) ? str(t.threadContext.filePath) : undefined;
    return [{
      id: t.id as number,
      status: THREAD_STATUS.has(status) ? (status as ForgeThread['status']) : 'unknown',
      kind: COMMENT_TYPE.has(kind) ? (kind as ForgeThread['kind']) : 'unknown',
      author,
      byFactory: endsWithMarker(first.content),
      updatedAt: str(t.lastUpdatedDate) ?? '',
      ...(file ? { file } : {}),
    }];
  });
}

/** One thread or comment body handed on, at most (the same cap as GitHub's, src/forge/github/graphql.ts). */
const MAX_FEEDBACK_BODY_CHARS = 8_000;
const capped = (body: string): string => (body.length <= MAX_FEEDBACK_BODY_CHARS ? body : `${body.slice(0, MAX_FEEDBACK_BODY_CHARS - 12)}\n(truncated)`);

/**
 * The human review input on one PR (ForgeReviews.reviewFeedback) from its
 * reviewers (Pull Requests - Get By Id) and threads (Pull Request Threads -
 * List). Trust is the given list (the caller passes `factory.review.trustedReviewers`
 * and the user-config trustedAuthors; uniqueNames, any case): Azure DevOps has no permission read the guard allows.
 * - decisions: each trusted reviewer's non-zero vote (10/5 approved, -5
 *   waiting for author and -10 rejected are changes-requested). A vote carries
 *   no time or commit; whether it survives a push is the branch policy's
 *   "reset votes" setting, so `at` is '' and `head` absent.
 * - threads: active or pending text threads with the trusted authors' text
 *   comments; the factory's own comments (marker) and deleted ones are
 *   dropped, so a trusted reply inside a factory-started thread still counts
 *   (its first trusted comment names the thread).
 * - head: `head` must be the PR's lastMergeSourceCommit, else
 *   ReviewHeadMovedError (the feedback would describe another commit).
 * - pendingReviewers: required reviewers who have not voted or declined.
 */
export function parseAdoReviewFeedback(prJson: unknown, threadsJson: unknown, pr: number, head: string, trustedReviewers: readonly string[]): ForgeReviewFeedback {
  if (!isObject(prJson) || prJson.pullRequestId !== pr) throw new Error(`pull request ${pr}: malformed response`);
  assertReviewHead(pr, head, isObject(prJson.lastMergeSourceCommit) ? prJson.lastMergeSourceCommit.commitId : undefined);
  const trusted = new Set(trustedReviewers.map((r) => r.toLowerCase()));
  const ignored = new Set<string>();
  const counts = (who: string): boolean => {
    if (!who) return false;
    if (trusted.has(who)) return true;
    ignored.add(who);
    return false;
  };
  const decisions: ForgeReviewFeedback['decisions'] = [];
  const pendingReviewers: string[] = [];
  for (const r of Array.isArray(prJson.reviewers) ? prJson.reviewers.filter(isObject) : []) {
    const who = (str(r.uniqueName) ?? '').toLowerCase();
    const vote = typeof r.vote === 'number' ? r.vote : 0;
    if (vote === 0) {
      if (r.isRequired === true && r.hasDeclined !== true && who) pendingReviewers.push(who);
      continue;
    }
    if (r.isContainer === true || !counts(who)) continue;
    decisions.push({ author: who, state: vote > 0 ? 'approved' : 'changes-requested', at: '' });
  }
  const threads: ForgeReviewFeedback['threads'] = [];
  for (const t of listValue(threadsJson)) {
    if (!isObject(t) || t.isDeleted === true || !Number.isSafeInteger(t.id)) continue;
    if (t.status !== 'active' && t.status !== 'pending') continue;
    const comments = Array.isArray(t.comments) ? t.comments.filter(isObject) : [];
    const first = comments[0] ?? {};
    if (str(first.commentType) !== 'text') continue;
    const kept = comments.flatMap((c) => {
      const who = (isObject(c.author) ? str(c.author.uniqueName) : undefined)?.toLowerCase() ?? '';
      const body = str(c.content) ?? '';
      if (c.isDeleted === true || str(c.commentType) !== 'text' || !body.trim() || endsWithMarker(body) || !counts(who)) return [];
      return [{ who, body, at: str(c.lastUpdatedDate) ?? str(c.publishedDate) ?? '' }];
    });
    if (kept.length === 0) continue;
    const ctxt = isObject(t.threadContext) ? t.threadContext : {};
    const file = str(ctxt.filePath);
    const start = isObject(ctxt.rightFileStart) ? ctxt.rightFileStart.line : undefined;
    const line = Number.isSafeInteger(start) && (start as number) > 0 ? (start as number) : undefined;
    const body = kept.length === 1 ? kept[0].body : kept.map((k) => `@${k.who}:\n${k.body}`).join('\n\n');
    const at = [str(t.lastUpdatedDate) ?? '', ...kept.map((k) => k.at)].sort().pop() ?? '';
    threads.push({ id: String(t.id), author: kept[0].who, body: capped(body), ...(file ? { file } : {}), ...(line ? { line } : {}), at });
  }
  return { decisions, threads, pendingReviewers, ignored: [...ignored].sort() };
}

const STATE: Readonly<Record<string, ForgePr['state']>> = { active: 'OPEN', completed: 'MERGED', abandoned: 'CLOSED' };
const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, '');

/** The text of a body file without control characters (the route's TEXT rule), capped at ADO's description limit. */
function description(bodyFile: string): string {
  const text = readFileSync(bodyFile, 'utf8').replace(/(?![\t\r\n])\p{Cc}/gu, '');
  return text.length <= ADO_PR_DESCRIPTION_MAX ? text : `${text.slice(0, ADO_PR_DESCRIPTION_MAX - TRUNCATED.length)}${TRUNCATED}`;
}

/** `review.trustedReviewers`: whose votes and comments reviewFeedback hands on (src/forge/config.ts, trusted layers only). */
export function adoReviews(ctx: AdoContext, review: { trustedReviewers: readonly string[] } = { trustedReviewers: [] }): ForgeReviews {
  const prUrl = (pr: number) => `${ctx.repo.url}/pullrequest/${pr}`;
  return {
    reviewFeedback(pr: number, head: string): ForgeReviewFeedback {
      const params = { ...repoParams(ctx), pullRequestId: String(pr) };
      const prJson = adoJson(adoCall(ctx, 'git.pullRequests.GET', params), `pull request ${pr}`);
      const threads = adoJson(adoCall(ctx, 'git.pullRequestThreads.GET', params), `threads of pull request ${pr}`);
      // No permission read on Azure DevOps: the user-config trustedAuthors (whose items the factory runs) count too.
      return parseAdoReviewFeedback(prJson, threads, pr, head, [...review.trustedReviewers, ...ctx.config.trustedAuthors]);
    },

    findOpenPrForBranch(branch: string): number | undefined {
      const json = adoJson(
        adoCall(ctx, 'git.pullRequests.GET', repoParams(ctx), { 'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'active' }),
        `pull requests for ${branch}`,
      );
      const ids = listValue(json).map((p) => (isObject(p) ? p.pullRequestId : undefined)).filter((n): n is number => Number.isSafeInteger(n));
      return ids[0];
    },

    findMergedPrForBranch(branch: string, base: string): number | undefined {
      const json = adoJson(
        adoCall(ctx, 'git.pullRequests.GET', repoParams(ctx), {
          'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'completed', 'searchCriteria.targetRefName': `refs/heads/${base}`,
        }),
        `merged pull requests for ${branch} into ${base}`,
      );
      const ids = listValue(json).map((p) => (isObject(p) ? p.pullRequestId : undefined)).filter((n): n is number => Number.isSafeInteger(n));
      return ids[0];
    },

    createDraftPr(o) {
      const text = description(o.bodyFile);
      const body = {
        sourceRefName: `refs/heads/${o.head}`,
        targetRefName: `refs/heads/${o.base}`,
        title: o.title,
        ...(text ? { description: text } : {}),
        isDraft: true,
        ...(o.itemId !== undefined ? { workItemRefs: [{ id: String(o.itemId) }] } : {}),
      };
      const json = adoJson(adoCall(ctx, 'git.pullRequests.POST', repoParams(ctx), {}, body), `create pull request for ${o.head}`);
      const id = isObject(json) ? json.pullRequestId : undefined;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new Error(`create pull request for ${o.head}: no pullRequestId in the response`);
      return id;
    },

    viewPr(pr: number): ForgePr {
      const v = readAdoPr(ctx, pr);
      const state = STATE[v.status];
      if (!state) throw new Error(`pull request ${pr}: unknown status ${JSON.stringify(v.status)}`);
      if (!v.lastMergeSourceCommit || !v.lastMergeTargetCommit) throw new Error(`pull request ${pr}: no source/target commit yet`);
      return {
        number: pr,
        state,
        isDraft: v.isDraft,
        baseRefName: branchOf(v.targetRefName),
        baseRefOid: v.lastMergeTargetCommit,
        headRefName: branchOf(v.sourceRefName),
        headRefOid: v.lastMergeSourceCommit,
        url: prUrl(pr),
      };
    },

    prHead(pr: number) {
      const v = readAdoPr(ctx, pr);
      if (!v.lastMergeSourceCommit) throw new Error(`pull request ${pr}: no source commit yet`);
      return { headRefOid: v.lastMergeSourceCommit, state: STATE[v.status] ?? v.status.toUpperCase() };
    },

    // mergeStatus: `conflicts` is a conflict, `succeeded` merges; queued/notSet/failure/rejectedByPolicy say nothing about conflicts.
    mergeability(pr: number): PrMergeability {
      const v = readAdoPr(ctx, pr);
      const head = v.lastMergeSourceCommit ? { headRefOid: v.lastMergeSourceCommit } : {};
      return { state: v.mergeStatus === 'conflicts' ? 'conflicting' : v.mergeStatus === 'succeeded' ? 'mergeable' : 'unknown', ...head };
    },

    markReady(pr: number): void {
      adoJson(adoCall(ctx, 'git.pullRequests.PATCH', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, { isDraft: false }), `mark pull request ${pr} ready`);
    },

    commentPr(pr: number, bodyFile: string) {
      try {
        const content = `${readFileSync(bodyFile, 'utf8').trimEnd()}\n\n${ADO_FACTORY_COMMENT_MARKER}\n`;
        const body = { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1 };
        const call = adoCall(ctx, 'git.pullRequestThreads.POST', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, body);
        return { ok: call.ok, stderr: call.ok ? '' : call.stderr || `az exited ${call.status}` };
      } catch (error) {
        return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
      }
    },

    listThreads(pr: number): ForgeThread[] {
      const json = adoJson(adoCall(ctx, 'git.pullRequestThreads.GET', { ...repoParams(ctx), pullRequestId: String(pr) }), `threads of pull request ${pr}`);
      return parseAdoThreads(json, pr);
    },
  };
}
