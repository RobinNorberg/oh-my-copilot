/**
 * The engine-owned prepare checkout and the trusted gate config for
 * `omg factory run` (design §3 prepare, §6, §10 hygiene).
 *
 * The checkout is a team worktree (src/team/git-worktree.ts) of the team
 * FACTORY_CHECKOUT_TEAM, `.omg/team/factory-run/worktrees/issue-<n>` on the
 * local branch `omc-team/factory-run/issue-<n>`, so its removal goes through
 * removeWorkerWorktree, which unlinks junctions (node_modules) before
 * `git worktree remove` and refuses dirty trees and commits nothing else
 * holds. The engine creates it with the hardened, guarded git
 * (`git worktree add -B <branch> <path> <sha>`); ship's runPrepare then runs
 * in it with push off, and the engine pushes the result itself.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statfsSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { copyFile } from 'fs/promises';
import { basename, join, posix, relative, win32 } from 'path';
import { loadBaseKnownFlaky, loadTrustedShipConfig, userConfigLayers } from '../../ship/config.js';
import { getBranchName, getWorktreePath } from '../../team/git-worktree.js';
import { runSlug } from './state.js';
import { expandWorkspaceDirs, plainDirUnder, workspaceLinkTarget } from './workspace-tree.js';
export const FACTORY_CHECKOUT_TEAM = 'factory-run';
/** `issue-<n>`, or `heal-<sig8>` for a ci-heal run. */
export const checkoutWorker = (issue) => runSlug(issue);
export function checkoutPath(root, issue) {
    return getWorktreePath(root, FACTORY_CHECKOUT_TEAM, checkoutWorker(issue));
}
export function checkoutBranch(issue) {
    return getBranchName(FACTORY_CHECKOUT_TEAM, checkoutWorker(issue));
}
/**
 * The tool-cache dirs a gate's node_modules gets fresh and empty per run,
 * even when your node_modules has them: vite and vitest (`.vite`, the
 * bundled-config `.vite-temp`, `.vitest`) and find-cache-dir users such as
 * babel-loader, eslint-loader and terser (`.cache`), and `.tmp`, where the
 * create-vite TypeScript templates put tsc's `tsBuildInfoFile` (a pure
 * incremental cache: fresh only means a full build). Your copies are never
 * linked in: a cache the PR's code wrote there would run on your next
 * `vite dev`. They are made whether or not yours has them; any other name
 * your node_modules lacks is simply creatable in the tree.
 */
export const GATE_CACHE_DIRS = ['.cache', '.tmp', '.vite', '.vite-temp', '.vitest'];
/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export const GATE_TREE_MARKER = '.omg-gate-tree';
/** The marker's last line once linkNodeModules built every tree (L3, review-547); a leading dot, so never a workspace dir. */
export const GATE_TREE_COMPLETE = '.omg-complete';
/** `target` is a real dir holding the engine's marker without the completion line (a build cut off by a crash). */
function gateTreeIncomplete(target) {
    try {
        if (!lstatSync(target).isDirectory())
            return false;
        const m = lstatSync(join(target, GATE_TREE_MARKER));
        if (!m.isFile() || m.size > 64 * 1024)
            return false;
        return !readFileSync(join(target, GATE_TREE_MARKER), 'utf-8').split('\n').includes(GATE_TREE_COMPLETE);
    }
    catch {
        return false;
    }
}
/** `target` is a real dir holding the engine's marker with the completion line (a tree linkNodeModules finished). */
function gateTreeComplete(target) {
    try {
        if (!lstatSync(target).isDirectory())
            return false;
        const m = lstatSync(join(target, GATE_TREE_MARKER));
        if (!m.isFile() || m.size > 64 * 1024)
            return false;
        return readFileSync(join(target, GATE_TREE_MARKER), 'utf-8').split('\n').includes(GATE_TREE_COMPLETE);
    }
    catch {
        return false;
    }
}
/** L3 (review-490): the largest top-level node_modules file copied into a tree (npm's `.package-lock.json` of a big monorepo is a few MB). */
export const GATE_TREE_FILE_MAX_BYTES = 16 * 1024 * 1024;
function unlinkLink(p) {
    // A junction or directory symlink on win32: rmdir removes the link itself.
    try {
        unlinkSync(p);
    }
    catch {
        rmdirSync(p);
    }
}
const DRAIN = Symbol('drain');
const SETTLE = Symbol('settle');
/** Runs tree steps synchronously: every copy is copyFileSync at its step, and its error is thrown into the body there. */
function runTreeSteps(steps) {
    let failure = null;
    for (;;) {
        const r = failure ? steps.throw(failure.error) : steps.next();
        failure = null;
        if (r.done)
            return r.value;
        const s = r.value;
        if (typeof s === 'object') {
            try {
                copyFileSync(s.copy, s.to);
            }
            catch (error) {
                failure = { error };
            }
        }
    }
}
/** File copies in flight at once (runTreeStepsAsync): the libuv threadpool's default size, so the engine's other async fs, dns and zlib work never waits behind a full queue of copies. */
const TREE_COPY_CONCURRENCY = 4;
/** The longest the async runner keeps the event loop between turns it gives back (ms). */
const TREE_STEP_SLICE_MS = 8;
/**
 * Runs tree steps without holding the event loop: a turn is given back
 * (setImmediate) once TREE_STEP_SLICE_MS of synchronous steps have run, and
 * files are copied by fs.promises, at most TREE_COPY_CONCURRENCY at once. A
 * copy's error is thrown into the body at its next step; later ones are
 * dropped (the body is already failing). Every copy has settled before the
 * result or the body's error is returned.
 */
