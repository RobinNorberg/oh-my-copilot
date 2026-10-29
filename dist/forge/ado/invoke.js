/**
 * The one way the ADO adapter calls Azure DevOps: `az devops invoke` with
 * the route's area, resource, api-version and method from routes.ts, an
 * explicit `--org`, `--detect false` and `--output json`, through the
 * caller's (guarded) Exec. Write bodies go through `--in-file`: the adapter
 * writes the JSON to its own temp file and the guard hands az a validated
 * copy (guard.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { adoOrgUrl } from './guard.js';
import { redactAdoSecrets } from './redact.js';
import { adoRouteById } from './routes.js';
/** The az argv (entry prefix included) for one route. */
export function adoInvokeArgs(ctx, routeId, routeParameters, queryParameters = {}, inFile) {
    const route = adoRouteById(routeId);
    const kv = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`);
    const rp = kv(routeParameters), qp = kv(queryParameters);
    return [
        ...ctx.entry.prefix,
        'devops', 'invoke',
        '--area', route.area,
        '--resource', route.resource,
        ...(rp.length ? ['--route-parameters', ...rp] : []),
        ...(qp.length ? ['--query-parameters', ...qp] : []),
        '--http-method', route.method,
        '--api-version', route.apiVersion,
        ...(route.mediaType ? ['--media-type', route.mediaType] : []),
        ...(inFile !== undefined ? ['--in-file', inFile] : []),
        '--org', adoOrgUrl(ctx.repo.owner),
        '--detect', 'false',
        '--output', 'json',
    ];
}
/** The project/repository route parameters every git route takes. */
export const repoParams = (ctx) => ({ project: ctx.repo.project ?? '', repositoryId: ctx.repo.name });
export const projectParams = (ctx) => ({ project: ctx.repo.project ?? '' });
/**
 * Run one route. A body is written to an adapter-owned temp file that is
 * removed afterwards. A guard refusal (a throw) propagates; callers that
 * must never throw catch it.
 */
export function adoCall(ctx, routeId, routeParameters, queryParameters = {}, body) {
    let dir;
    try {
        let inFile;
        if (body !== undefined) {
            dir = mkdtempSync(join(tmpdir(), 'omg-ado-'));
            inFile = join(dir, 'body.json');
            writeFileSync(inFile, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
        }
        const res = ctx.exec(ctx.entry.command, adoInvokeArgs(ctx, routeId, routeParameters, queryParameters, inFile), {
            cwd: ctx.cwd,
            ...(Object.keys(ctx.entry.env).length ? { env: ctx.entry.env } : {}),
        });
        let json;
        if (res.status === 0) {
            try {
                json = JSON.parse(res.stdout);
            }
            catch {
                json = undefined;
            }
        }
        return { ok: res.status === 0 && json !== undefined, status: res.status, json, stderr: redactAdoSecrets(res.stderr.trim()) };
    }
    finally {
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
}
/** The result's JSON, or a thrown Error naming the call and az's redacted stderr. */
export function adoJson(call, what) {
    if (call.ok)
        return call.json;
    const detail = call.stderr || (call.status === 0 ? 'stdout is not JSON' : `az exited ${call.status}`);
    throw new Error(`${what} failed: ${detail}`);
}
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** `value` of a REST list response, [] when absent. */
export const listValue = (v) => (isObject(v) && Array.isArray(v.value) ? v.value : []);
export const str = (v) => (typeof v === 'string' ? v : undefined);
//# sourceMappingURL=invoke.js.map