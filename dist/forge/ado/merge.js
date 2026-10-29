/**
 * ForgeMerge on Azure Repos (factory forges design §6, §8.4): the merge
 * decision from branch policies, for a human to read, and the merge command
 * a human runs. Nothing here merges: the guard refuses a PR body with
 * `status`, `completionOptions` or `autoCompleteSetBy`, so the printed
 * command cannot run through the factory.
 *
 * The printed command reads its body from a file the engine writes
 * (adoMergeBody, mode 0600) at an ABSOLUTE path in the engine-owned state
 * directory, outside every untrusted root: a relative path would resolve
 * against wherever the human stands, and a lane could have committed a body
 * there (completionOptions.bypassPolicy, say).
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { listEvaluations, policyName } from './checks.js';
import { adoInvokeArgs, repoParams } from './invoke.js';
import { readAdoPr } from './reviews.js';
/** The completion body a human sends: ADO rejects a stale lastMergeSourceCommit, the analogue of --match-head-commit. */
export function adoMergeBody(headSha) {
    return { status: 'completed', lastMergeSourceCommit: { commitId: headSha }, completionOptions: { mergeStrategy: 'noFastForward' } };
}
const SATISFIED = new Set(['approved', 'notApplicable']);
const realOr = (p) => {
    try {
        return realpathSync.native(p);
    }
    catch {
        return resolve(p);
    }
};
const under = (path, root) => {
    const rel = relative(realOr(root), path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const fileSafe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
/** Write the head-pinned body for `pr` and return its absolute path. */
export function writeAdoMergeBody(ctx, o, pr, headSha) {
    if (!isAbsolute(o.stateDir))
        throw new Error(`merge body directory ${o.stateDir} is not absolute`);
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    const dir = realOr(o.stateDir);
    const root = o.untrustedRoots.find((r) => r.trim() !== '' && under(dir, r));
    if (root)
        throw new Error(`merge body directory ${dir} is under the untrusted root ${root}`);
    const path = join(dir, fileSafe(`ado-merge-${ctx.repo.owner}-${ctx.repo.project}-${ctx.repo.name}-pr-${pr}-${headSha.slice(0, 12)}.json`));
    // A fresh file (flag wx after removing any old one), so the mode always applies and nothing pre-planted is reused.
    rmSync(path, { force: true });
    writeFileSync(path, `${JSON.stringify(adoMergeBody(headSha), null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return path;
}
export function adoMerge(ctx, o) {
    return {
        /** Writes the body file (writeAdoMergeBody), then returns the command that reads it. */
        humanMergeCommand(pr, headSha) {
            if (!/^[0-9a-f]{40}$/.test(headSha))
                throw new Error(`merge command needs a 40-hex head sha, got ${JSON.stringify(headSha)}`);
            const bodyFile = writeAdoMergeBody(ctx, o, pr, headSha);
            // Printed for a human with plain `az`, whatever entry the adapter spawns.
            const args = adoInvokeArgs({ entry: { command: 'az', prefix: [], env: {} }, repo: ctx.repo }, 'git.pullRequests.PATCH', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, bodyFile);
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