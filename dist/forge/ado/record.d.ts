/**
 * Fixture recording for the first live Azure DevOps run (factory forges
 * design §10.1). With `OMG_ADO_RECORD_DIR=<dir>` set, the adapter writes
 * every `az devops invoke` call it makes, and az's answer, to `<dir>` in the
 * fixture format of src/forge/ado/__tests__/fixtures.ts (same route ids and
 * parameter keys), so a recorded file can replace a docs sample as is.
 *
 * - Recording sits outside the guard: what is recorded is what the guarded
 *   Exec ran and returned. stdout and stderr pass through redactAdoSecrets.
 * - One file per call key (`<route id>.<hash>.json`); a repeated call
 *   overwrites it with the latest answer.
 * - Files carry `argv` (the --in-file path replaced) and `requestBody`, so
 *   the request shapes can be checked too.
 *
 * Diff the recording against the docs samples with
 * `node scripts/ado-fixture-diff.mjs <recorded dir>`, which prints, per
 * route, the response keys the samples have and the live answers lack
 * (adoFixtureShapeReport). Also record the resource table once:
 * `az devops invoke --org https://dev.azure.com/<org> --detect false
 * --query "[?area=='git' || area=='wit' || area=='policy' || area=='build' || area=='work']"`
 * and compare it with src/forge/ado/routes.ts.
 */
import type { Exec } from '../../ship/exec.js';
export declare const ADO_RECORD_ENV = "OMG_ADO_RECORD_DIR";
/** Wrap an Exec so each `az devops invoke` call and its answer is written to `dir` as a fixture. */
export declare function recordingAdoExec(exec: Exec, dir: string, now?: () => Date): Exec;
/** Every key path of a JSON value: `a.b`, `a[].c` (array elements merged). */
export declare function jsonKeyPaths(value: unknown, at?: string): Set<string>;
export interface FixtureLike {
    name: string;
    route: string;
    stdout: unknown;
}
/**
 * Per route, the response key paths the docs samples have and no recorded
 * answer of that route has (what the adapter may read but ADO does not
 * send), and the routes recorded with no sample. Empty = no drift found.
 */
export declare function adoFixtureShapeReport(samples: readonly FixtureLike[], recorded: readonly FixtureLike[]): string[];
//# sourceMappingURL=record.d.ts.map