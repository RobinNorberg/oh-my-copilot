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
import { type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { type FactoryRunKey } from './state.js';
export declare const FACTORY_CHECKOUT_TEAM = "factory-run";
/** `issue-<n>`, or `heal-<sig8>` for a ci-heal run. */
export declare const checkoutWorker: (issue: FactoryRunKey) => string;
export declare function checkoutPath(root: string, issue: FactoryRunKey): string;
export declare function checkoutBranch(issue: FactoryRunKey): string;
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
export declare const GATE_CACHE_DIRS: readonly string[];
/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export declare const GATE_TREE_MARKER = ".omg-gate-tree";
/** The marker's last line once linkNodeModules built every tree (L3, review-547); a leading dot, so never a workspace dir. */
export declare const GATE_TREE_COMPLETE = ".omg-complete";
/** L3 (review-490): the largest top-level node_modules file copied into a tree (npm's `.package-lock.json` of a big monorepo is a few MB). */
export declare const GATE_TREE_FILE_MAX_BYTES: number;
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
export declare function linkNodeModules(root: string, checkout: string, warn?: (message: string) => void, workspaces?: readonly string[], copy?: boolean | Partial<GateTreeCopyLimits>): string | null;
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
export declare function prepareLaneNodeModules(root: string, worktree: string, o: LaneTreeOptions): string | null;
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
export declare function prepareLaneNodeModulesAsync(root: string, worktree: string, o: LaneTreeOptions): Promise<string | null>;
/** The options of prepareLaneNodeModules. */
export interface LaneTreeOptions {
    workspaces?: readonly string[];
    warn?: (message: string) => void;
    ignored: (paths: string[]) => boolean;
    copy?: boolean | Partial<GateTreeCopyLimits>;
    reuseFrom?: readonly string[];
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
 * as in unlinkNodeModules M3), so its links are never committed.
 */
export declare function settleLaneNodeModules(root: string, worktree: string, ignored: (paths: string[]) => boolean, linked?: boolean): string | null;
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
export declare const GATE_TREE_COPY_WHY = "the OS sandbox on Windows denies opening a package dir through the gate tree's junction with generic read access, which esbuild needs";
/** L1 (review-546): the most bytes all copied trees of one linkNodeModules call may hold. */
export declare const GATE_TREE_COPY_MAX_BYTES: number;
/** L1 (review-546): the most files all copied trees of one linkNodeModules call may hold. */
export declare const GATE_TREE_COPY_MAX_FILES = 200000;
/** L1 (review-546): free space the destination volume keeps after the estimated copy. */
export declare const GATE_TREE_COPY_FREE_MARGIN_BYTES: number;
/** The bounds of a copied tree (the GATE_TREE_COPY_* constants; tests pass smaller ones), and the free space of a volume (statfs). */
export interface GateTreeCopyLimits {
    maxBytes: number;
    maxFiles: number;
    marginBytes: number;
    freeBytes: (dir: string) => number | null;
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
export declare function unlinkNodeModules(root: string, checkout: string): void;
/**
 * True when `<checkout>/node_modules` is, or still holds, a link at any
 * depth (or cannot be fully read): removing that dir recursively could go
 * through a link into your node_modules. False when it is absent or link-free.
 */
export declare function gateTreeHasLinks(checkout: string): boolean;
/**
 * The nested workspace trees of `checkout` that are there as real dirs: the
 * ones linkNodeModules built in this process and the ones the root tree's
 * marker lists (PR-writable, so every line must be an exact relative path
 * whose every segment is a plain dir in the checkout; another is ignored).
 */
export declare function nestedTreeDirs(checkout: string): string[];
/**
 * The nested workspace trees of `checkout` the engine vouches for, as
 * relative package dirs: the ones linkNodeModules built in this process, or
 * (after a restart) the base's workspace globs expanded in your checkout ∩
 * the marker's lines. The marker is PR-writable, so on its own it never
 * widens anything: the sandbox grant (nestedNodeModulesTargets) and the
 * dirty check use only this list (review-501 M1, L2); the removal may still
 * follow the marker (it never follows a link).
 */
export declare function trustedNestedRels(root: string, checkout: string, workspaces: readonly string[]): string[];
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
export declare const defaultGateConfigLoader: GateConfigLoader;
//# sourceMappingURL=prepare.d.ts.map