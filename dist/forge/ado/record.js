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
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AZ_PYTHON_PREFIX } from './az-binary.js';
import { parseAdoInvoke } from './guard.js';
import { redactAdoSecrets } from './redact.js';
export const ADO_RECORD_ENV = 'OMG_ADO_RECORD_DIR';
const parseMaybe = (text) => {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
};
/** Wrap an Exec so each `az devops invoke` call and its answer is written to `dir` as a fixture. */
export function recordingAdoExec(exec, dir, now = () => new Date()) {
    return (cmd, args, opts) => {
        const prefixed = args[0] === AZ_PYTHON_PREFIX[0] && args[1] === AZ_PYTHON_PREFIX[1];
        const azArgs = prefixed ? args.slice(2) : args;
        const inv = azArgs[0] === 'devops' ? parseAdoInvoke(azArgs) : 'not invoke';
        let requestBody;
        if (typeof inv !== 'string' && inv.flags['--in-file']) {
            try {
                requestBody = parseMaybe(readFileSync(inv.flags['--in-file'], 'utf8'));
            }
            catch {
                requestBody = '<unreadable>';
            }
        }
        const res = exec(cmd, args, opts);
        if (typeof inv === 'string')
            return res;
        const kv = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&');
        const key = `${inv.route.id}?route:${kv(inv.routeParameters)}|query:${kv(inv.queryParameters)}`;
        const fixture = {
            provenance: `recorded ${now().toISOString()} live az devops invoke`,
            route: inv.route.id,
            routeParameters: inv.routeParameters,
            queryParameters: inv.queryParameters,
            exitCode: res.status,
            stdout: parseMaybe(redactAdoSecrets(res.stdout)),
            stderr: redactAdoSecrets(res.stderr),
            argv: azArgs.map((a, i) => (inv.inFileAt === i ? '<in-file>' : a)),
            ...(requestBody !== undefined ? { requestBody } : {}),
        };
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${inv.route.id}.${createHash('sha256').update(key).digest('hex').slice(0, 10)}.json`), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
        return res;
    };
}
/** Every key path of a JSON value: `a.b`, `a[].c` (array elements merged). */
export function jsonKeyPaths(value, at = '') {
    const out = new Set();
    if (Array.isArray(value)) {
        for (const item of value)
            for (const p of jsonKeyPaths(item, `${at}[]`))
                out.add(p);
    }
    else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            const path = at ? `${at}.${k}` : k;
            out.add(path);
            for (const p of jsonKeyPaths(v, path))
                out.add(p);
        }
    }
    return out;
}
/**
 * Per route, the response key paths the docs samples have and no recorded
 * answer of that route has (what the adapter may read but ADO does not
 * send), and the routes recorded with no sample. Empty = no drift found.
 */
export function adoFixtureShapeReport(samples, recorded) {
    const lines = [];
    const routes = [...new Set(recorded.map((r) => r.route))].sort();
    for (const route of routes) {
        const mine = samples.filter((s) => s.route === route);
        if (mine.length === 0) {
            lines.push(`${route}: recorded, but no docs sample`);
            continue;
        }
        const live = new Set(recorded.filter((r) => r.route === route).flatMap((r) => [...jsonKeyPaths(r.stdout)]));
        const expected = new Set(mine.flatMap((s) => [...jsonKeyPaths(s.stdout)]));
        const missing = [...expected].filter((p) => !live.has(p)).sort();
        if (missing.length)
            lines.push(`${route}: missing in the live answer: ${missing.join(', ')}`);
    }
    return lines;
}
//# sourceMappingURL=record.js.map