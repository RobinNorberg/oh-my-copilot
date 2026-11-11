/**
 * The engine side of the private layout (item 2 B1b; design i23 4/8-7/8):
 * `factory.run.layout: "private"` runs a run's lanes, prepare checkout and
 * gates in an engine-owned private repository outside the user's checkout
 * (private-store.ts), and its commits reach the user's repository only
 * through importFromPrivate followed by the engine's existing hardened push.
 *
 * The engine (engine.ts) keeps its call sites thin and asks this module:
 * - at run start (the implement step that seals the base): the layout
 *   (trusted layers only), then PrivateRun.create: git >= 2.44, the user's
 *   common git dir resolved once, leftover `.trash-*` swept, stale
 *   refs/omg-import/<slug>/* deleted, the user repository guard baseline,
 *   ensureSeed + createPrivateRepo at the sealed base under the import lock;
 * - per lane: a detached worktree `<run>/w/<n>` made with the store's pinned
 *   git (never the unhardened `git worktree add` of the shared layout), its
 *   links recorded, and the paths its sandbox denies (the seed, the other
 *   runs and lanes);
 * - per engine git command in the private repository: privateGit /
 *   privateExec, which run privateRepoProblem first and name the git dir and
 *   work tree explicitly;
 * - per publish: publishImports, under the import lock: the guard compared
 *   with its baseline, each engine commit imported (exactly one new commit
 *   per import, parents and start from the engine's own record), the caller's
 *   checks and hardened push, the import refs dropped, the guard compared
 *   again with the PRE-import baseline, and only then a new baseline.
 *
 * One engine per checkout (the per-checkout engine lock is unchanged); the
 * import lock is a plain file lock per repository under the work root that
 * lane B2 (parallel runs) replaces.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { withFileLockSync } from '../../lib/file-lock.js';
import { defaultExec } from '../../ship/exec.js';
import { recordedWorktreeGitLinks, recordWorktreeGitLinks, readWorktreeGitLinks } from '../../team/git-worktree.js';
import { claimRepoKey } from './claims.js';
import { ENGINE_COMMIT_IDENTITY } from './lane-commit.js';
import { unlinkNodeModules } from './prepare.js';
import { assertPrivateRepo, createPrivateRepo, dropImportRef, dropStaleImportRef, ensureSeed, fetchIntoPrivate, gitVersionProblem, importFromPrivate, longPathProblem, privateExec, privateGit, privateGitOk, privateGitTools, privateHasCommit, privateRepoProblem, privateRunLayout, privateWorkRoot, privateWorktreePath, removeRunDir, rerecordConfigHash, resolveUserGitDir, staleImportRefs, userRepoGuardChanges, userRepoGuardSnapshot, compareUserRepoGuard, PrivateStoreError, } from './private-store.js';
/** The park when the private layout cannot run this part yet (an actionable command to continue is in the reason). */
export const LAYOUT_UNSUPPORTED_GATE = 'layout-unsupported';
/** The park when the private store could not be set up at run start (git too old, a partial clone, the work root, the seed). */
export const PRIVATE_STORE_GATE = 'private-store';
/** The park when the user repository guard changed between imports. */
export const REPO_GUARD_GATE = 'repo-guard-changed';
/** The park when importFromPrivate refused an engine commit (protected paths park at protected-paths instead). */
export const IMPORT_REFUSED_GATE = 'import-refused';
/** The park when the PR head changes a lockfile and factory.run.gateInstall is "park". */
export const GATE_INSTALL_GATE = 'gate-install-needed';
/** How long publishImports waits for another engine's import (lane B2 replaces this lock). */
export const IMPORT_LOCK_WAIT_MS = 60_000;
const run = (config) => {
    const r = config?.factory?.run;
    return typeof r === 'object' && r !== null ? r : undefined;
};
/**
 * factory.run.layout from the trusted layers only: the user config, then the
 * `.copilot/omg.jsonc` committed at the sealed base (never the working tree
 * or the PR head). Default "shared". Throws on any other value.
 */
