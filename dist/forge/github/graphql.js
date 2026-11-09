/**
 * The one GraphQL read of the GitHub forge (factory night 3, goal 2): the
 * human review input on one pull request. The factory guards refuse every
 * `gh api` except this exact argv (reviewFeedbackArgs): the query text is the
 * constant below, the repository is the configured one, the PR a number.
 *
 * Trust (decision D3): a reviewer counts when their login is in
 * `factory.review.trustedReviewers`, or when the same query reports write
 * access or more for them (the repository's first 100 collaborators, and the
 * viewer's own permission). Anyone else's review, comment or thread reply is
 * dropped and their login listed in `ignored`. Bodies are returned as
 * untrusted data: nothing here reads meaning into them.
 */
import { ADO_FACTORY_COMMENT_MARKER } from '../ado/reviews.js';
/**
 * The query, one line (no argv newline on any platform). `owner` and `name`
 * go in as raw strings (`-f`, never gh's `@file` form), `number` as an integer (`-F`).
 */
export const REVIEW_FEEDBACK_QUERY = 'query($owner:String!,$name:String!,$number:Int!){viewer{login}'
    + ' repository(owner:$owner,name:$name){viewerPermission collaborators(first:100){edges{permission node{login}}}'
    + ' pullRequest(number:$number){headRefOid'
    + ' latestReviews(first:50){nodes{id state submittedAt body author{login} commit{oid}}}'
    + ' reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}}}}'
    + ' reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:20){nodes{body path line originalLine createdAt author{login}}}}}}}}';
/** A GitHub login or repository name (conservative: no option shape, no `@`, no `/`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** One thread or review body handed on, at most (the fix prompt fences it). */
export const MAX_FEEDBACK_BODY_CHARS = 8_000;
const TRUNCATED = '\n(truncated)';
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
/** `gh` argv of the read for `pr` on `repo`. Throws on names the guard would refuse. */
export function reviewFeedbackArgs(repo, pr) {
    if (!HOST.test(repo.host) || !NAME.test(repo.owner) || !NAME.test(repo.name) || !Number.isSafeInteger(pr) || !NUMBER.test(String(pr))) {
        throw new Error(`review feedback: ${repo.host}/${repo.owner}/${repo.name} #${pr} is not a plain GitHub repository and PR number`);
    }
    return ['api', 'graphql', '--hostname', repo.host, '-f', `query=${REVIEW_FEEDBACK_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${pr}`];
}
/**
 * The guard clause shared by the run and read guards: `args` is exactly
 * reviewFeedbackArgs for the repository `repoArg` (ghRepoArg:
 * `HOST/OWNER/NAME`) and some PR number. Names compare case-insensitively,
 * as GitHub resolves them. Without a repository context it is refused.
 */
export function isReviewFeedbackArgs(args, repoArg) {
    if (repoArg === undefined || args.length !== 12)
        return false;
    const parts = repoArg.split('/');
    if (parts.length !== 3)
        return false;
    const [host, owner, name] = parts;
    if (!HOST.test(host) || !NAME.test(owner) || !NAME.test(name))
        return false;
    const value = (arg, key) => (arg.startsWith(`${key}=`) ? arg.slice(key.length + 1) : '');
    const o = value(args[7], 'owner');
    const n = value(args[9], 'name');
    const pr = value(args[11], 'number');
    return args[0] === 'api' && args[1] === 'graphql' && args[2] === '--hostname' && args[3].toLowerCase() === host.toLowerCase()
        && args[4] === '-f' && args[5] === `query=${REVIEW_FEEDBACK_QUERY}`
        && args[6] === '-f' && NAME.test(o) && o.toLowerCase() === owner.toLowerCase()
        && args[8] === '-f' && NAME.test(n) && n.toLowerCase() === name.toLowerCase()
        && args[10] === '-F' && NUMBER.test(pr);
}
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);
const nodes = (v) => (isObj(v) && Array.isArray(v.nodes) ? v.nodes.filter(isObj) : []);
const login = (v) => {
    const l = isObj(v) ? str(v.login) : undefined;
    return l && NAME.test(l) ? l : undefined;
};
/** A body the factory posted (its hidden marker as the last line): never human input. */
export function isFactoryComment(body) {
    return body.trimEnd().split('\n').pop()?.trim() === ADO_FACTORY_COMMENT_MARKER;
}
const capped = (body) => (body.length <= MAX_FEEDBACK_BODY_CHARS ? body : `${body.slice(0, MAX_FEEDBACK_BODY_CHARS - TRUNCATED.length)}${TRUNCATED}`);
const DECISION = {
    APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending',
};
/**
 * The feedback in one GraphQL response (stdout of reviewFeedbackArgs) at
 * `head`. Throws when the response carries no pull request (an unknown PR, a
 * failed query). A review body counts as a thread only when the review was
 * submitted on `head` (an older head's summary was answered by a later push);
 * inline threads count while unresolved and not outdated.
 */
