/**
 * ForgeCi on Azure Pipelines (ADO parity design §3.3): heal's CI history is
 * the builds of the one build definition `factory.heal.pipeline` names
 * (trusted config layers only), so `workflow`, GitHub's file name, is not
 * read here. Reads only: the heal guard runs these calls with the `read`
 * policy, and the rerun is a human step that omg prints and never issues.
 */
import { capLog } from '../../factory/heal/logs.js';
import { adoBuildUrl, buildHeadFields, buildTimeline, conclusion, newestJobRecords, readBuildLog, RUN_STATUS } from './checks.js';
import { adoCall, adoJson, isObject, listValue, projectParams, str } from './invoke.js';
const BUILD_ID = /^[1-9]\d{0,9}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const JOB_ID = /^([1-9]\d{0,9}):([0-9a-f-]{36})$/i;
/** CI builds of the base branch; the docs type `reasonFilter` as one BuildReason, so both are kept client-side. */
const PUSH_REASONS = new Set(['individualCI', 'batchedCI']);
/** TaskResult (Timeline - Get); an unknown result fails closed. */
const JOB_CONCLUSION = {
    succeeded: 'success', succeededWithIssues: 'success', failed: 'failure', canceled: 'cancelled', abandoned: 'cancelled', skipped: 'skipped',
};
const branchName = (ref) => (ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined);
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const byOrder = (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0);
/** A PR build's head: the recorded PR source sha (both fields must agree) and branch; undefined = dropped, never guessed. */
function prHead(build) {
    const { triggerSha, parameterSha } = buildHeadFields(build);
    if (triggerSha !== undefined && parameterSha !== undefined && triggerSha !== parameterSha)
        return undefined;
    const headSha = triggerSha ?? parameterSha;
    if (!headSha || !HEX40.test(headSha))
        return undefined;
    const trigger = isObject(build.triggerInfo) ? build.triggerInfo : {};
    const number = str(trigger['pr.number']);
    // Unverified live: pr.sourceBranch; else the PR number, so two PRs never share a head branch.
    const headBranch = branchName(str(trigger['pr.sourceBranch'])) ?? (number && BUILD_ID.test(number) ? `pr-${number}` : undefined);
    return headBranch ? { headSha, headBranch } : undefined;
}
function toRun(build, event) {
    if (!isObject(build) || !Number.isSafeInteger(build.id) || build.id < 1)
        return [];
    const reason = str(build.reason) ?? '';
    let head;
    if (event === 'push') {
        const sha = str(build.sourceVersion) ?? '';
        head = PUSH_REASONS.has(reason) && HEX40.test(sha) ? { headSha: sha, headBranch: branchName(str(build.sourceBranch)) ?? '' } : undefined;
    }
    else {
        head = reason === 'pullRequest' ? prHead(build) : undefined;
    }
    if (!head)
        return [];
    const status = RUN_STATUS[str(build.status) ?? ''] ?? 'queued';
    return [{
            id: String(build.id),
            ...head,
            event,
            createdAt: str(build.queueTime) ?? '',
            status,
            conclusion: status === 'completed' ? conclusion(str(build.result)).conclusion ?? 'failure' : '',
        }];
}
function buildId(runId) {
    if (!BUILD_ID.test(runId))
        throw new Error(`build id ${JSON.stringify(runId)} is not a number`);
    return runId;
}
export function adoCi(ctx, pipeline) {
    const definitions = String(pipeline.definitionId);
    return {
        listRuns(o) {
            const query = o.event === 'push'
                ? { definitions, ...(o.branch ? { branchName: `refs/heads/${o.branch}` } : {}), statusFilter: 'completed', queryOrder: 'finishTimeDescending', $top: String(o.limit) }
                : { definitions, reasonFilter: 'pullRequest', statusFilter: 'completed', queryOrder: 'finishTimeDescending', $top: String(o.limit) };
            const json = adoJson(adoCall(ctx, 'build.builds.GET', projectParams(ctx), query), `builds of pipeline ${definitions}`);
            // Newest first, whatever order the service returned.
            return listValue(json).flatMap((b) => toRun(b, o.event)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },
        runJobs(runId) {
            const records = buildTimeline(ctx, buildId(runId));
            return newestJobRecords(records).map((job) => {
                const result = str(job.result);
                return {
                    jobId: `${runId}:${str(job.id)}`,
                    name: (str(job.name) ?? '').slice(0, 200),
                    conclusion: !result || result === 'none' ? '' : JOB_CONCLUSION[result] ?? 'failure',
                    failedSteps: records
                        .filter((r) => sameId(r.parentId, job.id) && r.type === 'Task' && r.result === 'failed')
                        .sort(byOrder)
                        .map((r) => (str(r.name) ?? '').slice(0, 200)),
                };
            });
        },
        jobLog(jobId) {
            const m = JOB_ID.exec(jobId);
            if (!m)
                throw new Error(`job id ${JSON.stringify(jobId)} is not <buildId>:<timeline record id>`);
            const records = buildTimeline(ctx, m[1]);
            const job = records.find((r) => sameId(r.id, m[2]));
            if (!job)
                throw new Error(`build ${m[1]} has no timeline record ${m[2]}`);
            const logId = (r) => (isObject(r.log) ? r.log.id : undefined);
            // Unverified live which record carries the full log: the job's own, else its failed tasks' logs in order.
            const ids = (typeof logId(job) === 'number'
                ? [logId(job)]
                : records.filter((r) => sameId(r.parentId, job.id) && r.type === 'Task' && r.result === 'failed').sort(byOrder).map(logId)).filter((id) => typeof id === 'number' && Number.isSafeInteger(id));
            if (ids.length === 0)
                throw new Error(`build ${m[1]} record ${m[2]} has no log`);
            return capLog(ids.map((id) => readBuildLog(ctx, m[1], id)).join('\n'));
        },
        rerunIntent: (runId) => `Rerun failed jobs on ${adoBuildUrl(ctx.repo, runId)}`,
    };
}
//# sourceMappingURL=ci.js.map