async function runTreeStepsAsync(steps) {
    const pending = new Set();
    // A holder, as the copies set it from their callbacks.
    const failed = { first: null };
    let reported = false;
    const settle = async () => { while (pending.size > 0)
        await Promise.race(pending); };
    let slice = Date.now();
    for (;;) {
        let r;
        try {
            if (failed.first && !reported) {
                reported = true;
                r = steps.throw(failed.first.error);
            }
            else
                r = steps.next();
        }
        catch (error) {
            await settle();
            throw error;
        }
        if (r.done) {
            await settle();
            // A body always drains before it returns; a copy that failed after that is never left unseen.
            if (failed.first && !reported)
                throw failed.first.error;
            return r.value;
        }
        const s = r.value;
        if (s === DRAIN || s === SETTLE)
            await settle();
        if (s === SETTLE)
            reported = true;
        else if (typeof s === 'object') {
            while (pending.size >= TREE_COPY_CONCURRENCY)
                await Promise.race(pending);
            const p = copyFile(s.copy, s.to)
                .catch((error) => { failed.first ??= { error }; })
                .finally(() => { pending.delete(p); });
            pending.add(p);
        }
        if (Date.now() - slice >= TREE_STEP_SLICE_MS) {
            await new Promise((resolve) => setImmediate(resolve));
            slice = Date.now();
        }
    }
}
/**
 * Give the prepare checkout (or a calibration dir) your node_modules so
 * prepare's tsc / eslint / vitest find their packages: a real
 * `node_modules` directory holding one junction (win32) or directory
 * symlink per top-level entry of yours (`@scope` dirs and `.bin` linked
 * whole), the GATE_CACHE_DIRS as fresh empty dirs, and top-level files
 * (`.package-lock.json`) copied up to GATE_TREE_FILE_MAX_BYTES (a larger one
 * is skipped with a `warn` note). In the gate sandbox the checkout is
 * read-write and your node_modules read-only, so tools that write a cache
 * under node_modules (vitest's results cache in `.vite`) write into this
 * per-run tree, never into yours. A single junction from an older release
 * is replaced; anything else already there is left alone. Every link is
 * unlinked (never followed) by unlinkNodeModules before the dir goes.
 *
 * Workspaces: `workspaces` are the TRUSTED BASE's globs (never the PR
 * head's). Each matched package dir whose node_modules exists in your
 * checkout gets the same kind of tree in that package dir of the gate
 * checkout, and a workspace self-link (`node_modules/@scope/pkg ->
 * packages/pkg`) resolves to the gate checkout's package, never your
 * working tree. Returns why the layout is not supported (Yarn PnP, a nested
 * git repository, over the bounds; the folder named), else null; the trees
 * that can be built still are.
 *
 * `copy` (GATE_TREE_COPY_WHY): each package dir is a copy of yours instead
 * of a link (`.bin` and workspace self-links stay links), so a tool that
 * opens a package dir itself (esbuild) never opens a junction; a link to a
 * dir of a copied tree points at its copy (copiedAt). It throws, before
 * anything is copied, when the copy would pass a GATE_TREE_COPY_* bound or
 * the checkout's volume lacks the space (a dry run of the copy's own walk),
 * and at a bound while copying (the partial tree is removed first). The
 * marker's completion line (GATE_TREE_COMPLETE) is written last; a tree
 * found without it is removed and built again.
 */
export function linkNodeModules(root, checkout, warn, workspaces = [], copy = false) {
    return runTreeSteps(linkNodeModulesSteps(root, checkout, warn, workspaces, copy));
}
/** linkNodeModules as tree steps (runTreeSteps, runTreeStepsAsync). */
function* linkNodeModulesSteps(root, checkout, warn, workspaces, copy) {
    const source = join(root, 'node_modules');
    const target = join(checkout, 'node_modules');
    if (!existsSync(checkout))
        return null;
    // Workspaces (monorepos): the base's globs, expanded in your checkout (workspace-tree.ts).
    const ws = workspaces.length > 0 ? expandWorkspaceDirs(root, workspaces, warn) : { dirs: [], problem: null };
    if (!existsSync(source))
        return ws.problem;
    let present = true;
    try {
        present = !lstatSync(target).isSymbolicLink() || !unlinkOwnLink(root, target);
    }
    catch {
        present = false;
    }
    // L3 (review-547): a tree whose marker lacks the completion line was cut off mid-build (a crash): removed and built again.
    if (present && gateTreeIncomplete(target)) {
        yield* unlinkNodeModulesSteps(root, checkout);
        present = existsSync(target) || isLink(target);
    }
    if (present)
        return ws.problem;
    // The trees this call builds: the root one, then one per workspace package whose node_modules exists in your
    // checkout (npm puts version conflicts there, pnpm every package's direct deps), in the same package dir of the gate checkout.
    // The links name your node_modules by its realpath: the gate sandbox grants that dir (sandbox.ts buildSandboxConfig), and
    // on Linux (bwrap) a path through a link to it (a bench's `node_modules -> <omc>/node_modules`) is not mounted there.
    const trees = [{ src: realpathSync.native(source), to: target, rel: '' }];
    for (const rel of ws.dirs) {
        const yours = plainDirUnder(root, rel);
        const src = yours ? join(yours, 'node_modules') : null;
        const dir = plainDirUnder(checkout, rel);
        if (!src || !dir || isLink(src) || !existsSync(src) || !statSync(src).isDirectory())
            continue;
        const nested = join(dir, 'node_modules');
        if (existsSync(nested) || isLink(nested))
            continue;
        // By its realpath too, as the root's: the grant is the realpath of yours (sandbox.ts nestedNodeModulesTargets).
        trees.push({ src: realpathSync.native(src), to: nested, rel });
    }
    const built = [];
    let budget;
    if (copy) {
        // M1 (review-547): the copy's own walk, dry (nothing written), so the bounds and the free-space check see what the
        // copy will hold; over a bound or the volume's free space, nothing is copied and the caller parks with this text.
        const limits = { ...DEFAULT_COPY_LIMITS, ...(copy === true ? {} : copy) };
        const roots = trees.map((t) => ({ real: realpathSync.native(t.src), to: t.to }));
        const dry = { bytes: 0, files: 0, roots, limits, dry: true };
        for (const t of trees)
            yield* buildGateTree(t.src, t.to, root, checkout, t.rel ? `${t.rel}/` : '', undefined, dry);
        const free = limits.freeBytes(checkout);
        if (free !== null && free < dry.bytes + limits.marginBytes)
            throw new Error(`the copied gate node_modules tree needs ${dry.bytes} bytes plus a ${limits.marginBytes}-byte margin on the volume of ${checkout}, which has ${free} bytes free, so it is not copied`);
        budget = { bytes: 0, files: 0, roots, limits, dry: false };
    }
    try {
        for (const t of trees) {
            if (t.rel) {
                built.push(t.rel);
                // Listed before it is built, so a crash mid-build leaves it named for the removal (L3, review-547).
                writeFileSync(join(target, GATE_TREE_MARKER), built.map((r) => `${r}\n`).join(''));
            }
            yield* buildGateTree(t.src, t.to, root, checkout, t.rel ? `${t.rel}/` : '', warn, budget);
        }
        // Every file copy has landed before the completion line says the tree is whole.
        yield DRAIN;
        // The marker lists the nested trees for the removal and the sandbox's grant check (both re-validate every line);
        // its completion line is the last write of the build (L3, review-547).
        writeFileSync(join(target, GATE_TREE_MARKER), [...built, GATE_TREE_COMPLETE].map((r) => `${r}\n`).join(''));
        const moved = treeMoved(target, checkout, '');
        if (moved)
            throw new Error(moved);
    }
    catch (error) {
        // No file copy is still writing into the tree while it is removed (a later copy error is dropped: this one is thrown).
        yield SETTLE;
        for (const rel of built) {
            const dir = plainDirUnder(checkout, rel);
            if (dir)
                try {
                    if (lstatSync(join(dir, 'node_modules')).isDirectory())
                        yield* removeGateTreeSteps(join(dir, 'node_modules'));
                }
                catch { /* the caller's link-safe removal */ }
        }
        // Only a real dir (L3: the tree may be gone, or a link someone swapped in, which is never walked).
        try {
            if (lstatSync(target).isDirectory())
                yield* removeGateTreeSteps(target);
        }
        catch { /* gone */ }
        throw error;
    }
    nestedTrees.set(checkout, built);
    return ws.problem;
}
/**
 * A lane worktree's own node_modules for the OS sandbox. On Windows
 * (GATE_TREE_COPY_WHY: a package dir opened through a junction is denied,
 * so a lane's `npm test` fails with "Access is denied"): linkNodeModules'
 * copied tree in `worktree`, the same build the gates use, from your
 * node_modules at `root` (only read). On Linux and macOS (`copy: false`):
 * the gates' linked tree, whose links name your node_modules by its
 * realpath, which the lane's sandbox grants read-only (the engine passes it
 * as the session's nodeModulesTarget, so every link is checked before each
 * session); without it a lane worktree has no node_modules and, with no
 * network, no tsc or vitest. Once per worktree: a complete tree
 * already there is reused, a cut-off one is built again. Your node_modules,
 * and the target of any link, is never written or removed: an existing
 * `<worktree>/node_modules` link is unlinked only when it resolves to yours
 * (the link itself, never followed), and a link elsewhere refuses.
 *
 * `ignored(paths)`: whether git ignores every one of the tree dirs
 * (`node_modules`, `<pkg>/node_modules`, which need not exist yet) in the
 * worktree. It is asked before anything is copied: a tree git would list as
 * untracked is not built (a warning says so; the engine's lane commit
 * refuses a worktree with a junction in it), so the lane runs as before.
 * Returns why the lane must not start (the copy over its bounds or the free
 * space, a foreign link), else null.
 *
 * `reuseFrom`: earlier lane worktrees of the same work item, most recent
 * first; a complete copied tree there is moved here instead of a new copy
 * (adoptLaneTree, with its checks and trust argument). A linked tree
 * (`copy: false`) is never moved: it costs about as little as the move.
 */
