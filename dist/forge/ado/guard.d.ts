/**
 * The `az` guard (factory forges design §6, §8.2, §8.4; critic amendments
 * §A.1). src/factory/run/exec.ts and src/ship/exec.ts dispatch here for
 * `az` and the resolved python; git and gh never reach this file, so the
 * GitHub guards are unchanged.
 *
 * Allowed: `az devops invoke` only, run as the entry az-binary.ts resolved
 * (`az` on POSIX, `<CLI2>\python.exe -IBm azure.cli` on Windows; any
 * `.cmd`/`.bat` is refused), with
 *
 * - an `(area, resource, httpMethod)` tuple from routes.ts (the ship guard:
 *   reads plus the build requeue only);
 * - `--api-version` equal to that route's, `--detect false`, `--output json`,
 *   and `--org`, `project`/`projectId` and `repositoryId` equal to the
 *   resolved forge repo;
 * - only the route's `--route-parameters` and `--query-parameters` names,
 *   each once, with checked values;
 * - `--in-file` exactly when the route takes a body: the guard reads the
 *   file, validates the JSON with validateAdoBody (keys and values), writes
 *   the validated bytes to a file it owns and passes THAT path to az, so the
 *   bytes az sends are the bytes that were checked (no TOCTOU window).
 *
 * Refused outright with their own message: `--debug`/`--verbose` (they
 * print the Authorization header), `az repos pr update` and
 * `az repos pr create --auto-complete` (merge is human).
 *
 * Tracker writes (shipyard-factory design PR 7b): the work item create route
 * and the work item PATCH's title, description, AC, priority and link paths
 * pass only with `writes`, the tracker write context `omg factory enqueue`
 * sets (factoryGuardExec). The create names one of its item types; its tags
 * are on its allowlist. Without it (the engine, `check`, `omg ship`) they
 * are refused, and nothing ever removes a field, a link or an item.
 */
import type { Exec, ExecOptions, ExecResult } from '../../ship/exec.js';
import type { ForgeRepo } from '../types.js';
import type { AzEntry } from './az-binary.js';
import { type AdoRoute, type AdoTrackerWrites } from './routes.js';
export interface AdoGuardContext {
    /** The resolved forge repo (kind azure-devops): owner = org, project, name = repo. */
    repo: ForgeRepo;
    /** The az entry az-binary.ts resolved; the only command accepted. */
    entry: AzEntry;
    /** The progress-mapping states (progressStates): the only System.State a work item PATCH may set; none when absent. */
    allowedStates?: readonly string[];
    /** The progress-mapping board columns (progressColumns): the only Kanban column a work item PATCH may set; none when absent. */
    allowedColumns?: readonly string[];
}
/**
 * factory: every routes.ts route. ship: reads plus the requeue of a build
 * evaluation (`omg ship` reruns flaky builds). read: GET routes only
 * (`omg factory heal`, ADO parity design §3.5).
 */
export type AdoGuardPolicy = 'factory' | 'ship' | 'read';
/** The parsed parts of an `az devops invoke` argv (after the entry prefix). */
export interface AdoInvoke {
    route: AdoRoute;
    routeParameters: Record<string, string>;
    queryParameters: Record<string, string>;
    flags: Record<string, string>;
    /** Index of the --in-file value in the az argv, when present. */
    inFileAt?: number;
}
export declare const adoOrgUrl: (org: string) => string;
/** Whether a command is one this guard decides: az (any extension) or a python. */
export declare function isAdoCommand(cmd: string): boolean;
/** Parse `devops invoke …` (no entry prefix); a string = the refusal reason. */
export declare function parseAdoInvoke(azArgs: readonly string[]): AdoInvoke | string;
/** The checked command: argv as given, plus the validated body bytes for an --in-file route. */
export interface CheckedAdoCommand {
    invoke: AdoInvoke;
    /** Index of the --in-file value in the FULL argv (entry prefix included). */
    inFileArg?: number;
    body?: string;
}
/**
 * Check one az command; throws `fail(reason)` when it is refused. Reads and
 * validates the --in-file JSON; the bytes returned are what runGuardedAdo
 * hands az. `writes` (enqueue only) adds the tracker write routes and paths.
 */
export declare function checkAdoCommand(cmd: string, args: readonly string[], env: Readonly<Record<string, string>> | undefined, ctx: AdoGuardContext | undefined, policy: AdoGuardPolicy, fail: (reason: string) => Error, writes?: AdoTrackerWrites): CheckedAdoCommand;
/**
 * Check, copy the validated body into a guard-owned temp file, run az with
 * THAT path, and remove the copy. The caller's file is never handed to az.
 */
export declare function runGuardedAdo(exec: Exec, cmd: string, args: string[], opts: ExecOptions | undefined, ctx: AdoGuardContext | undefined, policy: AdoGuardPolicy, fail: (reason: string) => Error, writes?: AdoTrackerWrites): ExecResult;
//# sourceMappingURL=guard.d.ts.map