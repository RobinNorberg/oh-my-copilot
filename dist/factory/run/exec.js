/**
 * The `omg factory run` command guard: ship's allowlist (src/ship/exec.ts)
 * extended with the exact shapes the factory engine builds (design §4).
 *
 * - Pushes: only `git push origin <sha40>:refs/heads/factory/<name>`, plain
 *   (no `+`, no flags), never a protected branch. Ship's `HEAD:refs/heads/<b>`
 *   push shape is refused here: the factory pushes nothing else.
 * - GitHub: `gh issue view|comment`, `gh pr create --draft|comment|list|ready`
 *   (one `pr list` is the blocked-by gate's merged lookup on `factory/issue-<n>`)
 *   and `gh repo view --json url` (ci-heal runs) in fixed shapes, plus ship's
 *   `gh pr view|checks` and `gh run list|view|rerun`.
 *   Never `gh api`, `gh -R`, or a merge (merge is always human), except the
 *   human review read (src/forge/github/graphql.ts isReviewFeedbackArgs:
 *   `gh api graphql` with its constant query, pinned to the GithubReadContext
 *   repo) and the three coding-agent shapes below.
 * - Tracker writes (`omg factory enqueue` only, when its TrackerWriteContext is
 *   set): `gh issue create`, `gh issue edit` (title, body, labels) and the
 *   `shipyard-key:` search `gh issue list --search`, each in one exact shape,
 *   pinned to the configured repository, with a body file from the caller's
 *   own directory (gh reads the guard's checked copy) and labels from its allowlist. Never close
 *   (the factory's only close is the coding-agent PR close, bound to CodingAgentContext.pr), delete,
 *   transfer or lock; without the context all three shapes are refused.
 * - The Copilot coding agent (src/forge/github/coding-agent.ts), beside the
 *   review read: its fixed-query `gh api graphql` status read with the
 *   repository-only GithubReadContext; its two writes only with a
 *   CodingAgentContext, which the engine sets around that one step: the REST
 *   assign of exactly the context's issue on exactly its base, and
 *   `gh pr close` of exactly its `pr` (the agent's own PR; the tracker never
 *   closes). Without that context both writes are refused.
 * - Adopting the coding agent's PR (src/factory/run/coding-agent-lane.ts):
 *   `git fetch --no-tags --refmap= origin refs/pull/<n>/head` (only
 *   FETCH_HEAD moves; only with a step context whose `adopt` is `<n>`),
 *   `git rev-parse --verify FETCH_HEAD^{commit}`, `git merge-base <sha40> <sha40>`,
 *   `git ls-tree -r -z --full-tree <sha40>`, and the link comment
 *   `gh pr comment <pr> --repo <HOST/OWNER/NAME> --body-file <f>` only with a
 *   step context naming that `pr` and the link's numbers, run with the guard's
 *   own copy of the body, which must be exactly the factory's link text.
 * - Azure DevOps: `az devops invoke` on the routes.ts allowlist only, as the
 *   resolved az entry, for the run's forge repo (src/forge/ado/guard.ts).
 *   The work item create and the PATCH's item fields and links pass only with
 *   the TrackerWriteContext (shipyard-factory design PR 7b).
 * - The engine-owned prepare checkout: `git worktree add -B <its branch>
 *   <abs path> <sha40>` and `git merge --abort` (ship's prepare shapes run in it).
 * - Read-only git for the lane tamper check (review-guard.ts) and the review
 *   prompt's diff (no external diff driver, no textconv) and its standards
 *   files (`ls-tree` of docs/standards/ at the base commit).
 * - Every engine git command runs hardened (hardenedGitExec): no hooks and no
 *   fsmonitor, so a hook or fsmonitor a lane planted cannot run in the engine
 *   even if the tamper check missed it.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { checkAdoCommand, isAdoCommand, runGuardedAdo } from '../../forge/ado/guard.js';
import { isBodyFileIn, readTrackerBody } from '../../forge/body-file.js';
import { isCodingAgentAssignArgs, isCodingAgentCloseArgs, isCodingAgentStatusArgs } from '../../forge/github/coding-agent.js';
import { CODING_AGENT_LINK_BODY_ARG, codingAgentLinkBodyProblem, isCodingAgentGitArgs, isCodingAgentLinkCommentArgs } from './coding-agent-lane.js';
import { isReviewFeedbackArgs } from '../../forge/github/graphql.js';
import { LOCAL_REMOTE, STATE_CHANGE_LOG_FLAGS } from '../../forge/local/mirror.js';
import { assertSafeCommand, isTrustedFetch, PROTECTED_BRANCHES, ShipSafetyError, TRUSTED_READ_ENV } from '../../ship/exec.js';
import { triageWriteGh } from '../triage/guard.js';
/** Every branch the factory pushes starts with this prefix (fixed, not configurable). */
export const FACTORY_BRANCH_PREFIX = 'factory/';
export { MAX_TRACKER_BODY_CHARS } from '../../forge/body-file.js';
export class FactorySafetyError extends ShipSafetyError {
    constructor(message) {
        super(message);
        this.name = 'FactorySafetyError';
    }
}
const NUMBER = /^\d+$/;
const JSON_FIELDS = /^[A-Za-z]+(?:,[A-Za-z]+)*$/;
const BRANCH = /^[\w.][\w./-]*$/;
const REPO_PATH = /^[\w.][\w.-]*(?:\/[\w.][\w.-]*)*$/;
/** A plain repo-relative path for the local backlog shapes, shared with the check guard: no `.` or `..` segment. */
export const isPlainRepoPath = (p) => REPO_PATH.test(p) && !p.split('/').some((seg) => seg === '.' || seg === '..');
export const FOR_EACH_REF_FORMAT = '--format=%(refname) %(objectname)';
/** The local branch of the engine-owned prepare checkout (getBranchName(FACTORY_CHECKOUT_TEAM, `issue-<n>` or `heal-<sig8>`)). */
const CHECKOUT_BRANCH = /^omc-team\/factory-run\/(?:issue-\d+|heal-[0-9a-f]{8})$/;
const isBranch = (s) => typeof s === 'string' && BRANCH.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
const isFile = (s) => typeof s === 'string' && s.length > 0 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
/** One line of visible text: no control or format characters (tab, newline, NUL, bidi overrides such as RLO). */
const isTitle = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !s.startsWith('-') && !/[\p{Cc}\p{Cf}]/u.test(s);
const same = (args, shape) => args.length === shape.length && shape.every((v, i) => args[i] === v);
/** A progress label of the factory family (factory forges design §7): `factory:<stage>`. */
const FACTORY_LABEL = /^factory:[a-z0-9][a-z0-9-]{0,40}$/;
/**
 * Progress sync's label write: `issue edit <n> [--add-label <factory:*>] (--remove-label <factory:*>)*`,
 * at least one flag, one add at most, factory labels only and each once.
 */