export function prepareLaneNodeModules(root, worktree, o) {
    return runTreeSteps(prepareLaneSteps(root, worktree, o));
}
/**
 * prepareLaneNodeModules without blocking the event loop: the same steps,
 * checks and result, but the walk gives the event loop a turn every few
 * milliseconds and files are copied by fs.promises, a bounded number at a
 * time (runTreeStepsAsync), so the engine's other lanes, its heartbeats and
 * timers keep running while a lane's tree is copied. Every copy has landed
 * before the tree's completion line is written and before a cut-off tree is
 * removed. Within one engine process one preparation runs at a time (the
 * next waits), so each one's free-space check still sees the space the one
 * before it took, as when they were synchronous; the parallel supervisor's
 * child engines each have their own queue.
 */
export function prepareLaneNodeModulesAsync(root, worktree, o) {
    const run = laneTreeQueue.then(() => runTreeStepsAsync(prepareLaneSteps(root, worktree, o)));
    laneTreeQueue = run.then(() => undefined, () => undefined);
    return run;
}
/** The lane preparation before the next one (prepareLaneNodeModulesAsync). */
let laneTreeQueue = Promise.resolve();
function* prepareLaneSteps(root, worktree, o) {
    const target = join(worktree, 'node_modules');
    const copy = o.copy ?? true;
    if (!existsSync(join(root, 'node_modules')))
        return null;
    if (isLink(target) && !sameDir(target, join(root, 'node_modules')))
        return `${target} is a link the engine did not make, so the lane's node_modules is not prepared`;
    // A real dir with no cut-off marker: a tree already built here (reused), or the repository's own (the lane's).
    const building = !existsSync(target) || isLink(target) || gateTreeIncomplete(target);
    if (building) {
        // The dirs linkNodeModules may build: the root tree and each workspace package whose node_modules you have.
        const nested = (o.workspaces?.length ? expandWorkspaceDirs(root, o.workspaces).dirs : []).filter((rel) => {
            const yours = plainDirUnder(root, rel);
            return yours !== null && existsSync(join(yours, 'node_modules'));
        });
        const rels = ['node_modules', ...nested.map((rel) => `${rel}/node_modules`)];
        let ignored = false;
        try {
            ignored = o.ignored(rels);
        }
        catch { /* unknown: treated as not ignored */ }
        if (!ignored) {
            // A cut-off tree goes (its links unlinked, never followed); a link to yours stays as it was.
            if (!isLink(target) && existsSync(target))
                yield* unlinkNodeModulesSteps(root, worktree);
            o.warn?.(`omg factory run: git does not ignore ${rels.join(', ')} in ${worktree}, so the lane gets no ${copy ? 'copied ' : ''}node_modules (the lane commit refuses links in its worktree); add node_modules to .gitignore`);
            return null;
        }
        // Only a copied root tree moves (a workspace layout's nested trees are copied as before), and only into an empty spot.
        if (copy && nested.length === 0 && !existsSync(target) && !isLink(target)) {
            const adopted = yield* adoptLaneTree(root, worktree, o.reuseFrom ?? [], o.warn);
            if (adopted === true)
                return null;
            // A rejected tree that could not be removed (a busy or read-only file): never built over, the lane fails.
            if (typeof adopted === 'string')
                return adopted;
        }
    }
    let problem;
    try {
        problem = yield* linkNodeModulesSteps(root, worktree, o.warn, o.workspaces ?? [], copy);
    }
    catch (error) {
        return `the ${copy ? 'copied' : 'linked'} node_modules tree of the lane worktree ${worktree} could not be built (${error instanceof Error ? error.message : String(error)})`;
    }
    finally {
        // The in-process record serves the gate checkouts; a lane tree is found by its marker (settleLaneNodeModules), and the
        // lane worktree's own removal unlinks every link in it, so nothing keeps the entry for the lifetime of the engine.
        nestedTrees.delete(worktree);
    }
    if (problem)
        o.warn?.(`omg factory run: ${problem}; the lane's node_modules tree leaves it out`);
    let st;
    try {
        st = lstatSync(target);
    }
    catch {
        return null;
    }
    if (st.isSymbolicLink() || !st.isDirectory())
        return `${target} is not a real directory after its preparation, so the lane would fail in the sandbox`;
    return null;
}
/**
 * One copied node_modules per work item instead of one per lane
 * (prepareLaneNodeModules `reuseFrom`): the complete tree of an earlier,
 * completed lane of the same run is MOVED (renamed, never hard-linked or
 * linked) into the new lane's worktree, so the copy is paid once per item.
 * `from`: the earlier lanes' worktrees, most recent first; the first one
 * holding a complete tree is tried, and a failed rename (another volume, a
 * file still open) builds a fresh copy as before.
 *
 * Trust: the moved tree was writable by the earlier lane, so a lane of the
 * same item may find what the earlier one left in it (a changed package
 * file). That is the same trust the item's lanes already share: the next
 * lane starts from the earlier lane's committed code, runs in the same OS
 * sandbox, and the gates and your checkout never use a lane's tree (the
 * gates build their own copy from yours). What could reach beyond the
 * sandbox is refused: the moved tree must hold only plain dirs and files
 * plus links to exactly the same entry of your node_modules (the `.bin`
 * link the build makes), checked by a walk that never follows a link; a
 * link anywhere else (planted by the lane, or a build-time link into the
 * old worktree that the move would leave dangling) fails it. Every
 * top-level file of yours (`.package-lock.json`) must be byte-equal in the
 * tree, so a tree an `npm install` changed, or yours changed since, is not
 * reused. A tree that fails is removed (links unlinked, never followed) and
 * a fresh copy is built; when anything of it is left (a busy or read-only
 * file), the reason is returned and the lane fails (worktree-unprepared),
 * never building over the leftovers. Never a link into your node_modules is followed or
 * removed: the source is taken only when it is a real dir.
 */
