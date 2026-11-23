/**
 * `omg factory check` results (factory forges design §5, cut by critic
 * amendments §A.11): every item gets its bucket from the hard rules
 * (rules.ts); there is no 5-factor score, so the order is bucket (runnable,
 * needs-plan, blocked), then priority (ADO Priority 1..4, GitHub
 * `priority:p0..p3` labels as 1..4; none last), then id. Items are read only
 * through `forge.tracker`; the open-PR lookup goes through `forge.reviews`.
 */
import { stripAnsi } from '../../utils/string-width.js';
import { FactorySafetyError } from '../run/exec.js';
import { factoryBranch } from '../run/state.js';
import { evaluateItem } from './rules.js';
export const BUCKET_ORDER = ['runnable', 'needs-plan', 'blocked'];
/**
 * Selectors that only pick a glyph form and draw nothing themselves: the
 * variation selectors (VS16 in emoji and keycaps), the Mongolian free
 * variation selectors and the tag characters (tag-sequence flags). Deleted,
 * so an emoji or a flag keeps its look instead of gaining a space.
 */
// eslint-disable-next-line no-misleading-character-class -- the selectors are listed on purpose, each one alone
const GLYPH_SELECTORS = /[\u180B-\u180D\u180F\uFE00-\uFE0F\u{E0001}\u{E0020}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/**
 * Tracker text for a terminal: ANSI sequences dropped, the glyph selectors
 * above deleted, then every control/format/separator character as a space,
 * and so is every code point a terminal draws as blank or nothing although
 * it is neither (the Hangul fillers, blank braille, the combining grapheme
 * joiner, the Khmer invisible marks, the Mongolian vowel separator, U+2065,
 * U+16FE4), every private-use, surrogate and unassigned code point (a font
 * may draw any of them blank): such filler could pad text out to look like
 * a separate line.
 */
export const plainText = (v) => stripAnsi(v).replace(GLYPH_SELECTORS, '')
    // eslint-disable-next-line no-misleading-character-class -- the combining marks are listed on purpose, each one alone
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}\u034F\u115F\u1160\u17B4\u17B5\u180E\u2065\u2800\u3164\uFFA0\u{16FE4}\u{E0000}-\u{E0FFF}]/gu, ' ');
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
/**
 * An item, else (GitHub) a PR: open unless the forge says it is closed or
 * merged; unreadable counts as open. ADO work items and PRs are separate id
 * namespaces, so there a failed item read never falls back to the PR.
 */
function isOpen(forge, id) {
    try {
        return forge.tracker.viewItem(id).open;
    }
    catch {
        if (forge.kind === 'azure-devops')
            return true;
        try {
            return forge.reviews.viewPr(id).state === 'OPEN';
        }
        catch {
            return true;
        }
    }
}
/**
 * A dependency is satisfied when its factory run merged, the item is closed,
 * or (still open) a PR from `factory/issue-<n>` merged into `base`: with a
 * base other than the default branch, `Closes #n` never closes the issue
 * (shipyard ↔ factory design §3.5). A dependency that is a GitHub PR is
 * satisfied once merged (closed unmerged is not); on ADO a failed work-item
 * read never falls back to the PR with that number (separate id namespaces).
 * Anything unreadable is unsatisfied, but a guard refusal (FactorySafetyError)
 * is rethrown: it is a bug, never an unfinished dependency. The engine's
 * blocked-by intake gate shares this rule (engine.ts), so check and run cannot drift.
 */
export function isSatisfied(forge, id, base, runState) {
    if (runState(id)?.phase === 'merged')
        return true;
    const unreadable = (error) => {
        if (error instanceof FactorySafetyError)
            throw error;
        return false;
    };
    let item;
    try {
        item = forge.tracker.viewItem(id);
    }
    catch (error) {
        if (forge.kind === 'azure-devops')
            return unreadable(error);
        try {
            return forge.reviews.viewPr(id).state === 'MERGED';
        }
        catch (prError) {
            return unreadable(error instanceof FactorySafetyError ? error : prError);
        }
    }
    if (!item.open)
        return true;
    try {
        return forge.reviews.findMergedPrForBranch(factoryBranch(id), base) !== undefined;
    }
    catch (error) {
        return unreadable(error);
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
        isSatisfied: (dep) => isSatisfied(forge, dep, env.base, env.runState),
        runState: env.runState,
        openPr: (branch) => forge.reviews.findOpenPrForBranch(branch),
        mergedPr: (branch) => forge.reviews.findMergedPrForBranch(branch, env.base),
        remoteBranch: env.remoteBranch,
        readPlan: env.readPlan,
        planBase: env.planBase,
    };
    let v;
    try {
        v = evaluateItem(item, forge.kind, env.config, look);
    }
    catch (error) {
        if (error instanceof FactorySafetyError)
            throw error;
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