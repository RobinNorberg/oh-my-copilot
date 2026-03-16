/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Bundled as CJS via esbuild (scripts/build-runtime-cli.mjs).
 */
interface TaskResult {
    taskId: string;
    status: string;
    summary: string;
}
interface CliOutput {
    status: 'completed' | 'failed';
    teamName: string;
    taskResults: TaskResult[];
    duration: number;
    workerCount: number;
}
type TerminalStatus = 'completed' | 'failed' | null;
export declare function getTerminalStatus(taskCounts: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
}, expectedTaskCount: number): TerminalStatus;
export declare function checkWatchdogFailedMarker(stateRoot: string, startTime: number): Promise<{
    failed: boolean;
    reason?: string;
}>;
export declare function writeResultArtifact(output: CliOutput, finishedAt: string, jobId?: string | undefined, omcJobsDir?: string | undefined): Promise<void>;
export {};
//# sourceMappingURL=runtime-cli.d.ts.map