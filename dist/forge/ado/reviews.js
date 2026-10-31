/**
 * ForgeReviews on Azure Repos (factory forges design §6): pull requests
 * through `git/pullRequests`, comments as new threads. The factory only
 * opens drafts and only flips isDraft to false; the guard refuses any other
 * PR body (a merge in particular).
 */
import { readFileSync } from 'fs';
import { adoCall, adoJson, isObject, listValue, repoParams, str } from './invoke.js';
const SHA = /^[0-9a-f]{40}$/;
/** REST `description` limit on a pull request. */
export const ADO_PR_DESCRIPTION_MAX = 4000;
const TRUNCATED = '\n\n(truncated: the full text is in the factory run log)';
const commitOf = (v) => {
    const id = isObject(v) ? str(v.commitId) : undefined;
    return id && SHA.test(id) ? id : undefined;
};
export function readAdoPr(ctx, pr) {
    const json = adoJson(adoCall(ctx, 'git.pullRequests.GET', { ...repoParams(ctx), pullRequestId: String(pr) }), `pull request ${pr}`);
    if (!isObject(json) || json.pullRequestId !== pr || typeof json.status !== 'string')
        throw new Error(`pull request ${pr}: malformed response`);
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
const STATE = { active: 'OPEN', completed: 'MERGED', abandoned: 'CLOSED' };
const branchOf = (ref) => ref.replace(/^refs\/heads\//, '');
/** The text of a body file without control characters (the route's TEXT rule), capped at ADO's description limit. */
function description(bodyFile) {
    const text = readFileSync(bodyFile, 'utf8').replace(/(?![\t\r\n])\p{Cc}/gu, '');
    return text.length <= ADO_PR_DESCRIPTION_MAX ? text : `${text.slice(0, ADO_PR_DESCRIPTION_MAX - TRUNCATED.length)}${TRUNCATED}`;
}
export function adoReviews(ctx) {
    const prUrl = (pr) => `${ctx.repo.url}/pullrequest/${pr}`;
    return {
        findOpenPrForBranch(branch) {
            const json = adoJson(adoCall(ctx, 'git.pullRequests.GET', repoParams(ctx), { 'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'active' }), `pull requests for ${branch}`);
            const ids = listValue(json).map((p) => (isObject(p) ? p.pullRequestId : undefined)).filter((n) => Number.isSafeInteger(n));
            return ids[0];
        },
        findMergedPrForBranch(branch, base) {
            const json = adoJson(adoCall(ctx, 'git.pullRequests.GET', repoParams(ctx), {
                'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'completed', 'searchCriteria.targetRefName': `refs/heads/${base}`,
            }), `merged pull requests for ${branch} into ${base}`);
            const ids = listValue(json).map((p) => (isObject(p) ? p.pullRequestId : undefined)).filter((n) => Number.isSafeInteger(n));
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
            if (typeof id !== 'number' || !Number.isSafeInteger(id))
                throw new Error(`create pull request for ${o.head}: no pullRequestId in the response`);
            return id;
        },
        viewPr(pr) {
            const v = readAdoPr(ctx, pr);
            const state = STATE[v.status];
            if (!state)
                throw new Error(`pull request ${pr}: unknown status ${JSON.stringify(v.status)}`);
            if (!v.lastMergeSourceCommit || !v.lastMergeTargetCommit)
                throw new Error(`pull request ${pr}: no source/target commit yet`);
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
        prHead(pr) {
            const v = readAdoPr(ctx, pr);
            if (!v.lastMergeSourceCommit)
                throw new Error(`pull request ${pr}: no source commit yet`);
            return { headRefOid: v.lastMergeSourceCommit, state: STATE[v.status] ?? v.status.toUpperCase() };
        },
        markReady(pr) {
            adoJson(adoCall(ctx, 'git.pullRequests.PATCH', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, { isDraft: false }), `mark pull request ${pr} ready`);
        },
        commentPr(pr, bodyFile) {
            try {
                const body = { comments: [{ parentCommentId: 0, content: readFileSync(bodyFile, 'utf8'), commentType: 1 }], status: 1 };
                const call = adoCall(ctx, 'git.pullRequestThreads.POST', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, body);
                return { ok: call.ok, stderr: call.ok ? '' : call.stderr || `az exited ${call.status}` };
            }
            catch (error) {
                return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
//# sourceMappingURL=reviews.js.map