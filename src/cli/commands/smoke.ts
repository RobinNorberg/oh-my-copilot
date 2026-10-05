/**
 * `omg smoke copilot` — load-check the plugin inside the real Copilot CLI.
 * Exit codes: 0 all checks ok; 1 any check failed (or bad options / a crash);
 * 2 skipped because the copilot binary is missing and no static check failed.
 * With --json a SmokeReport is ALWAYS printed, including for option errors and
 * crashes (then `ok:false` with one `cli.error` check).
 */

import { resolve } from 'path';
import { colors } from '../utils/formatting.js';
import {
  MIN_MAX_CREDITS,
  runCopilotSmoke,
  type SmokeOptions,
  type SmokeReport,
} from '../../smoke/copilot-smoke.js';

export interface SmokeCopilotCliOptions {
  tier?: string;
  pluginRoot?: string;
  model?: string;
  maxCredits?: string;
  timeout?: string;
  keepHome?: boolean;
  delegate?: boolean;
  json?: boolean;
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

export function toSmokeOptions(cli: SmokeCopilotCliOptions): Partial<SmokeOptions> {
  const tierRaw = cli.tier ?? '0';
  if (tierRaw !== '0' && tierRaw !== '1') throw new Error(`--tier must be 0 or 1, got ${JSON.stringify(tierRaw)}`);
  const maxCredits = parsePositiveInt(cli.maxCredits, '--max-credits');
  if (maxCredits !== undefined && maxCredits < MIN_MAX_CREDITS) {
    throw new Error(`--max-credits must be at least ${MIN_MAX_CREDITS} (Copilot CLI minimum), got ${maxCredits}`);
  }
  return {
    tier: tierRaw === '1' ? 1 : 0,
    ...(cli.pluginRoot ? { pluginRoot: cli.pluginRoot } : {}),
    ...(cli.model ? { model: cli.model } : {}),
    ...(maxCredits !== undefined ? { maxCredits } : {}),
    ...(cli.timeout !== undefined ? { timeoutMs: parsePositiveInt(cli.timeout, '--timeout') } : {}),
    keepHome: cli.keepHome ?? false,
    delegate: cli.delegate ?? false,
  };
}

/**
 * 2 only for a pure skip: every failed check is the missing binary or a
 * dependent "skipped" check. A real failure alongside the skip is 1.
 */
export function smokeExitCode(report: SmokeReport): number {
  if (report.ok) return 0;
  if (!report.skipped) return 1;
  const realFailure = report.checks.some((c) => !c.ok && c.id !== 'copilot.binary' && c.detail !== 'skipped');
  return realFailure ? 1 : 2;
}

/** A report for option errors and crashes, so --json output is always a SmokeReport. */
export function errorReport(cli: SmokeCopilotCliOptions, err: unknown, started: number): SmokeReport {
  return {
    ok: false,
    tier: cli.tier === '1' ? 1 : 0,
    pluginRoot: cli.pluginRoot ? resolve(cli.pluginRoot) : '',
    pluginVersion: null,
    copilot: { bin: null, version: null },
    checks: [{ id: 'cli.error', ok: false, detail: err instanceof Error ? err.message : String(err) }],
    artifacts: {},
    durationMs: Date.now() - started,
  };
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push(`omg smoke copilot — tier ${report.tier}, plugin ${report.pluginVersion ?? '?'} at ${report.pluginRoot}`);
  lines.push(`copilot: ${report.copilot.bin ?? 'not found'}${report.copilot.version ? ` (v${report.copilot.version})` : ''}`);
  for (const check of report.checks) {
    const mark = check.ok ? colors.green('✓') : colors.red('✗');
    lines.push(`${mark} ${check.id} — ${check.detail}`);
    if (!check.ok && check.evidence) {
      for (const line of check.evidence.split('\n')) lines.push(colors.gray(`    ${line}`));
    }
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  const kept = Object.entries(report.artifacts).filter(([, v]) => v);
  for (const [key, value] of kept) lines.push(colors.gray(`  ${key}: ${value}`));
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
