/**
 * ForgeChecks on Azure Pipelines and branch policies (factory forges design
 * §6 "Gate mapping"; critic amendments §A.2, §A.3).
 *
 * Exact head. ADO PR builds run on the merge commit `refs/pull/N/merge`, so
 * a build counts for head H only when its recorded PR source sha is H
 * (`triggerInfo["pr.sourceSha"]` or the `system.pullRequest.sourceCommitId`
 * parameter) AND it built the PR's current merge commit
 * (`sourceVersion === lastMergeCommit.commitId`). No head field at all is
 * pending, never green. A status-policy check counts only for the PR
 * iteration whose sourceRefCommit is H. Expired or not-current evaluations
 * are pending, and while the PR's lastMergeSourceCommit is not H (the forge
 * lags a push by seconds) every check is pending.
 */

import type { ForgeCheck, ForgeChecks, ForgeRepo, ForgeRun } from '../types.js';
import { adoCall, adoJson, isObject, listValue, projectParams, repoParams, str, type AdoContext } from './invoke.js';
import { readAdoPr, type AdoPrView } from './reviews.js';

export const BUILD_POLICY_TYPE = '0609b952-1397-4640-95ec-e00a01b2c241';
export const STATUS_POLICY_TYPE = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';

/**
 * ADO 5xx, TF400898 (internal error), VS800075 (project service unavailable) and TF400733 (rate limited: retried, ADO parity design §2.3).
 * A transient error does not say whether the request took effect: no engine
 * path may retry a non-idempotent write (a POST of a thread, a comment or a
 * pull request) on `transientError`; only reads and idempotent writes retry.
 */
