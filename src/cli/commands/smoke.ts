/**
 * `omg smoke copilot` — load-check the plugin inside the real Copilot CLI.
 * Exit codes: 0 all checks ok; 1 any check failed (or bad options / a crash);
 * 2 skipped because the copilot binary or the optional `@github/copilot-sdk`
 * peer is missing and no other check failed.
 * With --json a SmokeReport is ALWAYS printed, including for option errors and
 * crashes (then `ok:false` with one `cli.error` check).
 */

import { resolve } from 'path';
import { colors } from '../utils/formatting.js';
import {
  ALL_SCENARIOS,
  MIN_MAX_CREDITS,
  runCopilotSmoke,
  type Scenario,
  type SmokeOptions,
  type SmokeReport,
  type SmokeTier,
} from '../../smoke/copilot-smoke.js';
import { SDK_MISSING_DETAIL } from '../../smoke/copilot-sdk-scenarios.js';

export interface SmokeCopilotCliOptions {
  tier?: string;
  pluginRoot?: string;
  model?: string;
  maxCredits?: string;
  timeout?: string;
  keepHome?: boolean;
  delegate?: boolean;
  /** Tier 2: comma-separated scenario names, or `all`. */
  scenario?: string;
  /** Tier 2 with no scenarios: SDK static checks only, zero model calls. */
  sdkStatic?: boolean;
  json?: boolean;
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/** Parse `--scenario a,b` / `all` into a deduplicated, validated list. */
export function parseScenarios(raw: string): Scenario[] {
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('--scenario needs at least one name (or `all`)');
  const out: Scenario[] = [];
  for (const name of names) {
    const expanded: readonly string[] = name === 'all' ? ALL_SCENARIOS : [name];
    for (const n of expanded) {
      if (!(ALL_SCENARIOS as readonly string[]).includes(n)) {
        throw new Error(`--scenario: unknown scenario ${JSON.stringify(n)} (expected ${ALL_SCENARIOS.join(', ')} or all)`);
      }
      if (!out.includes(n as Scenario)) out.push(n as Scenario);
    }
  }
  return out;
}

export function toSmokeOptions(cli: SmokeCopilotCliOptions): Partial<SmokeOptions> {
  const wantsTier2 = cli.sdkStatic === true || cli.scenario !== undefined;
  const tierRaw = cli.tier ?? (wantsTier2 ? '2' : '0');
  if (tierRaw !== '0' && tierRaw !== '1' && tierRaw !== '2') {
    throw new Error(`--tier must be 0, 1 or 2, got ${JSON.stringify(tierRaw)}`);
  }
  const tier = Number(tierRaw) as SmokeTier;
  if (wantsTier2 && tier !== 2) throw new Error('--scenario and --sdk-static need --tier 2');
  if (cli.sdkStatic && cli.scenario !== undefined) throw new Error('--sdk-static runs no scenarios; drop --scenario');
  if (tier === 2 && cli.delegate) throw new Error('--delegate is tier 1 only; at tier 2 use --scenario delegate');
  const maxCredits = parsePositiveInt(cli.maxCredits, '--max-credits');
  if (maxCredits !== undefined && maxCredits < MIN_MAX_CREDITS) {
    throw new Error(`--max-credits must be at least ${MIN_MAX_CREDITS} (Copilot CLI minimum), got ${maxCredits}`);
  }
  // Tier 2 without --scenario/--sdk-static leaves `scenarios` unset: the library default applies.
  const scenarios: Scenario[] | undefined = cli.sdkStatic ? [] : cli.scenario !== undefined ? parseScenarios(cli.scenario) : undefined;
  return {
    tier,
    ...(cli.pluginRoot ? { pluginRoot: cli.pluginRoot } : {}),
    ...(cli.model ? { model: cli.model } : {}),
    ...(maxCredits !== undefined ? { maxCredits } : {}),
    ...(cli.timeout !== undefined ? { timeoutMs: parsePositiveInt(cli.timeout, '--timeout') } : {}),
    keepHome: cli.keepHome ?? false,
    delegate: cli.delegate ?? false,
    ...(scenarios !== undefined ? { scenarios } : {}),
  };
}

/** A failed check that only says "could not run": missing binary, missing SDK peer, or a dependent skip. */
function isSkipFailure(check: SmokeReport['checks'][number]): boolean {
  return check.id === 'copilot.binary' || check.detail === 'skipped' || check.detail === SDK_MISSING_DETAIL;
}

/**
 * 2 only for a pure skip: every failed check is the missing binary/SDK or a
 * dependent "skipped" check. A real failure alongside the skip is 1.
 */
export function smokeExitCode(report: SmokeReport): number {
  if (report.ok) return 0;
  if (!report.skipped) return 1;
  return report.checks.some((c) => !c.ok && !isSkipFailure(c)) ? 1 : 2;
}

/** A report for option errors and crashes, so --json output is always a SmokeReport. */
export function errorReport(cli: SmokeCopilotCliOptions, err: unknown, started: number): SmokeReport {
  const tier: SmokeTier = cli.tier === '1' ? 1 : cli.tier === '2' || (cli.tier === undefined && (cli.sdkStatic || cli.scenario !== undefined)) ? 2 : 0;
  return {
    ok: false,
    tier,
    pluginRoot: cli.pluginRoot ? resolve(cli.pluginRoot) : '',
    pluginVersion: null,
    copilot: { bin: null, version: null },
    checks: [{ id: 'cli.error', ok: false, detail: err instanceof Error ? err.message : String(err) }],
    artifacts: {},
    durationMs: Date.now() - started,
  };
}

/** Output group for a check id at tier 2: `sdk` for SDK static checks, `scenario <name>` for `scn.<name>.*`. */
function checkGroup(id: string): string | null {
  if (id.startsWith('sdk.')) return 'sdk (static, no model call)';
  const scn = /^scn\.([^.]+)\./.exec(id);
  return scn ? `scenario ${scn[1]}` : null;
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push(`omg smoke copilot — tier ${report.tier}, plugin ${report.pluginVersion ?? '?'} at ${report.pluginRoot}`);
  lines.push(`copilot: ${report.copilot.bin ?? 'not found'}${report.copilot.version ? ` (v${report.copilot.version})` : ''}`);
  if (report.sdk) {
    const { version, runtimeVersion, protocolVersion, model } = report.sdk;
    lines.push(`sdk: @github/copilot-sdk ${version ?? '?'} driving runtime ${runtimeVersion ?? '?'} (protocol ${protocolVersion ?? '?'}), model ${model}`);
  }
  let group: string | null = null;
  for (const check of report.checks) {
    const next = checkGroup(check.id);
    if (next !== group) {
      if (next) lines.push(colors.bold(`── ${next}`));
      group = next;
    }
    const mark = check.ok ? colors.green('✓') : colors.red('✗');
    lines.push(`${mark} ${check.id} — ${check.detail}`);
    if (!check.ok && check.evidence) {
      for (const line of check.evidence.split('\n')) lines.push(colors.gray(`    ${line}`));
    }
  }
  if (report.cost) {
    lines.push(`cost: ${report.cost.premiumRequests} premium request(s), ${Number(report.cost.credits.toFixed(3))} credit(s)`);
  }
  for (const [key, value] of Object.entries(report.artifacts)) {
    if (!value) continue;
    if (typeof value === 'object') {
      for (const [name, path] of Object.entries(value)) lines.push(colors.gray(`  ${key}.${name}: ${String(path)}`));
    } else {
      lines.push(colors.gray(`  ${key}: ${String(value)}`));
    }
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  const summary = report.skipped
    ? colors.yellow(`SKIPPED: ${report.skipped}`)
    : report.ok
      ? colors.green(`PASS: ${report.checks.length} checks in ${report.durationMs} ms`)
      : colors.red(`FAIL: ${failed}/${report.checks.length} checks failed in ${report.durationMs} ms`);
  lines.push(summary);
  return lines.join('\n');
}

export async function smokeCopilotCommand(cli: SmokeCopilotCliOptions): Promise<number> {
  const started = Date.now();
  let report: SmokeReport;
  try {
    report = await runCopilotSmoke(toSmokeOptions(cli));
  } catch (err) {
    if (cli.json) {
      console.log(JSON.stringify(errorReport(cli, err, started), null, 2));
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }
  console.log(cli.json ? JSON.stringify(report, null, 2) : formatSmokeReport(report));
  return smokeExitCode(report);
}