function isProgressLabelEdit(r) {
    if (r.length < 3 || r.length % 2 === 0 || !NUMBER.test(r[0]))
        return false;
    const labels = [];
    let adds = 0;
    for (let i = 1; i < r.length; i += 2) {
        if (r[i] === '--add-label') {
            if (i !== 1 || ++adds > 1)
                return false;
        }
        else if (r[i] !== '--remove-label') {
            return false;
        }
        if (!FACTORY_LABEL.test(r[i + 1]) || labels.includes(r[i + 1]))
            return false;
        labels.push(r[i + 1]);
    }
    return true;
}
/** shipyardKeySearch (src/forge/types.ts) for any spec. */
const KEY_SEARCH = /^"shipyard-key: \d+\/" in:body$/;
/** At most this many labels on one write (an intake label and a priority, plus the old priority removed). */
const MAX_WRITE_LABELS = 4;
const isWriteLabel = (s, ctx) => typeof s === 'string' && ctx.labels.includes(s) && !/^(?:factory|harbor):/i.test(s) && /^[^,\s-][^,\r\n\0]{0,49}$/.test(s);
const isBodyFile = (s, ctx) => isFile(s) && isBodyFileIn(s, ctx.bodyDir);
/**
 * The argv index of a passed tracker write's `--body-file` value (create 7,
 * edit 8); undefined for every other shape. Call only after the guard passed.
 */
function trackerBodyFileArg(args) {
    if (args[0] !== 'issue')
        return undefined;
    if (args[1] === 'create' && args[6] === '--body-file')
        return 7;
    if (args[1] === 'edit' && args[3] === '--repo' && args[7] === '--body-file')
        return 8;
    return undefined;
}
/** `<flag> <label>` pairs, the flags' runs in `order`, every label allowlisted and used once. */
function isLabelPairs(r, order, ctx) {
    if (r.length % 2 !== 0 || r.length / 2 > MAX_WRITE_LABELS)
        return false;
    const seen = [];
    let at = 0;
    for (let i = 0; i < r.length; i += 2) {
        const idx = order.indexOf(r[i]);
        if (idx < at)
            return false;
        at = idx;
        if (!isWriteLabel(r[i + 1], ctx) || seen.includes(r[i + 1]))
            return false;
        seen.push(r[i + 1]);
    }
    return true;
}
/**
 * The enqueue write shapes, exact arity:
 *   issue create --repo <repo> --title <t> --body-file <f> (--label <l>)*
 *   issue edit <n> --repo <repo> --title <t> --body-file <f> (--add-label <l>)* (--remove-label <l>)*
 *   issue list --repo <repo> --search "shipyard-key: <spec>/" in:body --state all --json number,body --limit <1..1000>
 * null = not a write shape (the engine's shapes decide; they refuse all three).
 */
