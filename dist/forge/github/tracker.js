/**
 * GitHub issues as the factory tracker (factory forges design §2, PR 2): the
 * engine's `gh issue view` / `gh issue comment` moved verbatim, plus the
 * ForgeTracker reads and label writes, plus the `omg factory enqueue` item
 * writes (shipyard-factory design PR 7a), which pass the factory guard only
 * with enqueue's TrackerWriteContext (src/factory/run/exec.ts).
 */
import { commentTrusted, issueAuthorTrusted } from '../../factory/run/plan-rules.js';
import { shipyardKeys, shipyardKeySearch, } from '../types.js';
import { GhCommandError, ghJson, ghRepoArg, ghRun } from './gh.js';
/** `gh issue view --json` fields the engine reads (author: whose body `omg-plan:` line counts). */
export const ISSUE_FIELDS = 'title,body,labels,state,url,author,comments';
/** `gh issue view <id> --json ISSUE_FIELDS` (the engine's dry run handles the result itself). */
export function ghIssueView(exec, issue, cwd) {
    return exec('gh', ['issue', 'view', String(issue), '--json', ISSUE_FIELDS], { cwd });
}
/** ghIssueView as an engine step: GhCommandError on failure or no JSON; fields unchecked. */
export function ghIssueJson(exec, issue, cwd) {
    return ghJson(exec, ['issue', 'view', String(issue), '--json', ISSUE_FIELDS], cwd);
}
/** `gh issue comment <id> --body-file <file>`; never throws on a gh failure. */
export function ghIssueComment(exec, issue, bodyFile, cwd) {
    const res = exec('gh', ['issue', 'comment', String(issue), '--body-file', bodyFile], { cwd });
    return { ok: res.status === 0, stderr: res.stderr };
}
const str = (v) => (typeof v === 'string' ? v : '');
const login = (author) => str(author?.login);
const refs = (body, re) => [...new Set([...body.matchAll(re)].map((m) => Number(m[1])))];
/** `gh issue view` as a ForgeItem; throws GhCommandError when it is not the issue asked for. */
export function ghViewItem(exec, issue, cwd) {
    const v = ghIssueJson(exec, issue, cwd);
    const url = str(v?.url);
    const m = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/issues\/(\d+)$/.exec(url);
    if (!m || Number(m[2]) !== issue)
        throw new GhCommandError(`gh issue view ${issue} returned no issue url`);
    const body = str(v.body);
    const labels = Array.isArray(v.labels) ? v.labels.map((l) => str(l?.name)).filter(Boolean) : [];
    const comments = Array.isArray(v.comments) ? v.comments : [];
    const size = labels.map((l) => /^size:(\d+)$/i.exec(l)?.[1]).find(Boolean);
    const parent = /^[^\S\r\n]*part of[^\S\r\n]+#(\d+)\b/im.exec(body)?.[1];
    return {
        id: issue,
        url,
        title: str(v.title),
        body,
        open: v.state === 'OPEN',
        rawState: str(v.state),
        authorTrusted: issueAuthorTrusted(v),
        comments: comments.map((c) => ({ body: str(c?.body), author: login(c?.author), trusted: commentTrusted(c ?? {}) })),
        labels,
        ...(size ? { size: Number(size) } : {}),
        dependsOn: refs(body, /^[^\S\r\n]*(?:depends on|blocked by)[^\S\r\n]+#(\d+)\b/gim),
        children: refs(body, /^[^\S\r\n]*[-*][^\S\r\n]+\[[ xX]\][^\S\r\n]+#(\d+)\b/gm),
        ...(parent ? { parent: Number(parent) } : {}),
        repoUrl: m[1],
    };
}
/** Open issue numbers for a label or milestone source; the ADO sources are refused. */
export function ghQueryItems(exec, source, limit, cwd) {
    const filter = source.type === 'label' ? ['--label', source.label] : source.type === 'milestone' ? ['--milestone', source.milestone] : null;
    if (!filter)
        throw new GhCommandError(`intake source ${source.type} is not a GitHub source`);
    const list = ghJson(exec, ['issue', 'list', ...filter, '--state', 'open', '--json', 'number', '--limit', String(limit)], cwd);
    if (!Array.isArray(list))
        throw new GhCommandError('gh issue list returned no JSON array');
    return list.map((e) => e?.number).filter((n) => typeof n === 'number');
}
/** `gh issue edit <id>` with the given label flags; never throws. */
function editLabels(exec, issue, flags, cwd) {
    try {
        const res = exec('gh', ['issue', 'edit', String(issue), ...flags], { cwd });
        return { ok: res.status === 0, stderr: res.stderr };
    }
    catch (error) {
        return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * A stage's label; the other stages' labels are removed (one label family).
 * GitHub progress is labels only: a column or state mapping is ignored.
 * `cancelled` removes the whole family (design §7).
 */
export function ghSetProgress(exec, issue, stage, mapping, stages, cwd) {
    const family = [...new Set(Object.values(stages).map((m) => m?.label).filter((l) => Boolean(l)))];
    if (stage === 'cancelled') {
        if (family.length === 0)
            return { ok: true, detail: 'no label family' };
        const res = editLabels(exec, issue, family.flatMap((l) => ['--remove-label', l]), cwd);
        return { ok: res.ok, detail: res.ok ? 'label family removed' : res.stderr.trim() };
    }
    if (!mapping.label)
        return { ok: true, detail: `no label for stage ${stage}` };
    const others = family.filter((l) => l !== mapping.label);
    const res = editLabels(exec, issue, ['--add-label', mapping.label, ...others.flatMap((l) => ['--remove-label', l])], cwd);
    return { ok: res.ok, detail: res.ok ? `label ${mapping.label}` : res.stderr.trim() };
}
/** findByKey's one search page; GitHub search returns at most 1000 results. */
const KEY_SEARCH_LIMIT = 1000;
const sameUrl = (a, b) => a.toLowerCase() === b.toLowerCase();
/**
 * The issues of `repo` with exactly one `shipyard-key: <spec>/<key>` line,
 * found by `gh issue list --search` and then read with `gh issue view` (for
 * trust and parent). A body whose key differs between the two reads, or an
 * issue of another repository, is skipped.
 */
export function ghFindByKey(exec, repo, spec, cwd) {
    const args = ['issue', 'list', '--repo', ghRepoArg(repo), '--search', shipyardKeySearch(spec), '--state', 'all', '--json', 'number,body', '--limit', String(KEY_SEARCH_LIMIT)];
    const list = ghJson(exec, args, cwd);
    if (!Array.isArray(list))
        throw new GhCommandError('gh issue list returned no JSON array');
    const keyOf = (body) => {
        const keys = shipyardKeys(body).filter(([s]) => s === spec);
        return keys.length === 1 ? keys[0][1] : undefined;
    };
    const found = [];
    for (const e of list) {
        const n = e?.number;
        const key = keyOf(str(e?.body));
        if (typeof n !== 'number' || !key)
            continue;
        const item = ghViewItem(exec, n, cwd);
        if (keyOf(item.body) === key && sameUrl(item.repoUrl, repo.url))
            found.push({ key, item });
    }
    return found;
}
/** `gh issue create` from a body file; the new issue's number from the url gh prints. */
export function ghCreateItem(exec, repo, draft, cwd) {
    const args = ['issue', 'create', '--repo', ghRepoArg(repo), '--title', draft.title, '--body-file', draft.bodyFile, ...draft.labels.flatMap((l) => ['--label', l])];
    const url = ghRun(exec, args, cwd).trim().split('\n').pop().trim();
    const m = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/issues\/(\d+)$/.exec(url);
    if (!m || !sameUrl(m[1], repo.url))
        throw new GhCommandError(`gh issue create printed no issue url of ${repo.url}`);
    return Number(m[2]);
}
/** `gh issue edit`: title and body from a body file, then label adds and removes. */
export function ghUpdateItem(exec, repo, id, update, cwd) {
    ghRun(exec, [
        'issue', 'edit', String(id), '--repo', ghRepoArg(repo), '--title', update.title, '--body-file', update.bodyFile,
        ...update.addLabels.flatMap((l) => ['--add-label', l]), ...update.removeLabels.flatMap((l) => ['--remove-label', l]),
    ], cwd);
}
export function githubTracker(exec, cwd, config) {
    return {
        viewItem: (id) => ghViewItem(exec, id, cwd),
        queryItems: (source, limit) => ghQueryItems(exec, source, limit, cwd),
        comment: (id, bodyFile) => ghIssueComment(exec, id, bodyFile, cwd),
        setProgress: (id, stage, mapping) => ghSetProgress(exec, id, stage, mapping, config.progress.stages, cwd),
        addMarker: (id, marker) => editLabels(exec, id, ['--add-label', marker], cwd),
        findByKey: (spec) => ghFindByKey(exec, config.repo, spec, cwd),
        createItem: (draft) => ghCreateItem(exec, config.repo, draft, cwd),
        updateItem: (id, update) => ghUpdateItem(exec, config.repo, id, update, cwd),
    };
}
//# sourceMappingURL=tracker.js.map