/**
 * GitHub checks (factory forges design §2, PR 2): `gh pr checks`, the PR
 * head, `gh run list --commit`, job logs and `gh run rerun --failed`. The
 * bodies moved verbatim from src/ship/gates.ts and gates-driver.ts, whose
 * exported names now delegate here; argv, cwd and error text are unchanged.
 */
import { CHECK_FIELDS, GhChecksError, parseChecksJson, parseRunsJson, RUN_FIELDS, TRANSIENT_GH_ERROR } from '../../ship/gates.js';
/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list. */
export function ghPrChecks(exec, pr, cwd) {
    const res = exec('gh', ['pr', 'checks', String(pr), '--json', CHECK_FIELDS], { cwd });
    const out = res.stdout.trim();
    if (out.startsWith('['))
        return parseChecksJson(out);
    if (/no checks reported/i.test(res.stderr) || /no checks reported/i.test(res.stdout))
        return [];
    throw new GhChecksError(`gh pr checks ${pr} failed (exit ${res.status}): ${res.stderr.trim() || out}`);
}
/** The PR head sha from `gh pr view <pr> --json headRefOid`. */
export function ghHeadSha(exec, pr, cwd) {
    const res = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd });
    let sha;
    try {
        sha = JSON.parse(res.stdout).headRefOid;
    }
    catch {
        sha = undefined;
    }
    if (res.status !== 0 || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new GhChecksError(`gh pr view ${pr} did not return a head sha (exit ${res.status}): ${res.stderr.trim()}`);
    }
    return sha;
}
/**
 * Run `gh run list --commit <sha> --json ...`: every Actions workflow run for
 * the head sha. A run whose reported head_sha is another commit is dropped, so
 * a previous head's failed run never counts against this one.
 */
export function ghRunsForHead(exec, headSha, cwd) {
    const res = exec('gh', ['run', 'list', '--commit', headSha, '--json', RUN_FIELDS, '--limit', '100'], { cwd });
    if (res.status !== 0)
        throw new GhChecksError(`gh run list --commit ${headSha.slice(0, 12)} failed (exit ${res.status}): ${res.stderr.trim()}`);
    return parseRunsJson(res.stdout.trim() || '[]').filter((r) => !r.headSha || r.headSha === headSha);
}
/** `gh run view --job <id> --log`; `ok: false` (text = whatever stdout held) when gh failed. */
export function ghJobLog(exec, jobId, cwd) {
    const res = exec('gh', ['run', 'view', '--job', jobId, '--log'], { cwd });
    return { ok: res.status === 0, text: res.stdout };
}
/** `gh run rerun <id> --failed`. */
export function ghRerun(exec, runId, cwd) {
    const res = exec('gh', ['run', 'rerun', runId, '--failed'], { cwd });
    return { ok: res.status === 0, stderr: res.stderr };
}
/** ForgeChecks on GitHub: `pr checks` already reports the PR head, and a run list is per commit, so `headSha` / `pr` are not needed there. */
export function githubChecks(exec, cwd) {
    return {
        checks: (pr) => ghPrChecks(exec, pr, cwd),
        runsForHead: (_pr, headSha) => ghRunsForHead(exec, headSha, cwd),
        jobLog: (jobId) => ghJobLog(exec, jobId, cwd),
        rerun: (_pr, runId) => ghRerun(exec, runId, cwd),
        transientError: TRANSIENT_GH_ERROR,
    };
}
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[a-z0-9.-]+$/i;
/** `host/owner/name` (ghRepoArg) split and checked, else undefined. */
function repoParts(repoArg) {
    const parts = repoArg?.split('/') ?? [];
    return parts.length === 3 && HOST.test(parts[0]) && SEGMENT.test(parts[1]) && SEGMENT.test(parts[2]) ? [parts[0], parts[1], parts[2]] : undefined;
}
/** The read-only GETs of the forge's required checks and of a commit's checks: exact argv, built and matched here only. */
const apiGet = (host, path) => ['api', '--hostname', host, '--method', 'GET', path];
/**
 * The two GETs of ghRequiredChecks for `base` of `repoArg` (ghRepoArg):
 * the branch (its `protection.required_status_checks`) and the rules that
 * apply to it (rulesets' `required_status_checks`).
 */