function trackerWriteGh(a, ctx) {
    const [group, sub, ...r] = a;
    if (group !== 'issue')
        return null;
    if (sub === 'create') {
        return r.length >= 6 && same(r.slice(0, 6), ['--repo', ctx.repo, '--title', r[3], '--body-file', r[5]])
            && isTitle(r[3]) && isBodyFile(r[5], ctx) && isLabelPairs(r.slice(6), ['--label'], ctx);
    }
    if (sub === 'edit' && r[1] === '--repo') {
        return r.length >= 7 && NUMBER.test(r[0]) && same(r.slice(1, 7), ['--repo', ctx.repo, '--title', r[4], '--body-file', r[6]])
            && isTitle(r[4]) && isBodyFile(r[6], ctx) && isLabelPairs(r.slice(7), ['--add-label', '--remove-label'], ctx);
    }
    if (sub === 'list' && r[0] === '--repo') {
        return same(r, ['--repo', ctx.repo, '--search', r[3], '--state', 'all', '--json', 'number,body', '--limit', r[9]])
            && KEY_SEARCH.test(r[3]) && NUMBER.test(r[9]) && Number(r[9]) >= 1 && Number(r[9]) <= 1000;
    }
    return null;
}
function isFactoryBranch(name, protectedBranches) {
    return isBranch(name) && name.startsWith(FACTORY_BRANCH_PREFIX) && name.length > FACTORY_BRANCH_PREFIX.length
        && !protectedBranches.some((b) => b.toLowerCase() === name.toLowerCase());
}
/** Same path, case-insensitively only where the file system usually is (Windows, macOS); both sides resolved. */
export function sameFsPath(a, b) {
    const x = resolve(a);
    const y = resolve(b);
    return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/** Exactly the engine-owned bare mirror of this run (`<stateDir>/local/<repo-id>.git`, localMirrorPath), as an absolute path. */
function isMirrorPath(p, local) {
    return isFile(p) && isAbsolute(p) && /[\\/]local[\\/][A-Za-z0-9_][A-Za-z0-9._-]*-[0-9a-f]{12}\.git$/.test(p)
        && local !== undefined && sameFsPath(p, local.mirror);
}
/** The fetch refspec `git remote add omg-local` writes: the only one the engine accepts. */
export const LOCAL_REMOTE_DEFAULT_FETCH = `+refs/heads/*:refs/remotes/${LOCAL_REMOTE}/*`;
/**
 * `git config --get-regexp` of the `omg-local` keys the engine checks:
 * `vcs` hands the transport to a `git remote-<vcs>` helper (remote-ext runs
 * a command), `mirror` turns a push into a mirror push, and a `fetch`
 * refspec other than LOCAL_REMOTE_DEFAULT_FETCH could map a branch onto
 * local refs: git moves the refs it maps to after a push to the remote or to
 * its url (git 2.56 does that for a push to the mirror path too), and
 * `--refmap=` covers fetches only.
 */
export const LOCAL_REMOTE_REFUSED_CONFIG_ARGS = ['config', '--get-regexp', `^remote\\.${LOCAL_REMOTE}\\.(vcs|mirror|fetch)$`];
/** The refused `key=value`s in the output of LOCAL_REMOTE_REFUSED_CONFIG_ARGS: every vcs or mirror, and any fetch refspec but the default. */
export function localRemoteRefusedKeys(stdout) {
    const refused = stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter(([key]) => Boolean(key))
        .filter(([key, ...value]) => !(key === `remote.${LOCAL_REMOTE}.fetch` && value.join(' ') === LOCAL_REMOTE_DEFAULT_FETCH))
        .map(([key, ...value]) => `${key}=${value.join(' ')}`);
    return [...new Set(refused)];
}
/**
 * `git config -z --get-regexp` of every url rewrite (`url.<base>.insteadOf`
 * / `pushInsteadOf`, any scope or include). A push names the mirror path
 * itself (localTransportArgs), and git rewrites that literal string too: a
 * rewrite whose value is a prefix of it sends the push elsewhere, and an
 * identity `-c url.<mirror>.insteadOf=<mirror>` does not override a longer
 * planted one. `-z`: a url subsection may contain spaces.
 */
export const URL_REWRITE_CONFIG_ARGS = ['config', '-z', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'];
/**
 * The `key=value`s in the output of URL_REWRITE_CONFIG_ARGS that would
 * rewrite `mirror`: the value is a prefix of the mirror path in either slash
 * form, case-insensitively on Windows and macOS. A key without a value counts
 * (an empty prefix matches everything).
 */
export function mirrorRewriteKeys(stdout, mirror) {
    const fold = (s) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
    const forms = [mirror, mirror.replace(/\\/g, '/'), mirror.replace(/\//g, '\\')].map(fold);
    const refused = stdout.split('\0').filter(Boolean).map((rec) => {
        const nl = rec.indexOf('\n');
        return nl < 0 ? { key: rec, value: '' } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) };
    }).filter(({ value }) => forms.some((f) => f.startsWith(fold(value)))).map(({ key, value }) => `${key}=${value}`);
    return [...new Set(refused)];
}
/**
 * `git config -z --get-regexp` of every `remote.*` key, any scope or include.
 * A push names the mirror path (localTransportArgs), and git first looks up a
 * configured remote of exactly that name: POSIX git skips names that start
 * with `/`, but a Windows path (`C:\...`) is found, so its `url` / `pushurl`
 * redirect the push and its `receivepack` runs a command. Pinning
 * `-c remote.<mirror>.receivepack` cannot cover every spelling of the name,
 * so such a remote is refused instead (mirrorNamedRemoteKeys).
 */
export const REMOTE_CONFIG_ARGS = ['config', '-z', '--get-regexp', '^remote\\..*'];
/**
 * The `key=value`s in the output of REMOTE_CONFIG_ARGS whose remote NAME is
 * a spelling of `mirror`: either slash form, a trailing or doubled slash, the
 * `file://` form, case-insensitively on Windows and macOS.
 */
export function mirrorNamedRemoteKeys(stdout, mirror) {
    const spelling = (s) => {
        const p = s.replace(/\\/g, '/').replace(/^file:\/\//i, '').replace(/^\/(?=[A-Za-z]:)/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
        return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
    };
    const target = spelling(mirror);
    const refused = stdout.split('\0').filter(Boolean).map((rec) => {
        const nl = rec.indexOf('\n');
        return nl < 0 ? { key: rec, value: '' } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) };
    }).filter(({ key }) => {
        const dot = key.lastIndexOf('.');
        return dot > 'remote.'.length && spelling(key.slice('remote.'.length, dot)) === target;
    }).map(({ key, value }) => `${key}=${value}`);
    return [...new Set(refused)];
}
/** Factory-only git shapes; null = not a factory shape (ship's allowlist decides), false = refused outright. */
function factoryGit(a, protectedBranches, extraProtected = [], local, agent) {
    // The coding agent adopt (coding-agent-lane.ts): the fetch of one PR head, its FETCH_HEAD read and one commit's tree listing.
    if (isCodingAgentGitArgs(a, agent))
        return true;
    const [sub, ...r] = a;
    const remote = r[0] === 'origin' || r[0] === LOCAL_REMOTE;
    switch (sub) {
        case 'push': {
            // `omg factory run reset` on the local forge only: delete a factory branch of the engine-owned mirror,
            // and only while it is still at the sha the reset read (a lease, never a plain force).
            if (r.length === 3 && r[0] === LOCAL_REMOTE) {
                const lease = /^--force-with-lease=refs\/heads\/(.+):([0-9a-f]{40})$/.exec(r[1]);
                const del = /^:refs\/heads\/(.+)$/.exec(r[2]);
                return Boolean(lease && del) && lease[1] === del[1] && isFactoryBranch(del[1], protectedBranches) && !extraProtected.includes(del[1]);
            }
            const m = r.length === 2 && remote ? /^([0-9a-f]{40}):refs\/heads\/(.+)$/.exec(r[1]) : null;
            if (!m)
                return false;
            // The local forge's base sync: exactly the run's base (extraProtected) into the engine-owned mirror,
            // fast-forward only (no `+`), and only the base commit the sync read (LocalGuardContext.baseSha).
            if (r[0] === LOCAL_REMOTE && isBranch(m[2]) && extraProtected.includes(m[2]))
                return local?.baseSha !== undefined && m[1] === local.baseSha;
            return isFactoryBranch(m[2], protectedBranches);
        }
        case 'ls-remote': {
            const m = r.length === 2 && remote ? /^refs\/heads\/(.+)$/.exec(r[1]) : null;
            return Boolean(m) && isFactoryBranch(m[1], protectedBranches);
        }
        case 'init':
            // The local forge's bare mirror, created once under the engine-owned forge state dir.
            return r.length === 3 && same(r.slice(0, 2), ['--bare', '--quiet']) && isMirrorPath(r[2], local);
        case 'remote':
            // Registering that mirror as `omg-local` in the checkout; ship decides get-url, every other shape is refused there.
            if (r[0] === 'add')
                return r.length === 3 && r[1] === LOCAL_REMOTE && isMirrorPath(r[2], local);
            return null;
        case 'rev-parse':
            if (same(r, ['--git-common-dir']) || same(r, ['--symbolic-full-name', 'HEAD']))
                return true;
            // The local forge's claim key refuses a shallow clone (localFactoryClaimRepo, F60).
            if (same(r, ['--is-shallow-repository']))
                return true;
            if (r.length === 2 && r[0] === '--verify') {
                const m = /^([0-9a-f]{40}):(.+)$/.exec(r[1]);
                if (m)
                    return REPO_PATH.test(m[2]) && !m[2].split('/').includes('..');
                // The local forge's base: the local branch, fully qualified (a tag cannot shadow it).
                const h = /^refs\/heads\/(.+)$/.exec(r[1]);
                if (h)
                    return isBranch(h[1]);
            }
            return null;
        case 'config':
            // The tamper check hashes the file core.excludesFile names; ship decides the rest.
            if (same(a, [...LOCAL_REMOTE_REFUSED_CONFIG_ARGS]) || same(a, [...URL_REWRITE_CONFIG_ARGS]) || same(a, [...REMOTE_CONFIG_ARGS]))
                return true;
            return same(r, ['--get', 'core.excludesFile']) ? true : null;
        case 'for-each-ref':
            return same(r, [FOR_EACH_REF_FORMAT]);
        case 'status':
            return same(r, ['--porcelain=v1', '-z', '--untracked-files=all']) ? true : null;
        case 'log':
            // The local forge: the last commit that changed one backlog file's state: line on the base (lastStateChangeArgs, F31 reopen).
            return r.length === STATE_CHANGE_LOG_FLAGS.length + 3 && same(r.slice(0, STATE_CHANGE_LOG_FLAGS.length), [...STATE_CHANGE_LOG_FLAGS])
                && /^[0-9a-f]{40}$/.test(r[STATE_CHANGE_LOG_FLAGS.length]) && r[STATE_CHANGE_LOG_FLAGS.length + 1] === '--'
                && isPlainRepoPath(r[STATE_CHANGE_LOG_FLAGS.length + 2]) ? true : null;
        case 'diff':
            return r.length === 3 && r[0] === '--no-ext-diff' && r[1] === '--no-textconv' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[2]) ? true : null;
        case 'ls-tree':
            // Two-axis review: the standards files on the base commit.
            if (r.length === 6 && same(r.slice(0, 3), ['-r', '-z', '--name-only']) && /^[0-9a-f]{40}$/.test(r[3]) && same(r.slice(4), ['--', 'docs/standards/']))
                return true;
            // The local forge's backlog at the base commit (backlogListArgs): one plain repo directory, never `..`.
            if (r.length === 5 && same(r.slice(0, 2), ['-z', '--name-only']) && /^[0-9a-f]{40}$/.test(r[2]) && r[3] === '--' && r[4].endsWith('/')) {
                return isPlainRepoPath(r[4].slice(0, -1));
            }
            // One entry of the tree at a commit (the team files: exit status and mode tell absent from a gitlink, a tree or a link, whatever the locale): one plain file path.
            if (r.length === 4 && r[0] === '-z' && /^[0-9a-f]{40}$/.test(r[1]) && r[2] === '--')
                return isPlainRepoPath(r[3]);
            return null;
        case 'rev-list':
            // The local forge's claim key (localFactoryClaimRepo, F60): the root commits of HEAD, read-only.
            if (same(r, ['--max-parents=0', 'HEAD']))
                return true;
            // Publish check: the commits of the prepared head beyond the reviewed head and GitHub's base.
            return r.length === 3 && /^[0-9a-f]{40}$/.test(r[0]) && /^\^[0-9a-f]{40}$/.test(r[1]) && /^\^[0-9a-f]{40}$/.test(r[2]) ? true : null;
        case 'worktree':
            // The engine-owned prepare checkout only (prepare.ts): its own branch, at an exact commit. Removal goes through removeWorkerWorktree.
            return r.length === 5 && r[0] === 'add' && r[1] === '-B' && CHECKOUT_BRANCH.test(r[2]) && isAbsolute(r[3]) && isFile(r[3]) && /^[0-9a-f]{40}$/.test(r[4]);
        case 'merge':
            // Abort prepare's conflicted base merge in the engine checkout before it is discarded; ship decides every other merge shape.
            return same(r, ['--abort']) ? true : null;
        default:
            return null;
    }
}
function factoryGh(a, writes, github, agent) {
    // `omg factory triage --apply` (purpose 'triage') may write only the label-only issue edit (src/factory/triage/guard.ts); enqueue keeps its own shapes.
    const triage = writes?.purpose === 'triage' ? (triageWriteGh(a, writes) ?? (a[0] === 'issue' && a[1] === 'edit' ? false : null)) : null;
    if (triage !== null)
        return triage;
    const write = writes && writes.purpose !== 'triage' ? trackerWriteGh(a, writes) : null;
    if (write !== null)
        return write;
    // The Copilot coding agent (src/forge/github/coding-agent.ts): its status read (fixed GraphQL query) for the context's repository,
    if (isCodingAgentStatusArgs(a, github?.repo) || isCodingAgentStatusArgs(a, agent?.repo))
        return true;
    // and, only with the step's CodingAgentContext, the assign of its issue on its base and the close of its PR.
    if (isCodingAgentAssignArgs(a, agent) || isCodingAgentCloseArgs(a, agent))
        return true;
    // and, with the same context, the D5 link comment on exactly its `pr` (coding-agent-lane.ts; run with the guard's copy of the body).
    if (isCodingAgentLinkCommentArgs(a, agent))
        return true;
    const [group, sub, ...r] = a;
    // The other `gh api` shape (besides the coding agent's status read and assign above): the human review read of the
    // run's own repository (fixed query); ship refuses every other.
    if (group === 'api')
        return isReviewFeedbackArgs(a, github?.repo) ? true : null;
    if (group === 'issue') {
        if (sub === 'view')
            return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
        if (sub === 'comment')
            return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--body-file' && isFile(r[2]);
        if (sub === 'edit')
            return isProgressLabelEdit(r);
        return false;
    }
    if (group === 'pr') {
        if (sub === 'create') {
            return r.length === 9 && r[0] === '--draft' && r[1] === '--base' && isBranch(r[2]) && r[3] === '--head' && isFactoryBranch(r[4], [])
                && r[5] === '--title' && isTitle(r[6]) && r[7] === '--body-file' && isFile(r[8]);
        }
        if (sub === 'comment')
            return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--body-file' && isFile(r[2]);
        if (sub === 'list') {
            if (r.length === 4)
                return r[0] === '--head' && isFactoryBranch(r[1], []) && r[2] === '--json' && JSON_FIELDS.test(r[3]);
            // The blocked-by gate: a dependency's factory PR merged into the base (score.ts isSatisfied, findMergedPrForBranch).
            return r.length === 8 && r[0] === '--head' && /^factory\/issue-\d+$/.test(r[1]) && r[2] === '--base' && isBranch(r[3])
                && same(r.slice(4), ['--state', 'merged', '--json', 'number']);
        }
        if (sub === 'ready')
            return r.length === 1 && NUMBER.test(r[0]);
        // Merge is always a human step: ship's `gh pr merge` shape is refused here.
        if (sub === 'merge')
            return false;
        return null;
    }
    // A ci-heal run has no issue url: GitHub's url of the checkout's repository (the remote check compares origin with it).
    if (group === 'repo')
        return sub === 'view' && same(r, ['--json', 'url']);
    return null;
}
const adoRefusal = (cmd, args) => (reason) => new FactorySafetyError(`omg factory run refuses \`${cmd.replace(/\\/g, '/').split('/').pop()} ${args.join(' ')}\`: ${reason}`);
/**
 * Throws FactorySafetyError unless the command is a factory shape or a
 * non-push, non-merge ship shape. `extraProtected` adds the run's base.
 * `az` and python go to the Azure DevOps guard (src/forge/ado/guard.ts),
 * which refuses them unless `ado` names the run's forge and az entry.
 * `writes` (enqueue only) adds the tracker write shapes.
 */
