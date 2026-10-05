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

import { realpathSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { TOOL_CATEGORIES } from '../constants/names.js';
import type { ToolDefinition } from './types.js';

export const SMOKE_ALLOW_LIVE_ENV = 'OMC_SMOKE_ALLOW_LIVE';
export const SMOKE_ALLOW_ANY_ROOT_ENV = 'OMC_SMOKE_ALLOW_ANY_ROOT';

const hostSmokeSchema = {
  tier: z
    .number()
    .int()
    .min(0)
    .max(1)
    .optional()
    .describe(
      '0 = load check, no model call (default). 1 = tier 0 plus one live session with the prompt on stdin '
      + '(one premium request); requires OMC_SMOKE_ALLOW_LIVE=1 in the MCP server env.',
    ),
  pluginRoot: z
    .string()
    .optional()
    .describe('Plugin root to load with --plugin-dir. Defaults to, and must equal, the running package root unless OMC_SMOKE_ALLOW_ANY_ROOT=1.'),
  model: z.string().optional().describe('Tier 1 only: model id for the live session (default: the CLI auto-picks).'),
  maxCredits: z
    .number()
    .int()
    .min(30)
    .optional()
    .describe('Tier 1 only: --max-ai-credits cap (default and CLI minimum 30).'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Timeout in ms per subprocess at tier 0 (default 60000) / for the session at tier 1 (default 180000); the MCP check is fixed at 10 s.'),
  keepHome: z
    .boolean()
    .optional()
    .describe('Keep the throwaway COPILOT_HOME and project dir for debugging; paths are returned in artifacts.'),
  delegate: z
    .boolean()
    .optional()
    .describe('Tier 1 only: ask for one delegation to oh-my-copilot:architect to exercise subagent.selected.'),
};

function canonical(p: string): string {
  let out = resolve(p);
  try { out = realpathSync.native(out); } catch { /* missing: compare the resolved form */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export const hostSmokeTool: ToolDefinition<typeof hostSmokeSchema> = {
  name: 'host_smoke',
  description:
    'Run the headless Copilot CLI smoke check against a plugin root (same as `omg smoke copilot`). ' +
    'Tier 0 verifies the plugin loads (manifest, hooks, plugin/skill list, MCP tools) without a model call; ' +
    'tier 1 adds one live session (one premium request, needs OMC_SMOKE_ALLOW_LIVE=1). ' +
    'Returns the SmokeReport JSON; isError when any check fails.',
  category: TOOL_CATEGORIES.SMOKE,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  schema: hostSmokeSchema,
  handler: async (args) => {
    try {
      const tier = (args.tier ?? 0) as 0 | 1;
      if (tier === 1 && process.env[SMOKE_ALLOW_LIVE_ENV] !== '1') {
        return errorResult(
          `host_smoke: tier 1 runs a live, billed Copilot session and is disabled for MCP callers. `
          + `Set ${SMOKE_ALLOW_LIVE_ENV}=1 in the MCP server env, or run \`omg smoke copilot --tier 1\` from a shell.`,
        );
      }
      const { runCopilotSmoke, resolvePackageRoot } = await import('../smoke/copilot-smoke.js');
      if (args.pluginRoot !== undefined && process.env[SMOKE_ALLOW_ANY_ROOT_ENV] !== '1') {
        const packageRoot = resolvePackageRoot();
        if (!packageRoot || canonical(args.pluginRoot) !== canonical(packageRoot)) {
          return errorResult(
            `host_smoke: pluginRoot ${JSON.stringify(args.pluginRoot)} is not this server's package root `
            + `(${packageRoot ?? 'unresolved'}). Set ${SMOKE_ALLOW_ANY_ROOT_ENV}=1 to smoke another root.`,
          );
        }
      }
      const opts = {
        tier,
        ...(args.pluginRoot !== undefined ? { pluginRoot: args.pluginRoot } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.maxCredits !== undefined ? { maxCredits: args.maxCredits } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.keepHome !== undefined ? { keepHome: args.keepHome } : {}),
        ...(args.delegate !== undefined ? { delegate: args.delegate } : {}),
      };
      const report = await runCopilotSmoke(opts);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
        ...(report.ok ? {} : { isError: true }),
      };
    } catch (error) {
      return errorResult(`host_smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