export function requiredChecksArgs(repoArg, base) {
    const [host, owner, name] = repoParts(repoArg) ?? [];
    if (!host)
        throw new Error(`not a GitHub repository argument: ${repoArg}`);
    const b = encodeURIComponent(base);
    return [apiGet(host, `repos/${owner}/${name}/branches/${b}`), apiGet(host, `repos/${owner}/${name}/rules/branches/${b}?per_page=100&page=1`)];
}
/** Pages read of a paginated list (rules, check suites, check runs); a longer list counts as unreadable. */
export const MAX_API_PAGES = 10;
/** `args` (one of the GETs here, ending in `page=1`) for page `page`. */
const atPage = (args, page) => [...args.slice(0, 5), args[5].replace(/page=1$/, `page=${page}`)];
/**
 * The paginated GETs of the factory's gate reads at a full commit sha:
 * the commit's check suites and its check runs (with their app ids).
 */
export function gateReadArgs(repoArg, sha, what) {
    const [host, owner, name] = repoParts(repoArg) ?? [];
    if (!host)
        throw new Error(`not a GitHub repository argument: ${repoArg}`);
    if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error(`not a full commit sha: ${sha}`);
    return apiGet(host, `repos/${owner}/${name}/commits/${sha}/${what}?per_page=100&page=1`);
}
/** The GETs of latestChecks for `ref` of `repoArg`: the commit's check runs and its combined status. */
export function commitChecksArgs(repoArg, ref) {
    const [host, owner, name] = repoParts(repoArg) ?? [];
    if (!host)
        throw new Error(`not a GitHub repository argument: ${repoArg}`);
    const r = encodeURIComponent(ref);
    return [apiGet(host, `repos/${owner}/${name}/commits/${r}/check-runs?per_page=100`), apiGet(host, `repos/${owner}/${name}/commits/${r}/status?per_page=100`)];
}
const BRANCH_PATH = /^repos\/([^/]+)\/([^/]+)\/(?:branches\/([A-Za-z0-9_.%-]+)|rules\/branches\/([A-Za-z0-9_.%-]+)\?per_page=100&page=(?:[1-9]|10))$/;
const COMMIT_PATH = /^repos\/([^/]+)\/([^/]+)\/commits\/([A-Za-z0-9_.%-]+)\/(?:check-runs|status)\?per_page=100$/;
/** The factory run's gate reads: a full sha only (the base's check names, the head's suites and runs). */
const GATE_READ_PATH = /^repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/(?:(?:check-runs|status)\?per_page=100|(?:check-suites|check-runs)\?per_page=100&page=(?:[1-9]|10))$/;
/**
 * True for exactly one of the GETs above on `repoArg` (the guards of
 * factory run, setup and check allow these reads and nothing broader).
 * `commits` also allows the commit-check reads (setup and check only).
 */
export function isRequiredChecksArgs(args, repoArg, commits = false) {
    const parts = repoParts(repoArg);
    if (!parts)
        return false;
    return pathOf(args, parts, (path) => BRANCH_PATH.exec(path) ?? (commits ? COMMIT_PATH.exec(path) : null));
}
/** The GET `args` on `parts` whose path `match` accepts for the same owner/name, with no dot-only segment. */
function pathOf(args, parts, match) {
    const [host, owner, name] = parts;
    if (args.length !== 6 || args[0] !== 'api' || args[1] !== '--hostname' || args[2].toLowerCase() !== host.toLowerCase() || args[3] !== '--method' || args[4] !== 'GET')
        return false;
    const m = match(args[5]);
    const segment = m?.[3] ?? m?.[4];
    return m !== null && m[1] === owner && m[2] === name && segment !== undefined && !/^\.+$/.test(segment);
}
/**
 * True for exactly one of the factory run's gate reads on `repoArg` (the
 * run guard): the commit-check GETs at a full sha (the base's check names)
 * and the paginated check-suite / check-run GETs (gateReadArgs).
 */
export function isGateReadArgs(args, repoArg) {
    const parts = repoParts(repoArg);
    return parts !== undefined && pathOf(args, parts, (path) => GATE_READ_PATH.exec(path));
}
function readJson(exec, args, cwd) {
    let res;
    try {
        res = exec('gh', args, { cwd });
    }
    catch {
        return undefined;
    }
    if (res.status !== 0)
        return undefined;
    try {
        return JSON.parse(res.stdout);
    }
    catch {
        return undefined;
    }
}
/**
 * The status checks GitHub requires on `base` (the default of an empty
 * `ship.requiredChecks`): the branch protection's required contexts plus
 * the `required_status_checks` rules of the rulesets that apply to it. Read
 * from the forge API with the user's token, never from the repository tree.
 * undefined = neither read worked (the caller falls back to every reported
 * check); a readable empty list is [].
 */
