/**
 * copilot_run_* MCP tools: hand a task to GitHub Copilot as a background job.
 *
 * - `copilot_run_start` starts a headless Copilot SDK session on the prompt
 *   and returns the job id at once (needs OMG_COPILOT_RUN_ALLOW=1 in the MCP
 *   server env);
 * - `copilot_run_status` / `copilot_run_wait` report status, the final
 *   assistant text, session id, spend and, for isolation `worktree`, the
 *   worktree path, branch and `git diff --stat` to review and merge;
 * - `copilot_run_cancel` aborts the session;
 * - `copilot_run_cleanup` removes a finished job's worktree and branch only
 *   when no uncommitted or unmerged work is in them (ignored files go too).
 *
 * The tools are always listed; only start is gated (like host_smoke's live
 * tiers). The job library is loaded lazily so listing tools never pays its
 * import cost. See src/copilot-run/job.ts for the safety design.
 */
import { z } from 'zod';
import type { CopilotRunManager } from '../copilot-run/job.js';
import type { ToolDefinition } from './types.js';
/** Server shutdown: stop the live jobs (bounded); a no-op when no tool was ever called. */
export declare function stopCopilotRunJobs(): Promise<void>;
/** Test seam: replace the job manager (null restores the lazy default). */
export declare function setCopilotRunManagerForTests(next: CopilotRunManager | null): void;
declare const jobIdSchema: z.ZodString;
declare const startSchema: {
    prompt: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    maxCredits: z.ZodOptional<z.ZodNumber>;
    isolation: z.ZodOptional<z.ZodEnum<["worktree", "none"]>>;
    startRef: z.ZodOptional<z.ZodString>;
    profile: z.ZodOptional<z.ZodEnum<["write", "review"]>>;
};
declare const waitSchema: {
    jobId: z.ZodString;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
};
export declare const copilotRunStartTool: ToolDefinition<typeof startSchema>;
export declare const copilotRunStatusTool: ToolDefinition<{
    jobId: typeof jobIdSchema;
}>;
export declare const copilotRunWaitTool: ToolDefinition<typeof waitSchema>;
export declare const copilotRunCancelTool: ToolDefinition<{
    jobId: typeof jobIdSchema;
}>;
export declare const copilotRunCleanupTool: ToolDefinition<{
    jobId: typeof jobIdSchema;
}>;
export declare const copilotRunTools: (ToolDefinition<{
    prompt: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    maxCredits: z.ZodOptional<z.ZodNumber>;
    isolation: z.ZodOptional<z.ZodEnum<["worktree", "none"]>>;
    startRef: z.ZodOptional<z.ZodString>;
    profile: z.ZodOptional<z.ZodEnum<["write", "review"]>>;
}> | ToolDefinition<{
    jobId: typeof jobIdSchema;
}> | ToolDefinition<{
    jobId: z.ZodString;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}>)[];
export {};
//# sourceMappingURL=copilot-run-tools.d.ts.map