function* adoptLaneTree(root, worktree, from, warn) {
    const target = join(worktree, 'node_modules');
    for (const prev of from) {
        const src = join(prev, 'node_modules');
        if (sameDir(prev, worktree) || isLink(src) || !gateTreeComplete(src) || sameDir(src, join(root, 'node_modules')))
            continue;
        // A marker that names nested workspace trees: those stay with their worktree, so the tree is not taken.
        try {
            if (readFileSync(join(src, GATE_TREE_MARKER), 'utf-8').split('\n').some((l) => l !== '' && l !== GATE_TREE_COMPLETE))
                return false;
        }
        catch {
            return false;
        }
        try {
            renameSync(src, target);
        }
        catch {
            return false;
        }
        let problem;
        try {
            problem = treeMoved(target, worktree, '') ?? (yield* adoptedTreeProblem(root, target));
        }
        catch (error) {
            problem = error instanceof Error ? error.message : String(error);
        }
        if (!problem)
            return true;
        let removal = '';
        try {
            if (lstatSync(target).isDirectory())
                yield* removeGateTreeSteps(target);
        }
        catch (error) {
            removal = error instanceof Error ? error.message : String(error);
        }
        let left = true;
        try {
            lstatSync(target);
        }
        catch {
            left = false;
        }
        if (left)
            return `the node_modules tree moved from the earlier lane worktree ${prev} is not reused (${problem}), and it could not be removed from ${target} (${removal || 'it is not a plain dir'}); remove it by hand, then rerun`;
        warn?.(`omg factory run: the node_modules tree of the earlier lane worktree ${prev} is not reused (${problem}); a fresh copy is built`);
        return false;
    }
    return false;
}
/** Why a moved lane tree must not be reused (adoptLaneTree), or null: a walk that never follows a link. */
function* adoptedTreeProblem(root, tree) {
    const yours = join(root, 'node_modules');
    for (const e of readdirSync(yours, { withFileTypes: true })) {
        if (e.name === GATE_TREE_MARKER || !e.isFile())
            continue;
        const mine = join(yours, e.name);
        if (statSync(mine).size > GATE_TREE_FILE_MAX_BYTES)
            continue;
        let theirs;
        try {
            if (!lstatSync(join(tree, e.name)).isFile())
                return `node_modules/${e.name} is not a plain file`;
            theirs = readFileSync(join(tree, e.name));
        }
        catch {
            return `node_modules/${e.name} is missing`;
        }
        if (!theirs.equals(readFileSync(mine)))
            return `node_modules/${e.name} differs from yours`;
    }
    const walk = function* (dir, rel) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            yield;
            const p = join(dir, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            // A dir is entered only after its own lstat says it is a plain dir (a junction may be reported as a dir).
            const st = e.isFile() ? e : lstatSync(p);
            if (st.isSymbolicLink()) {
                if (!sameDir(p, join(yours, ...r.split('/'))))
                    return `node_modules/${r} is a link to somewhere other than the same entry of your node_modules`;
            }
            else if (st.isDirectory()) {
                const inner = yield* walk(p, r);
                if (inner)
                    return inner;
            }
            else if (!st.isFile())
                return `node_modules/${r} is neither a file, a dir nor a link`;
        }
        return null;
    };
    return yield* walk(tree, '');
}
/**
 * Before the engine commits a lane worktree: a copied tree
 * prepareLaneNodeModules built there (its marker with the completion line)
 * must still be ignored by git as the lane left the worktree, since the
 * lane may have changed .gitignore. `ignored(paths)` is the commit's own
 * check (lane-commit.ts). A tree that is not is removed, every link
 * unlinked first, never followed (unlinkNodeModules), so the commit neither
 * refuses its links nor stages the copy. Returns what was removed, or null.
 * A removal error throws (the commit then refuses the links that are left).
 *
 * `linked` (the Linux and macOS lane tree, `copy: false`): a tree of links
 * only, cheap to build again, so it always goes before the commit, whatever
 * git ignores (null returned): every link in the worktree's node_modules is
 * unlinked, never followed, marker or not (the lane can delete the marker,
 * as in unlinkNodeModules M3), so its links are never committed. `nested`:
 * the lane's nested workspace trees as relative package dirs, recorded by the
 * engine when it prepared the lane (the marker that also names them is
 * lane-writable): their links go too, never followed, marker or not.
 */
