/**
 * `omg smoke copilot` — load-check the plugin inside the real Copilot CLI.
 * Exit codes: 0 all checks ok; 1 any check failed (or bad options / a crash);
 * 2 skipped because the copilot binary or the optional `@github/copilot-sdk`
 * peer is missing and no other check failed.
 * With --json a SmokeReport is ALWAYS printed, including for option errors and
 * crashes (then `ok:false` with one `cli.error` check).
 */
import { runCopilotSmoke, type Scenario, type SmokeOptions, type SmokeReport } from '../../smoke/copilot-smoke.js';
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
    /** Tier 2: record the scenarios' model requests under this dir (billed). */
    record?: string;
    recordOverwrite?: boolean;
    /** Tier 2: replay the scenarios from the cassettes under this dir (free). */
    replay?: string;
    replayStrict?: boolean;
    json?: boolean;
}
/** A leading `~` as the home dir: PowerShell passes `~/omg-cassettes` to a native command unexpanded. */
export declare function expandHome(dir: string): string;
/** Parse `--scenario a,b` / `all` into a deduplicated, validated list; `all` never includes the opt-in scenarios (OPT_IN_SCENARIOS). */
export declare function parseScenarios(raw: string): Scenario[];
export declare function toSmokeOptions(cli: SmokeCopilotCliOptions, env?: NodeJS.ProcessEnv): Partial<SmokeOptions>;
/**
 * 2 only for a pure skip: every failed check is the missing binary/SDK or a
 * dependent "skipped" check. A real failure alongside the skip is 1.
 */
export declare function smokeExitCode(report: SmokeReport): number;
/** A report for option errors and crashes, so --json output is always a SmokeReport. */
export declare function errorReport(cli: SmokeCopilotCliOptions, err: unknown, started: number): SmokeReport;
export declare function formatSmokeReport(report: SmokeReport): string;
export declare function smokeCopilotCommand(cli: SmokeCopilotCliOptions): Promise<number>;
export interface VerifyCassettesOptions {
    /** Replay only these scenarios (default: every cassette for this machine under the root). */
    scenarios?: string[];
    pluginRoot?: string;
    timeoutMs?: number;
    /** The redaction gate only, no replay. */
    gateOnly?: boolean;
    /** Test seam (default runCopilotSmoke). */
    runSmoke?: typeof runCopilotSmoke;
}
/**
 * `omg smoke cassette verify <dir>`: the redaction gate over every cassette
 * under `dir` (a failure writes REDACTION-FAILED into that cassette), then a
 * replay of this machine's cassettes that passed, credential-free; each
 * replayed cassette's manifest gets `selfVerify`.
 */
export declare function verifyCassettes(root: string, opts?: VerifyCassettesOptions): Promise<{
    ok: boolean;
    lines: string[];
}>;
export declare function smokeCassetteVerifyCommand(dir: string, cli: {
    pluginRoot?: string;
    timeout?: string;
    gateOnly?: boolean;
}): Promise<number>;
/** Where `omg smoke cassette import` copies to by default: the repo's replay fixtures. */
export declare const CASSETTE_FIXTURES_DIR: string;
export declare function smokeCassetteImportCommand(dir: string, cli: {
    to?: string;
    overwrite?: boolean;
}): number;
//# sourceMappingURL=smoke.d.ts.map