export function resolveRunLayout(user, base) {
    for (const [config, source] of [[user, 'user config'], [base, 'the base .copilot/omg.jsonc']]) {
        const v = run(config)?.layout;
        if (v === undefined)
            continue;
        if (v !== 'shared' && v !== 'private')
            throw new PrivateStoreError(`${source}: factory.run.layout must be "shared" or "private"`);
        return { layout: v, source };
    }
    return { layout: 'shared', source: 'default' };
}
/** factory.run.gateInstall from the same trusted layers: "park" (default) or "sandboxed". */
export function resolveGateInstall(user, base) {
    for (const [config, source] of [[user, 'user config'], [base, 'the base .copilot/omg.jsonc']]) {
        const v = run(config)?.gateInstall;
        if (v === undefined)
            continue;
        if (v !== 'park' && v !== 'sandboxed')
            throw new PrivateStoreError(`${source}: factory.run.gateInstall must be "park" or "sandboxed"`);
        return { mode: v, source };
    }
    return { mode: 'park', source: 'default' };
}
const KIND_TEXT = {
    'gitdir': 'git dir',
    'redirect-entry': 'redirect entry (.git, commondir or gitdir in the git dir)',
    'config-key': 'config key',
    'config-link': 'config file that is a link',
    'include-not-followed': 'conditional include git cannot read',
    'unreadable': 'unreadable config, include or git state',
    'hooks-dir': 'hooks dir',
    'hooks-path': 'hooks path (core.hooksPath)',
    'hooks-too-large': 'hooks dir too large to compare (deeper than 3 levels, over 2 000 entries, or a file over 1 MiB)',
    'hooks-path-root': 'core.hooksPath at the work tree root or the git dir',
    'module': 'submodule git dir',
    'worktree': 'worktree entry',
    'grafts': 'grafts file',
    'shallow': 'shallow file',
    'alternates': 'alternates file',
    'http-alternates': 'http-alternates file',
    'replace-ref': 'replace ref',
};
/**
 * The park message for a changed user repository guard (review-481b k):
 * kind, path and key name of each changed entry, never a value or a
 * fingerprint, and that the user's own change trips it too.
 */
export function guardChangedReason(details, resume, cancel, stuck = []) {
    const head = `your repository's ${guardItemsText(details) || 'git state'} changed during the run, so nothing more was imported or pushed. `;
    // An item the guard can never compare parks every import while it stays: a rerun alone does not continue (review-483 HIGH-1).
    if (stuck.length > 0) {
        return `${head}The guard cannot compare your repository's ${guardItemsText(stuck)} at all, so every import parks while it stays. `
            + `Fix it (${STUCK_FIX}), then rerun ${resume}; or ${cancel} stops the run (factory.run.layout "shared" in your user config avoids this check for the next run).`;
    }
    return head
        + 'Your own change does this too (git submodule update --init, git lfs install --local, a local alias, scalar or fsmonitor, husky on a branch switch). '
        + `Check the change; rerunning ${resume} continues and takes your repository as it is then; ${cancel} stops the run.`;
}
/** What the user does about an item the guard cannot compare. */
const STUCK_FIX = 'make the config or include readable, keep hook files under 1 MiB and the hooks dir under 2 000 entries and 3 levels deep, and point core.hooksPath at a dir other than the work tree root or the git dir';
/** The kind, key name and path of up to five guard entries (never a value or a fingerprint). */
function guardItemsText(details) {
    const what = details.slice(0, 5).map((d) => `${KIND_TEXT[d.kind]}${d.key && d.kind === 'config-key' ? ` ${d.key} in` : ''}: ${d.path}`);
    return `${what.join('; ')}${details.length > 5 ? ` (and ${details.length - 5} more)` : ''}`;
}
/**
 * The entries of `guard` that compareUserRepoGuard always reports as changed
 * (an unreadable config, include or git state; a hooks dir too large to
 * compare; core.hooksPath at the work tree root or the git dir): with one of
 * them a private run would park at every import (review-483 HIGH-1). Empty
 * when the guard compares cleanly.
 */
