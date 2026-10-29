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
import { createHash } from 'crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
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
/**
 * Why `dir` (already resolved) may not hold the merge body, or undefined: it
 * must be a directory, and on POSIX owned by this user and not writable
 * by group or others, so nobody else can swap the body between the write
 * and the human's run. Windows modes carry no ACL information; there the
 * untrusted-root check is the guard.
 */
export function mergeBodyDirProblem(dir, platform = process.platform) {
    const st = lstatSync(dir);
    if (!st.isDirectory())
        return `merge body directory ${dir} is not a directory`;
    if (platform === 'win32')
        return undefined;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid)
        return `merge body directory ${dir} is owned by uid ${st.uid}, not this user (${uid})`;
    if ((st.mode & 0o022) !== 0)
        return `merge body directory ${dir} is writable by group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 700 it`;
    return undefined;
}
function writeBody(ctx, o, pr, headSha) {
    if (!isAbsolute(o.stateDir))
        throw new Error(`merge body directory ${o.stateDir} is not absolute`);
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    const dir = realOr(o.stateDir);
    const root = o.untrustedRoots.find((r) => r.trim() !== '' && under(dir, r));
    if (root)
        throw new Error(`merge body directory ${dir} is under the untrusted root ${root}`);
    const problem = mergeBodyDirProblem(dir);
    if (problem)
        throw new Error(problem);
    const path = join(dir, fileSafe(`ado-merge-${ctx.repo.owner}-${ctx.repo.project}-${ctx.repo.name}-pr-${pr}-${headSha.slice(0, 12)}.json`));
    const content = `${JSON.stringify(adoMergeBody(headSha), null, 2)}\n`;
    // A fresh file (flag wx after removing any old one), so the mode always applies and nothing pre-planted is reused.
    rmSync(path, { force: true });
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { path, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
}
/** Write the head-pinned body for `pr` and return its absolute path. */
export function writeAdoMergeBody(ctx, o, pr, headSha) {
    return writeBody(ctx, o, pr, headSha).path;
}
export function adoMerge(ctx, o) {
    /** Writes the body file, then returns the command that reads it and the file's SHA-256. */
    const humanMerge = (pr, headSha) => {
        if (!/^[0-9a-f]{40}$/.test(headSha))
            throw new Error(`merge command needs a 40-hex head sha, got ${JSON.stringify(headSha)}`);
        const body = writeBody(ctx, o, pr, headSha);
        // Printed for a human with plain `az`, whatever entry the adapter spawns.
        const args = adoInvokeArgs({ entry: { command: 'az', prefix: [], env: {} }, repo: ctx.repo }, 'git.pullRequests.PATCH', { ...repoParams(ctx), pullRequestId: String(pr) }, {}, body.path);
        return { command: ['az', ...args], bodyFile: body.path, bodySha256: body.sha256 };
    };
    return {
        humanMerge,
        humanMergeCommand: (pr, headSha) => humanMerge(pr, headSha).command,
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