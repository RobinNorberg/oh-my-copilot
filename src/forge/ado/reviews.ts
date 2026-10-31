/**
 * ForgeReviews on Azure Repos (factory forges design §6): pull requests
 * through `git/pullRequests`, comments as new threads. The factory only
 * opens drafts and only flips isDraft to false; the guard refuses any other
 * PR body (a merge in particular).
 */

import { readFileSync } from 'fs';
import type { ForgePr, ForgeReviews, ForgeThread } from '../types.js';
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
  /** createdBy.uniqueName, lowercased: the identity the factory opened the PR as. */
  createdBy?: string;
}

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
    createdBy: isObject(json.createdBy) ? str(json.createdBy.uniqueName)?.toLowerCase() : undefined,
  };
}

const THREAD_STATUS: ReadonlySet<string> = new Set(['active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending']);
const COMMENT_TYPE: ReadonlySet<string> = new Set(['text', 'system', 'codeChange']);

/** The PR's threads (Pull Request Threads - List), deleted ones left out; a thread without a numeric id fails the read. */
export function parseAdoThreads(json: unknown, pr: number, prAuthor: string | undefined): ForgeThread[] {
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
      byPrAuthor: author !== '' && author === prAuthor,
      updatedAt: str(t.lastUpdatedDate) ?? '',
      ...(file ? { file } : {}),
    }];
  });
}

const STATE: Readonly<Record<string, ForgePr['state']>> = { active: 'OPEN', completed: 'MERGED', abandoned: 'CLOSED' };
const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, '');

/** The text of a body file without control characters (the route's TEXT rule), capped at ADO's description limit. */
function description(bodyFile: string): string {
  const text = readFileSync(bodyFile, 'utf8').replace(/(?![\t\r\n])\p{Cc}/gu, '');
  return text.length <= ADO_PR_DESCRIPTION_MAX ? text : `${text.slice(0, ADO_PR_DESCRIPTION_MAX - TRUNCATED.length)}${TRUNCATED}`;
}

export function adoReviews(ctx: AdoContext): ForgeReviews {
  const prUrl = (pr: number) => `${ctx.repo.url}/pullrequest/${pr}`;
  // A PR's creator never changes: listThreads reuses the one viewPr or prHead read.
  const creators = new Map<number, string | undefined>();
  const read = (pr: number): AdoPrView => {
    const v = readAdoPr(ctx, pr);
    creators.set(pr, v.createdBy);
    return v;
  };
  return {
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
      const v = read(pr);
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
      const v = read(pr);
      if (!v.lastMergeSourceCommit) throw new Error(`pull request ${pr}: no source commit yet`);
      return { headRefOid: v.lastMergeSourceCommit, state: STATE[v.status] ?? v.status.toUpperCase() };
    },

    markReady(pr: number): void {
      adoJson(adoCall(ctx, 'git.pullRequests.PATCH', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, { isDraft: false }), `mark pull request ${pr} ready`);
    },

    commentPr(pr: number, bodyFile: string) {
      try {
        const body = { comments: [{ parentCommentId: 0, content: readFileSync(bodyFile, 'utf8'), commentType: 1 }], status: 1 };
        const call = adoCall(ctx, 'git.pullRequestThreads.POST', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, body);
        return { ok: call.ok, stderr: call.ok ? '' : call.stderr || `az exited ${call.status}` };
      } catch (error) {
        return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
      }
    },

    listThreads(pr: number): ForgeThread[] {
      const author = creators.has(pr) ? creators.get(pr) : read(pr).createdBy;
      const json = adoJson(adoCall(ctx, 'git.pullRequestThreads.GET', { ...repoParams(ctx), pullRequestId: String(pr) }), `threads of pull request ${pr}`);
      return parseAdoThreads(json, pr, author);
    },
  };
}