export function assertFactoryCommand(cmd, args, extraProtected = [], env, ado, writes, local, github, agent) {
    if (isAdoCommand(cmd)) {
        checkAdoCommand(cmd, args, env, ado, 'factory', adoRefusal(cmd, args), writes);
        return;
    }
    const file = cmd.replace(/\\/g, '/').split('/').pop().toLowerCase();
    const base = file.replace(/\.exe$/, '');
    const protectedBranches = [...PROTECTED_BRANCHES, ...extraProtected];
    const strings = args.every((x) => typeof x === 'string');
    const verdict = !strings ? false : base === 'git' ? factoryGit(args, protectedBranches, extraProtected, local, agent) : base === 'gh' ? factoryGh(args, writes, github, agent) : null;
    if (verdict === false)
        throw new FactorySafetyError(`omg factory run refuses \`${file} ${args.join(' ')}\`: not one of the command shapes the factory engine runs`);
    if (verdict === true) {
        // Factory shapes take no environment except ship's trusted-read env on git.
        const trusted = JSON.stringify(Object.entries(TRUSTED_READ_ENV));
        if (env !== undefined && !(base === 'git' && JSON.stringify(Object.entries(env)) === trusted) && !isTrustedFetch(base, args, env)) {
            throw new FactorySafetyError(`omg factory run refuses \`${file} ${args.join(' ')}\` with environment ${JSON.stringify(env)}: only ${JSON.stringify(TRUSTED_READ_ENV)} on git is allowed`);
        }
        return;
    }
    try {
        assertSafeCommand(cmd, args, extraProtected, env);
    }
    catch (error) {
        throw new FactorySafetyError(error instanceof Error ? error.message.replace(/^omg ship refuses/, 'omg factory run refuses') : String(error));
    }
}
/**
 * Wrap an Exec so every call passes assertFactoryCommand first; `extraProtected` is read per call.
 * An `az devops invoke` write runs with the guard's own copy of its validated --in-file body,
 * and a tracker write (gh issue create/edit) with the guard's own copy of its checked --body-file.
 * `writes` is set only by `omg factory enqueue`: the tracker write shapes pass while it returns a context.
 * `local` (the local forge only) binds the mirror init, the remote add and the base push to this run's mirror and synced base.
 * `github` (GitHub only) names the repository the human review read may query; without it that read is refused.
 * It is read-only: besides the review read it admits only the coding agent's status read.
 * `agent` (GitHub only, set by the engine around one coding agent step, never for a whole run) admits the assign of its
 * issue on its base and the close of its `pr`; without it both writes are refused.
 */
