/**
 * The local forge's PRs (offline forge plan §1.1): numbers and states in the
 * engine-owned JSON store, heads and bases read from the bare mirror's refs.
 * A PR turns MERGED when its head is an ancestor of the mirror's base (the
 * human merged it and the next run/poll synced the base). Bodies and
 * comments are written for the human under `.omg/factory/local/prs/<n>/`.
 * There are no review threads (listThreads is omitted). Human review is
 * played back: `omg factory pr review` appends a record to the engine-owned
 * `<store>/prs/<n>/reviews.jsonl` (store.ts), which reviewFeedback reads.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isLocalBranchName, mergedArgs, readMirrorRef } from './mirror.js';
import { appendNoFollow, readLocalReviews, readPrStore, updatePrStore, writeAtomic } from './store.js';
/** ship's TRUSTED_READ_ENV, by value (importing ship/exec.ts would load child_process into src/forge). */
const TRUSTED_READ_ENV = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1' });
export const localPrUrl = (pr) => `omg-local://pr/${pr}`;
/** true/false from `git merge-base --is-ancestor`; undefined when git could not tell (a missing object). */
function isAncestor(ctx, head, base) {
    const r = ctx.exec('git', mergedArgs(head, base), { cwd: ctx.root, env: TRUSTED_READ_ENV });
    return r.status === 0 ? true : r.status === 1 ? false : undefined;
}
/**
 * Played-back reviews as forge feedback at `head`: each author's latest
 * record is their decision; a record with text, given on `head`, that does
 * not approve is an open thread (one given on an older head was answered by
 * the push since). The author is whoever ran the command: the records live
 * outside every lane-writable root, so nobody is ignored and nobody is pending.
 */
export function localReviewFeedback(records, head) {
    const latest = new Map();
    for (const r of records)
        latest.set(r.author, r);
    return {
        decisions: [...latest.values()].map((r) => ({ author: r.author, state: r.state, at: r.at, head: r.head })),
        threads: records.filter((r) => r.head === head && r.state !== 'approved' && r.body.trim() !== '')
            .map((r) => ({ id: r.id, author: r.author, body: r.body, at: r.at })),
        pendingReviewers: [],
        ignored: [],
    };
}
export function localReviews(ctx) {
    const ref = (branch) => readMirrorRef(ctx.mirror, branch);
    /** The PR with its state brought up to date (OPEN -> MERGED once the base contains the head). */
    const refresh = (pr) => {
        if (pr.state !== 'OPEN')
            return pr;
        const head = ref(pr.head);
        const base = ref(pr.base);
        if (!head || !base || head === base || isAncestor(ctx, head, base) !== true)
            return pr;
        return updatePrStore(ctx.storePath, (store) => {
            const p = store.prs.find((x) => x.number === pr.number);
            if (p.state === 'OPEN')
                Object.assign(p, { state: 'MERGED', mergedHead: head, mergedAt: new Date().toISOString() });
            return { ...p };
        });
    };
    const find = (pr) => {
        const p = readPrStore(ctx.storePath).prs.find((x) => x.number === pr);
        if (!p)
            throw new Error(`local PR #${pr} does not exist`);
        return refresh(p);
    };
    const view = (pr) => {
        const p = find(pr);
        const head = p.state === 'MERGED' ? (p.mergedHead ?? ref(p.head)) : ref(p.head);
        const base = ref(p.base);
        if (!head)
            throw new Error(`local PR #${pr}: branch ${p.head} is not in the mirror`);
        if (!base)
            throw new Error(`local PR #${pr}: base ${p.base} is not in the mirror`);
        return { number: p.number, state: p.state, isDraft: p.isDraft, baseRefName: p.base, baseRefOid: base, headRefName: p.head, headRefOid: head, url: localPrUrl(p.number) };
    };
    const humanFile = (pr, name) => join(ctx.humanDir, 'prs', String(pr), name);
    /** The runtime root (`humanDir` is `<omgRoot>/factory/local`): no link below it is followed. */
    const omgRoot = join(ctx.humanDir, '..', '..');
    return {
        refreshPr: refresh,
        reviewFeedback(pr, head) {
            find(pr);
            return localReviewFeedback(readLocalReviews(dirname(ctx.storePath), pr), head);
        },
        findOpenPrForBranch(branch) {
            return readPrStore(ctx.storePath).prs.filter((p) => p.head === branch && p.state === 'OPEN').map(refresh).find((p) => p.state === 'OPEN')?.number;
        },
        findMergedPrForBranch(branch, base) {
            return readPrStore(ctx.storePath).prs.filter((p) => p.head === branch && p.base === base).map(refresh).find((p) => p.state === 'MERGED')?.number;
        },
        createDraftPr(o) {
            if (!isLocalBranchName(o.head) || !isLocalBranchName(o.base))
                throw new Error(`local PR: ${o.head} -> ${o.base} is not a pair of plain branch names`);
            const head = ref(o.head);
            const base = ref(o.base);
            if (!head)
                throw new Error(`local PR: branch ${o.head} is not in the mirror (push it first)`);
            if (!base)
                throw new Error(`local PR: base ${o.base} is not in the mirror`);
            if (head === base || isAncestor(ctx, head, base) === true)
                throw new Error(`local PR: no commits between ${o.base} and ${o.head}`);
            const body = readFileSync(o.bodyFile, 'utf8');
            const number = updatePrStore(ctx.storePath, (store) => {
                const open = store.prs.find((p) => p.head === o.head && p.base === o.base && p.state === 'OPEN');
                if (open)
                    throw new Error(`local PR: #${open.number} is already open for ${o.head}`);
                const n = store.next++;
                store.prs.push({ number: n, head: o.head, base: o.base, title: o.title, state: 'OPEN', isDraft: true, ...(o.itemId === undefined ? {} : { itemId: o.itemId }), createdAt: new Date().toISOString() });
                return n;
            });
            writeAtomic(humanFile(number, 'body.md'), `# ${o.title}\n\n${body}`, omgRoot);
            return number;
        },
        viewPr: view,
        prHead(pr) {
            const v = view(pr);
            return { headRefOid: v.headRefOid, state: v.state };
        },
        markReady(pr) {
            updatePrStore(ctx.storePath, (store) => {
                const p = store.prs.find((x) => x.number === pr);
                if (!p)
                    throw new Error(`local PR #${pr} does not exist`);
                p.isDraft = false;
            });
        },
        closePr(pr, reason) {
            // A PR the base already contains is MERGED, never closed.
            const current = find(pr);
            if (current.state !== 'OPEN')
                return;
            const head = ref(current.head);
            updatePrStore(ctx.storePath, (store) => {
                const p = store.prs.find((x) => x.number === pr);
                if (p.state === 'OPEN')
                    Object.assign(p, { state: 'CLOSED', closedReason: reason, closedAt: new Date().toISOString(), ...(head ? { closedHead: head } : {}) });
            });
        },
        commentPr(pr, bodyFile) {
            try {
                if (!readPrStore(ctx.storePath).prs.some((x) => x.number === pr))
                    return { ok: false, stderr: `local PR #${pr} does not exist` };
                appendNoFollow(omgRoot, humanFile(pr, 'comments.md'), `\n<!-- ${new Date().toISOString()} -->\n${readFileSync(bodyFile, 'utf8').replace(/\n*$/, '\n')}`);
                return { ok: true, stderr: '' };
            }
            catch (err) {
                return { ok: false, stderr: err.message };
            }
        },
    };
}
//# sourceMappingURL=reviews.js.map