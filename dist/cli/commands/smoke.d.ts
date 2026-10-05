/**
 * `omg smoke copilot` — load-check the plugin inside the real Copilot CLI.
 * Exit codes: 0 all checks ok; 1 any check failed (or bad options / a crash);
 * 2 skipped because the copilot binary is missing and no static check failed.
 * With --json a SmokeReport is ALWAYS printed, including for option errors and
 * crashes (then `ok:false` with one `cli.error` check).
 */
import { type SmokeOptions, type SmokeReport } from '../../smoke/copilot-smoke.js';
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
export declare function toSmokeOptions(cli: SmokeCopilotCliOptions): Partial<SmokeOptions>;
/**
 * 2 only for a pure skip: every failed check is the missing binary or a
 * dependent "skipped" check. A real failure alongside the skip is 1.
 */
export declare function smokeExitCode(report: SmokeReport): number;
/** A report for option errors and crashes, so --json output is always a SmokeReport. */
export declare function errorReport(cli: SmokeCopilotCliOptions, err: unknown, started: number): SmokeReport;
export declare function formatSmokeReport(report: SmokeReport): string;
export declare function smokeCopilotCommand(cli: SmokeCopilotCliOptions): Promise<number>;
//# sourceMappingURL=smoke.d.ts.map