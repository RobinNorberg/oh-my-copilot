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
import { TOOL_CATEGORIES } from '../constants/names.js';
import { COPILOT_RUN_ALLOW_ENV } from '../copilot-run/names.js';
const DEFAULT_WAIT_MS = 300_000;
const MAX_WAIT_MS = 3_600_000;
let manager = null;
async function getManager() {
    if (!manager) {
        const { CopilotRunManager: Manager, defaultCopilotRunDeps } = await import('../copilot-run/job.js');
        manager = new Manager(defaultCopilotRunDeps());
    }
    return manager;
}
/** Server shutdown: stop the live jobs (bounded); a no-op when no tool was ever called. */
export async function stopCopilotRunJobs() {
    await manager?.stopAll();
}
/** Test seam: replace the job manager (null restores the lazy default). */
export function setCopilotRunManagerForTests(next) {
    manager = next;
}
function jsonResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(text) {
    return { content: [{ type: 'text', text }], isError: true };
}
async function guarded(name, fn) {
    try {
        return jsonResult(await fn(await getManager()));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message.startsWith(name) ? message : `${name}: ${message}`);
    }
}
const jobIdSchema = z.string().describe('Job id returned by copilot_run_start (cr-<12 hex>).');
const startSchema = {
    prompt: z.string().min(1).describe('The task for Copilot, sent as the first and only prompt of a new session.'),
    cwd: z
        .string()
        .optional()
        .describe('Existing directory to work in (default: the MCP server cwd). Must be inside a git repository for isolation "worktree".'),
    model: z.string().optional().describe('Copilot model id (default: the CLI picks).'),
    timeoutMs: z
        .number()
        .int()
        .min(10_000)
        .max(3_600_000)
        .optional()
        .describe('Job timeout in ms from start (default 900000 = 15 min, max 3600000); the turn is aborted when it passes.'),
    maxCredits: z
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe('AI credit cap: the turn is aborted once the session passes it (default 30; the runtime gets --max-ai-credits max(30, cap)).'),
    isolation: z
        .enum(['worktree', 'none'])
        .optional()
        .describe('"worktree" (default): a new git worktree and branch under .omg/team/copilot-run/worktrees/<jobId>, created from HEAD. "none": Copilot edits cwd directly.'),
};
const waitSchema = {
    jobId: jobIdSchema,
    timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_MS)
        .optional()
        .describe(`How long to wait in ms (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}); returns the current status when it passes.`),
};
export const copilotRunStartTool = {
    name: 'copilot_run_start',
    description: 'Delegate a task to GitHub Copilot: start a headless Copilot SDK session on the prompt as a background job and return its jobId at once. '
        + 'By default Copilot works in a new git worktree and branch (isolation "worktree"), never in your working tree. '
        + `Live and billed (AI Credits); needs ${COPILOT_RUN_ALLOW_ENV}=1 in the MCP server env. `
        + 'Follow with copilot_run_wait or copilot_run_status.',
    category: TOOL_CATEGORIES.COPILOT_RUN,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: startSchema,
    handler: (args) => guarded('copilot_run_start', (m) => m.start(args)),
};
export const copilotRunStatusTool = {
    name: 'copilot_run_status',
    description: 'Status of a copilot_run job without waiting: status, final assistant text, session id, AI credits (and legacy premium requests) spent, '
        + 'and for isolation "worktree" the worktree path, branch and git diff --stat once it has ended.',
    category: TOOL_CATEGORIES.COPILOT_RUN,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: { jobId: jobIdSchema },
    handler: (args) => guarded('copilot_run_status', (m) => m.status(args.jobId)),
};
export const copilotRunWaitTool = {
    name: 'copilot_run_wait',
    description: 'Wait until a copilot_run job ends (completed, failed, timeout, cancelled) or timeoutMs passes, then return the same report as copilot_run_status.',
    category: TOOL_CATEGORIES.COPILOT_RUN,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: waitSchema,
    handler: (args) => guarded('copilot_run_wait', (m) => m.wait(args.jobId, args.timeoutMs ?? DEFAULT_WAIT_MS)),
};
export const copilotRunCancelTool = {
    name: 'copilot_run_cancel',
    description: 'Cancel a running copilot_run job: abort the Copilot turn and stop its session. The worktree and its changes are kept.',
    category: TOOL_CATEGORIES.COPILOT_RUN,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: { jobId: jobIdSchema },
    handler: (args) => guarded('copilot_run_cancel', (m) => m.cancel(args.jobId)),
};
export const copilotRunCleanupTool = {
    name: 'copilot_run_cleanup',
    description: 'Remove a finished copilot_run job\'s worktree and branch. Refused while the worktree has uncommitted changes or commits your HEAD does not contain: '
        + 'merge or discard them first. Ignored files in the worktree (build output such as dist/, .env, node_modules) are deleted with it; '
        + 'symlinks and junctions are unlinked first, so their targets are kept.',
    category: TOOL_CATEGORIES.COPILOT_RUN,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    schema: { jobId: jobIdSchema },
    handler: (args) => guarded('copilot_run_cleanup', (m) => m.cleanup(args.jobId)),
};
export const copilotRunTools = [
    copilotRunStartTool,
    copilotRunStatusTool,
    copilotRunWaitTool,
    copilotRunCancelTool,
    copilotRunCleanupTool,
];
//# sourceMappingURL=copilot-run-tools.js.map