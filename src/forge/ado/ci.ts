/**
 * ForgeCi on Azure Pipelines (ADO parity design §3.3): heal's CI history is
 * the builds of the one build definition `factory.heal.pipeline` names
 * (trusted config layers only), so `workflow`, GitHub's file name, is not
 * read here. Reads only: the heal guard runs these calls with the `read`
 * policy, and the rerun is a human step that omg prints and never issues.
 */

import type { HealJob, HealRun } from '../../factory/heal/history.js';
import { capLog, MAX_LOG_CHARS } from '../../factory/heal/logs.js';
import type { ForgeCi } from '../types.js';
import { adoBuildUrl, buildHeadFields, buildTimeline, conclusion, newestJobRecords, readBuildLog, RUN_STATUS } from './checks.js';
import { adoCall, adoJson, isObject, listValue, projectParams, str, type AdoContext } from './invoke.js';

const BUILD_ID = /^[1-9]\d{0,9}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const JOB_ID = /^([1-9]\d{0,9}):([0-9a-f-]{36})$/i;
/** CI builds of the base branch; the docs type `reasonFilter` as one BuildReason, so both are kept client-side. */
const PUSH_REASONS: ReadonlySet<string> = new Set(['individualCI', 'batchedCI']);
/** TaskResult (Timeline - Get); an unknown result fails closed. */
const JOB_CONCLUSION: Readonly<Record<string, string>> = {
  succeeded: 'success', succeededWithIssues: 'success', failed: 'failure', canceled: 'cancelled', abandoned: 'cancelled', skipped: 'skipped',
};

const branchName = (ref: string | undefined): string | undefined => (ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined);
const sameId = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const byOrder = (a: Record<string, unknown>, b: Record<string, unknown>): number => Number(a.order ?? 0) - Number(b.order ?? 0);
/** ASCII-only fold (as routes.ts folds tags): toLowerCase maps U+212A to "k", so a look-alike repository name would match. */
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The build checked out the forge repository: the user config can name a definition that builds another one. */
function ofRepo(build: Record<string, unknown>, ctx: AdoContext): boolean {
  const repository = isObject(build.repository) ? build.repository : {};
  const name = str(repository.name);
  return repository.type === 'TfsGit' && name !== undefined && fold(name) === fold(ctx.repo.name);
}

/** A PR build's head: the recorded PR source sha (both fields must agree) and branch; undefined = dropped, never guessed. */
function prHead(build: Record<string, unknown>): { headSha: string; headBranch: string } | undefined {
  const { triggerSha, parameterSha } = buildHeadFields(build);
  if (triggerSha !== undefined && parameterSha !== undefined && triggerSha !== parameterSha) return undefined;
  const headSha = triggerSha ?? parameterSha;
  if (!headSha || !HEX40.test(headSha)) return undefined;
  const trigger = isObject(build.triggerInfo) ? build.triggerInfo : {};
  const number = str(trigger['pr.number']);
  // Unverified live: pr.sourceBranch; else the PR number, so two PRs never share a head branch.
  const headBranch = branchName(str(trigger['pr.sourceBranch'])) ?? (number && BUILD_ID.test(number) ? `pr-${number}` : undefined);
  return headBranch ? { headSha, headBranch } : undefined;
}

function toRun(build: unknown, ctx: AdoContext, event: 'push' | 'pull_request', branch: string | undefined): HealRun[] {
  if (!isObject(build) || !Number.isSafeInteger(build.id) || (build.id as number) < 1 || !ofRepo(build, ctx)) return [];
  const reason = str(build.reason) ?? '';
  let head: { headSha: string; headBranch: string } | undefined;
  if (event === 'push') {
    const sha = str(build.sourceVersion) ?? '';
    // The server's branchName filter is not trusted alone: a build of another branch, or of a tag, is dropped.
    const headBranch = branchName(str(build.sourceBranch));
    head = PUSH_REASONS.has(reason) && HEX40.test(sha) && headBranch !== undefined && (branch === undefined || headBranch === branch)
      ? { headSha: sha, headBranch }
      : undefined;
  } else {
    head = reason === 'pullRequest' ? prHead(build) : undefined;
  }
  if (!head) return [];
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

function buildId(runId: string): string {
  if (!BUILD_ID.test(runId)) throw new Error(`build id ${JSON.stringify(runId)} is not a number`);
  return runId;
}

export function adoCi(ctx: AdoContext, pipeline: { definitionId: number }): ForgeCi {
  const definitions = String(pipeline.definitionId);

  return {
    listRuns(o) {
      const query: Record<string, string> = o.event === 'push'
        ? { definitions, ...(o.branch ? { branchName: `refs/heads/${o.branch}` } : {}), statusFilter: 'completed', queryOrder: 'finishTimeDescending', $top: String(o.limit) }
        : { definitions, reasonFilter: 'pullRequest', statusFilter: 'completed', queryOrder: 'finishTimeDescending', $top: String(o.limit) };
      const json = adoJson(adoCall(ctx, 'build.builds.GET', projectParams(ctx), query), `builds of pipeline ${definitions}`);
      // Newest first, whatever order the service returned.
      return listValue(json).flatMap((b) => toRun(b, ctx, o.event, o.branch)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    runJobs(runId): HealJob[] {
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
      if (!m) throw new Error(`job id ${JSON.stringify(jobId)} is not <buildId>:<timeline record id>`);
      const records = buildTimeline(ctx, m[1]);
      const job = records.find((r) => sameId(r.id, m[2]));
      if (!job) throw new Error(`build ${m[1]} has no timeline record ${m[2]}`);
      const logId = (r: Record<string, unknown>): unknown => (isObject(r.log) ? r.log.id : undefined);
      // Unverified live which record carries the full log: the job's own, else its failed tasks' logs in order.
      const ids = (typeof logId(job) === 'number'
        ? [logId(job)]
        : records.filter((r) => sameId(r.parentId, job.id) && r.type === 'Task' && r.result === 'failed').sort(byOrder).map(logId)
      ).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id));
      if (ids.length === 0) throw new Error(`build ${m[1]} record ${m[2]} has no log`);
      // In order, and no further log once the text reaches capLog's size cap.
      const logs: string[] = [];
      let length = 0;
      for (const id of ids) {
        if (length >= MAX_LOG_CHARS) break;
        const log = readBuildLog(ctx, m[1], id);
        logs.push(log);
        length += log.length + 1;
      }
      return capLog(logs.join('\n'));
    },

    rerunIntent: (runId) => `Rerun failed jobs on ${adoBuildUrl(ctx.repo, runId)}`,
  };
}
