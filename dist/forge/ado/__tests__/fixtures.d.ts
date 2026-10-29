/**
 * Azure DevOps fixtures (factory forges design §9 PR 3/PR 5): one JSON file
 * per recorded `az devops invoke` call under ./fixtures, keyed by the call's
 * route and parameters, so a fake Exec answers exactly the argv the adapter
 * builds. There is no live org, so every fixture says where its bytes came
 * from:
 *
 * {
 *   "provenance": "docs-sample <learn.microsoft.com url>" | "recorded <org-free note>" | "synthetic: <why>",
 *   "route": "<AdoRoute.id from src/forge/ado/routes.ts>",
 *   "routeParameters": { "<name>": "<value>" },   // optional
 *   "queryParameters": { "<name>": "<value>" },   // optional
 *   "exitCode": 0,                                 // optional, default 0
 *   "stdout": <REST JSON value, or a string for text routes>,
 *   "stderr": ""                                   // optional
 * }
 *
 * Route and parameter names are checked against the route table, so a
 * fixture cannot describe a call the guard would refuse.
 */
import type { Exec } from '../../../ship/exec.js';
import { type AdoRoute } from '../routes.js';
export interface AdoFixture {
    /** File name, for error messages. */
    name: string;
    provenance: string;
    route: AdoRoute;
    routeParameters: Readonly<Record<string, string>>;
    queryParameters: Readonly<Record<string, string>>;
    exitCode: number;
    stdout: unknown;
    stderr: string;
}
export declare const ADO_FIXTURE_DIR: string;
export declare function parseAdoFixture(name: string, raw: string): AdoFixture;
export declare function loadAdoFixtures(dir?: string): AdoFixture[];
export declare const adoFixtureKey: (f: AdoFixture) => string;
/** The fixture key of an `az devops invoke` argv (with or without the Windows `-IBm azure.cli` prefix). */
export declare function adoArgvKey(args: readonly string[]): string;
/**
 * A fake Exec that answers `az devops invoke` calls from fixtures and records
 * every call. An unmatched call throws, so a test never passes on a call the
 * fixtures do not describe.
 */
export declare function adoFixtureExec(fixtures: readonly AdoFixture[]): Exec & {
    calls: Array<{
        cmd: string;
        args: string[];
    }>;
};
//# sourceMappingURL=fixtures.d.ts.map