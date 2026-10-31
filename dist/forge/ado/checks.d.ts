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
import type { ForgeChecks, ForgeRepo } from '../types.js';
import { type AdoContext } from './invoke.js';
import { type AdoPrView } from './reviews.js';
export declare const BUILD_POLICY_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";
export declare const STATUS_POLICY_TYPE = "cbdc66da-9728-4af8-aada-9a5a32e4a226";
/** ADO 5xx, TF400898 (internal error), VS800075 (project service unavailable) and TF400733 (rate limited: retried, ADO parity design §2.3). */
export declare const ADO_TRANSIENT_ERROR: RegExp;
/** A request blocked by the 200 TSTU / 5 min limit: `omg factory poll` doubles its interval (az prints no Retry-After header). */
export declare const ADO_RATE_LIMITED: RegExp;
export type BuildHeadVerdict = 'counts' | 'pending' | 'foreign';
/** The PR source sha a build records, from either field; undefined values when absent. */
export declare function buildHeadFields(build: Record<string, unknown>): {
    triggerSha?: string;
    parameterSha?: string;
};
/**
 * Whether `build` counts for head `head` of a PR whose merge commit is
 * `mergeCommit` (critic amendments §A.3). A head field naming another sha
 * is foreign even when the other field matches (fail closed).
 */
export declare function buildHeadVerdict(build: Record<string, unknown>, head: string, mergeCommit: string | undefined): BuildHeadVerdict;
export declare const RUN_STATUS: Readonly<Record<string, string>>;
/** A finished build's conclusion; an unknown result fails closed. */
export declare const conclusion: (result: string | undefined) => {
    conclusion?: string;
};
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
export declare const isBuildPolicy: (e: Pick<Evaluation, "typeId" | "typeName">) => boolean;
export declare const isStatusPolicy: (e: Pick<Evaluation, "typeId" | "typeName">) => boolean;
export declare function policyName(e: Evaluation): string;
/** Every policy evaluation of the PR (policy/evaluations by the PR's artifact id). */
export declare function listEvaluations(ctx: AdoContext, pr: AdoPrView): Evaluation[];
/** The records of build `buildId`'s timeline; throws when it cannot be read. */
export declare function buildTimeline(ctx: AdoContext, buildId: string): Record<string, unknown>[];
/** The Job records of a timeline, only the newest `attempt` per `identifier`. */
export declare function newestJobRecords(records: readonly Record<string, unknown>[]): Record<string, unknown>[];
/** One build log's text (its lines joined); throws on a failed read or an unexpected response. */
export declare function readBuildLog(ctx: AdoContext, buildId: string, logId: number): string;
/** The build's results page (where a human reruns it). */
export declare const adoBuildUrl: (repo: ForgeRepo, id: number | string) => string;
export declare function adoChecks(ctx: AdoContext): ForgeChecks;
export {};
//# sourceMappingURL=checks.d.ts.map