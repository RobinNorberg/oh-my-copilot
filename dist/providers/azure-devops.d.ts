import type { GitProvider, PRInfo, IssueInfo, WorkItem } from './types.js';
export type AdoErrorType = 'auth' | 'not-found' | 'timeout' | 'unknown';
export declare class AdoError extends Error {
    readonly type: AdoErrorType;
    constructor(message: string, type: AdoErrorType);
}
export declare class AzureDevOpsProvider implements GitProvider {
    readonly name: "azure-devops";
    readonly displayName = "Azure DevOps";
    readonly prTerminology: "PR";
    readonly prRefspec: null;
    detectFromRemote(url: string): boolean;
    viewPR(number: number): PRInfo | null;
    viewIssue(number: number): IssueInfo | null;
    checkAuth(): boolean;
    getRequiredCLI(): string | null;
    escapeWiql(value: string): string;
    listWorkItems(options: {
        state?: string;
        tags?: string[];
        project?: string;
        org?: string;
        top?: number;
        skip?: number;
    }): WorkItem[];
    createWorkItem(options: {
        title: string;
        type?: string;
        description?: string;
        tags?: string[];
        assignedTo?: string;
        areaPath?: string;
        iterationPath?: string;
        org?: string;
        project?: string;
    }): WorkItem;
    addTag(workItemId: number, tag: string): void;
    removeTag(workItemId: number, tag: string): void;
    addComment(workItemId: number, comment: string): void;
    listPullRequests(options?: {
        status?: string;
        org?: string;
        project?: string;
    }): PRInfo[];
    createPullRequest(options: {
        title: string;
        sourceBranch: string;
        targetBranch: string;
        description?: string;
        org?: string;
        project?: string;
    }): PRInfo;
    mergePullRequest(id: number, org?: string): void;
    updateWorkItemState(workItemId: number, state: string, org?: string): void;
    linkWorkItemToPR(workItemId: number, prId: number, org?: string, project?: string): void;
    listPRsForReviewer(reviewerEmail: string, options?: {
        status?: string;
        org?: string;
        project?: string;
        repository?: string;
    }): PRInfo[];
    getPRDiff(prId: number, org?: string): string;
    private fetchWorkItemTags;
    private normalizeWorkItem;
}
//# sourceMappingURL=azure-devops.d.ts.map