export function settleLaneNodeModules(root, worktree, ignored, linked = false, nested = []) {
    const target = join(worktree, 'node_modules');
    if (linked) {
        for (const rel of nested) {
            const dir = plainDirUnder(worktree, rel);
            if (!dir)
                continue;
            const nm = join(dir, 'node_modules');
            try {
                if (lstatSync(nm).isSymbolicLink())
                    continue;
            }
            catch {
                continue;
            }
            runTreeSteps(unlinkTreeLinks(nm));
            if (existsSync(join(nm, GATE_TREE_MARKER)))
                runTreeSteps(removeGateTreeSteps(nm));
        }
    }
    try {
        if (!lstatSync(target).isDirectory())
            return null;
    }
    catch {
        return null;
    }
    if (sameDir(target, join(root, 'node_modules')))
        return null;
    if (linked) {
        unlinkNodeModules(root, worktree);
        return null;
    }
    if (!gateTreeComplete(target))
        return null;
    const rels = ['node_modules', ...nestedTreeDirs(worktree).map((nm) => relative(worktree, nm).split(/[\\/]/).join('/'))];
    let still = false;
    try {
        still = ignored(rels);
    }
    catch { /* unknown: treated as not ignored */ }
    if (still)
        return null;
    unlinkNodeModules(root, worktree);
    return `git no longer ignores ${rels.join(', ')} in ${worktree} (the lane changed the ignore rules), so the engine removed its copied node_modules before the lane commit`;
}
/** The nested trees linkNodeModules built in this process, per checkout (the marker may be gone; review-490 M3). */
const nestedTrees = new Map();
function isLink(p) {
    try {
        return lstatSync(p).isSymbolicLink();
    }
    catch {
        return false;
    }
}
const linkType = () => (process.platform === 'win32' ? 'junction' : 'dir');
/**
 * One tree: `target` a real dir with the marker, the GATE_CACHE_DIRS fresh,
 * top-level files of `source` copied (bounded), every dir linked to
 * `<source>/<name>` read-only, except a link into your working tree outside
 * any node_modules (a workspace self-link, workspaceLinkTarget), which goes
 * to the same dir of the gate checkout. A `@scope` dir holding such a link is
 * a real dir with one link per package; any other is linked whole. `copy`
 * (a budget): every dir but `.bin` and the workspace self-links is copied
 * (copyGateDir).
 */
function* buildGateTree(source, target, root, checkout, label, warn, copy) {
    // A dry budget (linkNodeModules' preflight) walks and counts exactly as below and writes nothing.
    const dry = copy?.dry === true;
    if (!dry) {
        mkdirSync(target);
        // L3 (review-501): a dir on the way swapped for a junction or link after plainDirUnder (a surviving PR process) would
        // put the tree, its marker and its links outside the checkout: the new dir must be where it was meant to be.
        const moved = treeMoved(target, checkout, label);
        if (moved) {
            try {
                rmdirSync(target);
            }
            catch { /* left for the caller's removal */ }
            throw new Error(moved);
        }
        writeFileSync(join(target, GATE_TREE_MARKER), '');
        for (const name of GATE_CACHE_DIRS)
            mkdirSync(join(target, name));
    }
    const place = function* (from, to) {
        const w = workspaceLinkTarget(from, root, checkout);
        if ('skip' in w) {
            warn?.(`omg factory run: ${w.skip}, so it is left out of the gate's node_modules tree ${target}`);
            return;
        }
        if (copy && !('to' in w) && basename(from) !== '.bin')
            return yield* copyGateEntry(from, to, copy);
        spend(copy, 0);
        if (!dry)
            symlinkSync('to' in w ? w.to : from, to, linkType());
    };
    for (const e of readdirSync(source, { withFileTypes: true })) {
        yield;
        if (e.name === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(e.name))
            continue;
        const from = join(source, e.name);
        let st;
        try {
            st = statSync(from);
        }
        catch {
            continue;
        }
        if (st.isFile()) {
            if (st.size > GATE_TREE_FILE_MAX_BYTES) {
                warn?.(`omg factory run: ${label}node_modules/${e.name} (${st.size} bytes) is over ${GATE_TREE_FILE_MAX_BYTES} bytes, so it is not copied into the gate's node_modules tree ${target}`);
                continue;
            }
            // A copy, never a link: a hard link would hand the PR's code your file to write.
            spend(copy, st.size);
            if (!dry)
                yield { copy: from, to: join(target, e.name) };
            continue;
        }
        if (!st.isDirectory())
            continue;
        if (e.name.startsWith('@') && !isLink(from)) {
            const children = readdirSync(from);
            if (children.some((c) => !('keep' in workspaceLinkTarget(join(from, c), root, checkout)))) {
                spend(copy, 0);
                if (!dry)
                    mkdirSync(join(target, e.name));
                for (const c of children) {
                    try {
                        if (!statSync(join(from, c)).isDirectory())
                            continue;
                    }
                    catch {
                        continue;
                    }
                    yield* place(join(from, c), join(target, e.name, c));
                }
                continue;
            }
        }
        yield* place(from, join(target, e.name));
    }
    if (dry)
        return;
    // The check below runs after the last write has landed.
    yield DRAIN;
    // L3 residual (review-501b): the same check after the last write; a swap during the build fails it (the caller removes, link-safe).
    const after = treeMoved(target, checkout, label);
    if (after)
        throw new Error(after);
}
/**
 * Why a gate tree may be built as copies: in the Copilot OS sandbox on
 * Windows (its low-integrity token) a directory junction whose target the
 * sandbox may only read cannot be opened as a whole with generic read access
 * (CreateFile GENERIC_READ: Access is denied), although listing it, reading
 * files through it and opening the target by its own path all work (live
 * 2026-11-13, Copilot CLI 1.0.105, Windows 11 26300). Node's readdir asks
 * for list access only, so tsc, eslint and vitest work through the links;
 * esbuild (Go's os.Open) asks for generic read on every package dir it lists
 * and fails with `Cannot read directory "node_modules/<pkg>": Access is
 * denied.` Granting the target changes nothing (a dir the sandbox was never
 * granted fails the same way); only a real dir in the checkout works.
 */
export const GATE_TREE_COPY_WHY = 'the OS sandbox on Windows denies opening a package dir through the gate tree\'s junction with generic read access, which esbuild needs';
/** L1 (review-546): the most bytes all copied trees of one linkNodeModules call may hold. */
export const GATE_TREE_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** L1 (review-546): the most files all copied trees of one linkNodeModules call may hold. */
export const GATE_TREE_COPY_MAX_FILES = 200_000;
/** L1 (review-546): free space the destination volume keeps after the estimated copy. */
export const GATE_TREE_COPY_FREE_MARGIN_BYTES = 1024 * 1024 * 1024;
const DEFAULT_COPY_LIMITS = {
    maxBytes: GATE_TREE_COPY_MAX_BYTES,
    maxFiles: GATE_TREE_COPY_MAX_FILES,
    marginBytes: GATE_TREE_COPY_FREE_MARGIN_BYTES,
    freeBytes: (dir) => {
        try {
            const fs = statfsSync(dir);
            return Number(fs.bavail) * Number(fs.bsize);
        }
        catch {
            return null; /* the platform cannot tell: the copy's own ENOSPC is the guard */
        }
    },
};
/** The copy would pass a GATE_TREE_COPY_* bound: the run parks with this text (linkNodeModules throws it). */
function copyLimitText(what) {
    return `the copied gate node_modules tree would be over ${what}, so it is not copied`;
}
/** One more entry (`bytes` of file content) in a copied tree; over a GATE_TREE_COPY_* bound it throws. No budget: a linked tree, unbounded. */
function spend(b, bytes) {
    if (!b)
        return;
    if (b.files + 1 > b.limits.maxFiles)
        throw new Error(copyLimitText(`${b.limits.maxFiles} entries (files, dirs and links)`));
    if (b.bytes + bytes > b.limits.maxBytes)
        throw new Error(copyLimitText(`${b.limits.maxBytes} bytes`));
    b.files += 1;
    b.bytes += bytes;
}
/**
 * L3 / M1 (review-546, review-547): where in the gate the copy of your dir
 * `real` (a realpath) is, when it lies in one of the trees being copied
 * (`budget.roots`), else null. That dir is copied once, by the walk of its
 * own tree, so a link to it becomes a link to the copy (pnpm's
 * `.pnpm/<pkg>/node_modules/<dep>`, npm's nested links): nothing is copied
 * twice, a cycle stays a cycle, and the copy keeps the layout pnpm resolves
 * through. Dirs the gate does not copy (`.bin`, the cache dirs) give null.
 */
