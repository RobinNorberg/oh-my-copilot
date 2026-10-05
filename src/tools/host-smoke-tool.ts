/**
 * host_smoke MCP tool
 *
 * Runs the headless Copilot CLI smoke check (`omg smoke copilot`) against a
 * plugin root and returns the SmokeReport as JSON. Tier 0 makes no model call;
 * tier 1 spends one premium request; tier 2 drives SDK scenarios (about one
 * premium request each) and is free only with `scenarios: []` (static checks).
 *
 * This tool is also reachable from inside Copilot through the plugin's own `t`
 * MCP server, so it is fenced (the `omg smoke copilot` CLI is not):
 * - `pluginRoot` must be the package root this server runs from (compared by
 *   realpath) unless OMC_SMOKE_ALLOW_ANY_ROOT=1;
 * - tier 1 (a live, billed session) and tier 2 with any scenario need
 *   OMC_SMOKE_ALLOW_LIVE=1; tier 2 with `scenarios: []` is free and ungated.
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

/** Tier 2 scenario names (mirrors the CLI's `--scenario`); `all` expands to the four. */
const SCENARIO_NAMES = ['smoke', 'guardrail', 'skill', 'delegate'] as const;
type ScenarioName = (typeof SCENARIO_NAMES)[number];

const hostSmokeSchema = {
  tier: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe(
      '0 = load check, no model call (default). 1 = tier 0 plus one live session with the prompt on stdin '
      + '(one premium request). 2 = tier 0 plus @github/copilot-sdk static checks plus scenarios. '
      + 'Tier 1 and tier 2 with scenarios require OMC_SMOKE_ALLOW_LIVE=1 in the MCP server env.',
    ),
  scenarios: z
    .array(z.enum([...SCENARIO_NAMES, 'all']))
    .optional()
    .describe(
      'Tier 2 only: scenarios to run (smoke, guardrail, skill, delegate, or all). Default smoke+guardrail '
      + '(~2 premium requests, 1 per scenario). [] = SDK static checks only, no model call, no opt-in needed.',
    ),
  pluginRoot: z
    .string()
    .optional()
    .describe('Plugin root to load with --plugin-dir. Defaults to, and must equal, the running package root unless OMC_SMOKE_ALLOW_ANY_ROOT=1.'),
  model: z.string().optional().describe('Tiers 1-2: model id (default: tier 1 lets the CLI auto-pick; tier 2 a cheap listed model, else auto).'),
  maxCredits: z
    .number()
    .int()
    .min(30)
    .optional()
    .describe('Tiers 1-2: AI credit cap (default and CLI minimum 30). Tier 2 also aborts a scenario and skips the rest once the run passes it.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Timeout in ms per subprocess at tier 0 (default 60000), for the session at tier 1 (default 180000), per scenario at tier 2 (default 120000, then abort); the MCP check is fixed at 10 s.'),
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
    'tier 1 adds one live session (one premium request, needs OMC_SMOKE_ALLOW_LIVE=1); ' +
    'tier 2 adds @github/copilot-sdk static checks (free with scenarios: []) and SDK scenarios (need OMC_SMOKE_ALLOW_LIVE=1). ' +
    'Returns the SmokeReport JSON; isError when any check fails.',
  category: TOOL_CATEGORIES.SMOKE,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  schema: hostSmokeSchema,
  handler: async (args) => {
    try {
      const tier = (args.tier ?? 0) as 0 | 1 | 2;
      if (args.scenarios !== undefined && tier !== 2) {
        return errorResult('host_smoke: scenarios apply to tier 2 only.');
      }
      const scenarios: ScenarioName[] | undefined = args.scenarios === undefined
        ? undefined
        : [...new Set(args.scenarios.flatMap((s) => (s === 'all' ? [...SCENARIO_NAMES] : [s])))];
      // Tier 2 without `scenarios` runs the library default (smoke, guardrail): live.
      const live = tier === 1 || (tier === 2 && (scenarios === undefined || scenarios.length > 0));
      if (live && process.env[SMOKE_ALLOW_LIVE_ENV] !== '1') {
        return errorResult(
          `host_smoke: tier ${tier}${tier === 2 ? ' with scenarios' : ''} runs live, billed Copilot sessions and is disabled for MCP callers. `
          + `Set ${SMOKE_ALLOW_LIVE_ENV}=1 in the MCP server env, pass scenarios: [] for the free tier 2 static checks, `
          + `or run \`omg smoke copilot --tier ${tier}\` from a shell.`,
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
        ...(scenarios !== undefined ? { scenarios } : {}),
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
