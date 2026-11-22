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

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statfsSync, statSync, symlinkSync, unlinkSync, writeFileSync, type Stats } from 'fs';
import { copyFile } from 'fs/promises';
import { basename, join, posix, relative, win32 } from 'path';
import { loadBaseKnownFlaky, loadTrustedShipConfig, userConfigLayers, type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { getBranchName, getWorktreePath } from '../../team/git-worktree.js';
import { runSlug, type FactoryRunKey } from './state.js';
import { dotnetBuildDirIndex } from './local-gate.js';
import { expandWorkspaceDirs, plainDirUnder, workspaceLinkTarget } from './workspace-tree.js';

export const FACTORY_CHECKOUT_TEAM = 'factory-run';

/** `issue-<n>`, or `heal-<sig8>` for a ci-heal run. */
export const checkoutWorker = (issue: FactoryRunKey): string => runSlug(issue);

export function checkoutPath(root: string, issue: FactoryRunKey): string {
  return getWorktreePath(root, FACTORY_CHECKOUT_TEAM, checkoutWorker(issue));
}

export function checkoutBranch(issue: FactoryRunKey): string {
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
export const GATE_CACHE_DIRS: readonly string[] = ['.cache', '.tmp', '.vite', '.vite-temp', '.vitest'];

/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export const GATE_TREE_MARKER = '.omg-gate-tree';

/** The marker's last line once linkNodeModules built every tree (L3, review-547); a leading dot, so never a workspace dir. */
export const GATE_TREE_COMPLETE = '.omg-complete';

/** `target` is a real dir holding the engine's marker without the completion line (a build cut off by a crash). */
function gateTreeIncomplete(target: string): boolean {
  try {
    if (!lstatSync(target).isDirectory()) return false;
    const m = lstatSync(join(target, GATE_TREE_MARKER));
    if (!m.isFile() || m.size > 64 * 1024) return false;
    return !readFileSync(join(target, GATE_TREE_MARKER), 'utf-8').split('\n').includes(GATE_TREE_COMPLETE);
  } catch {
    return false;
  }
}

/** `target` is a real dir holding the engine's marker with the completion line (a tree linkNodeModules finished). */
function gateTreeComplete(target: string): boolean {
  try {
    if (!lstatSync(target).isDirectory()) return false;
    const m = lstatSync(join(target, GATE_TREE_MARKER));
    if (!m.isFile() || m.size > 64 * 1024) return false;
    return readFileSync(join(target, GATE_TREE_MARKER), 'utf-8').split('\n').includes(GATE_TREE_COMPLETE);
  } catch {
    return false;
  }
}

/** L3 (review-490): the largest top-level node_modules file copied into a tree (npm's `.package-lock.json` of a big monorepo is a few MB). */
export const GATE_TREE_FILE_MAX_BYTES = 16 * 1024 * 1024;

function unlinkLink(p: string): void {
  // A junction or directory symlink on win32: rmdir removes the link itself.
  try { unlinkSync(p); } catch { rmdirSync(p); }
}

/**
 * A tree build or walk as steps, so one body serves the synchronous callers
 * (the gates, runTreeSteps) and the lane worktrees (runTreeStepsAsync), with
 * the same checks in the same order. Every fs call is synchronous in the
 * body except a file's copy, which it yields: `undefined` is a checkpoint
 * (the async runner may give the event loop a turn), `{ copy, to }` one file
 * copy, DRAIN waits until every yielded copy has landed and throws the first
 * copy error into the body, SETTLE only waits (a body already failing).
 */
type TreeStep = undefined | typeof DRAIN | typeof SETTLE | { copy: string; to: string };
type TreeSteps<T> = Generator<TreeStep, T, void>;
const DRAIN = Symbol('drain');
const SETTLE = Symbol('settle');

/** Runs tree steps synchronously: every copy is copyFileSync at its step, and its error is thrown into the body there. */
function runTreeSteps<T>(steps: TreeSteps<T>): T {
  let failure: { error: unknown } | null = null;
  for (;;) {
    const r = failure ? steps.throw(failure.error) : steps.next();
    failure = null;
    if (r.done) return r.value;
    const s = r.value;
    if (typeof s === 'object') {
      try { copyFileSync(s.copy, s.to); } catch (error) { failure = { error }; }
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
async function runTreeStepsAsync<T>(steps: TreeSteps<T>): Promise<T> {
  const pending = new Set<Promise<void>>();
  // A holder, as the copies set it from their callbacks.
  const failed: { first: { error: unknown } | null } = { first: null };
  let reported = false;
  const settle = async (): Promise<void> => { while (pending.size > 0) await Promise.race(pending); };
  let slice = Date.now();
  for (;;) {
    let r: IteratorResult<TreeStep, T>;
    try {
      if (failed.first && !reported) {
        reported = true;
        r = steps.throw(failed.first.error);
      } else r = steps.next();
    } catch (error) {
      await settle();
      throw error;
    }
    if (r.done) {
      await settle();
      // A body always drains before it returns; a copy that failed after that is never left unseen.
      if (failed.first && !reported) throw failed.first.error;
      return r.value;
    }
    const s = r.value;
    if (s === DRAIN || s === SETTLE) await settle();
    if (s === SETTLE) reported = true;
    else if (typeof s === 'object') {
      while (pending.size >= TREE_COPY_CONCURRENCY) await Promise.race(pending);
      const p: Promise<void> = copyFile(s.copy, s.to)
        .catch((error: unknown) => { failed.first ??= { error }; })
        .finally(() => { pending.delete(p); });
      pending.add(p);
    }
    if (Date.now() - slice >= TREE_STEP_SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
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
export function linkNodeModules(root: string, checkout: string, warn?: (message: string) => void, workspaces: readonly string[] = [], copy: boolean | Partial<GateTreeCopyLimits> = false): string | null {
  return runTreeSteps(linkNodeModulesSteps(root, checkout, warn, workspaces, copy));
}

/** linkNodeModules as tree steps (runTreeSteps, runTreeStepsAsync). */
function* linkNodeModulesSteps(root: string, checkout: string, warn: ((message: string) => void) | undefined, workspaces: readonly string[], copy: boolean | Partial<GateTreeCopyLimits>): TreeSteps<string | null> {
  const source = join(root, 'node_modules');
  const target = join(checkout, 'node_modules');
  if (!existsSync(checkout)) return null;
  // Workspaces (monorepos): the base's globs, expanded in your checkout (workspace-tree.ts).
  const ws = workspaces.length > 0 ? expandWorkspaceDirs(root, workspaces, warn) : { dirs: [], problem: null };
  if (!existsSync(source)) return ws.problem;
  let present = true;
  try { present = !lstatSync(target).isSymbolicLink() || !unlinkOwnLink(root, target); } catch { present = false; }
  // L3 (review-547): a tree whose marker lacks the completion line was cut off mid-build (a crash): removed and built again.
  if (present && gateTreeIncomplete(target)) {
    yield* unlinkNodeModulesSteps(root, checkout);
    present = existsSync(target) || isLink(target);
  }
  if (present) return ws.problem;
  // The trees this call builds: the root one, then one per workspace package whose node_modules exists in your
  // checkout (npm puts version conflicts there, pnpm every package's direct deps), in the same package dir of the gate checkout.
  // The links name your node_modules by its realpath: the gate sandbox grants that dir (sandbox.ts buildSandboxConfig), and
  // on Linux (bwrap) a path through a link to it (a bench's `node_modules -> <omc>/node_modules`) is not mounted there.
  const trees: { src: string; to: string; rel: string }[] = [{ src: realpathSync.native(source), to: target, rel: '' }];
  for (const rel of ws.dirs) {
    const yours = plainDirUnder(root, rel);
    const src = yours ? join(yours, 'node_modules') : null;
    const dir = plainDirUnder(checkout, rel);
    if (!src || !dir || isLink(src) || !existsSync(src) || !statSync(src).isDirectory()) continue;
    const nested = join(dir, 'node_modules');
    if (existsSync(nested) || isLink(nested)) continue;
    // By its realpath too, as the root's: the grant is the realpath of yours (sandbox.ts nestedNodeModulesTargets).
    trees.push({ src: realpathSync.native(src), to: nested, rel });
  }
  const built: string[] = [];
  let budget: CopyBudget | undefined;
  if (copy) {
    // M1 (review-547): the copy's own walk, dry (nothing written), so the bounds and the free-space check see what the
    // copy will hold; over a bound or the volume's free space, nothing is copied and the caller parks with this text.
    const limits: GateTreeCopyLimits = { ...DEFAULT_COPY_LIMITS, ...(copy === true ? {} : copy) };
    const roots = trees.map((t) => ({ real: realpathSync.native(t.src), to: t.to }));
    const dry: CopyBudget = { bytes: 0, files: 0, roots, limits, dry: true };
    for (const t of trees) yield* buildGateTree(t.src, t.to, root, checkout, t.rel ? `${t.rel}/` : '', undefined, dry);
    const free = limits.freeBytes(checkout);
    if (free !== null && free < dry.bytes + limits.marginBytes) throw new Error(`the copied gate node_modules tree needs ${dry.bytes} bytes plus a ${limits.marginBytes}-byte margin on the volume of ${checkout}, which has ${free} bytes free, so it is not copied`);
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
    if (moved) throw new Error(moved);
  } catch (error) {
    // No file copy is still writing into the tree while it is removed (a later copy error is dropped: this one is thrown).
    yield SETTLE;
    for (const rel of built) {
      const dir = plainDirUnder(checkout, rel);
      if (dir) try { if (lstatSync(join(dir, 'node_modules')).isDirectory()) yield* removeGateTreeSteps(join(dir, 'node_modules')); } catch { /* the caller's link-safe removal */ }
    }
    // Only a real dir (L3: the tree may be gone, or a link someone swapped in, which is never walked).
    try { if (lstatSync(target).isDirectory()) yield* removeGateTreeSteps(target); } catch { /* gone */ }
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
export function prepareLaneNodeModules(root: string, worktree: string, o: LaneTreeOptions): string | null {
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
export function prepareLaneNodeModulesAsync(root: string, worktree: string, o: LaneTreeOptions): Promise<string | null> {
  const run = laneTreeQueue.then(() => runTreeStepsAsync(prepareLaneSteps(root, worktree, o)));
  laneTreeQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** The lane preparation before the next one (prepareLaneNodeModulesAsync). */
let laneTreeQueue: Promise<void> = Promise.resolve();

/** The options of prepareLaneNodeModules. */
export interface LaneTreeOptions { workspaces?: readonly string[]; warn?: (message: string) => void; ignored: (paths: string[]) => boolean; copy?: boolean | Partial<GateTreeCopyLimits>; reuseFrom?: readonly string[] }

function* prepareLaneSteps(root: string, worktree: string, o: LaneTreeOptions): TreeSteps<string | null> {
  const target = join(worktree, 'node_modules');
  const copy = o.copy ?? true;
  if (!existsSync(join(root, 'node_modules'))) return null;
  if (isLink(target) && !sameDir(target, join(root, 'node_modules'))) return `${target} is a link the engine did not make, so the lane's node_modules is not prepared`;
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
    try { ignored = o.ignored(rels); } catch { /* unknown: treated as not ignored */ }
    if (!ignored) {
      // A cut-off tree goes (its links unlinked, never followed); a link to yours stays as it was.
      if (!isLink(target) && existsSync(target)) yield* unlinkNodeModulesSteps(root, worktree);
      o.warn?.(`omg factory run: git does not ignore ${rels.join(', ')} in ${worktree}, so the lane gets no ${copy ? 'copied ' : ''}node_modules (the lane commit refuses links in its worktree); add node_modules to .gitignore`);
      return null;
    }
    // Only a copied root tree moves (a workspace layout's nested trees are copied as before), and only into an empty spot.
    if (copy && nested.length === 0 && !existsSync(target) && !isLink(target)) {
      const adopted = yield* adoptLaneTree(root, worktree, o.reuseFrom ?? [], o.warn);
      if (adopted === true) return null;
      // A rejected tree that could not be removed (a busy or read-only file): never built over, the lane fails.
      if (typeof adopted === 'string') return adopted;
    }
  }
  let problem: string | null;
  try {
    problem = yield* linkNodeModulesSteps(root, worktree, o.warn, o.workspaces ?? [], copy);
  } catch (error) {
    return `the ${copy ? 'copied' : 'linked'} node_modules tree of the lane worktree ${worktree} could not be built (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    // The in-process record serves the gate checkouts; a lane tree is found by its marker (settleLaneNodeModules), and the
    // lane worktree's own removal unlinks every link in it, so nothing keeps the entry for the lifetime of the engine.
    nestedTrees.delete(worktree);
  }
  if (problem) o.warn?.(`omg factory run: ${problem}; the lane's node_modules tree leaves it out`);
  let st;
  try { st = lstatSync(target); } catch { return null; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${target} is not a real directory after its preparation, so the lane would fail in the sandbox`;
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
function* adoptLaneTree(root: string, worktree: string, from: readonly string[], warn?: (message: string) => void): TreeSteps<boolean | string> {
  const target = join(worktree, 'node_modules');
  for (const prev of from) {
    const src = join(prev, 'node_modules');
    if (sameDir(prev, worktree) || isLink(src) || !gateTreeComplete(src) || sameDir(src, join(root, 'node_modules'))) continue;
    // A marker that names nested workspace trees: those stay with their worktree, so the tree is not taken.
    try { if (readFileSync(join(src, GATE_TREE_MARKER), 'utf-8').split('\n').some((l) => l !== '' && l !== GATE_TREE_COMPLETE)) return false; } catch { return false; }
    try { renameSync(src, target); } catch { return false; }
    let problem: string | null;
    try { problem = treeMoved(target, worktree, '') ?? (yield* adoptedTreeProblem(root, target)); } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    if (!problem) return true;
    let removal = '';
    try { if (lstatSync(target).isDirectory()) yield* removeGateTreeSteps(target); } catch (error) { removal = error instanceof Error ? error.message : String(error); }
    let left = true;
    try { lstatSync(target); } catch { left = false; }
    if (left) return `the node_modules tree moved from the earlier lane worktree ${prev} is not reused (${problem}), and it could not be removed from ${target} (${removal || 'it is not a plain dir'}); remove it by hand, then rerun`;
    warn?.(`omg factory run: the node_modules tree of the earlier lane worktree ${prev} is not reused (${problem}); a fresh copy is built`);
    return false;
  }
  return false;
}

/** Why a moved lane tree must not be reused (adoptLaneTree), or null: a walk that never follows a link. */
function* adoptedTreeProblem(root: string, tree: string): TreeSteps<string | null> {
  const yours = join(root, 'node_modules');
  for (const e of readdirSync(yours, { withFileTypes: true })) {
    if (e.name === GATE_TREE_MARKER || !e.isFile()) continue;
    const mine = join(yours, e.name);
    if (statSync(mine).size > GATE_TREE_FILE_MAX_BYTES) continue;
    let theirs: Buffer;
    try {
      if (!lstatSync(join(tree, e.name)).isFile()) return `node_modules/${e.name} is not a plain file`;
      theirs = readFileSync(join(tree, e.name));
    } catch { return `node_modules/${e.name} is missing`; }
    if (!theirs.equals(readFileSync(mine))) return `node_modules/${e.name} differs from yours`;
  }
  const walk = function* (dir: string, rel: string): TreeSteps<string | null> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      yield;
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      // A dir is entered only after its own lstat says it is a plain dir (a junction may be reported as a dir).
      const st = e.isFile() ? e : lstatSync(p);
      if (st.isSymbolicLink()) {
        if (!sameDir(p, join(yours, ...r.split('/')))) return `node_modules/${r} is a link to somewhere other than the same entry of your node_modules`;
      } else if (st.isDirectory()) {
        const inner = yield* walk(p, r);
        if (inner) return inner;
      } else if (!st.isFile()) return `node_modules/${r} is neither a file, a dir nor a link`;
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
export function settleLaneNodeModules(root: string, worktree: string, ignored: (paths: string[]) => boolean, linked = false, nested: readonly string[] = []): string | null {
  const target = join(worktree, 'node_modules');
  if (linked) {
    for (const rel of nested) {
      const dir = plainDirUnder(worktree, rel);
      if (!dir) continue;
      const nm = join(dir, 'node_modules');
      try { if (lstatSync(nm).isSymbolicLink()) continue; } catch { continue; }
      runTreeSteps(unlinkTreeLinks(nm));
      if (existsSync(join(nm, GATE_TREE_MARKER))) runTreeSteps(removeGateTreeSteps(nm));
    }
  }
  try { if (!lstatSync(target).isDirectory()) return null; } catch { return null; }
  if (sameDir(target, join(root, 'node_modules'))) return null;
  if (linked) {
    unlinkNodeModules(root, worktree);
    return null;
  }
  if (!gateTreeComplete(target)) return null;
  const rels = ['node_modules', ...nestedTreeDirs(worktree).map((nm) => relative(worktree, nm).split(/[\\/]/).join('/'))];
  let still = false;
  try { still = ignored(rels); } catch { /* unknown: treated as not ignored */ }
  if (still) return null;
  unlinkNodeModules(root, worktree);
  return `git no longer ignores ${rels.join(', ')} in ${worktree} (the lane changed the ignore rules), so the engine removed its copied node_modules before the lane commit`;
}

/** The nested trees linkNodeModules built in this process, per checkout (the marker may be gone; review-490 M3). */
const nestedTrees = new Map<string, string[]>();

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const linkType = (): 'junction' | 'dir' => (process.platform === 'win32' ? 'junction' : 'dir');

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
function* buildGateTree(source: string, target: string, root: string, checkout: string, label: string, warn?: (message: string) => void, copy?: CopyBudget): TreeSteps<void> {
  // A dry budget (linkNodeModules' preflight) walks and counts exactly as below and writes nothing.
  const dry = copy?.dry === true;
  if (!dry) {
    mkdirSync(target);
    // L3 (review-501): a dir on the way swapped for a junction or link after plainDirUnder (a surviving PR process) would
    // put the tree, its marker and its links outside the checkout: the new dir must be where it was meant to be.
    const moved = treeMoved(target, checkout, label);
    if (moved) {
      try { rmdirSync(target); } catch { /* left for the caller's removal */ }
      throw new Error(moved);
    }
    writeFileSync(join(target, GATE_TREE_MARKER), '');
    for (const name of GATE_CACHE_DIRS) mkdirSync(join(target, name));
  }
  const place = function* (from: string, to: string): TreeSteps<void> {
    const w = workspaceLinkTarget(from, root, checkout);
    if ('skip' in w) {
      warn?.(`omg factory run: ${w.skip}, so it is left out of the gate's node_modules tree ${target}`);
      return;
    }
    if (copy && !('to' in w) && basename(from) !== '.bin') return yield* copyGateEntry(from, to, copy);
    spend(copy, 0);
    if (!dry) symlinkSync('to' in w ? w.to : from, to, linkType());
  };
  for (const e of readdirSync(source, { withFileTypes: true })) {
    yield;
    if (e.name === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(e.name)) continue;
    const from = join(source, e.name);
    let st;
    try { st = statSync(from); } catch { continue; }
    if (st.isFile()) {
      if (st.size > GATE_TREE_FILE_MAX_BYTES) {
        warn?.(`omg factory run: ${label}node_modules/${e.name} (${st.size} bytes) is over ${GATE_TREE_FILE_MAX_BYTES} bytes, so it is not copied into the gate's node_modules tree ${target}`);
        continue;
      }
      // A copy, never a link: a hard link would hand the PR's code your file to write.
      spend(copy, st.size);
      if (!dry) yield { copy: from, to: join(target, e.name) };
      continue;
    }
    if (!st.isDirectory()) continue;
    if (e.name.startsWith('@') && !isLink(from)) {
      const children = readdirSync(from);
      if (children.some((c) => !('keep' in workspaceLinkTarget(join(from, c), root, checkout)))) {
        spend(copy, 0);
        if (!dry) mkdirSync(join(target, e.name));
        for (const c of children) {
          try { if (!statSync(join(from, c)).isDirectory()) continue; } catch { continue; }
          yield* place(join(from, c), join(target, e.name, c));
        }
        continue;
      }
    }
    yield* place(from, join(target, e.name));
  }
  if (dry) return;
  // The check below runs after the last write has landed.
  yield DRAIN;
  // L3 residual (review-501b): the same check after the last write; a swap during the build fails it (the caller removes, link-safe).
  const after = treeMoved(target, checkout, label);
  if (after) throw new Error(after);
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

/** The bounds of a copied tree (the GATE_TREE_COPY_* constants; tests pass smaller ones), and the free space of a volume (statfs). */
export interface GateTreeCopyLimits { maxBytes: number; maxFiles: number; marginBytes: number; freeBytes: (dir: string) => number | null }

const DEFAULT_COPY_LIMITS: GateTreeCopyLimits = {
  maxBytes: GATE_TREE_COPY_MAX_BYTES,
  maxFiles: GATE_TREE_COPY_MAX_FILES,
  marginBytes: GATE_TREE_COPY_FREE_MARGIN_BYTES,
  freeBytes: (dir) => {
    try {
      const fs = statfsSync(dir);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch { return null; /* the platform cannot tell: the copy's own ENOSPC is the guard */ }
  },
};

/**
 * What one linkNodeModules call has copied so far (`files` counts every
 * entry made: file, dir or link), and the source trees it copies with the
 * gate dir each becomes (`roots`, realpaths of yours: L3). `dry`: count
 * only, write nothing (the preflight).
 */
interface CopyBudget { bytes: number; files: number; roots: readonly { real: string; to: string }[]; limits: GateTreeCopyLimits; dry: boolean }

/** The copy would pass a GATE_TREE_COPY_* bound: the run parks with this text (linkNodeModules throws it). */
function copyLimitText(what: string): string {
  return `the copied gate node_modules tree would be over ${what}, so it is not copied`;
}

/** One more entry (`bytes` of file content) in a copied tree; over a GATE_TREE_COPY_* bound it throws. No budget: a linked tree, unbounded. */
function spend(b: CopyBudget | undefined, bytes: number): void {
  if (!b) return;
  if (b.files + 1 > b.limits.maxFiles) throw new Error(copyLimitText(`${b.limits.maxFiles} entries (files, dirs and links)`));
  if (b.bytes + bytes > b.limits.maxBytes) throw new Error(copyLimitText(`${b.limits.maxBytes} bytes`));
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
function copiedAt(real: string, budget: CopyBudget): string | null {
  const P = process.platform === 'win32' ? win32 : posix;
  let best: { rel: string; to: string; len: number } | null = null;
  for (const r of budget.roots) {
    const rel = P.relative(r.real, real);
    if (rel.startsWith('..') || P.isAbsolute(rel)) continue;
    if (!best || r.real.length > best.len) best = { rel, to: r.to, len: r.real.length };
  }
  if (!best) return null;
  const first = best.rel.split(/[\\/]/)[0];
  if (first === '.bin' || first === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(first)) return null;
  return best.rel ? join(best.to, best.rel) : best.to;
}

/** A top-level package entry of a copied tree: a link into a copied tree becomes a link to that copy (copiedAt), anything else a copy (copyGateDir). */
function* copyGateEntry(from: string, to: string, budget: CopyBudget): TreeSteps<void> {
  if (isLink(from)) {
    let at: string | null = null;
    try { at = copiedAt(realpathSync.native(from), budget); } catch { /* dangling: copyGateDir's own read fails */ }
    if (at) {
      spend(budget, 0);
      if (!budget.dry) symlinkSync(at, to, linkType());
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
function* copyGateDir(from: string, to: string, budget: CopyBudget): TreeSteps<void> {
  spend(budget, 0);
  if (!budget.dry) mkdirSync(to);
  for (const e of readdirSync(from, { withFileTypes: true })) {
    yield;
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isSymbolicLink()) {
      let real: string;
      try {
        if (!statSync(s).isDirectory()) continue;
        real = realpathSync.native(s);
      } catch { continue; /* dangling: left out */ }
      spend(budget, 0);
      if (!budget.dry) symlinkSync(copiedAt(real, budget) ?? real, d, linkType());
    } else if (e.isDirectory()) yield* copyGateDir(s, d, budget);
    else if (e.isFile()) {
      const size = statSync(s).size;
      spend(budget, size);
      if (!budget.dry) yield { copy: s, to: d };
    }
  }
}

/** Why `target` (the tree for `label` in `checkout`) does not resolve where it was meant to be, or null. */
function treeMoved(target: string, checkout: string, label: string): string | null {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const want = join(realpathSync.native(checkout), ...label.split('/').filter((s) => s !== ''), 'node_modules');
  let got: string;
  try { got = realpathSync.native(target); } catch { got = ''; }
  return fold(got) === fold(want) ? null : `the gate's node_modules tree ${target} resolves to ${got || 'nothing'}, not ${want}: a dir on its way was replaced by a link`;
}

/** Unlink `link` when it resolves to the root's node_modules (the single link of older releases); true when it went. */
function unlinkOwnLink(root: string, link: string): boolean {
  try {
    const real = (p: string) => (process.platform === 'win32' ? realpathSync(p).toLowerCase() : realpathSync(p));
    if (real(link) !== real(join(root, 'node_modules'))) return false;
  } catch {
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
function* removeGateTreeSteps(dir: string): TreeSteps<void> {
  const walk = function* (d: string): TreeSteps<void> {
    for (const name of readdirSync(d)) {
      yield;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) unlinkLink(p);
      else if (st.isDirectory()) yield* walk(p);
      else unlinkSync(p);
    }
    rmdirSync(d);
  };
  yield* walk(dir);
}

/**
 * Remove a dotnet gate's leftover build state from `checkout` (the engine's
 * prepare checkout, before the gate): of `untracked` (repository paths as
 * `git ls-files --others -z` lists them against the head, ignored or not),
 * every path under a `bin`, `obj` or `artifacts` dir (local-gate.ts
 * dotnetBuildDirIndex), then the dirs that became empty under it. The PR's
 * code run there earlier (a prepare check, a source generator, an earlier
 * gate run) can leave a restore output or a stale build that MSBuild reuses
 * (NuGet's no-op restore keeps obj/*.nuget.g.targets; a newer bin/ skips
 * CoreCompile), and it would change the gate's result.
 *
 * Link-safe, never leaving the checkout: each path is walked from the
 * checkout one lstat at a time; a link (symlink or junction) at or below the
 * build dir is unlinked itself, never followed (git lists a junction's
 * content on Windows, the link itself on POSIX); a link above it, a file on
 * the way, or anything not there is left alone. A listed path that is the
 * build dir itself goes only when it is a link. Tracked files are never
 * listed, and a dir that still holds one is not empty. Returns how many
 * entries went.
 */
export function removeDotnetBuildOutput(checkout: string, untracked: readonly string[]): number {
  let removed = 0;
  const emptied = new Set<string>();
  for (const listed of untracked) {
    const at = dotnetBuildDirIndex(listed);
    if (at < 0) continue;
    const segs = listed.replace(/\/+$/, '').split('/');
    // A stream or drive spelling never names a plain checkout path on Windows.
    if (process.platform === 'win32' && segs.some((s) => s.includes(':'))) continue;
    let cur = checkout;
    const dirs: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      cur = join(cur, segs[i]);
      let st: Stats;
      try { st = lstatSync(cur); } catch { break; }
      if (st.isSymbolicLink()) {
        if (i >= at) {
          unlinkLink(cur);
          removed++;
          for (const d of dirs) emptied.add(d);
        }
        break;
      }
      const last = i === segs.length - 1;
      if (last && i > at) {
        if (st.isDirectory()) runTreeSteps(removeGateTreeSteps(cur));
        else unlinkSync(cur);
        removed++;
        for (const d of dirs) emptied.add(d);
        break;
      }
      if (!st.isDirectory()) break;
      if (i >= at) dirs.push(cur);
    }
  }
  // The dirs on the way, deepest first; one that still holds anything (a tracked file) stays.
  const candidates = [...emptied].sort((a, b) => b.length - a.length);
  for (const d of candidates) {
    try {
      const st = lstatSync(d);
      if (st.isDirectory() && !st.isSymbolicLink()) rmdirSync(d);
    } catch { /* not empty, or gone */ }
  }
  return removed;
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
export function unlinkNodeModules(root: string, checkout: string): void {
  runTreeSteps(unlinkNodeModulesSteps(root, checkout));
}

/** unlinkNodeModules as tree steps (a lane's cut-off or not-ignored tree goes without holding the event loop). */
function* unlinkNodeModulesSteps(root: string, checkout: string): TreeSteps<void> {
  const target = join(checkout, 'node_modules');
  // The nested workspace trees first (the root's marker names them): every link unlinked, never followed.
  for (const nm of nestedTreeDirs(checkout)) {
    yield* unlinkTreeLinks(nm);
    if (existsSync(join(nm, GATE_TREE_MARKER))) yield* removeGateTreeSteps(nm);
  }
  nestedTrees.delete(checkout);
  let st;
  try { st = lstatSync(target); } catch { return; }
  if (st.isSymbolicLink()) {
    unlinkOwnLink(root, target);
    return;
  }
  if (!st.isDirectory() || sameDir(target, join(root, 'node_modules'))) return;
  // M3 (review-490): a real node_modules dir in an engine checkout is treated as the engine's tree whether or not the
  // marker is still there (the PR's code can delete it): every link at any depth goes first, never followed. The
  // marker only decides whether the rest goes too; without it the caller's own (link-safe) removal takes the files.
  yield* unlinkTreeLinks(target);
  if (existsSync(join(target, GATE_TREE_MARKER))) yield* removeGateTreeSteps(target);
}

/**
 * Unlink every symlink and junction under `dir` at any depth, never following one; files and dirs stay. A dir that
 * is not the one its lstat saw once listed (a still-running lane process swapped it for a link or another dir between
 * the two: dev/ino differ) is skipped, so its listing is never acted on; a link left that way is refused by the commit.
 */
function* unlinkTreeLinks(dir: string, seen?: Stats): TreeSteps<void> {
  const before = seen ?? lstatSync(dir);
  if (before.isSymbolicLink() || !before.isDirectory()) return;
  const names = readdirSync(dir);
  const after = lstatSync(dir);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) return;
  for (const name of names) {
    yield;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) unlinkLink(p);
    else if (st.isDirectory()) yield* unlinkTreeLinks(p, st);
  }
}

/**
 * True when `<checkout>/node_modules` is, or still holds, a link at any
 * depth (or cannot be fully read): removing that dir recursively could go
 * through a link into your node_modules. False when it is absent or link-free.
 */
export function gateTreeHasLinks(checkout: string): boolean {
  const walk = (p: string): boolean => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return false;
    return readdirSync(p).some((name) => walk(join(p, name)));
  };
  const target = join(checkout, 'node_modules');
  let nested: string[];
  try { nested = nestedTreeDirs(checkout); } catch { return true; }
  for (const nm of nested) {
    try { if (walk(nm)) return true; } catch { return true; }
  }
  try { lstatSync(target); } catch { return false; }
  try { return walk(target); } catch { return true; }
}

/**
 * The nested workspace trees of `checkout` that are there as real dirs: the
 * ones linkNodeModules built in this process and the ones the root tree's
 * marker lists (PR-writable, so every line must be an exact relative path
 * whose every segment is a plain dir in the checkout; another is ignored).
 */
export function nestedTreeDirs(checkout: string): string[] {
  const rels = new Set(nestedTrees.get(checkout) ?? []);
  const marker = join(checkout, 'node_modules', GATE_TREE_MARKER);
  try {
    const st = lstatSync(join(checkout, 'node_modules'));
    const m = lstatSync(marker);
    if (!st.isSymbolicLink() && st.isDirectory() && m.isFile() && m.size <= 64 * 1024) {
      for (const line of readFileSync(marker, 'utf-8').split('\n')) if (line && line !== GATE_TREE_COMPLETE) rels.add(line);
    }
  } catch { /* no marker list */ }
  const out: string[] = [];
  for (const rel of rels) {
    const dir = plainDirUnder(checkout, rel);
    if (!dir) continue;
    const nm = join(dir, 'node_modules');
    try {
      const st = lstatSync(nm);
      if (!st.isSymbolicLink() && st.isDirectory()) out.push(nm);
    } catch { /* gone */ }
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
export function trustedNestedRels(root: string, checkout: string, workspaces: readonly string[]): string[] {
  const own = nestedTrees.get(checkout);
  if (own) return [...own];
  if (workspaces.length === 0) return [];
  const marker = join(checkout, 'node_modules', GATE_TREE_MARKER);
  const listed = new Set<string>();
  try {
    const st = lstatSync(join(checkout, 'node_modules'));
    const m = lstatSync(marker);
    if (!st.isSymbolicLink() && st.isDirectory() && m.isFile() && m.size <= 64 * 1024) {
      for (const line of readFileSync(marker, 'utf-8').split('\n')) if (line && line !== GATE_TREE_COMPLETE) listed.add(line);
    }
  } catch { return []; }
  return expandWorkspaceDirs(root, workspaces).dirs.filter((rel) => listed.has(rel));
}

function sameDir(a: string, b: string): boolean {
  try {
    const ra = realpathSync(a);
    const rb = realpathSync(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

export interface GateConfig {
  config: ShipConfig;
  known: KnownFlakyTest[];
}

export interface GateConfigInput {
  exec: Exec;
  root: string;
  base: string;
  /** GitHub's base sha (baseRefOid). */
  baseSha: string;
  /** The PR's repository URL. */
  repoUrl: string;
  warn: (message: string) => void;
}

export type GateConfigLoader = (input: GateConfigInput) => GateConfig;

/**
 * Ship's safety-key loader in strict mode: requiredChecks, advisoryChecks
 * and the known-flaky list come from the user config at its default
 * location or the base branch committed at GitHub's base sha, never from the
 * working tree or the PR head. A base that cannot be verified throws.
 */
export const defaultGateConfigLoader: GateConfigLoader = (i) => {
  const layers = userConfigLayers();
  const config = loadTrustedShipConfig({
    exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true,
    user: layers.user, trustedUser: layers.trustedUser, warn: i.warn,
  });
  return { config, known: loadBaseKnownFlaky(i.exec, i.root, config.trustedBaseCommit, config.knownFlakyFile) };
};
