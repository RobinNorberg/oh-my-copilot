export interface TaskUsageRecord {
    taskId: string;
    workerName: string;
    provider: 'codex' | 'gemini';
    model: string;
    startedAt: string;
    completedAt: string;
    wallClockMs: number;
    promptChars: number;
    responseChars: number;
}
export interface WorkerUsageSummary {
    workerName: string;
    provider: 'codex' | 'gemini';
    model: string;
    taskCount: number;
    totalWallClockMs: number;
    totalPromptChars: number;
    totalResponseChars: number;
}
export interface TeamUsageReport {
    teamName: string;
    totalWallClockMs: number;
    taskCount: number;
    workers: WorkerUsageSummary[];
}
/**
 * Record usage for a completed task.
 */
export declare function recordTaskUsage(workingDirectory: string, teamName: string, record: TaskUsageRecord): void;
/**
 * Compute Unicode code point counts from UTF-8 prompt and output files.
 * Combining marks count separately; these are not grapheme or token counts.
 * Returns { promptChars, responseChars }. Returns 0 for missing/unreadable files.
 */
export declare function measureCharCounts(promptFilePath: string, outputFilePath: string): {
    promptChars: number;
    responseChars: number;
};
/**
 * Generate usage report for a team session.
 * Aggregates TaskUsageRecords from the JSONL log.
 */
export declare function generateUsageReport(workingDirectory: string, teamName: string): TeamUsageReport;
//# sourceMappingURL=usage-tracker.d.ts.map