export interface OmcTeamJob {
    status: 'running' | 'completed' | 'failed' | 'timeout';
    result?: string;
    stderr?: string;
    startedAt: number;
    pid?: number;
    paneIds?: string[];
    leaderPaneId?: string;
    teamName?: string;
    cwd?: string;
    cleanedUpAt?: string;
}
export declare function convergeJobWithResultArtifact(job: OmcTeamJob, jobId: string, omcJobsDir: string): {
    job: OmcTeamJob;
    changed: boolean;
};
export declare function isJobTerminal(job: OmcTeamJob): boolean;
export declare function isPidAlive(pid: number): boolean;
export declare function clearScopedTeamState(job: Pick<OmcTeamJob, 'cwd' | 'teamName'>): string;
//# sourceMappingURL=team-job-convergence.d.ts.map