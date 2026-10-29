/**
 * The exec boundary of `omg factory setup` (factory forges design §4):
 * setupGuardExec allows the read shapes the wizard builds plus the one write
 * the user confirms, `gh label create`. It runs no lane and never pushes,
 * edits an item or calls a write route; anything else is refused before it
 * spawns.
 *
 * Azure DevOps calls are `az devops invoke` GETs of a route in
 * src/forge/ado/routes.ts, pinned to the detected org and project, with the
 * route's own API version, `--detect false`, and no `--in-file`, `--debug`
 * or `--verbose` (those print headers). On Windows az runs as the bundled
 * python.exe `-IBm azure.cli` that az-binary.ts resolved, never az.cmd.
 */
import { ShipSafetyError, type Exec, type ExecResult } from '../../ship/exec.js';
import type { AzEntry } from '../../forge/ado/az-binary.js';
import type { ForgeRepo } from '../../forge/types.js';
/** Exit codes (design §4): 2 usage, 3 auth or extension missing, 5 incompatible. */
export type SetupExitCode = 1 | 2 | 3 | 5;
export declare class SetupError extends Error {
    readonly exitCode: SetupExitCode;
    constructor(exitCode: SetupExitCode, message: string);
}
export declare class SetupSafetyError extends ShipSafetyError {
    constructor(message: string);
}
/** What the wizard talks to: the guarded exec, the repo root, the detected repo, and az on ADO. */
export interface SetupIo {
    exec: Exec;
    cwd: string;
    repo: ForgeRepo;
    az?: AzEntry;
}
export declare const LABEL_COLOR = "7c7c7c";
/** A GitHub label (the forge config's TRACKER_NAME rule). */
export declare const LABEL_NAME: RegExp;
export declare const adoOrgUrl: (repo: ForgeRepo) => string;
export declare const milestonesPath: (repo: ForgeRepo) => string;
/** Throws SetupSafetyError unless `cmd args` is one of the wizard's shapes. */
export declare function assertSetupCommand(cmd: string, args: string[], repo: ForgeRepo, az?: AzEntry, env?: Readonly<Record<string, string>>): void;
export declare function setupGuardExec(exec: Exec, repo: ForgeRepo, az?: AzEntry): Exec;
/** Run one az command (`az <args>` on POSIX, `python.exe -IBm azure.cli <args>` on Windows). */
export declare function runAz(io: SetupIo, args: string[]): ExecResult;
/** az stderr without token-shaped runs (PATs, bearer tokens); the wizard never prints stdout of an auth call. */
export declare function safeStderr(stderr: string): string;
/** The argv of one `az devops invoke` GET of a routes.ts route. */
export declare function adoInvokeArgs(repo: ForgeRepo, routeId: string, routeParameters: Record<string, string>, queryParameters?: Record<string, string>): string[];
/** One ADO GET; throws SetupError(code) with the redacted stderr when az fails. */
export declare function adoGet(io: SetupIo, routeId: string, routeParameters: Record<string, string>, queryParameters?: Record<string, string>, code?: SetupExitCode): unknown;
/** The `value` array of an ADO list response. */
export declare function adoList(body: unknown): Array<Record<string, unknown>>;
//# sourceMappingURL=guard.d.ts.map