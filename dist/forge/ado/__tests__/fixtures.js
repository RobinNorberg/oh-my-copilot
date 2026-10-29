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
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AZ_PYTHON_PREFIX } from '../az-binary.js';
import { adoRouteById, findAdoRoute } from '../routes.js';
export const ADO_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PROVENANCE = /^(?:docs-sample https:\/\/learn\.microsoft\.com\/\S+|recorded \S.*|synthetic: \S.*)$/;
function params(value, allowed, what, name) {
    if (value === undefined)
        return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`${name}: ${what} must be an object`);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (!allowed.includes(k))
            throw new Error(`${name}: ${what}.${k} is not allowed by the route (${allowed.join(', ') || 'none'})`);
        if (typeof v !== 'string')
            throw new Error(`${name}: ${what}.${k} must be a string`);
        out[k] = v;
    }
    return out;
}
export function parseAdoFixture(name, raw) {
    const f = JSON.parse(raw);
    if (typeof f.provenance !== 'string' || !PROVENANCE.test(f.provenance))
        throw new Error(`${name}: provenance must be "docs-sample <url>", "recorded …" or "synthetic: …"`);
    if (typeof f.route !== 'string')
        throw new Error(`${name}: route must be an AdoRoute id`);
    const route = adoRouteById(f.route);
    const exitCode = f.exitCode ?? 0;
    if (!Number.isInteger(exitCode))
        throw new Error(`${name}: exitCode must be an integer`);
    if (f.stdout === undefined)
        throw new Error(`${name}: stdout is required`);
    if (f.stderr !== undefined && typeof f.stderr !== 'string')
        throw new Error(`${name}: stderr must be a string`);
    return {
        name,
        provenance: f.provenance,
        route,
        routeParameters: params(f.routeParameters, route.routeParams, 'routeParameters', name),
        queryParameters: params(f.queryParameters, route.queryParams, 'queryParameters', name),
        exitCode: exitCode,
        stdout: f.stdout,
        stderr: f.stderr ?? '',
    };
}
export function loadAdoFixtures(dir = ADO_FIXTURE_DIR) {
    return readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n) => parseAdoFixture(n, readFileSync(join(dir, n), 'utf8')));
}
const keyOf = (route, rp, qp) => {
    const kv = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&');
    return `${route.id}?route:${kv(rp)}|query:${kv(qp)}`;
};
export const adoFixtureKey = (f) => keyOf(f.route, f.routeParameters, f.queryParameters);
/** `k=v` tokens after a flag, up to the next `--flag`. */
function pairs(args, flag) {
    const at = args.indexOf(flag);
    const out = {};
    if (at < 0)
        return out;
    for (const token of args.slice(at + 1)) {
        if (token.startsWith('--'))
            break;
        const eq = token.indexOf('=');
        if (eq <= 0)
            throw new Error(`${flag} token ${JSON.stringify(token)} is not name=value`);
        out[token.slice(0, eq)] = token.slice(eq + 1);
    }
    return out;
}
const flagValue = (args, flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
};
/** The fixture key of an `az devops invoke` argv (with or without the Windows `-IBm azure.cli` prefix). */
export function adoArgvKey(args) {
    const rest = args[0] === AZ_PYTHON_PREFIX[0] && args[1] === AZ_PYTHON_PREFIX[1] ? args.slice(2) : args;
    if (rest[0] !== 'devops' || rest[1] !== 'invoke')
        throw new Error(`not an az devops invoke call: ${rest.join(' ')}`);
    const area = flagValue(rest, '--area') ?? '';
    const resource = flagValue(rest, '--resource') ?? '';
    const method = flagValue(rest, '--http-method') ?? 'GET';
    const route = findAdoRoute(area, resource, method);
    if (!route)
        throw new Error(`no route for ${area}/${resource} ${method}`);
    return keyOf(route, pairs(rest, '--route-parameters'), pairs(rest, '--query-parameters'));
}
/**
 * A fake Exec that answers `az devops invoke` calls from fixtures and records
 * every call. An unmatched call throws, so a test never passes on a call the
 * fixtures do not describe.
 */
export function adoFixtureExec(fixtures) {
    const byKey = new Map();
    for (const f of fixtures) {
        const key = adoFixtureKey(f);
        if (byKey.has(key))
            throw new Error(`fixtures ${byKey.get(key).name} and ${f.name} describe the same call ${key}`);
        byKey.set(key, f);
    }
    const calls = [];
    const exec = ((cmd, args) => {
        calls.push({ cmd, args: [...args] });
        const key = adoArgvKey(args);
        const f = byKey.get(key);
        if (!f)
            throw new Error(`no fixture for ${key}`);
        return { status: f.exitCode, stdout: typeof f.stdout === 'string' ? f.stdout : JSON.stringify(f.stdout), stderr: f.stderr };
    });
    exec.calls = calls;
    return exec;
}
//# sourceMappingURL=fixtures.js.map