export function stuckGuardEntries(guard) {
    return compareUserRepoGuard(guard, guard).length > 0 ? userRepoGuardChanges(guard, guard) : [];
}
/** The park for an import refusal: the module's fixed reason, and the command that continues or cancels. */
export function importRefusalPark(code, reason, what, ref, resume, cancel, privateDir) {
    const pre = `the engine did not import ${what} into your repository: ${reason}; nothing of it was pushed`;
    switch (code) {
        case 'protected-path':
            return { name: 'protected-paths', reason: `${pre}. A write lane may not change merge-rule or lane-protected paths; ${cancel}, or change the path list in your config and rerun ${resume}` };
        case 'user-repo':
            return { name: IMPORT_REFUSED_GATE, reason: `${pre}. Fix your repository as named, then rerun ${resume}` };
        case 'ref-left':
            return { name: IMPORT_REFUSED_GATE, reason: `${pre}. Delete the ref by hand (git update-ref -d ${ref}), then rerun ${resume}` };
        case 'timeout':
            return { name: IMPORT_REFUSED_GATE, reason: `${pre}. Rerun ${resume} to try the import again` };
        case 'bad-input':
            return { name: IMPORT_REFUSED_GATE, reason: `${pre}. A commit the run already pushed is missing from your repository (a git gc --prune=now?); fetch the PR branch back (git fetch <remote> <branch>), then rerun ${resume}, or ${cancel}` };
        default:
            return { name: IMPORT_REFUSED_GATE, reason: `${pre}. Inspect the run's private repository ${privateDir}; ${cancel}, then omg factory run clean removes it` };
    }
}
/** Lexically under (or equal to) `dir`, case-folded on win32. */
const inside = (p, dir, platform) => {
    const norm = (x) => (platform === 'win32' ? resolve(x).toLowerCase() : resolve(x));
    const a = norm(p);
    const b = norm(dir);
    return a === b || a.startsWith(b.endsWith('\\') || b.endsWith('/') ? b : `${b}${platform === 'win32' ? '\\' : '/'}`);
};
export class PrivateRun {
    layout;
    repo;
    ctx;
    userGitDir;
    root;
    warn;
    constructor(layout, repo, ctx, userGitDir, root, warn = () => { }) {
        this.layout = layout;
        this.repo = repo;
        this.ctx = ctx;
        this.userGitDir = userGitDir;
        this.root = root;
        this.warn = warn;
    }
    /** The context of every store command: the ledger dir's tools, the unguarded exec. */
    static context(input) {
        return { tools: privateGitTools(input.ledgerDir), exec: input.exec ?? defaultExec, ...(input.platform ? { platform: input.platform } : {}) };
    }
    /** The layout of the run (work root from the trusted user config, repository dir from the claim key). */
    static runLayout(input) {
        const work = privateWorkRoot({ userConfig: input.userConfig, root: input.root, omcRoot: input.omcRoot, ...(input.platform ? { platform: input.platform } : {}) });
        return privateRunLayout(work, claimRepoKey(input.repoUrl, input.root, input.platform), input.slug);
    }
    /**
     * Run start (B1b scope 1): every check before the store is touched, then
     * the seed and the private clone at the sealed base under the import lock.
     * A run dir left by a failed earlier start of this run (the state records
     * no private store yet) is removed first. Throws PrivateStoreError.
     */
    static create(input, baseSha) {
        const ctx = PrivateRun.context(input);
        const version = gitVersionProblem(ctx.exec);
        if (version)
            throw new PrivateStoreError(`${version}; upgrade git, or set factory.run.layout "shared"`);
        const layout = PrivateRun.runLayout(input);
        const userGitDir = resolveUserGitDir(input.root, ctx);
        const warn = input.warn ?? (() => { });
        return withImportLock(layout, () => {
            sweepTrash(layout, warn);
            dropStaleImports(userGitDir, input.slug, ctx, warn);
            if (existsSync(layout.runDir))
                removeRunDir(layout.runDir, layout.work);
            // The baseline the first import compares with: taken before any store transport touched the repository.
            const guard = userRepoGuardSnapshot(userGitDir, ctx);
            // An item the guard can never compare would park every import: refused here, before the store is made (review-483 HIGH-1).
            const stuck = stuckGuardEntries(guard);
            if (stuck.length > 0) {
                throw new PrivateStoreError(`the import guard cannot compare your repository's ${guardItemsText(stuck)}, so every import would park; fix it (${STUCK_FIX})`);
            }
            ensureSeed(layout, userGitDir, baseSha, ctx);
            const repo = createPrivateRepo(layout, baseSha, ctx);
            const record = { userGitDir, configHash: repo.configHash, longestPath: repo.longestPath, nextImport: 0 };
            return { run: new PrivateRun(layout, repo, ctx, userGitDir, input.root, warn), record, guard };
        });
    }
    /** The run of a private-layout state (resume): the recorded dir and record, never recomputed from config. */
    static fromState(s, input) {
        if (s.layout !== 2 || !s.privateDir || !s.privateStore || !s.baseSha)
            throw new PrivateStoreError('the run state has no private store record');
        const runDir = resolve(s.privateDir);
        const repoDir = resolve(runDir, '..');
        const layout = {
            work: resolve(repoDir, '..'), repo8: basename(repoDir), repoDir, seed: join(repoDir, 'seed.git'), runDir,
            repo: join(runDir, 'repo'), gitDir: join(runDir, 'repo', '.git'), worktrees: join(runDir, 'w'), jobs: join(runDir, 'jobs'), lock: join(runDir, 'run.lock'),
        };
        const repo = { repo: layout.repo, gitDir: layout.gitDir, seed: layout.seed, baseSha: s.baseSha, configHash: s.privateStore.configHash, longestPath: s.privateStore.longestPath };
        return new PrivateRun(layout, repo, PrivateRun.context(input), s.privateStore.userGitDir, input.root, input.warn);
    }
    /** At every resume (B1b scope 1/5): leftover `.trash-*` and this run's stale import refs (a crash after an import). */
    resumeSweep(slug) {
        withImportLock(this.layout, () => {
            sweepTrash(this.layout, this.warn);
            dropStaleImports(this.userGitDir, slug, this.ctx, this.warn);
        });
    }
    problem() {
        return privateRepoProblem(this.repo, this.ctx);
    }
    /** privateRepoProblem, thrown (PrivateRepoTampered). */
    assert() {
        assertPrivateRepo(this.repo, this.ctx);
    }
    /** An engine git command in the private repository (privateRepoProblem first; explicit git dir and work tree). */
    gitOk(args, what, workTree) {
        return privateGitOk(this.repo, this.ctx, args, what, this.gitOptions(workTree));
    }
    /** gitOk without the exit check (the caller reads the status). */
    git(args, workTree) {
        return privateGit(this.repo, this.ctx, args, this.gitOptions(workTree));
    }
    gitOptions(workTree) {
        if (!workTree)
            return { env: identityEnv() };
        const gitDir = this.recordedGitDir(workTree);
        if (!gitDir)
            throw new PrivateStoreError(`no git links were recorded for ${workTree} in the private repository`);
        return { workTree, gitDir, env: identityEnv() };
    }
    /** The admin dir recorded for `workTree` at its creation (recordWorktreeGitLinks), or null. */
    recordedGitDir(workTree) {
        const links = recordedWorktreeGitLinks(workTree);
        return links && inside(links.adminDir, join(this.repo.gitDir, 'worktrees'), process.platform) ? links.adminDir : null;
    }
    /** The Exec for snapshotRepo and ship's runPrepare: the clone dir and the recorded worktrees only; the engine's commit identity. */
    exec() {
        return privateExec(this.repo, this.ctx, (cwd) => this.recordedGitDir(cwd), identityEnv());
    }
    /** `sha` is in the private repository: else fetched by sha from the user repository (seed first), kept by an engine ref. */
    ensureCommit(sha) {
        if (privateHasCommit(this.repo, this.ctx, sha))
            return;
        withImportLock(this.layout, () => fetchIntoPrivate(this.layout, this.repo, this.userGitDir, sha, this.ctx));
        // A ref keeps the fetched objects (fetchIntoPrivate leaves them unreferenced; review-481b l).
        this.gitOk(['update-ref', '--no-deref', '-m', 'omg private store: keep', `refs/omg/keep/${sha}`, sha], `keeping ${sha}`);
    }
    /** `<run>/w/<n>` or `<run>/w/prep`. */
    worktreePath(n) {
        return privateWorktreePath(this.layout, n);
    }
    /**
     * A new worktree at `sha` (detached, or on `branch`, which `-B` resets),
     * made with the store's pins (no hook, no filter, no global config), its
     * links recorded before anything else runs in it; the config hash is
     * re-recorded after (the allowlist still applies), so the caller seals
     * `repo.configHash` again.
     */
    addWorktree(path, sha, branch) {
        const tooLong = longPathProblem(path, this.repo.longestPath);
        if (tooLong)
            throw new PrivateStoreError(tooLong);
        if (existsSync(path))
            throw new PrivateStoreError(`the private worktree ${path} already exists`);
        this.ensureCommit(sha);
        privateGitOk(this.repo, this.ctx, ['worktree', 'add', '-q', ...(branch ? ['-B', branch] : ['--detach']), path, sha], `git worktree add ${path}`, { env: identityEnv() });
        this.repo = rerecordConfigHash(this.repo, this.ctx);
        const links = readWorktreeGitLinks(path);
        if (!links || !inside(links.adminDir, join(this.repo.gitDir, 'worktrees'), process.platform))
            throw new PrivateStoreError(`the private worktree ${path} has no git links in ${this.repo.gitDir}`);
        recordWorktreeGitLinks(path, links);
    }
    /**
     * Remove a private worktree: its node_modules link first, then removeRunDir
     * (links unlinked, never followed), then its own admin entry under the
     * private git dir's worktrees/ (the one whose gitdir file names
     * `<path>/.git`), by path; never `git worktree prune`. Only after its
     * process tree is gone (the caller's lane end or gate end).
     */
    removeWorktree(path) {
        if (existsSync(path)) {
            unlinkNodeModules(this.root, path);
            removeRunDir(path, this.layout.work);
        }
        const admin = join(this.repo.gitDir, 'worktrees');
        if (!existsSync(admin))
            return;
        const want = resolve(path, '.git');
        const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
        for (const name of readdirSync(admin)) {
            const dir = join(admin, name);
            let gitdir;
            try {
                gitdir = readFileSync(join(dir, 'gitdir'), 'utf8').trim();
            }
            catch {
                continue;
            }
            if (same(resolve(dir, gitdir), want))
                removeRunDir(dir, this.layout.work);
        }
    }
    /**
     * The paths a lane in `own` is denied (where the host can deny paths): the
     * seed, the other run dirs and trash under the repository dir, and the
     * other worktrees of this run. Its own worktree and the private git dir
     * (read-only) stay readable.
     */
    deniedFor(own) {
        const list = (dir) => { try {
            return readdirSync(dir).map((n) => join(dir, n));
        }
        catch {
            return [];
        } };
        const others = list(this.layout.repoDir).filter((p) => resolve(p) !== resolve(this.layout.runDir));
        const lanes = list(this.layout.worktrees).filter((p) => resolve(p) !== resolve(own));
        return [...others, ...lanes];
    }
    /**
     * Publish (B1b scope 5) under the import lock: the guard against its
     * baseline (a change parks before anything is imported), each step
     * imported in order, `body` (the caller's checks and hardened push; it may
     * return a park of its own), the import refs dropped, the guard compared
     * AGAIN with the pre-import baseline (a change parks: whatever the body
     * pushed is out, nothing more is), and only then the new baseline.
     * `nextImport` reserves and seals an import number; `baseline`/`setBaseline`
     * are the ledger's.
     */
    publishImports(o) {
        return withImportLock(this.layout, () => {
            const baseline = o.baseline ?? userRepoGuardSnapshot(this.userGitDir, this.ctx);
            const now = userRepoGuardSnapshot(this.userGitDir, this.ctx);
            if (compareUserRepoGuard(baseline, now).length > 0) {
                return { ok: false, pushed: false, park: { name: REPO_GUARD_GATE, reason: guardChangedReason(userRepoGuardChanges(baseline, now), o.resume, o.cancel, stuckGuardEntries(now)) } };
            }
            const held = [];
            const drop = () => {
                for (const h of held.splice(0)) {
                    try {
                        dropImportRef(this.userGitDir, o.slug, h.n, h.sha, this.ctx);
                    }
                    catch (e) {
                        this.warn(`omg factory run: ${e instanceof Error ? e.message : String(e)}; the next run start deletes it`);
                    }
                }
            };
            let value;
            try {
                for (const step of o.steps) {
                    const n = o.nextImport();
                    const r = importFromPrivate({ userGitDir: this.userGitDir, privateRepo: this.repo, sha: step.sha, expectedParents: step.parents, startSha: step.start, run: o.slug, n, extraProtected: o.extraProtected }, this.ctx);
                    if (!r.ok)
                        return { ok: false, pushed: false, park: importRefusalPark(r.code, r.reason, `${o.what} ${step.sha.slice(0, 12)}`, `refs/omg-import/${o.slug}/${n}`, o.resume, o.cancel, this.layout.runDir) };
                    held.push({ n, sha: step.sha });
                }
                value = o.body();
            }
            finally {
                drop();
            }
            const after = userRepoGuardSnapshot(this.userGitDir, this.ctx);
            if (compareUserRepoGuard(baseline, after).length > 0) {
                const pushed = o.pushed(value);
                return { ok: false, pushed, park: { name: REPO_GUARD_GATE, reason: `${pushed ? `${o.what} was pushed, and then ` : ''}${guardChangedReason(userRepoGuardChanges(baseline, after), o.resume, o.cancel, stuckGuardEntries(after))}` } };
            }
            o.setBaseline(after);
            return { ok: true, value };
        });
    }
}
/** The engine's fixed commit identity for prepare's merge and inventory commits in the private repository (no global config there). */
function identityEnv() {
    return {
        GIT_AUTHOR_NAME: ENGINE_COMMIT_IDENTITY.name, GIT_AUTHOR_EMAIL: ENGINE_COMMIT_IDENTITY.email,
        GIT_COMMITTER_NAME: ENGINE_COMMIT_IDENTITY.name, GIT_COMMITTER_EMAIL: ENGINE_COMMIT_IDENTITY.email,
    };
}
/**
 * The short lock around the store's transports into and out of the user
 * repository (seed fetch, clone, imports, push): one file per repository
 * under the work root. Lane B2 replaces it with the import lock across engines.
 */
export function withImportLock(layout, fn) {
    return withFileLockSync(join(layout.repoDir, 'import.lock'), fn, { timeoutMs: IMPORT_LOCK_WAIT_MS, staleLockMs: 10 * 60_000 });
}
/** Remove the `<repoDir>/.trash-*` a failed removeRunDir left (the SLUG pattern cannot name one). */
function sweepTrash(layout, warn) {
    let names = [];
    try {
        names = readdirSync(layout.repoDir);
    }
    catch {
        return;
    }
    for (const n of names.filter((x) => x.startsWith('.trash-'))) {
        try {
            removeRunDir(join(layout.repoDir, n), layout.work);
        }
        catch (e) {
            warn(`omg factory run: a leftover ${join(layout.repoDir, n)} could not be removed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
/** Delete this run's refs/omg-import/<slug>/* against their values (review-481 f). */
function dropStaleImports(userGitDir, slug, ctx, warn) {
    for (const { ref, sha } of staleImportRefs(userGitDir, slug, ctx)) {
        if (!dropStaleImportRef(userGitDir, ref, sha, ctx))
            warn(`omg factory run: the stale import ref ${ref} could not be deleted; delete it by hand (git update-ref -d ${ref})`);
    }
}
//# sourceMappingURL=private-run.js.map