function copiedAt(real, budget) {
    const P = process.platform === 'win32' ? win32 : posix;
    let best = null;
    for (const r of budget.roots) {
        const rel = P.relative(r.real, real);
        if (rel.startsWith('..') || P.isAbsolute(rel))
            continue;
        if (!best || r.real.length > best.len)
            best = { rel, to: r.to, len: r.real.length };
    }
    if (!best)
        return null;
    const first = best.rel.split(/[\\/]/)[0];
    if (first === '.bin' || first === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(first))
        return null;
    return best.rel ? join(best.to, best.rel) : best.to;
}
/** A top-level package entry of a copied tree: a link into a copied tree becomes a link to that copy (copiedAt), anything else a copy (copyGateDir). */
function* copyGateEntry(from, to, budget) {
    if (isLink(from)) {
        let at = null;
        try {
            at = copiedAt(realpathSync.native(from), budget);
        }
        catch { /* dangling: copyGateDir's own read fails */ }
        if (at) {
            spend(budget, 0);
            if (!budget.dry)
                symlinkSync(at, to, linkType());
            return;
        }
    }
    yield* copyGateDir(from, to, budget);
}
/**
 * A copy of your package dir `from` at `to`: dirs made, files copied (never
 * hard-linked: the PR's code could write your file through one), every entry
 * counted against `budget` (over a GATE_TREE_COPY_* bound it throws). A dir
 * link inside it points at the copy of its target when that lies in a tree
 * being copied (copiedAt; the PR's code can write that copy anyway), else at
 * the same target as yours (never followed, never copied). A file link or a
 * dangling one is left out. Nothing of yours is written. File copies are yielded
 * steps (runTreeSteps, runTreeStepsAsync).
 */
function* copyGateDir(from, to, budget) {
    spend(budget, 0);
    if (!budget.dry)
        mkdirSync(to);
    for (const e of readdirSync(from, { withFileTypes: true })) {
        yield;
        const s = join(from, e.name);
        const d = join(to, e.name);
        if (e.isSymbolicLink()) {
            let real;
            try {
                if (!statSync(s).isDirectory())
                    continue;
                real = realpathSync.native(s);
            }
            catch {
                continue; /* dangling: left out */
            }
            spend(budget, 0);
            if (!budget.dry)
                symlinkSync(copiedAt(real, budget) ?? real, d, linkType());
        }
        else if (e.isDirectory())
            yield* copyGateDir(s, d, budget);
        else if (e.isFile()) {
            const size = statSync(s).size;
            spend(budget, size);
            if (!budget.dry)
                yield { copy: s, to: d };
        }
    }
}
/** Why `target` (the tree for `label` in `checkout`) does not resolve where it was meant to be, or null. */
function treeMoved(target, checkout, label) {
    const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const want = join(realpathSync.native(checkout), ...label.split('/').filter((s) => s !== ''), 'node_modules');
    let got;
    try {
        got = realpathSync.native(target);
    }
    catch {
        got = '';
    }
    return fold(got) === fold(want) ? null : `the gate's node_modules tree ${target} resolves to ${got || 'nothing'}, not ${want}: a dir on its way was replaced by a link`;
}
/** Unlink `link` when it resolves to the root's node_modules (the single link of older releases); true when it went. */
function unlinkOwnLink(root, link) {
    try {
        const real = (p) => (process.platform === 'win32' ? realpathSync(p).toLowerCase() : realpathSync(p));
        if (real(link) !== real(join(root, 'node_modules')))
            return false;
    }
    catch {
        return false;
    }
    unlinkLink(link);
    return true;
}
/**
 * Remove a node_modules tree linkNodeModules built, never through a link:
 * every symlink and junction at any depth is unlinked first (the PR's code
 * may have planted one in a cache dir), then files and dirs bottom up. A
 * dir is read only after an lstat says it is a plain directory. As tree
 * steps (runTreeSteps for the synchronous callers).
 */
function* removeGateTreeSteps(dir) {
    const walk = function* (d) {
        for (const name of readdirSync(d)) {
            yield;
            const p = join(d, name);
            const st = lstatSync(p);
            if (st.isSymbolicLink())
                unlinkLink(p);
            else if (st.isDirectory())
                yield* walk(p);
            else
                unlinkSync(p);
        }
        rmdirSync(d);
    };
    yield* walk(dir);
}
/**
 * Remove what linkNodeModules made before the checkout is discarded: on
 * POSIX a symlink named node_modules is untracked for a `node_modules/`
 * gitignore line (directory-only), so removeWorkerWorktree would see a dirty
 * tree. The single link of older releases goes only when it resolves to the
 * root's node_modules. In a real node_modules dir every link at any depth is
 * unlinked, never followed, marker or not (M3); the engine's tree (with
 * GATE_TREE_MARKER) then goes whole. Your node_modules is never
 * touched, and anything else is left to the caller's own (link-safe) removal
 * and dirty check.
 */
