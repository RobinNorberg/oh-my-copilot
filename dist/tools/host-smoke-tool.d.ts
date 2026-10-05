/**
 * host_smoke MCP tool
 *
 * Runs the headless Copilot CLI smoke check (`omg smoke copilot`) against a
 * plugin root and returns the SmokeReport as JSON. Tier 0 makes no model call;
 * tier 1 spends one premium request.
 *
 * This tool is also reachable from inside Copilot through the plugin's own `t`
 * MCP server, so it is fenced (the `omg smoke copilot` CLI is not):
 * - `pluginRoot` must be the package root this server runs from (compared by
 *   realpath) unless OMC_SMOKE_ALLOW_ANY_ROOT=1;
 * - tier 1 (a live, billed session) needs OMC_SMOKE_ALLOW_LIVE=1.
 *
 * The smoke library is loaded lazily so listing tools never pays its import cost.
 */
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
export declare const SMOKE_ALLOW_LIVE_ENV = "OMC_SMOKE_ALLOW_LIVE";
export declare const SMOKE_ALLOW_ANY_ROOT_ENV = "OMC_SMOKE_ALLOW_ANY_ROOT";
declare const hostSmokeSchema: {
    tier: z.ZodOptional<z.ZodNumber>;
    pluginRoot: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    maxCredits: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    keepHome: z.ZodOptional<z.ZodBoolean>;
    delegate: z.ZodOptional<z.ZodBoolean>;
};
export declare const hostSmokeTool: ToolDefinition<typeof hostSmokeSchema>;
export {};
//# sourceMappingURL=host-smoke-tool.d.ts.map