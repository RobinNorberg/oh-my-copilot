/**
 * The one way the ADO adapter calls Azure DevOps: `az devops invoke` with
 * the route's area, resource, api-version and method from routes.ts, an
 * explicit `--org`, `--detect false` and `--output json`, through the
 * caller's (guarded) Exec. Write bodies go through `--in-file`: the adapter
 * writes the JSON to its own temp file and the guard hands az a validated
 * copy (guard.ts).
 */
import type { Exec } from '../../ship/exec.js';
import type { AzureDevOpsForgeConfig, ForgeRepo } from '../types.js';
import type { AzEntry } from './az-binary.js';
export interface AdoContext {
    exec: Exec;
    cwd: string;
    entry: AzEntry;
    repo: ForgeRepo;
    config: AzureDevOpsForgeConfig;
    /** intake.itemTypes: the WIQL intake filter. */
    intakeItemTypes: readonly string[];
}
export interface AdoCall {
    ok: boolean;
    status: number;
    /** Parsed stdout; undefined when the call failed or stdout is not JSON. */
    json: unknown;
    /** Redacted stderr. */
    stderr: string;
}
/** The az argv (entry prefix included) for one route. */
export declare function adoInvokeArgs(ctx: Pick<AdoContext, 'entry' | 'repo'>, routeId: string, routeParameters: Readonly<Record<string, string>>, queryParameters?: Readonly<Record<string, string>>, inFile?: string): string[];
/** The project/repository route parameters every git route takes. */
export declare const repoParams: (ctx: Pick<AdoContext, "repo">) => Record<string, string>;
export declare const projectParams: (ctx: Pick<AdoContext, "repo">) => Record<string, string>;
/**
 * Run one route. A body is written to an adapter-owned temp file that is
 * removed afterwards. A guard refusal (a throw) propagates; callers that
 * must never throw catch it.
 */
export declare function adoCall(ctx: AdoContext, routeId: string, routeParameters: Readonly<Record<string, string>>, queryParameters?: Readonly<Record<string, string>>, body?: unknown): AdoCall;
/** The result's JSON, or a thrown Error naming the call and az's redacted stderr. */
export declare function adoJson(call: AdoCall, what: string): unknown;
export declare const isObject: (v: unknown) => v is Record<string, unknown>;
/** `value` of a REST list response, [] when absent. */
export declare const listValue: (v: unknown) => unknown[];
export declare const str: (v: unknown) => string | undefined;
//# sourceMappingURL=invoke.d.ts.map