export function unlinkNodeModules(root, checkout) {
    runTreeSteps(unlinkNodeModulesSteps(root, checkout));
}
/** unlinkNodeModules as tree steps (a lane's cut-off or not-ignored tree goes without holding the event loop). */
function* unlinkNodeModulesSteps(root, checkout) {
    const target = join(checkout, 'node_modules');
    // The nested workspace trees first (the root's marker names them): every link unlinked, never followed.
    for (const nm of nestedTreeDirs(checkout)) {
        yield* unlinkTreeLinks(nm);
        if (existsSync(join(nm, GATE_TREE_MARKER)))
            yield* removeGateTreeSteps(nm);
    }
    nestedTrees.delete(checkout);
    let st;
    try {
        st = lstatSync(target);
    }
    catch {
        return;
    }
    if (st.isSymbolicLink()) {
        unlinkOwnLink(root, target);
        return;
    }
    if (!st.isDirectory() || sameDir(target, join(root, 'node_modules')))
        return;
    // M3 (review-490): a real node_modules dir in an engine checkout is treated as the engine's tree whether or not the
    // marker is still there (the PR's code can delete it): every link at any depth goes first, never followed. The
    // marker only decides whether the rest goes too; without it the caller's own (link-safe) removal takes the files.
    yield* unlinkTreeLinks(target);
    if (existsSync(join(target, GATE_TREE_MARKER)))
        yield* removeGateTreeSteps(target);
}
/**
 * Unlink every symlink and junction under `dir` at any depth, never following one; files and dirs stay. A dir that
 * is not the one its lstat saw once listed (a still-running lane process swapped it for a link or another dir between
 * the two: dev/ino differ) is skipped, so its listing is never acted on; a link left that way is refused by the commit.
 */
function* unlinkTreeLinks(dir, seen) {
    const before = seen ?? lstatSync(dir);
    if (before.isSymbolicLink() || !before.isDirectory())
        return;
    const names = readdirSync(dir);
    const after = lstatSync(dir);
    if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino)
        return;
    for (const name of names) {
        yield;
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isSymbolicLink())
            unlinkLink(p);
        else if (st.isDirectory())
            yield* unlinkTreeLinks(p, st);
    }
}
/**
 * True when `<checkout>/node_modules` is, or still holds, a link at any
 * depth (or cannot be fully read): removing that dir recursively could go
 * through a link into your node_modules. False when it is absent or link-free.
 */
export function gateTreeHasLinks(checkout) {
    const walk = (p) => {
        const st = lstatSync(p);
        if (st.isSymbolicLink())
            return true;
        if (!st.isDirectory())
            return false;
        return readdirSync(p).some((name) => walk(join(p, name)));
    };
    const target = join(checkout, 'node_modules');
    let nested;
    try {
        nested = nestedTreeDirs(checkout);
    }
    catch {
        return true;
    }
    for (const nm of nested) {
        try {
            if (walk(nm))
                return true;
        }
        catch {
            return true;
        }
    }
    try {
        lstatSync(target);
    }
    catch {
        return false;
    }
    try {
        return walk(target);
    }
    catch {
        return true;
    }
}
/**
 * Why the node_modules trees of `checkout` are not exactly what
 * linkNodeModules built from your node_modules (`root`), or null: what a
 * dotnet gate needs before it runs when the trusted definition files import
 * from node_modules (engine.ts packageTreeImportsReady). Read-only (lstat,
 * readlink, readdir, and the bytes of the small top-level files). Checked,
 * for the root tree and each nested workspace tree the engine vouches for
 * (`nestedRels`, trustedNestedRels): every top-level entry is the engine's
 * marker file, a fresh cache dir (GATE_CACHE_DIRS, not a link; what a check
 * writes there is not looked at), a link to `<yours>/<its name>` (or into
 * the checkout outside node_modules: a workspace self-link, the
 * repository's own files), a real `@scope` dir of such links, or a top-level
 * file with exactly your copy's bytes; and every dir of yours the engine
 * links is there. A plain dir where the engine put a link (the PR's code
 * replaced it with its own files), any other entry, or one that is gone is
 * `tampered`. Not verifiable (`tampered: false`): a copied tree
 * (GATE_TREE_COPY_WHY; comparing every file is not cheap), a node_modules
 * dir the engine did not build (git lists files under it in `untracked`, or
 * yours has no such tree), or a tree that cannot be read. A tree the
 * checkout does not have is fine: there is nothing to import.
 */