export function factoryGuardExec(exec, extraProtected = () => [], ado = () => undefined, writes = () => undefined, local = () => undefined, github = () => undefined, agent = () => undefined) {
    return (cmd, args, opts) => {
        if (isAdoCommand(cmd))
            return runGuardedAdo(exec, cmd, args, opts, ado(), 'factory', adoRefusal(cmd, args), writes());
        const ctx = writes();
        const step = agent();
        assertFactoryCommand(cmd, args, extraProtected(), opts?.env, undefined, ctx, local(), github(), step);
        const isGh = cmd.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '') === 'gh';
        const linkShape = isGh && isCodingAgentLinkCommentArgs(args, step);
        const at = linkShape ? CODING_AGENT_LINK_BODY_ARG : ctx && isGh ? trackerBodyFileArg(args) : undefined;
        if (at === undefined)
            return exec(cmd, args, opts);
        // A tracker write runs with the guard's own copy of the checked body, like an az --in-file.
        const body = readTrackerBody(args[at], (reason) => new FactorySafetyError(`omg factory run refuses \`gh ${args.join(' ')}\`: ${reason}`));
        // The link comment's body must be exactly the factory's own text for the step context (numbers, branch, sha).
        const linkProblem = linkShape ? codingAgentLinkBodyProblem(body.toString('utf8'), step) : null;
        if (linkProblem)
            throw new FactorySafetyError(`omg factory run refuses \`gh ${args.join(' ')}\`: ${linkProblem}`);
        const dir = mkdtempSync(join(tmpdir(), 'omg-gh-body-'));
        try {
            const owned = join(dir, 'body.md');
            writeFileSync(owned, body, { mode: 0o600, flag: 'wx' });
            const rewritten = [...args];
            rewritten[at] = owned;
            return exec(cmd, rewritten, opts);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
}
/** Prepended to every hardened git command, after the guard checked the plain shape. */
export function gitHardeningArgs(hooksDir) {
    return ['-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external='];
}
/**
 * Prepended to a transport command on the local forge's `omg-local` remote:
 * the stock pack programs, so a `remote.omg-local.receivepack` or
 * `uploadpack` planted in the checkout's .git/config never runs. Its url and
 * every push url are compared with the exact mirror path before each fetch
 * and push (localRemoteMismatch), so a planted pushurl or insteadOf refuses.
 */
export const LOCAL_REMOTE_PACK_ARGS = ['-c', `remote.${LOCAL_REMOTE}.receivepack=git-receive-pack`, '-c', `remote.${LOCAL_REMOTE}.uploadpack=git-upload-pack`];
const onLocalRemote = (args) => (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'ls-remote') && args[1] === LOCAL_REMOTE;
/**
 * The transport git really runs for an `omg-local` command. A fetch never
 * uses the checkout's `remote.omg-local.fetch` refspec (`--refmap=`) or
 * follows tags: a bare branch becomes the explicit
 * `+refs/heads/<b>:refs/remotes/omg-local/<b>`, so only that tracking ref
 * moves, never a planted destination such as `refs/heads/x/*`. A push names
 * the mirror path itself (`mirror`), because a push through the named remote
 * also moves the local refs that remote's fetch refspec maps the pushed
 * branch to (an empty `-c remote.omg-local.fetch=` does not reset it).
 * The remote's url and push urls, with insteadOf / pushInsteadOf applied,
 * are checked to be that path before every push (localRemoteMismatch), so
 * a rewrite that would apply to the path refuses first.
 */
export function localTransportArgs(args, mirror) {
    if (args[0] === 'push' && args[1] === LOCAL_REMOTE) {
        if (!mirror || !isAbsolute(mirror))
            throw new FactorySafetyError(`omg factory run refuses \`git ${args.join(' ')}\`: the local forge mirror path is unknown here`);
        return ['push', mirror, ...args.slice(2)];
    }
    if (args[0] !== 'fetch' || args[1] !== LOCAL_REMOTE)
        return [...args];
    const refspecs = args.slice(2).map((a) => (isBranch(a) && !a.startsWith('refs/') ? `+refs/heads/${a}:refs/remotes/${LOCAL_REMOTE}/${a}` : a));
    return ['fetch', '--no-tags', '--refmap=', LOCAL_REMOTE, ...refspecs];
}
/**
 * Run git with `core.hooksPath` set to an engine-owned empty directory and
 * `core.fsmonitor=false`, so no hook (pre-push, post-checkout,
 * reference-transaction) and no fsmonitor command runs in the engine.
 * Refuses when the hooks directory is missing or not empty. Other commands
 * pass through unchanged. Wrap it INSIDE factoryGuardExec, so the guard sees
 * the plain shape.
 *
 * The system and global config stay. GIT_CONFIG_NOSYSTEM is not set: Git for
 * Windows keeps `credential.helper` and `core.autocrlf` in the system config,
 * so pushes would lose their credentials and every CRLF checkout would read
 * as modified, and `credential.helper` cannot be blanked either (pushes need
 * the credential manager). The system config needs admin rights to write;
 * the global one and every file a config includes are hashed into the lane
 * snapshot instead (review-guard.ts), so a lane that plants a helper,
 * sshCommand, pushInsteadOf or clean filter there parks the run.
 *
 * `localMirror` (the local forge) is the engine-owned mirror path a push on
 * `omg-local` goes to (localTransportArgs).
 */
export function hardenedGitExec(exec, hooksDir, localMirror = () => undefined) {
    return (cmd, args, opts) => {
        const base = cmd.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
        if (base !== 'git')
            return exec(cmd, args, opts);
        if (!existsSync(hooksDir) || readdirSync(hooksDir).length > 0) {
            throw new FactorySafetyError(`omg factory run refuses git: the engine's empty hooks directory ${hooksDir} is missing or not empty`);
        }
        const hardening = gitHardeningArgs(hooksDir);
        if (!onLocalRemote(args))
            return exec(cmd, [...hardening, ...args], opts);
        // vcs / mirror / a foreign fetch refspec change what the transport does: syncLocalMirror refuses them first (exit 5), this is the backstop.
        const checked = exec(cmd, [...hardening, ...LOCAL_REMOTE_REFUSED_CONFIG_ARGS], { ...(opts?.cwd ? { cwd: opts.cwd } : {}), env: TRUSTED_READ_ENV });
        const refused = checked.status > 1 ? ['a config git could not read'] : localRemoteRefusedKeys(checked.stdout);
        if (refused.length > 0) {
            throw new FactorySafetyError(`omg factory run refuses \`git ${args.join(' ')}\`: the ${LOCAL_REMOTE} remote sets ${refused.join(', ')}; remove it (git config --unset)`);
        }
        // A url rewrite of the mirror path would send the transport elsewhere: syncLocalMirror refuses it first (exit 5).
        const mirror = localMirror();
        if (mirror) {
            const rewrites = exec(cmd, [...hardening, ...URL_REWRITE_CONFIG_ARGS], { ...(opts?.cwd ? { cwd: opts.cwd } : {}), env: TRUSTED_READ_ENV });
            const rewritten = rewrites.status > 1 ? ['a config git could not read'] : mirrorRewriteKeys(rewrites.stdout, mirror);
            if (rewritten.length > 0) {
                throw new FactorySafetyError(`omg factory run refuses \`git ${args.join(' ')}\`: the git config rewrites the local forge mirror ${mirror} (${rewritten.join(', ')}); remove it (git config --unset)`);
            }
            // A remote named after the mirror path would take over the push to it (Windows git): syncLocalMirror refuses it first (exit 5).
            const remotes = exec(cmd, [...hardening, ...REMOTE_CONFIG_ARGS], { ...(opts?.cwd ? { cwd: opts.cwd } : {}), env: TRUSTED_READ_ENV });
            const named = remotes.status > 1 ? ['a config git could not read'] : mirrorNamedRemoteKeys(remotes.stdout, mirror);
            if (named.length > 0) {
                throw new FactorySafetyError(`omg factory run refuses \`git ${args.join(' ')}\`: the git config has a remote named after the local forge mirror ${mirror} (${named.join(', ')}); remove it (git config --remove-section)`);
            }
        }
        return exec(cmd, [...hardening, ...LOCAL_REMOTE_PACK_ARGS, ...localTransportArgs(args, mirror)], opts);
    };
}
//# sourceMappingURL=exec.js.map