/**
 * The forge layer (factory forges design §1-§2): one `Forge` per repository
 * host, built from the caller's already-guarded Exec. Adapters never spawn;
 * src/forge/__tests__/no-spawn.test.ts holds that. Normalized shapes reuse
 * the ship ones, so the GitHub adapter returns exactly what the ship parsers
 * return today.
 */
import type { Exec } from '../ship/exec.js';
import type { GhCheck, WorkflowRun } from '../ship/gates.js';
import type { HealJob, HealRun } from '../factory/heal/history.js';
import type { ProviderName } from '../providers/types.js';
export type ForgeKind = 'github' | 'azure-devops';
export interface ForgeRepo {
    kind: ForgeKind;
    /** github.com (or the GitHub host) | dev.azure.com */
    host: string;
    /** GitHub owner | ADO organization */
    owner: string;
    /** ADO only. */
    project?: string;
    name: string;
    /** Canonical repo URL stored as FactoryRunState.repoUrl; remoteRepoMismatch compares origin against it. */
    url: string;
}
export interface ForgeComment {
    body: string;
    author: string;
    /** OWNER/MEMBER/COLLABORATOR on GitHub; `createdBy.uniqueName` in trustedAuthors on ADO. */
    trusted: boolean;
}
export interface ForgeItem {
    id: number;
    url: string;
    title: string;
    /** Markdown or plain text; ADO HTML is converted (src/forge/ado/html.ts). */
    body: string;
    /** ADO Microsoft.VSTS.Common.AcceptanceCriteria converted to text; undefined on GitHub. */
    acceptance?: string;
    /** GitHub state OPEN | ADO state category not Completed/Removed. */
    open: boolean;
    rawState: string;
    /** issueAuthorTrusted on GitHub; createdBy.uniqueName in trustedAuthors on ADO. */
    authorTrusted: boolean;
    comments: ForgeComment[];
    /** GitHub labels | ADO tags. */
    labels: string[];
    /** ADO work item type. */
    type?: string;
    /** ADO System.BoardColumn. */
    column?: string;
    priority?: number;
    /** ADO StoryPoints/Effort; GitHub `size:*` label. */
    size?: number;
    /** GitHub "Depends on #n"/"Blocked by #n" lines | ADO Dependency-Reverse links. */
    dependsOn: number[];
    /** ADO Hierarchy-Forward; GitHub task-list "- [ ] #n". */
    children: number[];
    /** Repository the factory branch and PR live in. */
    repoUrl: string;
}
/** The fields the engine and merge policy read (today's MergeView plus url/headRefName). */
export interface ForgePr {
    number: number;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    isDraft: boolean;
    baseRefName: string;
    /** GitHub baseRefOid | ADO lastMergeTargetCommit.commitId */
    baseRefOid: string;
    headRefName: string;
    /** GitHub headRefOid | ADO lastMergeSourceCommit.commitId */
    headRefOid: string;
    url: string;
}
/** A check in GitHub's vocabulary (state SUCCESS/SKIPPED/FAILURE/PENDING/…). ADO maps policy evaluations into it. */
export interface ForgeCheck extends GhCheck {
    /** GitHub: from link (actionsIds) | ADO: buildId */
    runId?: string;
    /** GitHub: job id | ADO: `${buildId}:${timelineRecordId}` */
    jobId?: string;
    /** Set only by adapters (ADO non-blocking policy); GitHub never sets it, so classifyCheck is unchanged for GitHub. */
    advisory?: boolean;
}
/** ADO: { databaseId: buildId, status, conclusion: result, workflowName: definition.name, headSha: the exact-head field }. */
export type ForgeRun = WorkflowRun;
/** GitHub Projects v2 (`project-column`) intake is cut for now (critic amendments §A.11). */
export type IntakeSource = {
    type: 'label';
    label: string;
} | {
    type: 'milestone';
    milestone: string;
} | {
    type: 'wiql-query';
    queryId: string;
} | {
    type: 'board-column';
    team: string;
    board: string;
    column: string;
} | {
    type: 'area-tag';
    areaPath: string;
    tag: string;
};
export declare const PROGRESS_STAGES: readonly ["queued", "building", "reviewing", "verifying", "ready-to-merge", "done", "blocked", "cancelled"];
export type ProgressStage = (typeof PROGRESS_STAGES)[number];
/** One stage's tracker write: a GitHub label, or an ADO board column and/or state. */
export interface ProgressMapping {
    label?: string;
    column?: string;
    state?: string;
}
export interface ForgeTracker {
    /** Throws FactoryStepError-compatible messages. */
    viewItem(id: number): ForgeItem;
    /** Ids only; viewItem per id. */
    queryItems(source: IntakeSource, limit: number): number[];
    /** Post a comment from a file the engine wrote; false + warn text on failure; never throws. */
    comment(id: number, bodyFile: string): {
        ok: boolean;
        stderr: string;
    };
    /** Apply one stage's mapping (labels / state / column); idempotent; never throws. */
    setProgress(id: number, stage: ProgressStage, mapping: ProgressMapping): {
        ok: boolean;
        detail: string;
    };
    /** `omg factory check --mark` only, after confirmation. */
    addMarker(id: number, marker: string): {
        ok: boolean;
        stderr: string;
    };
}
export interface ForgeReviews {
    findOpenPrForBranch(branch: string): number | undefined;
    createDraftPr(o: {
        base: string;
        head: string;
        title: string;
        bodyFile: string;
        itemId?: number;
    }): number;
    /** Throws on missing/malformed (parseMergeView semantics). */
    viewPr(pr: number): ForgePr;
    /** readPrHead semantics. */
    prHead(pr: number): {
        headRefOid: string;
        state: string;
    };
    markReady(pr: number): void;
    commentPr(pr: number, bodyFile: string): {
        ok: boolean;
        stderr: string;
    };
}
export interface ForgeChecks {
    /** fetchChecks semantics ("no checks reported" = []). */
    checks(pr: number): ForgeCheck[];
    /**
     * fetchWorkflowRuns semantics: only runs for exactly `headSha` (foreign head
     * dropped). ADO lists the builds of `refs/pull/{pr}/merge` and keeps those
     * whose recorded PR source sha is `headSha` (critic amendments §A.2/§A.3).
     */
    runsForHead(pr: number, headSha: string): ForgeRun[];
    jobLog(jobId: string): {
        ok: boolean;
        text: string;
    };
    /** GitHub `run rerun --failed` | ADO policy evaluation requeue. */
    rerun(runId: string): {
        ok: boolean;
        stderr: string;
    };
    /** TRANSIENT_GH_ERROR for GitHub; ADO 5xx/TF400898/VS800075. */
    readonly transientError: RegExp;
}
export interface ForgeMerge {
    /** The command a HUMAN runs; the factory guard refuses it, ship merge alone may run the GitHub one. */
    humanMergeCommand(pr: number, headSha: string): string[];
    /** ADO branch-policy decision inputs beyond gates (reviewers, comments, work-item link); GitHub returns []. */
    blockingPolicies(pr: number, headSha: string): string[];
}
/** Heal (CI history); GitHub only for now: ADO has capabilities.heal = false. */
export interface ForgeCi {
    listRuns(o: {
        workflow: string;
        event: 'push' | 'pull_request';
        branch?: string;
        limit: number;
    }): HealRun[];
    runJobs(runId: string): HealJob[];
    jobLog(jobId: string): string;
}
export interface ForgeCapabilities {
    heal: boolean;
    projectsV2: boolean;
    boardColumns: boolean;
    webhookIntake: boolean;
}
export interface Forge {
    readonly kind: ForgeKind;
    readonly provider: ProviderName;
    readonly repo: ForgeRepo;
    readonly tracker: ForgeTracker;
    readonly reviews: ForgeReviews;
    readonly checks: ForgeChecks;
    readonly merge: ForgeMerge;
    readonly ci?: ForgeCi;
    readonly capabilities: ForgeCapabilities;
}
export interface AzureDevOpsForgeConfig {
    org: string;
    project: string;
    repo: string;
    /** Default: project. */
    workItemProject: string;
    /** Board-column intake and progress columns. */
    team?: string;
    /** Pinned; the resolver refuses anything else. Per-route versions live in src/forge/ado/routes.ts. */
    apiVersion: '7.1';
    /** User config (default location) only; matched against createdBy.uniqueName, lowercased. */
    trustedAuthors: string[];
}
export interface ForgeIntakeConfig {
    source?: IntakeSource;
    /** ADO only. */
    itemTypes: string[];
    /** 1..200 */
    limit: number;
    /** Label (GitHub) / tag (ADO) that `check --mark` adds. */
    marker: string;
}
export interface ForgeCheckConfig {
    maxAcceptanceItems: number;
    maxSize: number;
    maxBodyChars: number;
}
export interface ForgeProgressConfig {
    enabled: boolean;
    stages: Partial<Record<ProgressStage, ProgressMapping>>;
}
/** `factory.*` forge settings after trust layering (src/forge/config.ts resolveForgeConfig). */
export interface ResolvedForgeConfig {
    kind: ForgeKind;
    repo: ForgeRepo;
    /** Set when kind is azure-devops. */
    azureDevOps?: AzureDevOpsForgeConfig;
    intake: ForgeIntakeConfig;
    check: ForgeCheckConfig;
    progress: ForgeProgressConfig;
}
/** Adapters are built from the caller's (guarded) Exec; they never spawn. */
export type ForgeFactory = (exec: Exec, cwd: string, config: ResolvedForgeConfig) => Forge;
//# sourceMappingURL=types.d.ts.map