export function gateTreeExactProblem(root, checkout, nestedRels, untracked, copied) {
    const win = process.platform === 'win32';
    const P = win ? win32 : posix;
    const fold = (s) => (win ? s.toLowerCase() : s);
    const same = (a, b) => fold(P.resolve(a)) === fold(P.resolve(b));
    const isNodeModules = (s) => s.replace(/[. ]+$/, '').toLowerCase() === 'node_modules';
    const trees = [{ rel: '', src: join(root, 'node_modules') }, ...nestedRels.map((rel) => ({ rel, src: join(root, ...rel.split('/'), 'node_modules') }))];
    const isDir = (p) => { try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    } };
    // A node_modules dir with files git lists that is none of the engine's trees: installed or written in the checkout.
    for (const p of untracked) {
        const segs = p.split('/');
        const at = segs.findIndex(isNodeModules);
        if (at < 0)
            continue;
        const rel = segs.slice(0, at).join('/');
        if (!trees.some((t) => fold(t.rel) === fold(rel) && isDir(t.src)))
            return { problem: `${segs.slice(0, at + 1).join('/')} in the checkout is not a node_modules tree the engine built from yours, so what is in it cannot be verified`, tampered: false };
    }
    const insideCheckout = (p, to) => {
        const rel = P.relative(P.resolve(checkout), to);
        if (!rel || rel.startsWith('..') || P.isAbsolute(rel) || rel.split(/[\\/]/).some(isNodeModules))
            return false;
        try {
            const real = P.relative(fold(realpathSync.native(checkout)), fold(realpathSync.native(p)));
            return !!real && !real.startsWith('..') && !P.isAbsolute(real) && !real.split(/[\\/]/).some(isNodeModules);
        }
        catch {
            return false;
        }
    };
    const linkOk = (p, wants) => {
        let to;
        try {
            to = P.resolve(P.dirname(p), readlinkSync(p));
        }
        catch {
            return false;
        }
        return wants.some((w) => same(to, w)) || insideCheckout(p, to);
    };
    for (const t of trees) {
        const nm = join(checkout, ...t.rel.split('/').filter(Boolean), 'node_modules');
        const shown = `${t.rel ? `${t.rel}/` : ''}node_modules`;
        let st;
        try {
            st = lstatSync(nm);
        }
        catch {
            continue;
        }
        if (!isDir(t.src))
            return { problem: `${shown} in the checkout is not a tree the engine built (your checkout has no such node_modules), so what is in it cannot be verified`, tampered: false };
        if (copied)
            return { problem: `${shown} is the engine's copied tree (${GATE_TREE_COPY_WHY}), whose files the engine cannot compare with yours cheaply`, tampered: false };
        let srcReal;
        try {
            srcReal = realpathSync.native(t.src);
        }
        catch (error) {
            return { problem: `your ${t.src} cannot be read (${error instanceof Error ? error.message : String(error)})`, tampered: false };
        }
        if (st.isSymbolicLink()) {
            // An older release's single link: fine only when it resolves to yours (read-only in the sandbox).
            let real = '';
            try {
                real = realpathSync.native(nm);
            }
            catch { /* compared below */ }
            if (real && fold(real) === fold(srcReal))
                continue;
            return { problem: `${shown} is a link that does not resolve to your node_modules`, tampered: true };
        }
        if (!st.isDirectory())
            return { problem: `${shown} is not a directory`, tampered: true };
        const wants = (name) => [join(srcReal, name), join(t.src, name)];
        try {
            const present = new Set();
            for (const name of readdirSync(nm)) {
                present.add(fold(name));
                const p = join(nm, name);
                const e = lstatSync(p);
                if (name === GATE_TREE_MARKER) {
                    if (!e.isFile())
                        return { problem: `${shown}/${name} is not the engine's marker file`, tampered: true };
                    continue;
                }
                if (GATE_CACHE_DIRS.includes(name)) {
                    if (e.isSymbolicLink() || !e.isDirectory())
                        return { problem: `${shown}/${name} is not the fresh cache dir the engine made`, tampered: true };
                    continue;
                }
                if (e.isSymbolicLink()) {
                    if (!linkOk(p, wants(name)))
                        return { problem: `${shown}/${name} is a link to somewhere else than your node_modules/${name}`, tampered: true };
                }
                else if (e.isDirectory() && name.startsWith('@')) {
                    const inner = new Set();
                    for (const c of readdirSync(p)) {
                        inner.add(fold(c));
                        const cp = join(p, c);
                        if (!lstatSync(cp).isSymbolicLink() || !linkOk(cp, wants(join(name, c))))
                            return { problem: `${shown}/${name}/${c} is not the engine's link to your node_modules/${name}/${c}`, tampered: true };
                    }
                    for (const c of readdirSync(join(t.src, name))) {
                        if (!isDir(join(t.src, name, c)) || inner.has(fold(c)) || 'skip' in workspaceLinkTarget(join(t.src, name, c), root, checkout))
                            continue;
                        return { problem: `${shown}/${name}/${c}, which the engine links to yours, is gone`, tampered: true };
                    }
                }
                else if (e.isFile()) {
                    const from = join(t.src, name);
                    let mine = null;
                    try {
                        mine = statSync(from);
                    }
                    catch { /* none */ }
                    if (!mine?.isFile() || mine.size !== e.size || mine.size > GATE_TREE_FILE_MAX_BYTES || !readFileSync(from).equals(readFileSync(p)))
                        return { problem: `${shown}/${name} is not the engine's copy of your node_modules/${name}`, tampered: true };
                }
                else {
                    return { problem: `${shown}/${name} is a ${e.isDirectory() ? 'plain directory' : 'special file'} where the engine links your node_modules/${name}`, tampered: true };
                }
            }
            for (const name of readdirSync(t.src)) {
                if (name === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(name) || present.has(fold(name)) || !isDir(join(t.src, name)))
                    continue;
                if ('skip' in workspaceLinkTarget(join(t.src, name), root, checkout))
                    continue;
                return { problem: `${shown}/${name}, which the engine links to your node_modules/${name}, is gone`, tampered: true };
            }
        }
        catch (error) {
            return { problem: `${shown} cannot be read (${error instanceof Error ? error.message : String(error)})`, tampered: false };
        }
    }
    return null;
}
/**
 * The nested workspace trees of `checkout` that are there as real dirs: the
 * ones linkNodeModules built in this process and the ones the root tree's
 * marker lists (PR-writable, so every line must be an exact relative path
 * whose every segment is a plain dir in the checkout; another is ignored).
 */
export function nestedTreeDirs(checkout) {
    const rels = new Set(nestedTrees.get(checkout) ?? []);
    const marker = join(checkout, 'node_modules', GATE_TREE_MARKER);
    try {
        const st = lstatSync(join(checkout, 'node_modules'));
        const m = lstatSync(marker);
        if (!st.isSymbolicLink() && st.isDirectory() && m.isFile() && m.size <= 64 * 1024) {
            for (const line of readFileSync(marker, 'utf-8').split('\n'))
                if (line && line !== GATE_TREE_COMPLETE)
                    rels.add(line);
        }
    }
    catch { /* no marker list */ }
    const out = [];
    for (const rel of rels) {
        const dir = plainDirUnder(checkout, rel);
        if (!dir)
            continue;
        const nm = join(dir, 'node_modules');
        try {
            const st = lstatSync(nm);
            if (!st.isSymbolicLink() && st.isDirectory())
                out.push(nm);
        }
        catch { /* gone */ }
    }
    return out;
}
/**
 * The nested workspace trees of `checkout` the engine vouches for, as
 * relative package dirs: the ones linkNodeModules built in this process, or
 * (after a restart) the base's workspace globs expanded in your checkout ∩
 * the marker's lines. The marker is PR-writable, so on its own it never
 * widens anything: the sandbox grant (nestedNodeModulesTargets) and the
 * dirty check use only this list (review-501 M1, L2); the removal may still
 * follow the marker (it never follows a link).
 */
export function trustedNestedRels(root, checkout, workspaces) {
    const own = nestedTrees.get(checkout);
    if (own)
        return [...own];
    if (workspaces.length === 0)
        return [];
    const marker = join(checkout, 'node_modules', GATE_TREE_MARKER);
    const listed = new Set();
    try {
        const st = lstatSync(join(checkout, 'node_modules'));
        const m = lstatSync(marker);
        if (!st.isSymbolicLink() && st.isDirectory() && m.isFile() && m.size <= 64 * 1024) {
            for (const line of readFileSync(marker, 'utf-8').split('\n'))
                if (line && line !== GATE_TREE_COMPLETE)
                    listed.add(line);
        }
    }
    catch {
        return [];
    }
    return expandWorkspaceDirs(root, workspaces).dirs.filter((rel) => listed.has(rel));
}
function sameDir(a, b) {
    try {
        const ra = realpathSync(a);
        const rb = realpathSync(b);
        return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
    }
    catch {
        return false;
    }
}
/**
 * Ship's safety-key loader in strict mode: requiredChecks, advisoryChecks
 * and the known-flaky list come from the user config at its default
 * location or the base branch committed at GitHub's base sha, never from the
 * working tree or the PR head. A base that cannot be verified throws.
 */
export const defaultGateConfigLoader = (i) => {
    const layers = userConfigLayers();
    const config = loadTrustedShipConfig({
        exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true,
        user: layers.user, trustedUser: layers.trustedUser, warn: i.warn,
    });
    return { config, known: loadBaseKnownFlaky(i.exec, i.root, config.trustedBaseCommit, config.knownFlakyFile) };
};
//# sourceMappingURL=prepare.js.map