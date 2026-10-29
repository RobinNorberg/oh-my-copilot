/**
 * GitHub pull requests (factory forges design §2, PR 2): the `gh pr` reads
 * and writes of `omg ship`, the gates driver and the factory engine, moved
 * verbatim. Engine-step calls throw GhCommandError with the engine's own
 * message (src/forge/github/gh.ts); the others keep their callers' result
 * handling.
 */
import { GhCommandError, ghJson, ghRun } from './gh.js';
/** `gh pr view --json` fields the merge step reads. */
export const MERGE_VIEW_FIELDS = 'number,state,isDraft,baseRefName,baseRefOid,headRefOid';
const HEX40 = /^[0-9a-f]{40}$/;
/** Parse `gh pr view --json MERGE_VIEW_FIELDS`; null when a field is missing or malformed. */
export function parseMergeView(stdout) {
    let v;
    try {
        v = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    if (typeof v !== 'object' || v === null)
        return null;
    const ok = typeof v.number === 'number' && typeof v.state === 'string' && typeof v.isDraft === 'boolean' && typeof v.baseRefName === 'string'
        && typeof v.baseRefOid === 'string' && HEX40.test(v.baseRefOid) && typeof v.headRefOid === 'string' && HEX40.test(v.headRefOid);
    return ok ? v : null;
}
/** `gh pr view <pr> --json <fields>` in the process cwd (the `omg ship` CLI reads); the caller parses. */
export function ghPrView(exec, pr, fields) {
    return exec('gh', ['pr', 'view', String(pr), '--json', fields]);
}
/** `gh pr view <pr> --json headRefOid,state`; throws on anything but a full sha and a state. */
export function ghPrHead(exec, pr, cwd) {
    const res = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,state'], { cwd });
    let v = {};
    try {
        v = JSON.parse(res.stdout);
    }
    catch { /* checked below */ }
    if (res.status !== 0 || typeof v.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(v.headRefOid) || typeof v.state !== 'string') {
        throw new Error(`gh pr view ${pr} did not return a head sha and state (exit ${res.status}): ${res.stderr.trim()}`);
    }
    return { headRefOid: v.headRefOid, state: v.state };
}
/** The engine's review read: `gh pr view <pr> --json headRefOid,state`, fields unchecked. */
export function ghPrHeadState(exec, pr, cwd) {
    return ghJson(exec, ['pr', 'view', String(pr), '--json', 'headRefOid,state'], cwd);
}
/** `gh pr list --head <branch> --json number,state,headRefOid,url` as printed (open PRs only, gh's default). */
export function ghOpenPrs(exec, branch, cwd) {
    return ghJson(exec, ['pr', 'list', '--head', branch, '--json', 'number,state,headRefOid,url'], cwd);
}
/** The first open PR's number on `branch`, if gh reports one. */
export function ghFindOpenPr(exec, branch, cwd) {
    const open = ghOpenPrs(exec, branch, cwd);
    return Array.isArray(open) && typeof open[0]?.number === 'number' ? open[0].number : undefined;
}
/** `gh pr create --draft`; the new PR's number from the url gh prints. */
export function ghCreateDraftPr(exec, o, cwd) {
    const out = ghRun(exec, ['pr', 'create', '--draft', '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', o.bodyFile], cwd);
    const m = /\/pull\/(\d+)/.exec(out);
    if (!m)
        throw new GhCommandError(`gh pr create printed no PR url: ${out.trim().slice(0, 200)}`);
    return Number(m[1]);
}
/** `gh pr view <pr> --json MERGE_VIEW_FIELDS`. */
export function ghMergeView(exec, pr, cwd) {
    const view = parseMergeView(ghRun(exec, ['pr', 'view', String(pr), '--json', MERGE_VIEW_FIELDS], cwd));
    if (!view || view.number !== pr)
        throw new GhCommandError(`gh pr view ${pr} did not return the PR's state, base and head`);
    return view;
}
/** `gh pr ready <pr>`. */
export function ghMarkReady(exec, pr, cwd) {
    ghRun(exec, ['pr', 'ready', String(pr)], cwd);
}
/** `gh pr comment <pr> --body-file <file>`; never throws on a gh failure. */
export function ghCommentPr(exec, pr, bodyFile, cwd) {
    const res = exec('gh', ['pr', 'comment', String(pr), '--body-file', bodyFile], { cwd });
    return { ok: res.status === 0, stderr: res.stderr };
}
/** `gh repo view --json url` as printed (the ci-heal intake checks the url). */
export function ghRepoView(exec, cwd) {
    return ghJson(exec, ['repo', 'view', '--json', 'url'], cwd);
}
/** The ForgePr fields, the same list `omg ship merge` reads. */
export const PR_VIEW_FIELDS = 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,url';
const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED']);
/** `gh pr view <pr> --json PR_VIEW_FIELDS`; throws on a missing or malformed field. */
export function ghViewPr(exec, pr, cwd) {
    const v = ghJson(exec, ['pr', 'view', String(pr), '--json', PR_VIEW_FIELDS], cwd);
    const ok = typeof v === 'object' && v !== null && v.number === pr && typeof v.state === 'string' && PR_STATES.has(v.state)
        && typeof v.isDraft === 'boolean' && typeof v.baseRefName === 'string' && typeof v.baseRefOid === 'string' && HEX40.test(v.baseRefOid)
        && typeof v.headRefName === 'string' && typeof v.headRefOid === 'string' && HEX40.test(v.headRefOid) && typeof v.url === 'string';
    if (!ok)
        throw new GhCommandError(`gh pr view ${pr} did not return the PR's state, base and head`);
    return v;
}
export function githubReviews(exec, cwd) {
    return {
        findOpenPrForBranch: (branch) => ghFindOpenPr(exec, branch, cwd),
        createDraftPr: (o) => ghCreateDraftPr(exec, o, cwd),
        viewPr: (pr) => ghViewPr(exec, pr, cwd),
        prHead: (pr) => ghPrHead(exec, pr, cwd),
        markReady: (pr) => ghMarkReady(exec, pr, cwd),
        commentPr: (pr, bodyFile) => ghCommentPr(exec, pr, bodyFile, cwd),
    };
}
//# sourceMappingURL=reviews.js.map