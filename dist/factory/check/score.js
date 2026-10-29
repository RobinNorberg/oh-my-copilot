/**
 * `omg factory check` results (factory forges design §5, cut by critic
 * amendments §A.11): every item gets its bucket from the hard rules
 * (rules.ts); there is no 5-factor score, so the order is bucket (runnable,
 * needs-plan, blocked), then priority (ADO Priority 1..4, GitHub
 * `priority:p0..p3` labels as 1..4; none last), then id. Items are read only
 * through `forge.tracker`; the open-PR lookup goes through `forge.reviews`.
 */
import { stripAnsi } from '../../utils/string-width.js';
import { evaluateItem } from './rules.js';
export const BUCKET_ORDER = ['runnable', 'needs-plan', 'blocked'];
/** Tracker text for a terminal: ANSI sequences dropped, then every control/format/separator character as a space. */
export const plainText = (v) => stripAnsi(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
/** ADO Priority, else a GitHub `priority:pN` label (p0 -> 1 ... p3 -> 4). */
export function itemPriority(item) {
    if (item.priority !== undefined && Number.isInteger(item.priority) && item.priority > 0)
        return item.priority;
    const label = item.labels.map((l) => /^priority:p([0-3])$/i.exec(l)?.[1]).find((p) => p !== undefined);
    return label === undefined ? null : Number(label) + 1;
}
export function compareResults(a, b) {
    return BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
        || (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
        || a.id - b.id;
}
/** gh prints a PR for `gh issue view <pr>`; the GitHub tracker refuses it with this message. */
const NOT_AN_ISSUE = /returned no issue url/;
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const failed = (id, reason, detail) => ({ id, title: '', url: '', bucket: 'blocked', reasons: [reason], detail: plainText(detail), priority: null, planSource: null });
/** An item, else a PR (a dependency may be one): open unless the forge says it is closed or merged; unreadable counts as open. */
function isOpen(forge, id) {
    try {
        return forge.tracker.viewItem(id).open;
    }
    catch {
        try {
            return forge.reviews.viewPr(id).state === 'OPEN';
        }
        catch {
            return true;
        }
    }
}
/**
 * The result of one item. A GitHub PR id is `wrong-type`; any other failed
 * read (the item, its run state, PR or branch lookup) is `read-failed`, so one
 * bad item never stops the batch.
 */
export function checkItem(forge, id, env) {
    let item;
    try {
        item = forge.tracker.viewItem(id);
    }
    catch (error) {
        if (forge.kind === 'github' && NOT_AN_ISSUE.test(messageOf(error)))
            return failed(id, 'wrong-type', `#${id} is not an issue (a pull request?)`);
        return failed(id, 'read-failed', `#${id} could not be read: ${messageOf(error)}`);
    }
    const look = {
        isOpen: (other) => isOpen(forge, other),
        runState: env.runState,
        openPr: (branch) => forge.reviews.findOpenPrForBranch(branch),
        remoteBranch: env.remoteBranch,
        readPlan: env.readPlan,
        planBase: env.planBase,
    };
    let v;
    try {
        v = evaluateItem(item, forge.kind, env.config, look);
    }
    catch (error) {
        return { ...failed(id, 'read-failed', `#${id} could not be checked: ${messageOf(error)}`), title: plainText(item.title), url: plainText(item.url), priority: itemPriority(item) };
    }
    return {
        id: item.id,
        title: plainText(item.title),
        url: plainText(item.url),
        bucket: v.bucket,
        reasons: v.reasons,
        detail: plainText(v.detail),
        priority: itemPriority(item),
        planSource: v.planSource ?? null,
    };
}
/** Every id once, checked and ordered. */
export function checkItems(forge, ids, env) {
    return [...new Set(ids)].map((id) => checkItem(forge, id, env)).sort(compareResults);
}
/**
 * The scorer for the setup wizard's `PreviewCheck` hook
 * (`(forge, ids) => PreviewRow[]`): `deps.previewCheck = factoryCheckPreview(env)`.
 * Readiness is the bucket and its reason, e.g. `blocked: pr-exists`.
 */
export function factoryCheckPreview(env) {
    return (forge, ids) => checkItems(forge, ids, env).map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        readiness: r.reasons.length > 0 ? `${r.bucket}: ${r.reasons[0]}` : r.bucket,
    }));
}
//# sourceMappingURL=score.js.map