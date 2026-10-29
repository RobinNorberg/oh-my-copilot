/**
 * ForgeMerge on Azure Repos (factory forges design §6, §8.4): the merge
 * decision from branch policies, for a human to read, and the merge command
 * a human runs. Nothing here merges: the guard refuses a PR body with
 * `status`, `completionOptions` or `autoCompleteSetBy`, so the printed
 * command cannot run through the factory.
 */
import { listEvaluations, policyName } from './checks.js';
import { adoInvokeArgs, repoParams } from './invoke.js';
import { readAdoPr } from './reviews.js';
/** The completion body a human sends: ADO rejects a stale lastMergeSourceCommit, the analogue of --match-head-commit. */
export function adoMergeBody(headSha) {
    return { status: 'completed', lastMergeSourceCommit: { commitId: headSha }, completionOptions: { mergeStrategy: 'noFastForward' } };
}
/** The file name the printed merge command reads its body from. */
export const adoMergeBodyFile = (pr) => `omg-merge-pr-${pr}.json`;
const SATISFIED = new Set(['approved', 'notApplicable']);
export function adoMerge(ctx) {
    return {
        humanMergeCommand(pr, headSha) {
            if (!/^[0-9a-f]{40}$/.test(headSha))
                throw new Error(`merge command needs a 40-hex head sha, got ${JSON.stringify(headSha)}`);
            // Printed for a human with plain `az`, whatever entry the adapter spawns.
            const args = adoInvokeArgs({ entry: { command: 'az', prefix: [], env: {} }, repo: ctx.repo }, 'git.pullRequests.PATCH', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, adoMergeBodyFile(pr));
            return ['az', ...args];
        },
        blockingPolicies(pr, headSha) {
            const view = readAdoPr(ctx, pr);
            const reasons = [];
            if (view.status !== 'active')
                reasons.push(`pull request is ${view.status}`);
            if (view.isDraft)
                reasons.push('pull request is a draft');
            if (view.lastMergeSourceCommit !== headSha)
                reasons.push(`Azure DevOps head ${view.lastMergeSourceCommit ?? 'unknown'} is not ${headSha}`);
            if (view.mergeStatus !== 'succeeded')
                reasons.push(`merge status ${view.mergeStatus ?? 'unknown'} (needs succeeded)`);
            for (const e of listEvaluations(ctx, view)) {
                if (!e.isBlocking)
                    continue;
                if (e.expired)
                    reasons.push(`${policyName(e)}: expired`);
                else if (!SATISFIED.has(e.status))
                    reasons.push(`${policyName(e)}: ${e.status || 'unknown'}`);
            }
            return reasons;
        },
    };
}
//# sourceMappingURL=merge.js.map