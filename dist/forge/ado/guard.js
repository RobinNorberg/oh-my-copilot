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
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { findAdoRoute, validateAdoBody } from './routes.js';
const SHIP_WRITES = new Set(['policy.evaluations.PATCH']);
const MULTI = new Set(['--route-parameters', '--query-parameters']);
const SINGLE = new Set(['--area', '--resource', '--http-method', '--api-version', '--org', '--detect', '--in-file', '--media-type', '--accept-media-type', '--output']);
const NUMBER_ID = /^[1-9]\d{0,9}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A name (work item type, team, board): no control characters or URL-path syntax. */
const NAME = /^[^\p{Cc}/\\?#%&]{1,256}$/u;
const VALUE = /^[^\p{Cc}]{1,2048}$/u;
const ROUTE_VALUE = {
    id: NUMBER_ID, workItemId: NUMBER_ID, pullRequestId: NUMBER_ID, buildId: NUMBER_ID, logId: NUMBER_ID,
    evaluationId: GUID, type: NAME, team: NAME, board: NAME, structureGroup: /^(?:areas|iterations)$/,
};
/** Where `id` is not a numeric id: a saved query's GUID, a board's name. */
const ROUTE_VALUE_BY_ROUTE = {
    'wit.wiql.GET': { id: GUID },
    'work.boards.GET': { id: NAME },
};
const QUERY_VALUE = {
    $top: /^\d{1,4}$/, $skip: /^\d{1,6}$/, $depth: /^\d{1,2}$/, $expand: /^[A-Za-z]{1,32}$/,
    artifactId: /^vstfs:\/\/\/CodeReview\/CodeReviewId\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-9]\d{0,9}$/i,
    includeNotApplicable: /^(?:true|false)$/, format: /^markdown$/, order: /^(?:asc|desc)$/,
    branchName: /^refs\/pull\/[1-9]\d{0,9}\/merge$/, reasonFilter: /^pullRequest$/, queryOrder: /^queueTimeDescending$/,
    'searchCriteria.sourceRefName': /^refs\/heads\/(?!.*\.\.)[^\s\p{Cc}~^:?*[\\]{1,400}$/u, 'searchCriteria.status': /^active$/,
    continuationToken: /^[A-Za-z0-9+/=_-]{1,512}$/,
};
const MAX_BODY_BYTES = 1024 * 1024;
/** ADO names compare case-insensitively with escapes decoded (design §8.3). */
const fold = (s) => {
    try {
        return decodeURIComponent(s).toLowerCase();
    }
    catch {
        return s.toLowerCase();
    }
};
export const adoOrgUrl = (org) => `https://dev.azure.com/${encodeURIComponent(org)}`;
const baseName = (cmd) => cmd.replace(/\\/g, '/').split('/').pop().toLowerCase();
/** Whether a command is one this guard decides: az (any extension) or a python. */
export function isAdoCommand(cmd) {
    const base = baseName(cmd).replace(/\.(?:exe|cmd|bat)$/, '');
    return base === 'az' || /^python(?:\d+(?:\.\d+)?)?w?$/.test(base);
}
/** Parse `devops invoke …` (no entry prefix); a string = the refusal reason. */
export function parseAdoInvoke(azArgs) {
    if (azArgs[0] !== 'devops' || azArgs[1] !== 'invoke')
        return 'only `az devops invoke` is allowed';
    const flags = {};
    const lists = {};
    let inFileAt;
    for (let i = 2; i < azArgs.length; i++) {
        const flag = azArgs[i];
        if (MULTI.has(flag)) {
            if (lists[flag])
                return `${flag} is given twice`;
            const values = [];
            while (i + 1 < azArgs.length && !azArgs[i + 1].startsWith('--'))
                values.push(azArgs[++i]);
            if (values.length === 0)
                return `${flag} has no values`;
            lists[flag] = values;
        }
        else if (SINGLE.has(flag)) {
            if (Object.hasOwn(flags, flag))
                return `${flag} is given twice`;
            const value = azArgs[i + 1];
            if (value === undefined || value.startsWith('--'))
                return `${flag} has no value`;
            flags[flag] = value;
            if (flag === '--in-file')
                inFileAt = i + 1;
            i++;
        }
        else {
            return `${JSON.stringify(flag)} is not an allowed az devops invoke argument`;
        }
    }
    for (const required of ['--area', '--resource', '--http-method', '--api-version', '--org', '--detect', '--output']) {
        if (!Object.hasOwn(flags, required))
            return `${required} is required`;
    }
    const route = findAdoRoute(flags['--area'], flags['--resource'], flags['--http-method']);
    if (!route)
        return `${flags['--area']}/${flags['--resource']} ${flags['--http-method']} is not an allowed Azure DevOps route`;
    const pairs = (flag, allowed) => {
        const out = {};
        for (const token of lists[flag] ?? []) {
            const eq = token.indexOf('=');
            if (eq <= 0)
                return `${flag} token ${JSON.stringify(token)} is not name=value`;
            const name = token.slice(0, eq);
            if (!allowed.includes(name))
                return `${flag} ${name} is not allowed on ${route.id}`;
            if (Object.hasOwn(out, name))
                return `${flag} ${name} is given twice`;
            out[name] = token.slice(eq + 1);
        }
        return out;
    };
    const routeParameters = pairs('--route-parameters', route.routeParams);
    if (typeof routeParameters === 'string')
        return routeParameters;
    const queryParameters = pairs('--query-parameters', route.queryParams);
    if (typeof queryParameters === 'string')
        return queryParameters;
    return { route, routeParameters, queryParameters, flags, inFileAt };
}
/** Why an invoke is refused for `ctx`/`policy`, or undefined. Does not read the body. */
function invokeProblem(inv, ctx, policy) {
    const { route, flags, routeParameters: rp, queryParameters: qp } = inv;
    if (policy === 'ship' && route.method !== 'GET' && !SHIP_WRITES.has(route.id))
        return `${route.id} is not a route omg ship runs`;
    if (flags['--http-method'] !== route.method)
        return `--http-method must be ${route.method}`;
    if (flags['--api-version'] !== route.apiVersion)
        return `--api-version must be ${route.apiVersion} on ${route.id}`;
    if (flags['--detect'] !== 'false')
        return '--detect must be false';
    if (flags['--output'] !== 'json')
        return '--output must be json';
    if (fold(flags['--org']) !== fold(adoOrgUrl(ctx.repo.owner)))
        return `--org must be ${adoOrgUrl(ctx.repo.owner)}`;
    if (flags['--media-type'] !== route.mediaType)
        return route.mediaType ? `--media-type must be ${route.mediaType}` : '--media-type is not allowed';
    if (flags['--accept-media-type'] !== route.acceptMediaType)
        return route.acceptMediaType ? `--accept-media-type must be ${route.acceptMediaType}` : '--accept-media-type is not allowed';
    for (const name of route.routeParams) {
        if (!Object.hasOwn(rp, name))
            continue;
        const value = rp[name];
        if (name === 'project' || name === 'projectId') {
            if (fold(value) !== fold(ctx.repo.project ?? ''))
                return `${name} must be the forge project ${JSON.stringify(ctx.repo.project)}`;
        }
        else if (name === 'repositoryId') {
            if (fold(value) !== fold(ctx.repo.name))
                return `repositoryId must be the forge repository ${JSON.stringify(ctx.repo.name)}`;
        }
        else if (!(ROUTE_VALUE_BY_ROUTE[route.id]?.[name] ?? ROUTE_VALUE[name] ?? NAME).test(value)) {
            return `route parameter ${name} has a refused value`;
        }
    }
    if (route.routeParams.includes('project') && !Object.hasOwn(rp, 'project'))
        return 'the project route parameter is required';
    if (route.routeParams.includes('repositoryId') && !Object.hasOwn(rp, 'repositoryId'))
        return 'the repositoryId route parameter is required';
    for (const [name, value] of Object.entries(qp)) {
        if (!(QUERY_VALUE[name] ?? VALUE).test(value))
            return `query parameter ${name} has a refused value`;
    }
    const takesBody = route.body !== undefined && route.body.kind !== 'none';
    if (takesBody && inv.inFileAt === undefined)
        return `${route.id} needs --in-file`;
    if (!takesBody && inv.inFileAt !== undefined)
        return `${route.id} takes no --in-file`;
    return undefined;
}
/**
 * Check one az command; throws `fail(reason)` when it is refused. Reads and
 * validates the --in-file JSON; the bytes returned are what runGuardedAdo
 * hands az.
 */
export function checkAdoCommand(cmd, args, env, ctx, policy, fail) {
    const file = baseName(cmd);
    if (/\.(?:cmd|bat)$/.test(file))
        throw fail(`${file} is a cmd.exe shim; az runs only as the resolved python -IBm azure.cli entry`);
    if (!args.every((a) => typeof a === 'string'))
        throw fail('every argument must be a string');
    if (args.some((a) => /^--(?:debug|verbose)(?:=|$)/.test(a)))
        throw fail('--debug and --verbose print the Authorization header');
    if (!ctx)
        throw fail('no Azure DevOps forge is configured for this run');
    const { entry } = ctx;
    const sameCmd = entry.prefix.length > 0 ? cmd.toLowerCase() === entry.command.toLowerCase() : cmd === entry.command;
    if (!sameCmd)
        throw fail(`az runs only as ${entry.command}${entry.prefix.length ? ` ${entry.prefix.join(' ')}` : ''}`);
    if (!entry.prefix.every((p, i) => args[i] === p))
        throw fail(`${entry.command} runs only with ${entry.prefix.join(' ')}`);
    const azArgs = args.slice(entry.prefix.length);
    if (azArgs[0] === 'repos' && azArgs[1] === 'pr' && azArgs[2] === 'update')
        throw fail('`az repos pr update` can complete a pull request; merge is a human step');
    if (azArgs[0] === 'repos' && azArgs[1] === 'pr' && azArgs[2] === 'create' && azArgs.some((a) => /^--auto-complete(?:=|$)/.test(a))) {
        throw fail('`az repos pr create --auto-complete` merges without a human');
    }
    const wantEnv = JSON.stringify(Object.entries(entry.env));
    if (env !== undefined && JSON.stringify(Object.entries(env)) !== wantEnv)
        throw fail(`environment ${JSON.stringify(env)}: only ${JSON.stringify(entry.env)} is allowed on az`);
    if (env === undefined && Object.keys(entry.env).length > 0)
        throw fail(`az needs the entry environment ${JSON.stringify(entry.env)}`);
    const inv = parseAdoInvoke(azArgs);
    if (typeof inv === 'string')
        throw fail(inv);
    const problem = invokeProblem(inv, ctx, policy);
    if (problem)
        throw fail(problem);
    if (inv.inFileAt === undefined)
        return { invoke: inv };
    const path = inv.flags['--in-file'];
    if (!isAbsolute(path) || /[\r\n\0]/.test(path))
        throw fail('--in-file must be an absolute path');
    let raw;
    try {
        raw = readFileSync(path);
    }
    catch (error) {
        throw fail(`cannot read --in-file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (raw.length > MAX_BODY_BYTES)
        throw fail(`--in-file is larger than ${MAX_BODY_BYTES} bytes`);
    let parsed;
    try {
        const text = raw.toString('utf8');
        parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
    catch {
        throw fail('--in-file is not JSON');
    }
    const bodyProblem = validateAdoBody(inv.route, parsed);
    if (bodyProblem)
        throw fail(`--in-file refused: ${bodyProblem}`);
    // Re-serialized from the parsed value: a duplicate key cannot smuggle a second value past the check.
    return { invoke: inv, inFileArg: entry.prefix.length + inv.inFileAt, body: JSON.stringify(parsed) };
}
/**
 * Check, copy the validated body into a guard-owned temp file, run az with
 * THAT path, and remove the copy. The caller's file is never handed to az.
 */
export function runGuardedAdo(exec, cmd, args, opts, ctx, policy, fail) {
    const checked = checkAdoCommand(cmd, args, opts?.env, ctx, policy, fail);
    if (checked.body === undefined || checked.inFileArg === undefined)
        return exec(cmd, args, opts);
    const dir = mkdtempSync(join(tmpdir(), 'omg-ado-body-'));
    try {
        const owned = join(dir, 'body.json');
        writeFileSync(owned, checked.body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const rewritten = [...args];
        rewritten[checked.inFileArg] = owned;
        return exec(cmd, rewritten, opts);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=guard.js.map