export const ADO_TRANSIENT_ERROR = /HTTP 5\d\d|\b50[0234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error|TF400898|VS800075|TF400733/i;
/**
 * A request blocked by the 200 TSTU / 5 min limit: `omg factory poll` doubles its interval (az prints no Retry-After header).
 * Anchored, so an id in the error text (`PR 429`, `pull request 429`) is no rate limit.
 */
export const ADO_RATE_LIMITED = /TF400733|HTTP 429\b|\bstatus 429\b|Too Many Requests/i;

export type BuildHeadVerdict = 'counts' | 'pending' | 'foreign';

/** The PR source sha a build records, from either field; undefined values when absent. */
export function buildHeadFields(build: Record<string, unknown>): { triggerSha?: string; parameterSha?: string } {
  const trigger = isObject(build.triggerInfo) ? str(build.triggerInfo['pr.sourceSha']) : undefined;
  let parameterSha: string | undefined;
  // `parameters` is a JSON string in the REST shape.
  if (typeof build.parameters === 'string') {
    try {
      const p = JSON.parse(build.parameters) as unknown;
      parameterSha = isObject(p) ? str(p['system.pullRequest.sourceCommitId']) : undefined;
    } catch {
      parameterSha = undefined;
    }
  } else if (isObject(build.parameters)) {
    parameterSha = str(build.parameters['system.pullRequest.sourceCommitId']);
  }
  return { triggerSha: trigger || undefined, parameterSha: parameterSha || undefined };
}

/**
 * Whether `build` counts for head `head` of a PR whose merge commit is
 * `mergeCommit` (critic amendments §A.3). A head field naming another sha
 * is foreign even when the other field matches (fail closed).
 */
export function buildHeadVerdict(build: Record<string, unknown>, head: string, mergeCommit: string | undefined): BuildHeadVerdict {
  const { triggerSha, parameterSha } = buildHeadFields(build);
  if (triggerSha === undefined && parameterSha === undefined) return 'pending';
  if ((triggerSha !== undefined && triggerSha !== head) || (parameterSha !== undefined && parameterSha !== head)) return 'foreign';
  if (mergeCommit === undefined || build.sourceVersion !== mergeCommit) return 'pending';
  return 'counts';
}

export const RUN_STATUS: Readonly<Record<string, string>> = { notStarted: 'queued', postponed: 'queued', inProgress: 'in_progress', cancelling: 'in_progress', completed: 'completed' };
const RUN_CONCLUSION: Readonly<Record<string, string>> = { succeeded: 'success', partiallySucceeded: 'failure', failed: 'failure', canceled: 'cancelled' };

/** A finished build's conclusion; an unknown result fails closed. */
export const conclusion = (result: string | undefined): { conclusion?: string } =>
  !result || result === 'none' ? {} : { conclusion: RUN_CONCLUSION[result] ?? 'failure' };

const EVALUATION_STATE: Readonly<Record<string, string>> = { approved: 'SUCCESS', notApplicable: 'SKIPPED', queued: 'QUEUED', running: 'IN_PROGRESS' };
const STATUS_STATE: Readonly<Record<string, string>> = { succeeded: 'SUCCESS', notApplicable: 'SKIPPED', pending: 'PENDING', notSet: 'PENDING', failed: 'FAILURE', error: 'FAILURE' };

interface Evaluation {
  evaluationId: string;
  status: string;
  isBlocking: boolean;
  typeId: string;
  typeName: string;
  configId: string;
  settings: Record<string, unknown>;
  buildId?: number;
  expired: boolean;
}

function parseEvaluation(e: unknown): Evaluation | undefined {
  if (!isObject(e) || !isObject(e.configuration)) return undefined;
  const c = e.configuration;
  const type = isObject(c.type) ? c.type : {};
  const context = isObject(e.context) ? e.context : {};
  const buildId = context.buildId;
  return {
    evaluationId: str(e.evaluationId) ?? '',
    status: str(e.status) ?? '',
    isBlocking: c.isBlocking === true,
    typeId: (str(type.id) ?? '').toLowerCase(),
    typeName: str(type.displayName) ?? '',
    configId: String(c.id ?? ''),
    settings: isObject(c.settings) ? c.settings : {},
    buildId: typeof buildId === 'number' && Number.isSafeInteger(buildId) ? buildId : undefined,
    expired: context.isExpired === true || context.buildIsNotCurrent === true,
  };
}

export const isBuildPolicy = (e: Pick<Evaluation, 'typeId' | 'typeName'>): boolean => e.typeId === BUILD_POLICY_TYPE || e.typeName === 'Build';
export const isStatusPolicy = (e: Pick<Evaluation, 'typeId' | 'typeName'>): boolean => e.typeId === STATUS_POLICY_TYPE || e.typeName === 'Status';

export function policyName(e: Evaluation): string {
  return str(e.settings.displayName) || str(e.settings.defaultDisplayName) || e.typeName || `policy ${e.configId}`;
}

/** Every policy evaluation of the PR (policy/evaluations by the PR's artifact id). */
export function listEvaluations(ctx: AdoContext, pr: AdoPrView): Evaluation[] {
  if (!pr.projectId) throw new Error(`pull request ${pr.id}: no project id in the response`);
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${pr.projectId}/${pr.id}`;
  const json = adoJson(adoCall(ctx, 'policy.evaluations.GET', projectParams(ctx), { artifactId }), `policy evaluations of pull request ${pr.id}`);
  return listValue(json).map(parseEvaluation).filter((e): e is Evaluation => e !== undefined);
}

/** The id of the newest PR iteration whose sourceRefCommit is `head`. */
function iterationFor(ctx: AdoContext, pr: number, head: string): number | undefined {
  const json = adoJson(adoCall(ctx, 'git.pullRequestIterations.GET', { ...repoParams(ctx), pullRequestId: String(pr) }), `iterations of pull request ${pr}`);
  const ids = listValue(json)
    .filter((i): i is Record<string, unknown> => isObject(i) && isObject(i.sourceRefCommit) && i.sourceRefCommit.commitId === head)
    .map((i) => i.id)
    .filter((n): n is number => Number.isSafeInteger(n));
  return ids.length ? Math.max(...ids) : undefined;
}

interface PrStatus { id: number; state: string; genre: string; name: string; iterationId?: number }

function listStatuses(ctx: AdoContext, pr: number): PrStatus[] {
  const json = adoJson(adoCall(ctx, 'git.pullRequestStatuses.GET', { ...repoParams(ctx), pullRequestId: String(pr) }), `statuses of pull request ${pr}`);
  return listValue(json).filter(isObject).map((s) => {
    const context = isObject(s.context) ? s.context : {};
    return { id: Number(s.id) || 0, state: str(s.state) ?? '', genre: str(context.genre) ?? '', name: str(context.name) ?? '', iterationId: typeof s.iterationId === 'number' ? s.iterationId : undefined };
  });
}

/** A status policy's state for head H: the newest matching status on H's iteration, agreeing with the evaluation. */
function statusPolicyState(e: Evaluation, statuses: PrStatus[], iteration: number | undefined): string {
  if (e.expired || iteration === undefined) return 'PENDING';
  const genre = str(e.settings.statusGenre) ?? '', name = str(e.settings.statusName) ?? '';
  const mine = statuses.filter((s) => s.iterationId === iteration && s.name === name && s.genre === genre).sort((a, b) => b.id - a.id)[0];
  if (!mine) return 'PENDING';
  const state = STATUS_STATE[mine.state] ?? 'FAILURE';
  // The evaluation lags the status: green only when both are green.
  return state === 'SUCCESS' && e.status !== 'approved' ? 'PENDING' : state;
}

function buildPolicyState(e: Evaluation, counted: ReadonlySet<number>): string {
  if (e.expired) return 'PENDING';
  if (e.status === 'notApplicable') return 'SKIPPED';
  // A build that does not count for the head says nothing about it, green or red.
  if (e.buildId === undefined || !counted.has(e.buildId)) return e.status === 'queued' ? 'QUEUED' : 'PENDING';
  return EVALUATION_STATE[e.status] ?? 'FAILURE';
}

/**
 * The failed job of build `buildId` as a jobLog id (`<buildId>:<record id>`):
 * the one Job record whose newest attempt (per `identifier`) failed.
 * Undefined when none or more than one failed (one job's known-flaky log must
 * not excuse another job's real failure) or the timeline cannot be read; the
 * check stays a failure either way.
 */
function failedJobId(ctx: AdoContext, buildId: number): string | undefined {
  try {
    const failed = newestJobRecords(buildTimeline(ctx, String(buildId))).filter((r) => r.result === 'failed');
    return failed.length === 1 ? `${buildId}:${str(failed[0].id)}` : undefined;
  } catch {
    return undefined;
  }
}

/** The records of build `buildId`'s timeline; throws when it cannot be read. */
export function buildTimeline(ctx: AdoContext, buildId: string): Record<string, unknown>[] {
  const timeline = adoJson(adoCall(ctx, 'build.timeline.GET', { ...projectParams(ctx), buildId }), `timeline of build ${buildId}`);
  return (isObject(timeline) && Array.isArray(timeline.records) ? timeline.records : []).filter(isObject);
}

/** The Job records of a timeline, only the newest `attempt` per `identifier`. */
export function newestJobRecords(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const newest = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    const id = r.type === 'Job' ? str(r.id) : undefined;
    if (!id) continue;
    const key = str(r.identifier) ?? id;
    const seen = newest.get(key);
    if (!seen || Number(r.attempt ?? 1) > Number(seen.attempt ?? 1)) newest.set(key, r);
  }
  return [...newest.values()];
}

/** One build log's text (its lines joined); throws on a failed read or an unexpected response. */
export function readBuildLog(ctx: AdoContext, buildId: string, logId: number): string {
  const log = adoJson(adoCall(ctx, 'build.logs.GET', { ...projectParams(ctx), buildId, logId: String(logId) }), `log ${logId} of build ${buildId}`);
  const lines = isObject(log) && Array.isArray(log.value) ? log.value.filter((l): l is string => typeof l === 'string') : typeof log === 'string' ? [log] : undefined;
  if (!lines) throw new Error(`log ${logId} of build ${buildId}: unexpected response`);
  return lines.join('\n');
}

/** The build's results page (where a human reruns it). */
export const adoBuildUrl = (repo: ForgeRepo, id: number | string): string =>
  `https://dev.azure.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.project ?? '')}/_build/results?buildId=${id}`;

export function adoChecks(ctx: AdoContext): ForgeChecks {
  const buildUrl = (id: number) => adoBuildUrl(ctx.repo, id);

  function runs(view: AdoPrView, head: string): ForgeRun[] {
    const json = adoJson(
      adoCall(ctx, 'build.builds.GET', projectParams(ctx), { branchName: `refs/pull/${view.id}/merge`, reasonFilter: 'pullRequest', queryOrder: 'queueTimeDescending', $top: '50' }),
      `builds of pull request ${view.id}`,
    );
    return listValue(json)
      .filter((b): b is Record<string, unknown> => isObject(b) && Number.isSafeInteger(b.id) && buildHeadVerdict(b, head, view.lastMergeCommit) === 'counts')
      .map((b) => ({
        databaseId: b.id as number,
        status: RUN_STATUS[str(b.status) ?? ''] ?? 'queued',
        ...conclusion(str(b.result)),
        workflowName: str((b.definition as { name?: unknown } | undefined)?.name),
        headSha: head,
      }));
  }

  return {
    transientError: ADO_TRANSIENT_ERROR,

    runsForHead(pr: number, headSha: string): ForgeRun[] {
      return runs(readAdoPr(ctx, pr), headSha);
    },

    checks(pr: number, headSha: string): ForgeCheck[] {
      const view = readAdoPr(ctx, pr);
      const evaluations = listEvaluations(ctx, view).filter((e) => isBuildPolicy(e) || isStatusPolicy(e));
      if (evaluations.length === 0) return [];
      const lagging = view.lastMergeSourceCommit !== headSha;
      const counted = new Map(lagging ? [] : runs(view, headSha).map((r) => [r.databaseId, r]));
      const countedIds = new Set(counted.keys());
      const iteration = lagging || !evaluations.some(isStatusPolicy) ? undefined : iterationFor(ctx, pr, headSha);
      const statuses = iteration === undefined ? [] : listStatuses(ctx, pr);
      const seen = new Map<string, number>();
      return evaluations.map((e) => {
        const base = policyName(e);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const state = lagging ? 'PENDING' : isBuildPolicy(e) ? buildPolicyState(e, countedIds) : statusPolicyState(e, statuses, iteration);
        const run = e.buildId !== undefined ? counted.get(e.buildId) : undefined;
        // The failed job's log feeds the failing test titles and the known-flaky analysis; advisory checks read none.
        const jobId = state === 'FAILURE' && e.isBlocking && e.buildId !== undefined && isBuildPolicy(e) ? failedJobId(ctx, e.buildId) : undefined;
        return {
          name: n === 1 ? base : `${base} (policy ${e.configId})`,
          state,
          ...(e.buildId !== undefined ? { runId: String(e.buildId), link: buildUrl(e.buildId) } : {}),
          ...(jobId ? { jobId } : {}),
          ...(run?.workflowName ? { workflow: run.workflowName } : {}),
          event: 'pull_request',
          ...(e.isBlocking ? {} : { advisory: true }),
        };
      });
    },

    jobLog(jobId: string) {
      const m = /^([1-9]\d{0,9}):([0-9a-f-]{36})$/i.exec(jobId);
      if (!m) return { ok: false, text: `job id ${JSON.stringify(jobId)} is not <buildId>:<timeline record id>` };
      try {
        const buildId = m[1];
        const record = buildTimeline(ctx, buildId).find((r) => str(r.id)?.toLowerCase() === m[2].toLowerCase());
        const logId = isObject(record) && isObject(record.log) ? record.log.id : undefined;
        if (typeof logId !== 'number') return { ok: false, text: `build ${buildId} record ${m[2]} has no log` };
        return { ok: true, text: readBuildLog(ctx, buildId, logId) };
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
    },

    rerun(pr: number, runId: string) {
      try {
        const buildId = Number(runId);
        const evaluation = listEvaluations(ctx, readAdoPr(ctx, pr)).find((e) => e.buildId !== undefined && e.buildId === buildId && isBuildPolicy(e));
        if (!evaluation || !evaluation.evaluationId) return { ok: false, stderr: `no build policy evaluation of pull request ${pr} ran build ${runId}` };
        const call = adoCall(ctx, 'policy.evaluations.PATCH', { ...projectParams(ctx), evaluationId: evaluation.evaluationId });
        return { ok: call.ok, stderr: call.ok ? '' : call.stderr || `az exited ${call.status}` };
      } catch (error) {
        return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
