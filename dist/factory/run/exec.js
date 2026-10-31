/**
 * The `omg factory run` command guard: ship's allowlist (src/ship/exec.ts)
 * extended with the exact shapes the factory engine builds (design §4).
 *
 * - Pushes: only `git push origin <sha40>:refs/heads/factory/<name>`, plain
 *   (no `+`, no flags), never a protected branch. Ship's `HEAD:refs/heads/<b>`
 *   push shape is refused here: the factory pushes nothing else.
 * - GitHub: `gh issue view|comment`, `gh pr create --draft|comment|list|ready`
 *   and `gh repo view --json url` (ci-heal runs) in fixed shapes, plus ship's
 *   `gh pr view|checks` and `gh run list|view|rerun`.
 *   Never `gh api`, `gh -R`, or a merge (merge is always human).
 * - Tracker writes (`omg factory enqueue` only, when its TrackerWriteContext is
 *   set): `gh issue create`, `gh issue edit` (title, body, labels) and the
 *   `shipyard-key:` search `gh issue list --search`, each in one exact shape,
 *   pinned to the configured repository, with a body file from the caller's
 *   own directory (gh reads the guard's checked copy) and labels from its allowlist. Never close, delete,
 *   transfer or lock; without the context all three shapes are refused.
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
import { isAbsolute, join, relative, resolve } from 'path';
import { checkAdoCommand, isAdoCommand, runGuardedAdo } from '../../forge/ado/guard.js';
import { readTrackerBody } from '../../forge/body-file.js';
import { assertSafeCommand, PROTECTED_BRANCHES, ShipSafetyError, TRUSTED_READ_ENV } from '../../ship/exec.js';
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
function isBodyFile(s, ctx) {
    if (!isFile(s) || !isAbsolute(s) || !isAbsolute(ctx.bodyDir))
        return false;
    const rel = relative(resolve(ctx.bodyDir), resolve(s));
    // No `:` either: `b.md:s` names an NTFS alternate data stream of b.md.
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !/[\\/:]/.test(rel);
}
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
/** Factory-only git shapes; null = not a factory shape (ship's allowlist decides), false = refused outright. */
function factoryGit(a, protectedBranches) {
    const [sub, ...r] = a;
    switch (sub) {
        case 'push': {
            const m = r.length === 2 && r[0] === 'origin' ? /^([0-9a-f]{40}):refs\/heads\/(.+)$/.exec(r[1]) : null;
            return Boolean(m) && isFactoryBranch(m[2], protectedBranches);
        }
        case 'ls-remote': {
            const m = r.length === 2 && r[0] === 'origin' ? /^refs\/heads\/(.+)$/.exec(r[1]) : null;
            return Boolean(m) && isFactoryBranch(m[1], protectedBranches);
        }
        case 'rev-parse':
            if (same(r, ['--git-common-dir']) || same(r, ['--symbolic-full-name', 'HEAD']))
                return true;
            if (r.length === 2 && r[0] === '--verify') {
                const m = /^([0-9a-f]{40}):(.+)$/.exec(r[1]);
                if (m)
                    return REPO_PATH.test(m[2]) && !m[2].split('/').includes('..');
            }
            return null;
        case 'config':
            // The tamper check hashes the file core.excludesFile names; ship decides the rest.
            return same(r, ['--get', 'core.excludesFile']) ? true : null;
        case 'for-each-ref':
            return same(r, [FOR_EACH_REF_FORMAT]);
        case 'status':
            return same(r, ['--porcelain=v1', '-z', '--untracked-files=all']) ? true : null;
        case 'diff':
            return r.length === 3 && r[0] === '--no-ext-diff' && r[1] === '--no-textconv' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[2]) ? true : null;
        case 'ls-tree':
            // Two-axis review: the standards files on the base commit.
            return r.length === 6 && same(r.slice(0, 3), ['-r', '-z', '--name-only']) && /^[0-9a-f]{40}$/.test(r[3]) && same(r.slice(4), ['--', 'docs/standards/']) ? true : null;
        case 'rev-list':
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
function factoryGh(a, writes) {
    const write = writes ? trackerWriteGh(a, writes) : null;
    if (write !== null)
        return write;
    const [group, sub, ...r] = a;
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
        if (sub === 'list')
            return r.length === 4 && r[0] === '--head' && isFactoryBranch(r[1], []) && r[2] === '--json' && JSON_FIELDS.test(r[3]);
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
export function assertFactoryCommand(cmd, args, extraProtected = [], env, ado, writes) {
    if (isAdoCommand(cmd)) {
        checkAdoCommand(cmd, args, env, ado, 'factory', adoRefusal(cmd, args), writes);
        return;
    }
    const file = cmd.replace(/\\/g, '/').split('/').pop().toLowerCase();
    const base = file.replace(/\.exe$/, '');
    const protectedBranches = [...PROTECTED_BRANCHES, ...extraProtected];
    const strings = args.every((x) => typeof x === 'string');
    const verdict = !strings ? false : base === 'git' ? factoryGit(args, protectedBranches) : base === 'gh' ? factoryGh(args, writes) : null;
    if (verdict === false)
        throw new FactorySafetyError(`omg factory run refuses \`${file} ${args.join(' ')}\`: not one of the command shapes the factory engine runs`);
    if (verdict === true) {
        // Factory shapes take no environment except ship's trusted-read env on git.
        const trusted = JSON.stringify(Object.entries(TRUSTED_READ_ENV));
        if (env !== undefined && !(base === 'git' && JSON.stringify(Object.entries(env)) === trusted)) {
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
 */
export function factoryGuardExec(exec, extraProtected = () => [], ado = () => undefined, writes = () => undefined) {
    return (cmd, args, opts) => {
        if (isAdoCommand(cmd))
            return runGuardedAdo(exec, cmd, args, opts, ado(), 'factory', adoRefusal(cmd, args), writes());
        const ctx = writes();
        assertFactoryCommand(cmd, args, extraProtected(), opts?.env, undefined, ctx);
        const at = ctx && cmd.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '') === 'gh' ? trackerBodyFileArg(args) : undefined;
        if (at === undefined)
            return exec(cmd, args, opts);
        // A tracker write runs with the guard's own copy of the checked body, like an az --in-file.
        const body = readTrackerBody(args[at], (reason) => new FactorySafetyError(`omg factory run refuses \`gh ${args.join(' ')}\`: ${reason}`));
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
 */
export function hardenedGitExec(exec, hooksDir) {
    return (cmd, args, opts) => {
        const base = cmd.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
        if (base !== 'git')
            return exec(cmd, args, opts);
        if (!existsSync(hooksDir) || readdirSync(hooksDir).length > 0) {
            throw new FactorySafetyError(`omg factory run refuses git: the engine's empty hooks directory ${hooksDir} is missing or not empty`);
        }
        return exec(cmd, [...gitHardeningArgs(hooksDir), ...args], opts);
    };
}
//# sourceMappingURL=exec.js.map