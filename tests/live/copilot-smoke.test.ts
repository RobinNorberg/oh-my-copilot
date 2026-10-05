/**
 * Live smoke against a real Copilot CLI binary and the local build.
 *
 * Excluded from the default vitest run (see vitest.config.ts); run with
 * `npm run test:live`. Requires `npm run build` first (mcp.list_tools spawns
 * dist/mcp/standalone-server.js).
 *
 * - Tier 0 (no model call) runs whenever the copilot binary resolves; it skips
 *   itself when the smoke report says the binary is missing.
 * - Tier 1 spends one premium request and runs only with OMC_LIVE_SMOKE=1.
 * - Tier 2 static (SDK introspection, no model call) runs whenever the copilot
 *   binary and the optional peer `@github/copilot-sdk` resolve; it skips itself
 *   otherwise. Tier 2 default scenarios (smoke, guardrail; ~2 premium requests)
 *   run only with OMC_LIVE_SMOKE=2.
 */

import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runCopilotSmoke, type SmokeReport } from '../../src/smoke/copilot-smoke.js';

const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));
const liveTier1 = process.env.OMC_LIVE_SMOKE === '1';
const liveTier2 = process.env.OMC_LIVE_SMOKE === '2';

const SDK_STATIC_IDS = ['sdk.available', 'sdk.runtime', 'sdk.plugins', 'sdk.skills', 'sdk.agents', 'sdk.mcp', 'sdk.tools_excluded'];

function failures(report: SmokeReport): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.id}: ${c.detail}${c.evidence ? `\n  ${c.evidence}` : ''}`)
    .join('\n');
}

describe('copilot smoke (live)', () => {
  it('tier 0: plugin loads in the real Copilot CLI (no model call)', async (ctx) => {
    const report = await runCopilotSmoke({ tier: 0, pluginRoot });
    if (report.skipped) {
      ctx.skip(`copilot binary not resolved: ${report.skipped}`);
      return;
    }
    expect(report.tier).toBe(0);
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'plugin.manifest',
        'plugin.hooks',
        'copilot.binary',
        'copilot.plugin_list',
        'copilot.skill_list',
        'copilot.agents',
        'mcp.list_tools',
      ]),
    );
    expect(report.ok, failures(report)).toBe(true);
  }, 120_000);

  it.runIf(liveTier1)('tier 1: one live session, prompt on stdin (one premium request)', async (ctx) => {
    const report = await runCopilotSmoke({ tier: 1, pluginRoot });
    if (report.skipped) {
      ctx.skip(`copilot binary not resolved: ${report.skipped}`);
      return;
    }
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['session.exit', 'session.events', 'plugins.loaded', 'state.written']),
    );
    expect(report.ok, failures(report)).toBe(true);
  }, 300_000);

  it('tier 2 static: SDK sees plugin, skills, agents and MCP tools (no model call)', async (ctx) => {
    const report = await runCopilotSmoke({ tier: 2, pluginRoot, scenarios: [] });
    if (report.skipped) {
      ctx.skip(`copilot binary or @github/copilot-sdk not resolved: ${report.skipped}`);
      return;
    }
    expect(report.tier).toBe(2);
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(SDK_STATIC_IDS));
    expect(report.checks.some((c) => c.id.startsWith('scn.'))).toBe(false);
    expect(report.ok, failures(report)).toBe(true);
  }, 180_000);

  it.runIf(liveTier2)('tier 2 scenarios: smoke + guardrail through the SDK (~2 premium requests, 1 per scenario)', async (ctx) => {
    const report = await runCopilotSmoke({ tier: 2, pluginRoot });
    if (report.skipped) {
      ctx.skip(`copilot binary or @github/copilot-sdk not resolved: ${report.skipped}`);
      return;
    }
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([...SDK_STATIC_IDS, 'scn.smoke.reply', 'scn.guardrail.denied', 'scn.guardrail.no_push']),
    );
    expect(report.ok, failures(report)).toBe(true);
  }, 600_000);
});