export function ghRequiredChecks(exec, repoArg, base, cwd) {
    return ghRequiredCheckRules(exec, repoArg, base, cwd)?.names;
}
/**
 * ghRequiredChecks with the app each name is required from: a ruleset's
 * `integration_id`, a classic protection check's `app_id` (absent, null or
 * -1 = any source). A name required from two different apps keeps no app
 * (name matching), since one check run cannot satisfy both.
 */
export function ghRequiredCheckRules(exec, repoArg, base, cwd) {
    const [branchArgs, rulesArgs] = requiredChecksArgs(repoArg, base);
    const names = new Set();
    const apps = new Map();
    const add = (v, app) => {
        if (typeof v !== 'string' || v.length === 0)
            return;
        names.add(v);
        const id = typeof app === 'number' && Number.isInteger(app) && app > 0 ? app : null;
        apps.set(v, apps.has(v) && apps.get(v) !== id ? null : id);
    };
    const branch = readJson(exec, branchArgs, cwd);
    const rules = readPages(exec, rulesArgs, cwd, (page) => (Array.isArray(page) ? page : undefined));
    if ((branch === undefined || typeof branch !== 'object') && rules === undefined)
        return undefined;
    const rsc = branch?.protection?.required_status_checks;
    const checks = Array.isArray(rsc?.checks) ? rsc.checks : [];
    for (const c of Array.isArray(rsc?.contexts) ? rsc.contexts : [])
        add(c, checks.find((k) => k?.context === c)?.app_id);
    for (const c of checks)
        add(c?.context, c?.app_id);
    for (const rule of rules ?? []) {
        const r = rule;
        if (r?.type !== 'required_status_checks')
            continue;
        const list = r.parameters?.required_status_checks;
        for (const c of Array.isArray(list) ? list : [])
            add(c?.context, c?.integration_id);
    }
    return { names: [...names], apps: Object.fromEntries([...apps].filter((e) => e[1] !== null)) };
}
/**
 * Every item of a paginated GET (`first` ends in `page=1`, 100 per page):
 * `items` picks a page's list. Stops at a short page; undefined when a page
 * is unreadable or the list is longer than MAX_API_PAGES pages.
 */
function readPages(exec, first, cwd, items) {
    const out = [];
    for (let page = 1; page <= MAX_API_PAGES; page += 1) {
        const list = items(readJson(exec, atPage(first, page), cwd));
        if (list === undefined)
            return undefined;
        out.push(...list);
        if (list.length < 100)
            return out;
    }
    return undefined;
}
/** The check suites GitHub lists for `sha` (gateReadArgs, paginated); undefined = unreadable. */
export function ghCheckSuites(exec, repoArg, sha, cwd) {
    const raw = readPages(exec, gateReadArgs(repoArg, sha, 'check-suites'), cwd, (page) => {
        const list = page?.check_suites;
        return Array.isArray(list) ? list : undefined;
    });
    if (raw === undefined)
        return undefined;
    const out = [];
    for (const s of raw) {
        if (typeof s?.status !== 'string')
            return undefined;
        out.push({ status: s.status, ...(typeof s.app?.slug === 'string' ? { app: s.app.slug } : {}), runs: typeof s.latest_check_runs_count === 'number' ? s.latest_check_runs_count : 0 });
    }
    return out;
}
/** The check runs GitHub lists for `sha` with their app ids (gateReadArgs, paginated); undefined = unreadable. */
export function ghCheckRunApps(exec, repoArg, sha, cwd) {
    const raw = readPages(exec, gateReadArgs(repoArg, sha, 'check-runs'), cwd, (page) => {
        const list = page?.check_runs;
        return Array.isArray(list) ? list : undefined;
    });
    if (raw === undefined)
        return undefined;
    return raw
        .filter((r) => typeof r?.name === 'string')
        .map((r) => ({ name: r.name, ...(typeof r.app?.id === 'number' ? { appId: r.app.id } : {}) }));
}
/** The check names (check runs and commit statuses) GitHub reports for `ref`; undefined = unreadable (with `both`: either read failed). */
export function ghCommitCheckNames(exec, repoArg, ref, cwd, both = false) {
    const [runsArgs, statusArgs] = commitChecksArgs(repoArg, ref);
    const runs = readJson(exec, runsArgs, cwd);
    const status = readJson(exec, statusArgs, cwd);
    if (both ? !runs || !status : !runs && !status)
        return undefined;
    const names = new Set();
    for (const r of Array.isArray(runs?.check_runs) ? runs.check_runs : [])
        if (typeof r?.name === 'string' && r.name)
            names.add(r.name);
    for (const s of Array.isArray(status?.statuses) ? status.statuses : [])
        if (typeof s?.context === 'string' && s.context)
            names.add(s.context);
    return [...names];
}
//# sourceMappingURL=checks.js.map