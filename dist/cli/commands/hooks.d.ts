/**
 * `omg hooks doctor [--json] [--plugin-root <dir>] [--event <name>] [--no-dispatch]`:
 * check the Copilot hook wiring the way Copilot CLI runs it.
 *
 * - node on PATH: every copilot/hooks.json entry execs `node`;
 * - copilot/hooks.json in sync with scripts/copilot/build-hooks.mjs (read only);
 * - every script path an entry names exists;
 * - a dry dispatch of each entry with a recorded Copilot payload, timed, with
 *   its stderr. Copilot only writes hook stderr to its debug log, so this is
 *   where adapter errors (`[omg-hook]` lines) become visible;
 * - the installed Copilot CLI against the version the fork targets.
 *
 * The dry dispatch runs the real hooks in a throwaway project and home
 * (HOME, USERPROFILE and COPILOT_HOME point into it, the smoke env policy
 * strips OMC_* switches), so no user state or notification config is touched.
 * Exit codes: 0 no check failed (warnings allowed), 1 a check failed.
 */
import { spawn as nodeSpawn } from 'child_process';
import { rmSync } from 'fs';
import type { Command } from 'commander';
import { type BinaryResolverDeps } from '../../smoke/copilot-binary.js';
import type { SpawnSyncFn } from '../../smoke/process-utils.js';
export type DoctorStatus = 'ok' | 'warn' | 'fail';
export interface HooksDoctorCheck {
    id: string;
    status: DoctorStatus;
    detail: string;
    evidence?: string;
}
export interface HooksDoctorReport {
    ok: boolean;
    pluginRoot: string;
    checks: HooksDoctorCheck[];
}
export interface HooksDoctorOptions {
    pluginRoot?: string;
    /** false: skip the dry dispatch (no hook runs). */
    dispatch?: boolean;
    /** Dispatch only this event (PascalCase key of copilot/hooks.json). */
    event?: string;
    env?: NodeJS.ProcessEnv;
    deps?: HooksDoctorDeps;
}
export interface HooksDoctorDeps extends BinaryResolverDeps {
    spawnSync?: SpawnSyncFn;
    /** The generator's rendering of hooks/hooks.json (default: scripts/copilot/build-hooks.mjs). */
    renderHooks?: (root: string, sourceText: string) => Promise<string>;
    randomUUID?: () => string;
    /** Sandbox removal and the detached remover spawn (default: fs.rmSync, child_process.spawn). */
    rmSync?: typeof rmSync;
    spawn?: typeof nodeSpawn;
}
/**
 * Hook payloads as Copilot CLI 1.0.91 sent them to our PascalCase
 * registrations (live probe 2026-10-23): snake_case Claude-format payloads,
 * except PermissionRequest and SubagentStart, which stay camelCase. `tool`
 * is the Claude tool name an entry matcher is tested against (Copilot maps
 * powershell to Bash before matching).
 */
export declare function doctorPayloads(project: string, sessionId: string, now?: Date): Record<string, Array<{
    tool?: string;
    payload: Record<string, unknown>;
}>>;
export declare function runHooksDoctor(opts?: HooksDoctorOptions): Promise<HooksDoctorReport>;
export declare function formatHooksDoctorReport(report: HooksDoctorReport): string;
export interface HooksDoctorCliOptions {
    json?: boolean;
    pluginRoot?: string;
    event?: string;
    /** Commander's --no-dispatch. */
    dispatch?: boolean;
}
export declare function hooksDoctorCommand(cli: HooksDoctorCliOptions): Promise<number>;
export declare function hooksCommand(program: Command): Command;
//# sourceMappingURL=hooks.d.ts.map