export function parseReviewFeedback(stdout, head, trust) {
    let json;
    try {
        json = JSON.parse(stdout);
    }
    catch {
        throw new Error('review feedback: gh api graphql printed no JSON');
    }
    const data = isObj(json) && isObj(json.data) ? json.data : {};
    const repo = isObj(data.repository) ? data.repository : undefined;
    const pull = repo && isObj(repo.pullRequest) ? repo.pullRequest : undefined;
    if (!repo || !pull) {
        const first = isObj(json) && Array.isArray(json.errors) && isObj(json.errors[0]) ? str(json.errors[0].message) : undefined;
        throw new Error(`review feedback: no pull request in the response${first ? ` (${first.slice(0, 200)})` : ''}`);
    }
    const trusted = new Set(trust.trustedReviewers.map((l) => l.toLowerCase()));
    const collaborators = isObj(repo.collaborators) && Array.isArray(repo.collaborators.edges) ? repo.collaborators.edges.filter(isObj) : [];
    for (const e of collaborators) {
        const l = login(e.node);
        if (l && WRITE_PERMISSIONS.has(str(e.permission) ?? ''))
            trusted.add(l.toLowerCase());
    }
    const viewer = login(data.viewer);
    if (viewer && WRITE_PERMISSIONS.has(str(repo.viewerPermission) ?? ''))
        trusted.add(viewer.toLowerCase());
    const ignored = new Set();
    const counts = (author) => {
        if (!author)
            return false;
        if (trusted.has(author.toLowerCase()))
            return true;
        ignored.add(author);
        return false;
    };
    const decisions = [];
    const threads = [];
    for (const r of nodes(pull.latestReviews)) {
        const author = login(r.author);
        const state = DECISION[str(r.state) ?? ''];
        const body = str(r.body) ?? '';
        if (!state || isFactoryComment(body) || !counts(author))
            continue;
        const at = str(r.submittedAt) ?? '';
        const oid = isObj(r.commit) ? str(r.commit.oid) : undefined;
        const reviewHead = oid && HEX40.test(oid) ? oid : undefined;
        decisions.push({ author, state, at, ...(reviewHead ? { head: reviewHead } : {}) });
        const id = str(r.id);
        if (id && body.trim() && reviewHead === head && (state === 'changes-requested' || state === 'commented')) {
            threads.push({ id: `review:${id}`, author, body: capped(body), at });
        }
    }
    for (const t of nodes(pull.reviewThreads)) {
        const id = str(t.id);
        if (!id || t.isResolved !== false || t.isOutdated !== false)
            continue;
        const kept = nodes(t.comments).flatMap((c) => {
            const author = login(c.author);
            const body = str(c.body) ?? '';
            return body.trim() && !isFactoryComment(body) && counts(author) ? [{ author, body, c }] : [];
        });
        if (kept.length === 0)
            continue;
        const first = kept[0];
        const path = str(first.c.path);
        const line = [first.c.line, first.c.originalLine].find((v) => Number.isSafeInteger(v) && v > 0);
        const body = kept.length === 1 ? first.body : kept.map((k) => `@${k.author}:\n${k.body}`).join('\n\n');
        const at = kept.map((k) => str(k.c.createdAt) ?? '').sort().pop() ?? '';
        threads.push({ id, author: first.author, body: capped(body), ...(path ? { file: path } : {}), ...(line ? { line } : {}), at });
    }
    const pending = new Set();
    for (const q of nodes(pull.reviewRequests)) {
        const who = isObj(q.requestedReviewer) ? q.requestedReviewer : {};
        const slug = str(who.slug);
        const name = login(who) ?? (slug && NAME.test(slug) ? `team:${slug}` : undefined);
        if (name)
            pending.add(name);
    }
    return {
        decisions,
        threads,
        pendingReviewers: [...pending],
        ignored: [...ignored].filter((l) => !trusted.has(l.toLowerCase())).sort(),
    };
}
//# sourceMappingURL=graphql.js.map